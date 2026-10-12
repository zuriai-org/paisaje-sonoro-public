/**
 * Normalización adaptativa del peak (corrección fase 6):
 * corrige que "ningún audio llega a 1.0". Mantiene un runningMax por
 * reproducción y normaliza contra él, con piso anti-ruido.
 */

export interface PeakNormalizerState {
  /** Máximo instantáneo (con drive) visto en la reproducción, con decaimiento. */
  runningMax: number;
}

export function createNormalizerState(): PeakNormalizerState {
  return { runningMax: 0 };
}

/**
 * Normaliza un peak instantáneo crudo (0..1) contra el runningMax.
 *
 * - `drive` (default 1.0, rango 0.5–3): ganancia multiplicativa ANTES de
 *   normalizar; empuja piezas muy planas.
 * - `runningMax = max(runningMax · 0.999, instant·drive)` cada frame.
 * - Normalizado = (instant·drive) / max(runningMax, 0.08); el piso de 0.08
 *   evita amplificar ruido de fondo en silencios.
 * - El resultado se clampa a [0, 1]: el punto más intenso sonado = 1.0 =
 *   imagen completa visible (con maxVisibleRatio = 1), con cualquier audio.
 * - El suavizado exponencial se aplica DESPUÉS, sobre este valor (§3.2).
 */
export function normalizeInstant(
  instant: number,
  drive: number,
  state: PeakNormalizerState
): number {
  const driven = instant * drive;
  state.runningMax = Math.max(state.runningMax * 0.999, driven);
  return Math.min(1, driven / Math.max(state.runningMax, 0.08));
}

/** Reset al cambiar de audio o reiniciar la reproducción desde cero. */
export function resetNormalizer(state: PeakNormalizerState): void {
  state.runningMax = 0;
}
