/**
 * Núcleo del conversor puntillista (DISENO.md §2.3, CON promedio de celda).
 * Función pura: ImageData + params → array plano de puntos.
 * Determinista: usa mulberry32 con params.seed (reproducibilidad).
 */

import { mulberry32 } from "./prng";
import { packRGB, roundRadius } from "./format";

export interface GenerateParams {
  /** Separación de la rejilla en px. */
  step: number;
  /** Radio máximo base. */
  maxRadius: number;
  /** Escala global del radio. */
  multiplicador: number;
  /** Semilla del PRNG. */
  seed: number;
  /**
   * PRNG opcional (inyección para tests). Si se omite, se usa
   * mulberry32(seed) — comportamiento de producción reproducible.
   */
  random?: () => number;
}

export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Promedia los píxeles de la celda [x0, x1) × [y0, y1) en RGB.
 * Mejora sobre el conversor Python original, que muestreaba solo la esquina.
 */
function averageCell(
  img: ImageDataLike,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const { data, width } = img;
  const count = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
  }
  return [r / count, g / count, b / count];
}

/**
 * Genera el array plano de puntos [x, y, r, rgb, ...] en orden de barrido
 * (fila a fila de la rejilla).
 *
 * Algoritmo por celda (heredado de puntillismo_svg):
 *   brightness = (r + g + b) / 3            (promedio de celda)
 *   prob       = 1 - brightness / 255       → punto si prng() < prob
 *   radius     = multiplicador * (1 + (1 - brightness/255) * (maxRadius - 1))
 */
export function generatePoints(
  img: ImageDataLike,
  params: GenerateParams
): number[] {
  const step = Math.max(1, Math.floor(params.step));
  const prng = params.random ?? mulberry32(params.seed);
  const points: number[] = [];

  for (let y = 0; y < img.height; y += step) {
    const y1 = Math.min(y + step, img.height);
    for (let x = 0; x < img.width; x += step) {
      const x1 = Math.min(x + step, img.width);
      const [r, g, b] = averageCell(img, x, y, x1, y1);

      const brightness = (r + g + b) / 3;
      const darkness = 1 - brightness / 255;

      if (prng() >= darkness) continue; // umbral probabilístico

      const radius = roundRadius(
        params.multiplicador * (1 + darkness * (params.maxRadius - 1))
      );
      points.push(x, y, radius, packRGB(
        Math.round(r),
        Math.round(g),
        Math.round(b)
      ));
    }
  }
  return points;
}

/** Número de puntos almacenados en un array plano. */
export function pointCount(points: number[]): number {
  return points.length / 4;
}
