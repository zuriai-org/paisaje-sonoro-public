import { describe, it, expect } from "vitest";
import {
  createInitialState,
  editStep,
  confirmStep,
  modifyConfirmedStep,
  canAdvance,
  canGoBack,
  next,
  back,
  STEP_COUNT,
  isPieceTitleValid,
  PIECE_TITLE_MAX,
} from "./wizardState";

describe("wizardState — estado inicial", () => {
  it("empieza en el paso 1, todo empty, sin avance ni retroceso", () => {
    const s = createInitialState();
    expect(s.current).toBe(0);
    expect(s.status).toEqual(["empty", "empty", "empty"]);
    expect(canAdvance(s)).toBe(false);
    expect(canGoBack(s)).toBe(false);
  });
});

describe("wizardState — regla de [SIGUIENTE]", () => {
  it("no avanza si el paso actual no está confirmado", () => {
    const s0 = createInitialState();
    const s1 = editStep(s0, 0);
    expect(canAdvance(s1)).toBe(false);
    expect(next(s1)).toBe(s1); // no-op, mismo objeto
    expect(next(s0)).toBe(s0);
  });

  it("avanza solo tras confirmar el paso actual", () => {
    let s = createInitialState();
    s = editStep(s, 0);
    s = confirmStep(s, 0);
    expect(canAdvance(s)).toBe(true);
    s = next(s);
    expect(s.current).toBe(1);
    expect(canGoBack(s)).toBe(true);
  });

  it("no avanza más allá del último paso", () => {
    let s = createInitialState();
    for (let i = 0; i < STEP_COUNT; i++) s = confirmStep(s, i);
    s = { ...s, current: STEP_COUNT - 1 };
    expect(canAdvance(s)).toBe(false);
    expect(next(s)).toBe(s);
  });
});

describe("wizardState — regla de [ATRÁS]", () => {
  it("no retrocede en el paso 1", () => {
    expect(back(createInitialState())).toEqual(createInitialState());
  });

  it("retrocede en pasos 2 y 3", () => {
    let s = createInitialState();
    s = confirmStep(s, 0);
    s = next(s); // paso 2
    expect(canGoBack(s)).toBe(true);
    s = back(s);
    expect(s.current).toBe(0);
  });
});

describe("wizardState — modificar un paso confirmado", () => {
  it("lo desconfirma (vuelve a editing) y desactiva [SIGUIENTE]", () => {
    let s = createInitialState();
    s = confirmStep(s, 0);
    s = next(s); // en paso 2
    s = back(s); // vuelve al paso 1 (confirmado)
    s = modifyConfirmedStep(s, 0); // el usuario cambia la imagen
    expect(s.status[0]).toBe("editing");
    expect(canAdvance(s)).toBe(false);
  });

  it("CONSERVA los pasos posteriores ya hechos (no desconfirma en cadena)", () => {
    let s = createInitialState();
    s = confirmStep(editStep(s, 0), 0);
    s = next(s);
    s = confirmStep(editStep(s, 1), 1);
    s = next(s); // paso 3
    expect(s.status).toEqual(["confirmed", "confirmed", "empty"]);
    // Navega atrás y modifica el paso 1:
    s = back(s);
    s = back(s); // paso 1, confirmado
    s = modifyConfirmedStep(s, 0);
    expect(s.status[0]).toBe("editing");
    expect(s.status[1]).toBe("confirmed"); // el audio procesado se conserva
    expect(s.status[2]).toBe("empty");
    // Al reconfirmar el paso 1, el paso 2 sigue confirmado → [SIGUIENTE] directo.
    s = confirmStep(s, 0);
    s = next(s);
    expect(s.current).toBe(1);
    expect(canAdvance(s)).toBe(true); // aparece [SIGUIENTE] sin rehacer nada
  });

  it("modificar un paso en editing no altera nada", () => {
    let s = createInitialState();
    s = editStep(s, 0);
    expect(modifyConfirmedStep(s, 0)).toEqual(s);
  });
});

describe("wizardState — inmutabilidad", () => {
  it("las transiciones no mutan el estado anterior", () => {
    const s0 = createInitialState();
    const s1 = editStep(s0, 0);
    const s2 = confirmStep(s1, 0);
    expect(s0.status[0]).toBe("empty");
    expect(s1.status[0]).toBe("editing");
    expect(s2.status[0]).toBe("confirmed");
    expect(s0.status).not.toBe(s1.status);
  });
});

describe("wizardState — título de la pieza (F1)", () => {
  it("vacío o solo espacios NO es válido: [TERMINAR] deshabilitado", () => {
    expect(isPieceTitleValid("")).toBe(false);
    expect(isPieceTitleValid("   ")).toBe(false);
    expect(isPieceTitleValid("\n\t ")).toBe(false);
  });

  it("vale cualquier texto de 1 a 120 caracteres tras recortar", () => {
    expect(isPieceTitleValid("A")).toBe(true);
    expect(isPieceTitleValid("Retrato sonoro")).toBe(true);
    expect(PIECE_TITLE_MAX).toBe(120);
    expect(isPieceTitleValid("x".repeat(120))).toBe(true);
    expect(isPieceTitleValid("x".repeat(121))).toBe(false);
  });

  it("el recorte va antes de medir (mismo contrato que el backend)", () => {
    expect(isPieceTitleValid("  ok  ")).toBe(true);
    expect(isPieceTitleValid(" " + "x".repeat(120) + " ")).toBe(true); // recorta a 120
    expect(isPieceTitleValid(" " + "x".repeat(121) + " ")).toBe(false); // recorta a 121
  });
});
