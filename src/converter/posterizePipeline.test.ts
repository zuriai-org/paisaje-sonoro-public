import { describe, it, expect } from "vitest";
import {
  loadPosterizedImage,
  traceFromPosterizedJpeg,
} from "./posterizePipeline";
import { assignToPalette, traceLayers, type TraceResult } from "./posterize";

/**
 * Corrección estructural 2026-09-22 — el trazado opera sobre el JPEG
 * posterizado, NUNCA sobre la foto original ni el WebP. Estos tests
 * verifican el ORDEN contractual del pipeline con mocks inyectados (corren
 * en node, sin canvas): resize → webp-ref → posterizar → JPEG → (revisión)
 * → decodificar JPEG → re-snap a paleta → trazar.
 */

const PALETTE: Array<[number, number, number]> = [
  [10, 20, 30],
  [100, 110, 120],
  [190, 200, 210],
  [250, 250, 250],
];

function fakeTrace(width = 2, height = 2): TraceResult {
  return {
    idx: new Int8Array(width * height),
    margins: new Float32Array(width * height),
    palette: PALETTE.map((c) => [...c] as [number, number, number]),
    width,
    height,
  };
}

describe("pipeline estructural del posterizado (órden con mocks)", () => {
  it("subida: decode → resize → webp-ref → posterizar (sobre la YA redimensionada) → JPEG", async () => {
    const order: string[] = [];
    // Imagen enorme simulada (4000×3000): el fixture real no aplica en node;
    // lo que se verifica es el ORDEN de llamadas con mocks.
    const fakeImageData = {
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4),
    } as unknown as ImageData;
    const trace = fakeTrace(4, 4);
    const file = { name: "foto.png" } as unknown as File;

    const res = await loadPosterizedImage(file, {
      decodeImageFile: async () => {
        order.push("decode");
        return { width: 4000, height: 3000, close() {} } as unknown as ImageBitmap;
      },
      normalizeHeight: (bitmap) => {
        order.push("resize");
        expect(bitmap.width).toBe(4000); // se redimensiona ANTES de todo
        return {
          canvas: {} as HTMLCanvasElement,
          imageData: fakeImageData,
          resized: true,
        };
      },
      convertCanvas: async () => {
        order.push("webp-ref");
        return {} as never;
      },
      posterizeImage: (img) => {
        order.push("posterize");
        // El posterizado recibe la imagen YA redimensionada (no el original).
        expect(img).toBe(fakeImageData);
        return trace;
      },
      encodeRasterJpeg: async (t) => {
        order.push("jpeg");
        expect(t).toBe(trace); // el JPEG se codifica del raster posterizado
        return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
      },
    });

    expect(order).toEqual(["decode", "resize", "webp-ref", "posterize", "jpeg"]);
    expect(res.posterizedJpeg.type).toBe("image/jpeg");
    expect(res.trace).toBe(trace);
  });

  it("bloquea imágenes > 4096×4096 ANTES de redimensionar (guardarraíl de memoria)", async () => {
    let resized = false;
    await expect(
      loadPosterizedImage({ name: "enorme.png" } as unknown as File, {
        decodeImageFile: async () =>
          ({ width: 8000, height: 8000, close() {} }) as unknown as ImageBitmap,
        normalizeHeight: () => {
          resized = true;
          return {} as never;
        },
      })
    ).rejects.toThrow(/4096/);
    expect(resized).toBe(false);
  });

  it("trazado: decodifica el JPEG y re-snapea a la paleta antes de trazar", async () => {
    const order: string[] = [];
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    const decoded = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(2 * 2 * 4),
    };
    const source = fakeTrace();

    const traced = await traceFromPosterizedJpeg(jpeg, source, {
      decodeBlobToImageData: async () => {
        order.push("decode-jpeg");
        return decoded as unknown as ImageData;
      },
      assignToPalette: (img, palette) => {
        order.push("snap");
        expect(img).toBe(decoded);
        expect(palette).toBe(source.palette); // la paleta de la fase 1
        return source;
      },
    });

    expect(order).toEqual(["decode-jpeg", "snap"]);
    expect(traced).toBe(source);
    // Y con ese TraceResult se trazan las 4 capas (re-traza = limpieza).
    const layers = traceLayers(traced, 12);
    expect(layers).toHaveLength(4);
  });
});

describe("re-snap a paleta fija (assignToPalette)", () => {
  it("es determinista: mismo JPEG-decodificado → mismas máscaras", () => {
    // Píxeles ligeramente desplazados respecto a la paleta (el JPEG q92
    // desplaza los colores planos unos pocos puntos). Una sola FILA: así no
    // hay celdas 2×2 y la resolución de sillas (breakSaddles) no interviene;
    // lo que se mide aquí es la asignación pura al color más cercano.
    const px = [
      12, 18, 33, 255, // cerca de [10,20,30]
      97, 108, 118, 255, // cerca de [100,110,120]
      188, 196, 214, 255, // cerca de [190,200,210]
      248, 251, 247, 255, // cerca de [250,250,250]
      0, 0, 0, 255, // negro → sigue siendo la capa más cercana (0)
      255, 255, 255, 255, // blanco → capa 3
    ];
    const img = {
      width: 6,
      height: 1,
      data: new Uint8ClampedArray(px),
    };
    const a = assignToPalette(img, PALETTE);
    const b = assignToPalette(img, PALETTE);
    expect(a.idx).toEqual(b.idx);
    expect(Array.from(a.idx)).toEqual([0, 1, 2, 3, 0, 3]);
  });

  it("estabiliza bordes: colores exactos de la paleta quedan en su capa", () => {
    const px: number[] = [];
    for (const c of PALETTE) px.push(c[0], c[1], c[2], 255);
    const img = { width: 4, height: 1, data: new Uint8ClampedArray(px) };
    const t = assignToPalette(img, PALETTE);
    expect(Array.from(t.idx)).toEqual([0, 1, 2, 3]);
    expect(t.palette).toEqual(PALETTE);
  });
});


describe("F2 · re-snap con fondo (hilado del background al re-trazar)", () => {
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  const decoded = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(2 * 2 * 4),
  } as unknown as ImageData;

  it("si la fase 1 excluyó el fondo, el re-snap recibe el color de fondo (los píxeles cercanos quedan sin capa)", async () => {
    const source: TraceResult = {
      ...fakeTrace(),
      background: [255, 255, 255],
      backgroundExcluded: true,
    };
    let got: unknown = "no-llamado";
    await traceFromPosterizedJpeg(jpeg, source, {
      decodeBlobToImageData: async () => decoded,
      assignToPalette: (_img, _palette, opts) => {
        got = opts?.background ?? null;
        return source;
      },
    });
    expect(got).toEqual([255, 255, 255]);
  });

  it("sin exclusión (toggle OFF o fondo no candidato), el re-snap NO recibe fondo (comportamiento actual)", async () => {
    let got: unknown = "no-llamado";
    await traceFromPosterizedJpeg(jpeg, fakeTrace(), {
      decodeBlobToImageData: async () => decoded,
      assignToPalette: (_img, _palette, opts) => {
        got = opts?.background ?? null;
        return fakeTrace();
      },
    });
    expect(got).toBeNull();
    // y también cuando el fondo fue detectado pero no excluido
    const detectedOnly: TraceResult = { ...fakeTrace(), background: [73, 182, 182] };
    await traceFromPosterizedJpeg(jpeg, detectedOnly, {
      decodeBlobToImageData: async () => decoded,
      assignToPalette: (_img, _palette, opts) => {
        got = opts?.background ?? null;
        return detectedOnly;
      },
    });
    expect(got).toBeNull();
  });
});
