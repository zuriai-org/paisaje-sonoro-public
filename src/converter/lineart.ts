/**
 * Núcleo del conversor "Line Art" (LA-1, 2026-09-24) — hermano del
 * puntillista (core.ts): misma rejilla y mismo muestreo estocástico por
 * oscuridad con azar sembrado (mulberry32, seed reproducible), pero cada
 * celda aceptada emite un SEGMENTO en vez de un punto.
 *
 * Orientación: Sobel sobre luminancia → campo de gradientes; el ángulo del
 * trazo es la TANGENTE al borde (atan2(gy, gx) + 90°): las líneas SIGUEN los
 * contornos de la imagen, no los cruzan. Longitud ∝ oscuridad (trazos
 * largos en sombra, cortos en luz).
 *
 * MODO 'bordes' (LA-4, 2026-09-27): el estilo "grabado" que el usuario vio
 * en el Azimutal — sin muestreo estocástico ni color de celda: solo las
 * celdas con magnitud de borde Sobel ≥ umbral emiten, trazo NEGRO y
 * len = maxLength·(0.4 + 0.6·m) (la misma tinta del Azimutal, vista plana,
 * sin esfera). Determinista (sin seed). El campo de bordes vive AQUÍ (su
 * hogar natural, encima de sobelGradients); azimuthal.ts lo reutiliza.
 *
 * Trabaja sobre el ImageData ORIGINAL (como el puntillista): el muestreo
 * estocástico no es frágil ante artefactos de compresión, no hay JPEG
 * intermedio. El trazador de regiones del posterizado NO se usa aquí.
 */
import { mulberry32 } from "./prng";
import { packRGB } from "./format";
import type { ImageDataLike } from "./core";

/** Parámetros de generación Line Art (van al JSON en `params`). */
export type LineArtMode = "luz" | "bordes";

export interface LineArtParams {
  /** Separación de la rejilla en px. */
  step: number;
  /** Longitud máxima de trazo en px (la alcanzan las zonas en sombra). */
  maxLength: number;
  /** Grosor de trazo en px (lo usa el futuro render/player; no la generación). */
  strokeWidth: number;
  /** Semilla del PRNG (reproducibilidad del muestreo, solo modo 'luz'). */
  seed: number;
  /** Ratio de segmentos visibles en el reproductor. */
  maxVisibleRatio: number;
  /**
   * 'luz' (default): muestreo estocástico por oscuridad, color de celda.
   * 'bordes' (LA-4): grabado — solo bordes ≥ umbral, trazo negro,
   * len ∝ fuerza del borde. Determinista (sin seed).
   */
  mode?: LineArtMode;
  /** Magnitud de borde mínima en modo 'bordes' (0.05–0.6, def 0.15). */
  umbral?: number;
}

/** Luminancia percibida (Rec. 601, misma que posterize.ts). */
function luma(data: Uint8ClampedArray, i: number): number {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * Campo de gradientes de luminancia con Sobel (3×3, implementación propia):
 *   gx = [−1 0 +1; −2 0 +2; −1 0 +1] ∗ L,  gy = gxᵀ (máscara transpuesta).
 * Bordes de la imagen = gradiente 0 (sin vecinos completos). Devuelve
 * gx/gy como Float32Array de width·height (radio 1, sin suavizado extra).
 */
export function sobelGradients(
  img: ImageDataLike
): { gx: Float32Array; gy: Float32Array } {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) lum[p] = luma(data, p * 4);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const tl = lum[p - w - 1], t = lum[p - w], tr = lum[p - w + 1];
      const l = lum[p - 1], r = lum[p + 1];
      const bl = lum[p + w - 1], b = lum[p + w], br = lum[p + w + 1];
      gx[p] = tr + 2 * r + br - (tl + 2 * l + bl);
      gy[p] = bl + 2 * b + br - (tl + 2 * t + tr);
    }
  }
  return { gx, gy };
}

// ─────────────────────────────────────────────────────────────────────────
// Campo de bordes (LA-4): magnitud normalizada + dirección, para el modo
// 'bordes' (grabado). Hogar natural del campo: encima de sobelGradients.
// Lo reutiliza azimuthal.ts (re-exportado desde allí).
// ─────────────────────────────────────────────────────────────────────────

export interface BorderField {
  /** Magnitud |∇L| normalizada por el máximo global → [0, 1]. */
  m: Float32Array;
  /** Componentes Sobel sin normalizar (para la DIRECCIÓN del borde). */
  gx: Float32Array;
  gy: Float32Array;
  width: number;
  height: number;
}

/**
 * Mapa de bordes: Sobel sobre luminancia → magnitud normalizada por el
 * MÁXIMO GLOBAL (umbral = "borde principal relativo a esta imagen").
 * Imagen plana → m = 0. Determinista (sin seed: los bordes son estructura).
 */
export function borderField(img: ImageDataLike): BorderField {
  const { gx, gy } = sobelGradients(img);
  const n = gx.length;
  const m = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const mag = Math.hypot(gx[i], gy[i]);
    m[i] = mag;
    if (mag > max) max = mag;
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) m[i] /= max;
  }
  return { m, gx, gy, width: img.width, height: img.height };
}

/** Muestreo bilineal CLAMPEADO del campo (m, gx, gy) en pixel fuente. */
export function sampleField(
  field: BorderField,
  x: number,
  y: number
): { m: number; gx: number; gy: number } {
  const { width, height, m, gx, gy } = field;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  const ch = (a: Float32Array) =>
    (a[i00] * (1 - fx) + a[i10] * fx) * (1 - fy) +
    (a[i01] * (1 - fx) + a[i11] * fx) * fy;
  return { m: ch(m), gx: ch(gx), gy: ch(gy) };
}

/** Redondeo a 1 decimal (mismo criterio que roundRadius del formato). */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Genera el array plano de segmentos [x, y, angle, len, rgb, ...] en orden
 * de barrido (fila a fila de la rejilla), igual que generatePoints.
 *
 * Por celda (step): promedio de celda → oscuridad d ∈ [0,1] (misma regla
 * que el puntillista: se acepta si prng() < d); ángulo = atan2(gy, gx) + 90°
 * del gradiente SOBEL acumulado en la celda (tangente al borde; zona plana →
 * 0°, trazo horizontal); len = maxLength·(0.3 + 0.7·d). Ángulo y len con 1
 * decimal; rgb = color promedio de la celda, empaquetado.
 *
 * `random` opcional inyecta el PRNG (tests deterministas); si se omite,
 * mulberry32(params.seed) — comportamiento de producción reproducible.
 */
export function generateSegments(
  img: ImageDataLike,
  params: LineArtParams,
  random?: () => number
): number[] {
  if ((params.mode ?? "luz") === "bordes") {
    return generateBorderSegments(img, params);
  }
  const step = Math.max(1, Math.floor(params.step));
  const prng = random ?? mulberry32(params.seed);
  const { width, height, data } = img;
  const { gx, gy } = sobelGradients(img);
  const segments: number[] = [];

  for (let y = 0; y < height; y += step) {
    const y1 = Math.min(y + step, height);
    for (let x = 0; x < width; x += step) {
      const x1 = Math.min(x + step, width);
      let r = 0, g = 0, b = 0;
      const count = (x1 - x) * (y1 - y);
      for (let cy = y; cy < y1; cy++) {
        let i = (cy * width + x) * 4;
        for (let cx = x; cx < x1; cx++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      r /= count;
      g /= count;
      b /= count;
      const darkness = 1 - (r + g + b) / 3 / 255;
      if (prng() >= darkness) continue; // umbral probabilístico (puntillista)

      // Gradiente acumulado de la celda (la suma de vectores pondera por
      // magnitud: dominan los píxeles con borde fuerte).
      let sgx = 0, sgy = 0;
      for (let cy = y; cy < y1; cy++) {
        for (let cx = x; cx < x1; cx++) {
          const p = cy * width + cx;
          sgx += gx[p];
          sgy += gy[p];
        }
      }
      const raw = (Math.atan2(sgy, sgx) * 180) / Math.PI + 90;
      const angle =
        sgx === 0 && sgy === 0
          ? 0 // zona plana: sin borde → trazo horizontal
          : ((round1(raw) % 360) + 360) % 360;

      const len = round1(params.maxLength * (0.3 + 0.7 * darkness));
      segments.push(x, y, angle, len, packRGB(Math.round(r), Math.round(g), Math.round(b)));
    }
  }
  return segments;
}

/**
 * Modo 'bordes' (LA-4): la tinta de grabado del Azimutal en vista plana —
 * sin proyección. Por celda: (m, gx, gy) bilineal; si m ≥ umbral, segmento
 * tangente con len = maxLength·(0.4 + 0.6·m), trazo NEGRO. Sin seed
 * (determinista); el color de celda y la oscuridad no intervienen.
 */
function generateBorderSegments(img: ImageDataLike, params: LineArtParams): number[] {
  const step = Math.max(1, Math.floor(params.step));
  const umbral = params.umbral ?? 0.15;
  const field = borderField(img);
  const { width, height } = img;
  const segments: number[] = [];
  for (let y = 0; y < height; y += step) {
    const y1 = Math.min(y + step, height);
    for (let x = 0; x < width; x += step) {
      const x1 = Math.min(x + step, width);
      const cx = (x + x1) / 2;
      const cy = (y + y1) / 2;
      const { m, gx, gy } = sampleField(field, cx, cy);
      if (m < umbral) continue;
      const angle =
        gx === 0 && gy === 0
          ? 0
          : ((round1((Math.atan2(gy, gx) * 180) / Math.PI + 90) % 360) + 360) % 360;
      const len = round1(params.maxLength * (0.4 + 0.6 * m));
      segments.push(round1(cx), round1(cy), angle, len, 0); // rgb negro
    }
  }
  return segments;
}

/** Número de segmentos almacenados en un array plano. */
export function segmentCount(segments: number[]): number {
  return segments.length / 5;
}
