import { describe, it, expect } from "vitest";
import { generatePoints, pointCount, type ImageDataLike } from "./core";
import { unpackRGB } from "./format";

/** Construye un ImageDataLike de prueba a partir de un fill(x, y) → [r, g, b]. */
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

const PARAMS = { step: 4, maxRadius: 4, multiplicador: 3, seed: 42 };
/** PRNG inyectado: siempre acepta (darkness ≤ 1 > 0). Tests deterministas. */
const ALWAYS: () => number = () => 0;

describe("generatePoints", () => {
  it("imagen completamente negra → todos los puntos, radio máximo (MULT*MAX_RADIUS)", () => {
    const img = makeImageData(16, 16, () => [0, 0, 0]);
    const points = generatePoints(img, PARAMS);
    const n = pointCount(points);
    expect(n).toBe((16 / 4) * (16 / 4)); // rejilla completa 4×4
    for (let i = 0; i < n; i++) {
      expect(points[i * 4 + 2]).toBe(12); // 3 * (1 + 1*(4-1)) = 12
      expect(points[i * 4 + 3]).toBe(0); // rgb(0,0,0)
    }
  });

  it("imagen completamente blanca → ningún punto (prob = 0)", () => {
    const img = makeImageData(32, 32, () => [255, 255, 255]);
    const points = generatePoints(img, PARAMS);
    expect(pointCount(points)).toBe(0);
  });

  it("reproducibilidad: mismo seed → array idéntico", () => {
    const img = makeImageData(32, 32, (x, y) => [
      (x * 7 + y * 13) % 256,
      (x * 3 + y * 5) % 256,
      (x * 11 + y * 2) % 256,
    ]);
    const a = generatePoints(img, PARAMS);
    const b = generatePoints(img, PARAMS);
    expect(a).toEqual(b);
  });

  it("seed distinto → array distinto (imagen mixta)", () => {
    const img = makeImageData(32, 32, (x, y) => [
      (x * 31 + y * 17) % 256,
      (x * 7 + y * 3) % 256,
      128,
    ]);
    const a = generatePoints(img, { ...PARAMS, seed: 1 });
    const b = generatePoints(img, { ...PARAMS, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("radio redondeado a 1 decimal: gris 94 → darkness 161/255 → r = 8.7", () => {
    // brightness=94 → darkness = 161/255 ≈ 0.6314 → r = 3*(1+0.6314*3) ≈ 8.682 → 8.7
    const img = makeImageData(8, 8, () => [94, 94, 94]);
    const points = generatePoints(img, { ...PARAMS, random: ALWAYS });
    const n = pointCount(points);
    expect(n).toBe(4); // 2×2 celdas, aceptación forzada
    for (let i = 0; i < n; i++) {
      const r = points[i * 4 + 2];
      expect(Math.round(r * 10) / 10).toBe(r); // invariante: exactamente 1 decimal
      expect(r).toBe(8.7);
    }
  });

  it("radio nunca excede multiplicador * maxRadius ni baja de multiplicador", () => {
    const img = makeImageData(48, 48, (x, y) => [
      (x * y) % 256,
      (x + y) % 256,
      (x * x + y) % 256,
    ]);
    const points = generatePoints(img, { ...PARAMS, random: ALWAYS });
    const n = pointCount(points);
    expect(n).toBe(144); // (48/4)^2, aceptación forzada
    for (let i = 0; i < n; i++) {
      const r = points[i * 4 + 2];
      expect(r).toBeLessThanOrEqual(PARAMS.multiplicador * PARAMS.maxRadius);
      expect(r).toBeGreaterThanOrEqual(PARAMS.multiplicador);
    }
  });

  it("promedia la celda (no la esquina): celda mitad negra mitad blanca → gris 128, r=7.5", () => {
    // step=2: cada celda tiene un píxel negro y uno blanco → avg = 127.5
    // darkness = 0.5 → r = 3*(1+0.5*3) = 7.5
    const img = makeImageData(4, 2, (x) => (x % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
    const points = generatePoints(img, { step: 2, maxRadius: 4, multiplicador: 3, seed: 42, random: ALWAYS });
    const n = pointCount(points);
    expect(n).toBe(2); // 2 celdas de 2×1 (alto=2, step=2 → 1 fila)
    for (let i = 0; i < n; i++) {
      expect(points[i * 4 + 2]).toBe(7.5); // radio de gris medio, ni 12 (negro) ni 3 (blanco)
      const [r, g, b] = unpackRGB(points[i * 4 + 3]);
      expect([r, g, b]).toEqual([128, 128, 128]); // 127.5 → redondeo
    }
  });

  it("celdas parciales en el borde derecho/inferior usan el recorte correcto", () => {
    // 6px de ancho con step=4 → celdas x=0..3 y x=4..5 (parcial)
    const img = makeImageData(6, 6, () => [0, 0, 0]);
    const points = generatePoints(img, PARAMS);
    const n = pointCount(points);
    expect(n).toBe(4); // 2×2 celdas, todas negras → todas pasan
    const xs = [points[0], points[4], points[8], points[12]];
    expect(xs).toContain(4); // la celda parcial del borde existe y su x es 4
  });

  it("los puntos salen en orden de barrido (fila a fila)", () => {
    const img = makeImageData(16, 16, () => [0, 0, 0]);
    const points = generatePoints(img, PARAMS);
    const n = pointCount(points);
    let prevY = -1;
    let prevX = -1;
    for (let i = 0; i < n; i++) {
      const x = points[i * 4];
      const y = points[i * 4 + 1];
      expect(y).toBeGreaterThanOrEqual(prevY);
      if (y === prevY) expect(x).toBeGreaterThan(prevX);
      prevY = y;
      prevX = x;
    }
  });

  it("el color almacenado es el promedio de celda redondeado", () => {
    const img = makeImageData(8, 8, () => [200, 100, 50]);
    const points = generatePoints(img, { ...PARAMS, random: ALWAYS });
    expect(pointCount(points)).toBe(4);
    const [r, g, b] = unpackRGB(points[3]);
    expect([r, g, b]).toEqual([200, 100, 50]);
  });

  it("step <= 0 se corrige a 1 (no bucle infinito)", () => {
    const img = makeImageData(4, 4, () => [0, 0, 0]);
    const points = generatePoints(img, { ...PARAMS, step: 0 });
    expect(pointCount(points)).toBe(16); // 4×4 celdas de 1px
  });
});
