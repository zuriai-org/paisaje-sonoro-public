import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "path";
import {
  posterizeImage,
  traceLayerMasks,
  traceLayers,
  removeSpikes,
  interiorAngleDeg,
  scaleAndFilterRings,
  type ImageDataLike,
} from "./posterize";
import { validateLayerPath, parsePathRings } from "./traceInvariant";

/**
 * INVARIANTE DEL TRAZADOR (test de propiedad permanente, re-baseline 2026-09-23;
 * fixtures sustituidas por sintéticas el 2026-10-12, higiene pre-entrega).
 *
 * El raster puede estar limpio y el SVG tener saltos: los bugs del trazador
 * encontrados por el debug forense del 2026-09-23 fueron
 *  (1) snapChamfers: dos chamfers solapados emitían el vértice esquina DOS
 *      VECES (duplicado consecutivo en el path);
 *  (2) removeSpikes por ángulo puro cortaba uniones contenido↔marco
 *      (ángulos de ~5° genuinos) y la cascada acababa exportando cuerdas a
 *      hasta ~13 px de la frontera real.
 * Arreglados en posterize.ts (skip de solapados + tope de desviación por
 * eliminación). Este test fija el invariante geométrico definitivo:
 *
 *   todo vértice y todo punto de todo segmento del path debe estar a ≤ 2.5 px
 *   (distancia perpendicular real a la curva de frontera de la máscara que
 *   el trazador trazó, con el marco padBackground como frontera válida).
 *
 * Estándar permanente del proyecto: 0 violaciones en las 4 capas de las 3
 * fixtures sintéticas de geometría de borde nítido (`__fixtures__/synth-*`,
 * generadas por `__fixtures__/generate.mjs`; directo y por pipeline JPEG,
 * ver scripts/check-invariant.ts).
 */

const FIXTURES_DIR = path.join(__dirname, "__fixtures__");
const MIN_REGION = 12;
/** Tolerancia del invariante (px): 2.5. DP ε 0.6 en rejilla 0.5× ≈ 1.2 px
 *  reales de cuerda; el tope de desviación de púas añade hasta 2.5 px. */
const TOL = 2.5;

interface SyntheticFixture {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function loadFixture(file: string, width: number, height: number): SyntheticFixture {
  const data = new Uint8ClampedArray(fs.readFileSync(path.join(FIXTURES_DIR, file)));
  return { name: file, width, height, data };
}

const PHOTOS: SyntheticFixture[] = [
  loadFixture("synth-shapes-414x360.rgba", 414, 360),
  loadFixture("synth-blocks-360x360.rgba", 360, 360),
  loadFixture("synth-step-360x360.rgba", 360, 360),
];

describe("INVARIANTE del trazador en fixtures sintéticas", () => {
  for (const photo of PHOTOS) {
    it(`${photo.name}: 0 violaciones (tol ${TOL} px) en las 4 capas`, () => {
      const trace = posterizeImage({
        width: photo.width,
        height: photo.height,
        data: photo.data,
      });
      const layers = traceLayerMasks(trace, MIN_REGION);
      expect(layers).toHaveLength(4);
      let total = 0;
      const worst: number[] = [];
      for (const { layer, path, mask, width, height } of layers) {
        const violations = validateLayerPath(mask, width, height, path, {
          tolVertex: TOL,
          tolSegment: TOL,
        });
        total += violations.length;
        worst.push(
          violations.reduce((m, v) => Math.max(m, v.distance), 0)
        );
        if (violations.length > 0) {
          console.error(
            `capa ${layer}: ${violations.length} violaciones, p. ej.`,
            violations.slice(0, 3).map((v) => `${v.kind}@${v.point} d=${v.distance.toFixed(2)}`)
          );
        }
      }
      expect({ total, worst: worst.map((w) => +w.toFixed(2)) }).toEqual({
        total: 0,
        worst: worst.map(() => expect.any(Number)),
      });
    });
  }
});

describe("INVARIANTE · regresión del bug de bordes (cierre-Z a través de la región)", () => {
  it("franja en L que toca dos bordes: contorno cerrado por el marco, sin saltos", () => {
    // Franja negra de 6 px de ancho por el borde inferior y el izquierdo
    // (tocando la esquina). Antes del marco de fondo esto producía cadenas
    // abiertas con cierre-Z diagonal.
    const W = 40;
    const H = 36;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const on = y >= H - 6 || x < 6;
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = on ? 0 : 255;
        data[o + 3] = 255;
      }
    }
    const trace = posterizeImage({ width: W, height: H, data } as ImageDataLike);
    // Fijar la capa negra a un solo índice para una máscara conocida.
    const blackLayer = trace.palette.findIndex(
      (c) => c[0] + c[1] + c[2] < 100
    );
    expect(blackLayer).toBeGreaterThanOrEqual(0);
    const layers = traceLayerMasks(trace, MIN_REGION);
    const { mask, path, width, height } = layers[blackLayer];
    const violations = validateLayerPath(mask, width, height, path, {
      tolVertex: TOL,
      tolSegment: TOL,
    });
    expect(violations).toEqual([]);
    // El anillo cierra POR EL MARCO: contiene vértices en x o y = −0.5
    // (coordenadas del marco exterior) y no hay segmentos que crucen la
    // región (todos los segmentos largos pegados a la frontera).
    const rings = parsePathRings(path);
    expect(rings.length).toBeGreaterThanOrEqual(1);
    const all = rings.flat();
    expect(all.some(([x, y]) => x <= -0.4 || y <= -0.4 || x >= W - 0.4 || y >= H - 0.4)).toBe(true);
  });

  it("región interior sin tocar bordes: invariante intacto", () => {
    const W = 32;
    const H = 32;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
    const trace = posterizeImage({ width: W, height: H, data } as ImageDataLike);
    const blackLayer = trace.palette.findIndex((c) => c[0] + c[1] + c[2] < 100);
    const layers = traceLayerMasks(trace, MIN_REGION);
    const { mask, path, width, height } = layers[blackLayer];
    const violations = validateLayerPath(mask, width, height, path, {
      tolVertex: TOL,
      tolSegment: TOL,
    });
    expect(violations).toEqual([]);
  });
});

describe("removeSpikes converge (con tope de desviación) y la regla de triángulos aplica", () => {
  it("re-aplicar removeSpikes con las opciones de producción no cambia nada", () => {
    // Las capas exportadas ya pasaron por removeSpikes con tope de
    // desviación (1.25 en rejilla 0.5× = 2.5 px reales); re-aplicarlo con
    // las mismas opciones debe ser la identidad (convergencia real).
    for (const photo of PHOTOS) {
      const trace = posterizeImage({
        width: photo.width,
        height: photo.height,
        data: photo.data,
      });
      const traced = traceLayers(trace, MIN_REGION);
      for (const layer of traced) {
        for (const ring of parsePathRings(layer.path)) {
          const again = removeSpikes(ring, 60, 100, { maxDeviation: 2.5 });
          expect(again.length).toBe(ring.length);
          expect(again).toEqual(ring);
        }
      }
    }
  });

  it("regla de anillos de 3 vértices: aguja fuera; área < 2·minRegion fuera; polígono sano con área ≥ minRegion dentro", () => {
    // Aguja: ángulo < 60° → descarte.
    const spiky: Array<[number, number]> = [[0, 0], [10, 0], [0, 1]];
    expect(scaleAndFilterRings([spiky], false, 0)).toEqual([]);
    // Triángulo equilátero (los 3 ángulos miden 60.000000° en float) con
    // área 43.3 < 2·30 → descarte por la regla de área.
    const equilateral: Array<[number, number]> = [[0, 0], [10, 0], [5, 5 * Math.sqrt(3)]];
    for (let i = 0; i < 3; i++) {
      expect(interiorAngleDeg(equilateral, i)).toBeGreaterThanOrEqual(60);
    }
    expect(scaleAndFilterRings([equilateral], false, 30)).toEqual([]);
    // NOTA: el "keep" de un triángulo es inalcanzable en la práctica: tras
    // el round1 de coordenadas de scaleAndFilterRings ningún triángulo
    // conserva los 3 ángulos ≥ 60° (la altura equilátera es irracional y
    // redondea a <60 en un vértice). El camino de conservación se ejerce
    // con polígonos de ≥ 4 vértices.
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(scaleAndFilterRings([square], false, 12)).toHaveLength(1);
  });
});
