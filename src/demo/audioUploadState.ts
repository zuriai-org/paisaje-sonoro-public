/**
 * Máquina de fases de la subida de audio del paso 2 — LÓGICA PURA.
 *
 * Dos fases distinguibles (no se finge porcentaje de servidor):
 * - "uploading": progreso REAL de subida 0–100 (XMLHttpRequest upload
 *   onprogress; fetch no da progreso de subida).
 * - "processing": al terminar la subida, barra indeterminada — el navegador
 *   no puede saber el avance del ffmpeg (loudnorm + AAC) en el servidor.
 *
 * Reglas:
 * - El audio anterior del wizard NO se toca hasta "ready": si la subida
 *   falla (red o servidor), el estado queda en "error" y el audio previo
 *   sigue usable.
 * - "uploading"/"processing" bloquean el reproductor (isAudioUploadLocked).
 */

export type AudioUploadPhase = "idle" | "uploading" | "processing" | "ready" | "error";

export interface AudioUploadState {
  phase: AudioUploadPhase;
  /** 0–100, solo significativo en "uploading". */
  progress: number;
  /** Mensaje solo en "error". */
  error: string | null;
}

export function initialAudioUploadState(): AudioUploadState {
  return { phase: "idle", progress: 0, error: null };
}

/** idle | ready | error → uploading (empieza/reintenta/reemplaza). */
export function startAudioUpload(state: AudioUploadState): AudioUploadState {
  if (state.phase === "uploading" || state.phase === "processing") return state;
  return { phase: "uploading", progress: 0, error: null };
}

/** Actualiza el porcentaje real de subida (solo en "uploading"). */
export function setAudioUploadProgress(state: AudioUploadState, pct: number): AudioUploadState {
  if (state.phase !== "uploading") return state;
  const progress = Math.min(100, Math.max(0, pct));
  return { ...state, progress };
}

/** La subida terminó: el servidor está procesando (barra indeterminada). */
export function audioUploadComplete(state: AudioUploadState): AudioUploadState {
  if (state.phase !== "uploading") return state;
  return { phase: "processing", progress: 100, error: null };
}

/** Procesado correcto: el nuevo audio se confirma en el wizard. */
export function audioUploadSucceed(state: AudioUploadState): AudioUploadState {
  if (state.phase !== "processing") return state;
  return { phase: "ready", progress: 100, error: null };
}

/** Fallo de red o del servidor: el audio anterior queda intacto. */
export function audioUploadFail(state: AudioUploadState, message: string): AudioUploadState {
  if (state.phase !== "uploading" && state.phase !== "processing") return state;
  return { phase: "error", progress: 0, error: message };
}

/** El reproductor debe bloquearse (y pausarse) durante todo el proceso. */
export function isAudioUploadLocked(state: AudioUploadState): boolean {
  return state.phase === "uploading" || state.phase === "processing";
}
