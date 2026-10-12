/**
 * Máquina de estados del asistente (wizard) — LÓGICA PURA, sin React.
 * Los payloads (imagen, audio, config) viven en el componente; aquí solo
 * el flujo: paso actual + estado de cada paso.
 *
 * Reglas:
 * - Cada paso: "empty" → "editing" → "confirmed".
 * - [SIGUIENTE] solo activo si el paso actual está "confirmed".
 * - [ATRÁS] activo salvo en el paso 1.
 * - Editar un paso YA confirmado lo vuelve a "editing", pero CONSERVA
 *   los pasos posteriores tal cual (no se desconfirman en cadena).
 */

export type StepStatus = "empty" | "editing" | "confirmed";

export const STEP_TITLES = [
  "Imagen y estilo",
  "Audio y reproductor",
  "Resumen",
] as const;

export const STEP_COUNT = STEP_TITLES.length;

export interface WizardState {
  /** Índice del paso actual (0-based). */
  current: number;
  /** Estado de cada paso, en orden. */
  status: StepStatus[];
}

export function createInitialState(): WizardState {
  return { current: 0, status: Array.from({ length: STEP_COUNT }, () => "empty" as StepStatus) };
}

/** El paso pasa a estar en edición (desde empty o confirmed). */
export function editStep(state: WizardState, step: number): WizardState {
  if (step < 0 || step >= STEP_COUNT || state.status[step] === "editing") return state;
  const status = state.status.slice();
  status[step] = "editing";
  return { ...state, status };
}

/** Confirma el paso (p. ej. tras [USAR] / [Usar reproductor]). */
export function confirmStep(state: WizardState, step: number): WizardState {
  if (step < 0 || step >= STEP_COUNT) return state;
  const status = state.status.slice();
  status[step] = "confirmed";
  return { ...state, status };
}

/**
 * Edita un paso confirmado: lo desconfirma SIN tocar los posteriores.
 * Es la operación clave de la navegación hacia atrás (regla: modificar un
 * paso ya confirmado lo desconfirma, pero conserva lo hecho después).
 * Si el paso no estaba confirmado, equivale a editStep.
 */
export function modifyConfirmedStep(state: WizardState, step: number): WizardState {
  return editStep(state, step);
}

/** [SIGUIENTE] activo solo si el paso actual está confirmado. */
export function canAdvance(state: WizardState): boolean {
  return state.current < STEP_COUNT - 1 && state.status[state.current] === "confirmed";
}

/** [ATRÁS] activo salvo en el paso 1. */
export function canGoBack(state: WizardState): boolean {
  return state.current > 0;
}

/** Límite de caracteres del título de la pieza (F1 2026-10-11, igual que
 *  el validador del backend en server/pieces.ts). */
export const PIECE_TITLE_MAX = 120;

/**
 * Validación del título de la pieza (F1): obligatorio en el paso Resumen —
 * [TERMINAR] queda deshabilitado mientras no sea válido. Mismo contrato que
 * el backend: tras recortar, 1–120 caracteres.
 */
export function isPieceTitleValid(title: string): boolean {
  const t = title.trim();
  return t.length >= 1 && t.length <= PIECE_TITLE_MAX;
}

/** Avanza al paso siguiente. No-op si canAdvance es false. */
export function next(state: WizardState): WizardState {
  if (!canAdvance(state)) return state;
  return { ...state, current: state.current + 1 };
}

/** Retrocede al paso anterior. No-op en el paso 1. */
export function back(state: WizardState): WizardState {
  if (!canGoBack(state)) return state;
  return { ...state, current: state.current - 1 };
}
