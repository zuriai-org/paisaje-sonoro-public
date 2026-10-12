/**
 * Utilidades del modo espectral (DISENO.md §3.2/§3.4 — mejora futura (a),
 * ahora implementada). Reutiliza normalize.ts para la normalización por banda.
 */

import {
  createNormalizerState,
  normalizeInstant,
  resetNormalizer,
  type PeakNormalizerState,
} from "./normalize";

/**
 * Rango útil para las bandas: 60 Hz – 10 kHz (corrección 2026-09-20).
 * Por debajo de 60 Hz casi no hay contenido musical (subgrave); por encima
 * de 10 kHz los bins del analyser (fftSize 2048) quedan casi vacíos de
 * energía. Espaciado logarítmico, igual que antes.
 */
export const MIN_HZ = 60;
export const MAX_HZ = 10000;

/**
 * Ancho de la zona de transición entre bandas vecinas, en celdas de rejilla
 * del conversor (~1.5 · step px a cada lado del borde). Dentro de la zona,
 * la energía efectiva de un punto interpola sus dos bandas vecinas.
 */
export const TRANSITION_CELLS = 1.5;

/**
 * Bordes de banda espaciados LOGARÍTMICAMENTE (la percepción de frecuencia
 * es logarítmica; bandas planas harían que los graves dominaran todo).
 * Devuelve `bands + 1` bordes: el primero = minHz, el último = maxHz.
 */
export function logBandEdges(bands: number, minHz: number = MIN_HZ, maxHz: number = MAX_HZ): number[] {
  const edges: number[] = [];
  const logMin = Math.log(minHz);
  const logMax = Math.log(maxHz);
  for (let i = 0; i <= bands; i++) {
    edges.push(Math.exp(logMin + (logMax - logMin) * (i / bands)));
  }
  return edges;
}

/**
 * Asigna cada bin de frecuencia del analyser a una banda según su Hz.
 * Bins por debajo de minHz → banda 0; por encima de maxHz → última banda.
 *
 * `edges` opcional (v2 posterizado): bordes de banda EXPLÍCITOS del
 * documento (bands+1 valores, p. ej. [60, 200, 1000, 4000, 10000]). Si no se
 * da, se usan los bordes logarítmicos por defecto (v1, 6 bandas).
 */
export function assignBinsToBands(
  bands: number,
  binCount: number,
  sampleRate: number,
  edges?: number[]
): Uint8Array {
  const useEdges = edges && edges.length === bands + 1 ? edges : logBandEdges(bands);
  const nyquist = sampleRate / 2;
  const map = new Uint8Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const hz = (i * nyquist) / binCount;
    let b = 0;
    while (b < bands - 1 && hz > useEdges[b + 1]) b++;
    map[i] = b;
  }
  return map;
}

/**
 * Energía por banda = promedio de sus bins / 255 (0..1).
 * Bandas sin bins quedan a 0.
 */
export function bandEnergies(
  freqData: Uint8Array<ArrayBuffer>,
  binToBand: Uint8Array,
  bands: number
): number[] {
  const sums = new Float64Array(bands);
  const counts = new Float64Array(bands);
  for (let i = 0; i < freqData.length; i++) {
    const b = binToBand[i];
    sums[b] += freqData[i];
    counts[b]++;
  }
  const out = new Array<number>(bands).fill(0);
  for (let b = 0; b < bands; b++) {
    out[b] = counts[b] > 0 ? sums[b] / counts[b] / 255 : 0;
  }
  return out;
}

/**
 * Partición espacial de puntos en franjas verticales: cada punto pertenece a
 * la banda floor(x / width · bands), clampada a [0, bands−1]. Graves a la
 * izquierda, agudos a la derecha. Devuelve los índices de punto por banda.
 */
export function partitionPointsByBand(
  points: number[],
  width: number,
  bands: number
): number[][] {
  const out: number[][] = Array.from({ length: bands }, () => []);
  const n = Math.floor(points.length / 4);
  for (let i = 0; i < n; i++) {
    const x = points[i * 4];
    let b = Math.floor((x / width) * bands);
    if (b >= bands) b = bands - 1;
    if (b < 0) b = 0;
    out[b].push(i);
  }
  return out;
}

/**
 * Normalización adaptativa POR BANDA: cada banda tiene su runningMax propio
 * (misma semántica que la de amplitud: decaimiento 0.999, piso 0.08) y su
 * valor suavizado propio (mismo α; el suavizado lo aplica el hook por frame).
 */
export interface BandNormalizers {
  states: PeakNormalizerState[];
  /** Peak suavizado por banda (lo actualiza el hook cada frame). */
  smooth: number[];
}

export function createBandNormalizers(bands: number): BandNormalizers {
  return {
    states: Array.from({ length: bands }, () => createNormalizerState()),
    smooth: new Array<number>(bands).fill(0),
  };
}

export function resetBandNormalizers(bn: BandNormalizers): void {
  for (const s of bn.states) resetNormalizer(s);
  bn.smooth.fill(0);
}

/** Normaliza la energía de UNA banda contra su runningMax (piso 0.08). */
export function normalizeBand(energy: number, state: PeakNormalizerState): number {
  return normalizeInstant(energy, 1, state);
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Opacidad con velo (ajuste fino 2026-09-20):
 *   opacity = maxOpacity · (1 − veil · (1 − energía))
 *
 * - veil = 0 → opacidad plena siempre (maxOpacity), con cualquier energía.
 * - veil = 1 → opacity = maxOpacity · energía (velo total: las bandas en
 *   silencio desaparecen, como la versión anterior al fix de franjas).
 * - veil = 0.35 (default) → una banda en silencio se ve al 65 % y una al
 *   máximo al 100 %: velo perceptible pero nítido en los picos.
 * Aplica igual en modo 'amplitude' (con el peak global) y 'spectrum'.
 * El corte duro por silencio (silenceThreshold) se aplica fuera, en el render.
 */
export function veiledOpacity(
  energy: number,
  veil: number,
  maxOpacity: number
): number {
  const v = Math.min(1, Math.max(0, veil));
  const e = Math.min(1, Math.max(0, energy));
  return maxOpacity * (1 - v * (1 - e));
}

/**
 * Energía efectiva de UN punto (corrección 2026-09-20 — elimina las líneas
 * divisorias entre franjas):
 *
 * - Lejos de los bordes: energía pura de su banda `floor(x/width · bands)`.
 * - Dentro de la zona de transición (~TRANSITION_CELLS · step px a cada
 *   lado del borde más cercano): mezcla simétrica y suave (smoothstep) de
 *   las dos bandas vecinas. En el borde exacto devuelve la media de ambas.
 * - Los bordes externos (0 y bands) no mezclan: clampa a la banda extrema.
 *
 * La transición se aplica al RADIO y no crea opacidad parcial: los puntos
 * visibles siguen yendo a opacidad plena (ver PaisajePlayer).
 */
export function pointBandEnergy(
  x: number,
  width: number,
  bands: number,
  energies: number[],
  transitionPx: number
): number {
  const bandWidth = width / bands;
  const p = (x / width) * bands;
  const pc = Math.min(Math.max(p, 0), bands); // clamp al rango de bandas
  const b = Math.min(Math.floor(pc), bands - 1);
  const edge = Math.round(pc); // borde de banda más cercano (en unidades de banda)
  if (edge <= 0 || edge >= bands || transitionPx <= 0) return energies[b];
  const distPx = Math.abs(pc - edge) * bandWidth;
  if (distPx >= transitionPx) return energies[b];
  const w = smoothstep01(distPx / transitionPx); // 0 en el borde, 1 al salir de la zona
  const mix = (energies[edge - 1] + energies[edge]) / 2;
  return pc < edge
    ? mix + (energies[edge - 1] - mix) * w
    : mix + (energies[edge] - mix) * w;
}
