import { describe, it, expect } from "vitest";
import {
  assignToPalette,
  detectBackgroundColor,
  douglasPeucker,
  extractContours,
  generatePosterized,
  histogramPalette,
  kmeansPalette,
  luminance,
  majorityFilter,
  nearestLayerIndex,
  reducePalette,
  renderRaster,
  samplePixels,
  serializeLayerPath,
  posterizeImage,
  traceLayers,
  type ImageDataLike,
} from "./posterize";
import { POSTERIZED_BANDS } from "./format";

function makeImage(width: number, height: number, colors: Array<[number, number, number]>): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colors[Math.floor((x / width) * colors.length) % colors.length];
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Máscara → cuadrícula de índices (capa 0 donde mask, −1 fuera) + márgenes uniformes. */
function gridFromMask(mask: number[][], width: number, height: number) {
  const idx = new Int8Array(width * height).fill(-1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (mask[y][x]) idx[y * width + x] = 0;
  const margins = new Float32Array(width * height).fill(1);
  return { idx, margins };
}

/** Ángulo interno (radianes) del vértice i de un anillo cerrado. */
function interiorAngle(ring: Array<[number, number]>, i: number): number {
  const n = ring.length;
  const [px, py] = ring[(i - 1 + n) % n];
  const [cx, cy] = ring[i];
  const [nx, ny] = ring[(i + 1) % n];
  const v1x = px - cx, v1y = py - cy;
  const v2x = nx - cx, v2y = ny - cy;
  const dot = v1x * v2x + v1y * v2y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (m === 0) return Math.PI;
  return Math.acos(Math.min(1, Math.max(-1, dot / m)));
}

function minInteriorAngle(ring: Array<[number, number]>): number {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) min = Math.min(min, interiorAngle(ring, i));
  return min;
}

const box = (from: number, to: number, size: number) =>
  Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => (x >= from && x <= to && y >= from && y <= to ? 1 : 0))
  );

// ─────────────────────────────────────────────────────────────────────────
// PUERTA GEOMÉTRICA (spec: si estos tests fallan, no se continúa)
// ─────────────────────────────────────────────────────────────────────────

describe("GEOMETRÍA · rectángulo negro sobre blanco", () => {
  it("→ 1 contorno con 4 vértices exactos tras DP", () => {
    const { idx, margins } = gridFromMask(box(4, 11, 16), 16, 16);
    const contours = extractContours(idx, margins, 16, 16, 0, 1);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(4);
    const verts = new Set(contours[0].map(([x, y]) => `${x},${y}`));
    expect(verts).toEqual(new Set(["3.5,3.5", "11.5,3.5", "11.5,11.5", "3.5,11.5"]));
  });
});

describe("GEOMETRÍA · círculo sin púas", () => {
  it("→ polígono suave: ningún ángulo interno < 60°", () => {
    const size = 80;
    const cx = 40, cy = 40, r = 28;
    const mask = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) =>
        (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 1 : 0
      )
    );
    const { idx, margins } = gridFromMask(mask, size, size);
    const contours = extractContours(idx, margins, size, size, 0, 4);
    expect(contours.length).toBeGreaterThanOrEqual(1);
    const ring = contours.reduce((a, b) => (b.length > a.length ? b : a));
    const minAngle = (minInteriorAngle(ring) * 180) / Math.PI;
    console.log(`  círculo: ${ring.length} vértices, ángulo interno mínimo ${minAngle.toFixed(1)}°`);
    expect(ring.length).toBeGreaterThanOrEqual(8); // suficientes vértices para la curva
    expect(minAngle).toBeGreaterThanOrEqual(60);
  });
});

describe("GEOMETRÍA · dos regiones separadas", () => {
  it("→ 2 subpaths independientes", () => {
    const mask = Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 24 }, (_, x) =>
        ((x >= 2 && x <= 9 && y >= 2 && y <= 9) || (x >= 14 && x <= 21 && y >= 14 && y <= 21)) ? 1 : 0
      )
    );
    const { idx, margins } = gridFromMask(mask, 24, 24);
    const contours = extractContours(idx, margins, 24, 24, 0, 1);
    expect(contours).toHaveLength(2);
    const areas = contours.map((c) => Math.abs(c.reduce((s, [x0, y0], i) => {
      const [x1, y1] = c[(i + 1) % c.length];
      return s + x0 * y1 - x1 * y0;
    }, 0)) / 2);
    for (const a of areas) expect(a).toBeCloseTo(64, 0); // 8×8 cada una
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Filtro mayoritario (elimina islas de 1 px, origen de púas)
// ─────────────────────────────────────────────────────────────────────────

describe("majorityFilter 3×3", () => {
  it("elimina una isla de 1 píxel", () => {
    const w = 10, h = 10;
    const idx = new Int8Array(w * h); // todo capa 0
    idx[4 * w + 4] = 1; // isla de 1 px de capa 1
    const out = majorityFilter(idx, w, h, 2);
    expect(out[4 * w + 4]).toBe(0);
    expect(out[0]).toBe(0); // regiones planas intactas
  });

  it("conserva un bloque sólido de 3×3 aunque su capa sea minoritaria global", () => {
    const w = 9, h = 9;
    const idx = new Int8Array(w * h).fill(0);
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) idx[y * w + x] = 1;
    const out = majorityFilter(idx, w, h, 2);
    expect(out[4 * w + 4]).toBe(1); // el centro tiene 9/9 vecinos de capa 1
    expect(out[0]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pipeline completo (posterizar + trazar)
// ─────────────────────────────────────────────────────────────────────────

describe("posterizeImage + traceLayers", () => {
  const img = makeImage(64, 64, [
    [20, 20, 30],
    [60, 50, 40],
    [200, 190, 170],
    [245, 245, 240],
  ]);

  it("posterizeImage es determinista y sin parámetros de color", () => {
    const a = posterizeImage(img);
    const b = posterizeImage(img);
    expect([...a.idx]).toEqual([...b.idx]);
    expect(a.palette).toEqual(b.palette);
  });

  it("traceLayers solo depende de minRegion y produce paths válidos", () => {
    const trace = posterizeImage(img);
    const traced = traceLayers(trace, 12);
    expect(traced).toHaveLength(4);
    for (const t of traced) {
      expect(typeof t.path).toBe("string");
      expect(t.path.length).toBeGreaterThan(0);
      expect(t.path.startsWith("M")).toBe(true);
    }
    // minRegion mayor → menos o igual contornos.
    const more = traceLayers(trace, 0).reduce((n, t) => n + (t.path.match(/M/g) ?? []).length, 0);
    const less = traceLayers(trace, 100).reduce((n, t) => n + (t.path.match(/M/g) ?? []).length, 0);
    expect(less).toBeLessThanOrEqual(more);
  });

  it("generatePosterized: 4 capas ordenadas por luminancia, bandas fijas, color=palette", () => {
    const layers = generatePosterized(img, 4);
    expect(layers).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(layers[i].band).toEqual([POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]]);
      expect(layers[i].color).toEqual(layers[i].palette);
    }
    for (let i = 1; i < 4; i++) {
      expect(luminance(...layers[i].palette)).toBeGreaterThanOrEqual(
        luminance(...layers[i - 1].palette)
      );
    }
  });

  it("k-means determinista y centroides coherentes", () => {
    const samples = Array.from({ length: 4000 }, (_, i) => {
      const c: [number, number, number] = i % 2 === 0 ? [10, 10, 12] : [240, 238, 235];
      return [c[0] + (i % 7), c[1] + (i % 5), c[2] + (i % 3)] as [number, number, number];
    });
    const p1 = kmeansPalette(samples);
    expect(p1).toEqual(kmeansPalette(samples));
    const big = makeImage(300, 300, [[10, 20, 30], [200, 190, 180], [50, 60, 70], [250, 250, 250]]);
    expect(samplePixels(big).length).toBeGreaterThan(20000);
  });

  it("nearestLayerIndex asigna todo color a una capa válida", () => {
    const palette = [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]] as const;
    for (let v = 0; v <= 255; v += 3) {
      const i = nearestLayerIndex(palette, v, v, v);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(4);
    }
  });

  it("Douglas-Peucker: línea colineal con ruido → 2 puntos; umbral por defecto 0.6", () => {
    const pts: Array<[number, number]> = [[0, 0], [1, 0.1], [2, -0.1], [3, 0], [4, 0]];
    expect(douglasPeucker(pts, 0.5)).toEqual([[0, 0], [4, 0]]);
    expect(douglasPeucker(pts)).toEqual([[0, 0], [4, 0]]); // ε 0.6 por defecto
  });

  it("serialización: subtrayectos M…Z por contorno", () => {
    const path = serializeLayerPath([[[0, 0], [4, 0], [4, 4]], [[10, 10], [12, 10], [12, 12]]]);
    expect(path).toBe("M0,0 L4,0 L4,4 Z M10,10 L12,10 L12,12 Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Selección de paleta 6→4 (P2 2026-09-23): top-6 del histograma + fusión
// iterativa del par más cercano hasta 4. Determinista, sin azar.
// ─────────────────────────────────────────────────────────────────────────

describe("reducePalette (fusión del par más cercano)", () => {
  it("el superviviente del par es el candidato MÁS FRECUENTE (su color no se altera)", () => {
    const r = reducePalette(
      [[10, 10, 10], [12, 12, 12], [200, 200, 200]],
      2,
      [1, 100, 1]
    );
    // par más cercano: (10,10,10)–(12,12,12) (d²=12); gana (12,12,12) aunque
    // vaya segundo: es el más frecuente. El absorbido queda en `merged`.
    expect(r.palette).toEqual([[12, 12, 12], [200, 200, 200]]);
    expect(r.merged).toEqual([[10, 10, 10]]);
  });

  it("es determinista: misma entrada → misma paleta y mismos fusionados (en orden)", () => {
    const candidates: Array<[number, number, number]> = [
      [0, 0, 0], [36, 36, 36], [255, 255, 255], [219, 219, 219],
      [146, 73, 36], [182, 146, 109],
    ];
    const counts = [20, 19, 18, 17, 16, 15];
    const a = reducePalette(candidates, 4, counts);
    const b = reducePalette(candidates, 4, counts);
    expect(a.palette).toEqual(b.palette);
    expect(a.merged).toEqual(b.merged);
    // Los dos pares más cercanos son los extremos (d² 3888 y 4107): se
    // funden; los dos marrones del medio (d² 11954 entre ellos) sobreviven.
    expect(a.merged).toEqual([[36, 36, 36], [219, 219, 219]]);
    expect(a.palette).toEqual([[0, 0, 0], [255, 255, 255], [146, 73, 36], [182, 146, 109]]);
  });

  it("con menos candidatos que target no fusiona nada", () => {
    const r = reducePalette([[1, 2, 3], [4, 5, 6]], 4, [1, 1]);
    expect(r.palette).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(r.merged).toEqual([]);
  });
});

describe("selección 6→4 · foto oscura con dos marrones distintos", () => {
  // Franjas verticales en la retícula exacta {0,36,73,109,146,182,219,255},
  // con frecuencias decrecientes: los 4 más frecuentes son dos negros y dos
  // blancos; los DOS MARRONES DISTINTOS quedan en los puestos 5 y 6 → con el
  // antiguo recorte top-4 por frecuencia CAÍAN AMBOS; con 6 candidatos +
  // fusión del par más cercano sobreviven (era el defecto de las fotos
  // oscuras: paleta ganadora casi monocromática).
  const STRIPES: Array<{ c: [number, number, number]; w: number }> = [
    { c: [0, 0, 0], w: 20 },        // negro        (1º)
    { c: [36, 36, 36], w: 19 },     // gris oscuro  (2º)
    { c: [255, 255, 255], w: 18 },  // blanco       (3º)
    { c: [219, 219, 219], w: 17 },  // gris claro   (4º)
    { c: [146, 73, 36], w: 16 },    // marrón       (5º)
    { c: [182, 146, 109], w: 15 },  // marrón claro (6º)
  ];
  const W = STRIPES.reduce((s, t) => s + t.w, 0); // 105
  const H = 4;

  function darkPhoto(): ImageDataLike {
    const data = new Uint8ClampedArray(W * H * 4);
    let x0 = 0;
    for (const s of STRIPES) {
      for (let y = 0; y < H; y++) {
        for (let x = x0; x < x0 + s.w; x++) {
          const o = (y * W + x) * 4;
          data[o] = s.c[0];
          data[o + 1] = s.c[1];
          data[o + 2] = s.c[2];
          data[o + 3] = 255;
        }
      }
      x0 += s.w;
    }
    return { width: W, height: H, data };
  }

  it("ambos marrones sobreviven y los fusionados son los pares más cercanos", () => {
    const trace = posterizeImage(darkPhoto());
    expect(trace.palette).toHaveLength(4);
    expect(trace.palette).toEqual([
      [0, 0, 0],
      [255, 255, 255],
      [146, 73, 36], // marrón
      [182, 146, 109], // marrón claro
    ]);
    expect(trace.merged).toEqual([
      [36, 36, 36],
      [219, 219, 219],
    ]);
  });

  it("con el recorte antiguo (top-4 por frecuencia) los dos marrones caían", () => {
    // Documenta la regresión: top-4 puro = los cuatro más frecuentes,
    // sin marrón ninguno.
    expect(histogramPalette(darkPhoto(), 4)).toEqual([
      [0, 0, 0],
      [36, 36, 36],
      [255, 255, 255],
      [219, 219, 219],
    ]);
  });

  it("los píxeles de los fusionados se reasignan al superviviente más cercano", () => {
    const trace = posterizeImage(darkPhoto());
    const idxAt = (x: number, y = 1) => trace.idx[y * W + x];
    // gris oscuro (x=25, fundido) → negro; gris claro (x=65, fundido) → blanco
    expect(trace.palette[idxAt(25)]).toEqual([0, 0, 0]);
    expect(trace.palette[idxAt(65)]).toEqual([255, 255, 255]);
    // los marrones se mapean a SUS colores (no colapsan entre sí)
    expect(trace.palette[idxAt(80)]).toEqual([146, 73, 36]);
    expect(trace.palette[idxAt(100)]).toEqual([182, 146, 109]);
  });

  it("es determinista: dos corridas → misma paleta y mismos índices", () => {
    const a = posterizeImage(darkPhoto());
    const b = posterizeImage(darkPhoto());
    expect(a.palette).toEqual(b.palette);
    expect(a.merged).toEqual(b.merged);
    expect([...a.idx]).toEqual([...b.idx]);
  });
});

describe("selección 6→4 · caso normal (regresión)", () => {
  it("4 colores dominantes reales: la paleta no cambia (los de relleno se funden)", () => {
    // Misma imagen del test del histograma: 4 bloques con ruido ±6.
    const w = 80, h = 80;
    const data = new Uint8ClampedArray(w * h * 4);
    const blocks: Array<[number, number, number]> = [
      [40, 40, 50], [160, 60, 50], [60, 150, 60], [230, 225, 210],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = blocks[Math.floor(x / 20) % 4];
        const o = (y * w + x) * 4;
        data[o] = b[0] + ((x * 7 + y * 13) % 13) - 6;
        data[o + 1] = b[1] + ((x * 5 + y * 11) % 13) - 6;
        data[o + 2] = b[2] + ((x * 3 + y * 17) % 13) - 6;
        data[o + 3] = 255;
      }
    }
    const trace = posterizeImage({ width: w, height: h, data });
    // Mismos 4 colores reales, sin más (el ruido ±6 desempata frecuencias,
    // así que el ORDEN (frecuencia↓) no se fija: comparamos como conjunto).
    const asSet = (cs: Array<readonly number[]>) =>
      cs.map((c) => c.join(",")).sort();
    expect(asSet(trace.palette)).toEqual(
      asSet([[36, 36, 36], [73, 146, 73], [146, 73, 36], [219, 219, 219]])
    );
    // los 2 fusionados son los colores de relleno (frecuencia 0), no reales
    expect(trace.merged).toHaveLength(2);
    for (const m of trace.merged ?? []) {
      expect(trace.palette.some((p) => p[0] === m[0] && p[1] === m[1] && p[2] === m[2])).toBe(false);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// F2 (2026-10-11) — quitar fondo
// ─────────────────────────────────────────────────────────────────────────

function solidImage(
  width: number,
  height: number,
  color: [number, number, number],
  paint?: (x: number, y: number) => [number, number, number] | null
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = paint?.(x, y) ?? color;
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("F2 · quitar fondo (detección del color del anillo)", () => {
  it("anillo de borde dominante (blanco) aunque el interior sea de otro color", () => {
    const img = solidImage(16, 16, [255, 255, 255], (x, y) =>
      x > 2 && x < 13 && y > 2 && y < 13 ? [200, 30, 30] : null
    );
    expect(detectBackgroundColor(img)).toEqual([255, 255, 255]);
  });

  it("imagen uniforme → ese color (snapado a la retícula); imagen <3×3 → null (sin anillo fiable)", () => {
    // [12,34,56] snapa a [0,36,73]: el detector devuelve el color en la
    // retícula, el mismo espacio en el que se comparan los candidatos.
    expect(detectBackgroundColor(solidImage(8, 8, [12, 34, 56]))).toEqual([0, 36, 73]);
    expect(detectBackgroundColor(solidImage(8, 8, [255, 255, 255]))).toEqual([255, 255, 255]);
    expect(detectBackgroundColor(solidImage(2, 10, [255, 255, 255]))).toBeNull();
  });

  it("ruido leve en el borde sigue dando el color dominante (snap a la retícula)", () => {
    const img = solidImage(20, 20, [255, 255, 255]);
    const o1 = (1 * 20 + 1) * 4;
    img.data[o1] = 250; img.data[o1 + 1] = 252; img.data[o1 + 2] = 249;
    const o2 = (18 * 20 + 18) * 4;
    img.data[o2] = 240; img.data[o2 + 1] = 245; img.data[o2 + 2] = 235;
    expect(detectBackgroundColor(img)).toEqual([255, 255, 255]);
  });
});

describe("F2 · quitar fondo (posterizar)", () => {
  /** 40×40: anillo blanco de 1 px + interior a bandas de 4 colores reales. */
  function portraitWithWhiteBg(): ImageDataLike {
    return solidImage(40, 40, [255, 255, 255], (x, y) => {
      if (x === 0 || y === 0 || x === 39 || y === 39) return null; // anillo blanco
      if (x < 12) return [200, 30, 30];
      if (x < 22) return [30, 160, 60];
      if (x < 32) return [40, 60, 180];
      return [20, 20, 20];
    });
  }

  it("con removeBackground: el blanco NO está en la paleta, los bordes quedan SIN capa (−1) y hay 4 capas", () => {
    const trace = posterizeImage(portraitWithWhiteBg(), { removeBackground: true });
    expect(trace.background).toEqual([255, 255, 255]);
    expect(trace.backgroundExcluded).toBe(true);
    expect(trace.palette).toHaveLength(4);
    expect(trace.palette.some((c) => c[0] === 255 && c[1] === 255 && c[2] === 255)).toBe(false);
    // esquinas = anillo blanco → sin capa (transparentes en la pieza)
    expect(trace.idx[0]).toBe(-1);
    expect(trace.idx[39]).toBe(-1);
    expect(trace.idx[39 * 40]).toBe(-1);
    expect(trace.idx[39 * 40 + 39]).toBe(-1);
    // interior coloreado → capa válida
    expect(trace.idx[20 * 40 + 5]).toBeGreaterThanOrEqual(0);
    // trazado: SIGUE habiendo exactamente 4 capas (ninguna es el fondo)
    const layers = traceLayers(trace, 4);
    expect(layers).toHaveLength(4);
  });

  it("sin removeBackground (default OFF): el blanco entra en la paleta y los bordes tienen capa", () => {
    const trace = posterizeImage(portraitWithWhiteBg());
    expect(trace.backgroundExcluded).toBeUndefined();
    expect(trace.palette.some((c) => c[0] === 255 && c[1] === 255 && c[2] === 255)).toBe(true);
    expect(trace.idx[0]).toBeGreaterThanOrEqual(0);
  });

  it("toggle OFF == comportamiento actual (misma paleta e mismos índices que sin la opción)", () => {
    const a = posterizeImage(portraitWithWhiteBg());
    const b = posterizeImage(portraitWithWhiteBg(), { removeBackground: false });
    expect(b.palette).toEqual(a.palette);
    expect(Array.from(b.idx)).toEqual(Array.from(a.idx));
  });

  it("si el color del borde NO está entre los candidatos, el toggle no tiene efecto visible", () => {
    // Interior con 6 colores frecuentes; anillo de 1 px de un 7º color raro.
    const colors: Array<[number, number, number]> = [
      [200, 30, 30], [30, 160, 60], [40, 60, 180],
      [220, 200, 90], [120, 40, 160], [20, 20, 20],
    ];
    const img = solidImage(48, 48, [90, 200, 200], (x, y) => {
      if (x === 0 || y === 0 || x === 47 || y === 47) return null; // anillo cyan raro
      return colors[Math.min(5, Math.floor(x / 8))];
    });
    const off = posterizeImage(img);
    const on = posterizeImage(img, { removeBackground: true });
    expect(on.background).toEqual([73, 182, 182]); // cyan snapado a la retícula
    expect(on.backgroundExcluded).toBeUndefined(); // no era candidato: sin efecto
    expect(on.palette).toEqual(off.palette);
    expect(Array.from(on.idx)).toEqual(Array.from(off.idx));
  });

  it("assignToPalette con background: el píxel más cerca del fondo que de su paleta → −1 (empate se queda coloreado)", () => {
    const palette: Array<[number, number, number]> = [
      [255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0],
    ];
    // 1×3: blanco puro / rojo exacto / cyan (0,255,255): equidistante a
    // fondo y a azul/verde → con la regla estricta (<) se queda COLOREADO.
    const img: ImageDataLike = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([
        255, 255, 255, 255,
        255, 0, 0, 255,
        0, 255, 255, 255,
      ]),
    };
    const t = assignToPalette(img, palette, { background: [255, 255, 255] });
    expect(t.idx[0]).toBe(-1); // puro fondo
    expect(t.idx[1]).toBe(0); // rojo exacto
    expect(t.idx[2]).toBe(1); // empate → coloreado, en su capa más cercana (azul)
    expect(t.background).toEqual([255, 255, 255]);
    expect(t.backgroundExcluded).toBe(true);
  });

  it("renderRaster aplana los píxeles sin capa al color de fondo (el JPEG no tiene alfa)", () => {
    const trace = posterizeImage(portraitWithWhiteBg(), { removeBackground: true });
    const raster = renderRaster(trace);
    expect([raster.data[0], raster.data[1], raster.data[2]]).toEqual([255, 255, 255]);
    expect(raster.data[3]).toBe(255); // opaco (aplanado, no transparente)
  });

  it("majorityFilter: una capa NUNCA se voltea a fondo; un fondo interior con ≥5 vecinos de capa se vuelve capa", () => {
    // 5×5: brazos de capa 0 en cruz sobre fondo −1; el centro (12) queda
    // fondo: solo 4 vecinos de capa (< 5) → el filtro no cambia nada.
    const idx = new Int8Array(25).fill(-1);
    for (const p of [7, 11, 13, 17]) idx[p] = 0;
    const out = majorityFilter(idx, 5, 5);
    expect(Array.from(out)).toEqual(Array.from(idx));
    // Rodeamos el centro por las diagonales: 8 vecinos de capa → fondo pasa a capa
    const idx2 = new Int8Array(idx);
    for (const p of [6, 8, 16, 18]) idx2[p] = 0;
    const out2 = majorityFilter(idx2, 5, 5);
    expect(out2[12]).toBe(0);
  });
});
