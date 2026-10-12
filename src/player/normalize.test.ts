import { describe, it, expect } from "vitest";
import {
  createNormalizerState,
  normalizeInstant,
  resetNormalizer,
} from "./normalize";

describe("normalizeInstant (normalización adaptativa)", () => {
  it("el pico más intenso llega a 1.0 aunque el crudo sea bajo (p.ej. 0.2)", () => {
    const s = createNormalizerState();
    // Audio "planito": picos de 0.2 → tras varios frames el runningMax≈0.2
    let v = 0;
    for (let i = 0; i < 500; i++) v = normalizeInstant(0.2, 1, s);
    expect(v).toBe(1); // el máximo histórico se normaliza a 1.0
    expect(s.runningMax).toBeGreaterThan(0.19);
  });

  it("picos por debajo del máximo histórico se escalan proporcionalmente", () => {
    const s = createNormalizerState();
    for (let i = 0; i < 500; i++) normalizeInstant(0.4, 1, s); // máximo 0.4
    // Un pico de la mitad → ~0.5 normalizado
    expect(normalizeInstant(0.2, 1, s)).toBeCloseTo(0.5, 1);
  });

  it("el piso 0.08 evita amplificar ruido en silencios", () => {
    const s = createNormalizerState();
    // "Silencio" con micro-ruido de 0.001: no debe amplificarse a valores altos
    const v = normalizeInstant(0.001, 1, s);
    expect(v).toBeLessThanOrEqual(0.001 / 0.08);
    expect(v).toBeLessThan(0.05);
    // Silencio digital puro → 0
    expect(normalizeInstant(0, 1, s)).toBe(0);
  });

  it("drive > 1 empuja piezas planas hacia el máximo", () => {
    const s = createNormalizerState();
    for (let i = 0; i < 500; i++) normalizeInstant(0.1, 3, s); // plano ×3
    expect(normalizeInstant(0.1, 3, s)).toBe(1); // runningMax ≈ 0.3 → 0.3/0.3
  });

  it("drive < 1 comprime: picos bajo el piso 0.08 no llegan a 1.0", () => {
    // instant 0.1: con drive 1 → driven 0.1 ≥ piso → llega a 1.0;
    // con drive 0.5 → driven 0.05 < piso 0.08 → 0.05/0.08 = 0.625
    const s1 = createNormalizerState();
    for (let i = 0; i < 500; i++) normalizeInstant(0.1, 1, s1);
    expect(normalizeInstant(0.1, 1, s1)).toBe(1);

    const s05 = createNormalizerState();
    for (let i = 0; i < 500; i++) normalizeInstant(0.1, 0.5, s05);
    expect(normalizeInstant(0.1, 0.5, s05)).toBeCloseTo(0.625, 3);
  });

  it("el resultado nunca supera 1 (clamped)", () => {
    const s = createNormalizerState();
    for (let i = 0; i < 1000; i++) {
      const v = normalizeInstant(0.5, 3, s);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("resetNormalizer reinicia el runningMax (cambio de audio / replay)", () => {
    const s = createNormalizerState();
    for (let i = 0; i < 500; i++) normalizeInstant(0.5, 1, s);
    expect(s.runningMax).toBeGreaterThan(0.4);
    resetNormalizer(s);
    expect(s.runningMax).toBe(0);
    // Tras el reset el piso 0.08 vuelve a aplicarse
    expect(normalizeInstant(0.5, 1, s)).toBe(1);
  });
});
