/**
 * Tests del núcleo Line Art (LA-1 2026-09-24): campo de gradientes Sobel,
 * orientación tangente al borde, longitud ∝ oscuridad, reproducibilidad por
 * seed y la regla de aceptación del puntillista.
 */
import { describe, it, expect } from "vitest";
import {
  generateSegments,
  segmentCount,
  sobelGradients,
  type LineArtParams,
} from "./lineart";
import { unpackRGB } from "./format";
import type { ImageDataLike } from "./core";

/** ImageDataLike a partir de un fill(x, y) → [r, g, b] (mismo patrón que core.test). */
function makeImageData(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number]
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const PARAMS: LineArtParams = {
  step: 4,
  maxLength: 10,
  strokeWidth: 2,
  seed: 42,
  maxVisibleRatio: 1,
};
/** PRNG inyectado: siempre acepta (0 < darkness para toda celda no blanca). */
const ALWAYS: () => number = () => 0;

describe("sobelGradients", () => {
  it("rampa horizontal → gradiente +x (borde vertical), gy = 0", () => {
    // Grises crecientes con x: el borde "corre" en dirección vertical y el
    // gradiente apunta a +x (de oscuro a claro).
    const img = makeImageData(24, 24, (x) => {
      const v = Math.round((x / 23) * 255);
      return [v, v, v];
    });
    const { gx, gy } = sobelGradients(img);
    // píxel interior: gx > 0 y gy = 0 (constante en y)
    expect(gx[12 * 24 + 12]).toBeGreaterThan(0);
    expect(gy[12 * 24 + 12]).toBe(0);
    // bordes de la imagen: gradiente nulo (sin vecinos completos)
    expect(gx[0]).toBe(0);
    expect(gx[12 * 24]).toBe(0); // x = 0
  });

  it("imagen plana → gradiente cero en todas partes", () => {
    const img = makeImageData(16, 16, () => [80, 80, 80]);
    const { gx, gy } = sobelGradients(img);
    expect([...gx]).toEqual(new Array(16 * 16).fill(0));
    expect([...gy]).toEqual(new Array(16 * 16).fill(0));
  });
});

describe("generateSegments — orientación (tangente al borde)", () => {
  it("rampa horizontal (borde vertical) → angle = 90° en todas las celdas interiores", () => {
    const img = makeImageData(24, 24, (x) => {
      const v = Math.round((x / 23) * 255);
      return [v, v, v];
    });
    const segs = generateSegments(img, PARAMS, ALWAYS);
    const n = segmentCount(segs);
    expect(n).toBe(6 * 6); // rejilla completa 24/4 × 24/4
    for (let i = 0; i < n; i++) {
      // atan2(0, gx>0) = 0 → +90 = 90: el trazo sigue el contorno (vertical)
      expect(segs[i * 5 + 2]).toBe(90);
    }
  });

  it("rampa vertical (borde horizontal) → angle = 180° (mismo trazo, sentido opuesto)", () => {
    const img = makeImageData(24, 24, (_x, y) => {
      const v = Math.round((y / 23) * 255);
      return [v, v, v];
    });
    const segs = generateSegments(img, PARAMS, ALWAYS);
    for (let i = 0; i < segmentCount(segs); i++) {
      expect(segs[i * 5 + 2]).toBe(180);
    }
  });

  it("zona plana → angle = 0 (trazo horizontal por defecto)", () => {
    const img = makeImageData(16, 16, () => [60, 60, 60]);
    const segs = generateSegments(img, PARAMS, ALWAYS);
    for (let i = 0; i < segmentCount(segs); i++) {
      expect(segs[i * 5 + 2]).toBe(0);
    }
  });
});

describe("generateSegments — longitud ∝ oscuridad", () => {
  it("len crece con la oscuridad y respeta la fórmula maxLength·(0.3+0.7·d)", () => {
    // misma rejilla, misma seed: solo cambia el nivel de gris
    const dark = generateSegments(makeImageData(16, 16, () => [51, 51, 51]), PARAMS, ALWAYS);
    const light = generateSegments(makeImageData(16, 16, () => [204, 204, 204]), PARAMS, ALWAYS);
    const dDark = 1 - 51 / 255; // 0.8
    const dLight = 1 - 204 / 255; // 0.2
    expect(dark[3]).toBeCloseTo(10 * (0.3 + 0.7 * dDark), 5); // 8.6
    expect(light[3]).toBeCloseTo(10 * (0.3 + 0.7 * dLight), 5); // 4.4
    expect(dark[3]).toBeGreaterThan(light[3]);
    // sombra = maxLength exacto, luz = mínimo (30%)
    const black = generateSegments(makeImageData(16, 16, () => [0, 0, 0]), PARAMS, ALWAYS);
    const gray = generateSegments(makeImageData(16, 16, () => [128, 128, 128]), PARAMS, ALWAYS);
    expect(black[3]).toBe(10);
    const grayLen = 10 * (0.3 + 0.7 * (1 - 128 / 255));
    expect(gray[3]).toBe(Math.round(grayLen * 10) / 10); // redondeo a 1 decimal
  });

  it("ángulo y len van con 1 decimal", () => {
    const img = makeImageData(16, 16, (_x, y) => {
      const v = Math.round((y / 15) * 255);
      return [v, v, v];
    });
    const segs = generateSegments(img, PARAMS, ALWAYS);
    for (let i = 0; i < segmentCount(segs); i++) {
      expect(segs[i * 5 + 2] * 10).toBe(Math.round(segs[i * 5 + 2] * 10));
      expect(segs[i * 5 + 3] * 10).toBe(Math.round(segs[i * 5 + 3] * 10));
    }
  });
});

describe("generateSegments — muestreo y reproducibilidad", () => {
  it("imagen negra + PRNG que siempre acepta → rejilla completa, rgb = negro, len = maxLength", () => {
    const segs = generateSegments(makeImageData(16, 16, () => [0, 0, 0]), PARAMS, ALWAYS);
    expect(segmentCount(segs)).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(segs[i * 5 + 3]).toBe(10); // maxLength
      expect(segs[i * 5 + 4]).toBe(0); // rgb(0,0,0)
    }
  });

  it("imagen blanca → ningún segmento (prob = 0)", () => {
    const segs = generateSegments(makeImageData(16, 16, () => [255, 255, 255]), PARAMS, ALWAYS);
    expect(segmentCount(segs)).toBe(0);
  });

  it("mismo seed → array idéntico; seed distinto → array distinto", () => {
    const img = makeImageData(32, 32, (x, y) => [
      (x * 31 + y * 17) % 256,
      (x * 7 + y * 3) % 256,
      (x * 11 + y * 23) % 256,
    ]);
    const a = generateSegments(img, PARAMS);
    const b = generateSegments(img, PARAMS);
    expect(a).toEqual(b);
    const c = generateSegments(img, { ...PARAMS, seed: 43 });
    expect(c).not.toEqual(a);
  });

  it("rgb = color promedio de la celda, empaquetado", () => {
    // mitad roja / mitad azul en cada celda de 4×4 → promedio (~127, 0, ~127)
    const img = makeImageData(16, 16, (x) => (x % 4 < 2 ? [255, 0, 0] : [0, 0, 255]));
    const segs = generateSegments(img, PARAMS, ALWAYS);
    const [r, g, b] = unpackRGB(segs[4]);
    expect(Math.abs(r - 127)).toBeLessThanOrEqual(1);
    expect(g).toBe(0);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// MODO 'bordes' (LA-4 2026-09-27): la tinta de grabado del Azimutal en
// vista plana — solo bordes ≥ umbral, trazo negro, len ∝ fuerza del borde.
// ─────────────────────────────────────────────────────────────────────────

describe("generateSegments · modo 'bordes' (grabado)", () => {
  const PARAMS_BORDES: LineArtParams = {
    step: 1,
    maxLength: 10,
    strokeWidth: 2,
    seed: 42,
    maxVisibleRatio: 1,
    mode: "bordes",
    umbral: 0.15,
  };

  it("escalón: solo las celdas del borde emiten, tangentes (90°), negras", () => {
    // v(x) = x<=60 ? 0 : 255 → el Sobel pica en las columnas 60 y 61.
    const img = makeImageData(120, 90, (x) => (x <= 60 ? [0, 0, 0] : [255, 255, 255]));
    const segs = generateSegments(img, PARAMS_BORDES);
    expect(segs.length % 5).toBe(0);
    const n = segmentCount(segs);
    expect(n).toBeGreaterThan(0);
    // Centros en mitades (x+0.5): el borde pica en 60/61 → 59.5, 60.5, 61.5.
    for (let i = 0; i < n; i++) {
      expect(Math.abs(segs[i * 5] - 60.5)).toBeLessThanOrEqual(1);
      expect(segs[i * 5 + 2]).toBe(90); // tangente al borde vertical
      expect(segs[i * 5 + 4]).toBe(0); // negro empaquetado
    }
  });

  it("imagen plana → ningún segmento", () => {
    const img = makeImageData(60, 60, () => [120, 120, 120]);
    expect(generateSegments(img, PARAMS_BORDES)).toHaveLength(0);
  });

  it("determinista SIN seed: dos corridas idénticas y seeds distintas no cambian nada", () => {
    const img = makeImageData(120, 90, (x) => (x <= 60 ? [0, 0, 0] : [255, 255, 255]));
    const a = generateSegments(img, PARAMS_BORDES);
    const b = generateSegments(img, { ...PARAMS_BORDES, seed: 999 });
    expect(a).toEqual(b); // el modo 'bordes' ignora la seed
  });

  it("longitud ∝ fuerza del borde: el borde fuerte da len = maxLength", () => {
    // escalón fuerte en 60/61 (m = 1) y rampa suave en 76..80 (m < 1)
    const img = makeImageData(120, 90, (x) => {
      const v =
        x <= 60 ? 0 : x <= 75 ? 255 : x <= 80 ? Math.round(((80 - x) / 4) * 255) : 0;
      return [v, v, v];
    });
    const segs = generateSegments(img, { ...PARAMS_BORDES, maxLength: 10 });
    const lenAt = (centerX: number) => {
      for (let i = 0; i < segs.length; i += 5) {
        if (Math.abs(segs[i] - centerX) <= 0.6 && Math.abs(segs[i + 1] - 45.5) <= 0.6) {
          return segs[i + 3];
        }
      }
      return null;
    };
    expect(lenAt(60.5)).toBe(10); // borde fuerte: m = 1 → maxLength
    const soft = lenAt(78.5);
    expect(soft).not.toBeNull();
    expect(soft!).toBeLessThan(10); // el blando se acorta
    expect(soft!).toBeGreaterThanOrEqual(4); // suelo de la fórmula
  });

  it("el umbral filtra los bordes débiles", () => {
    const img = makeImageData(120, 90, (x) => {
      const v =
        x <= 60 ? 0 : x <= 75 ? 255 : x <= 80 ? Math.round(((80 - x) / 4) * 255) : 0;
      return [v, v, v];
    });
    const conBajo = generateSegments(img, { ...PARAMS_BORDES, umbral: 0.15 });
    const conAlto = generateSegments(img, { ...PARAMS_BORDES, umbral: 0.6 });
    expect(segmentCount(conBajo)).toBeGreaterThan(segmentCount(conAlto));
    expect(segmentCount(conAlto)).toBeGreaterThan(0); // el fuerte sigue
  });
});
