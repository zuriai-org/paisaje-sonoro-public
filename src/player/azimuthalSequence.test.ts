/**
 * Tests de la órbita azimutal (AZ-4): odómetro de velocidad híbrida
 * (reloj + energía de los picos) y pliegue del fin de recorrido
 * ('clamp' se detiene en C; 'bounce' rebota de C a A sin salto).
 */
import { describe, it, expect } from "vitest";
import {
  azimuthalAdvance,
  azimuthalFold,
  azimuthalFrameIndex,
  AZIMUTHAL_ENERGY_GAIN,
  AZIMUTHAL_LAST,
} from "./PaisajePlayer";

describe("azimuthalAdvance — odómetro de velocidad híbrida", () => {
  it("en silencio (peak 0) completa A→C exactamente una vez por tema", () => {
    let odo = 0;
    const dt = 0.25;
    const duration = 26; // 13 estados en 26 s
    for (let t = 0; t < duration; t += dt) {
      odo = azimuthalAdvance(odo, 0, duration, dt);
    }
    expect(odo).toBeCloseTo(AZIMUTHAL_LAST, 9);
  });

  it("los picos la aceleran: con peak 1 avanza ×(1 + gain)", () => {
    const silent = azimuthalAdvance(0, 0, 26, 1);
    const loud = azimuthalAdvance(0, 1, 26, 1);
    expect(loud / silent).toBeCloseTo(1 + AZIMUTHAL_ENERGY_GAIN, 9);
    // peak fuera de rango se clampa
    expect(azimuthalAdvance(0, 3, 26, 1)).toBeCloseTo(loud, 9);
  });

  it("curva gamma 0.7: los picos medios/bajos (el rango real) reaccionan más", () => {
    const silent = azimuthalAdvance(0, 0, 26, 1);
    // peak 0.3 → actúa como 0.3^0.7 ≈ 0.43 (antes de la ganancia)
    const mid = azimuthalAdvance(0, 0.3, 26, 1);
    expect(mid / silent).toBeCloseTo(1 + AZIMUTHAL_ENERGY_GAIN * Math.pow(0.3, 0.7), 9);
    // y un pico 0.3 rinde más de la mitad de lo que rendía un 0.5 lineal
    const at03 = azimuthalAdvance(0, 0.3, 26, 1);
    const at06 = azimuthalAdvance(0, 0.6, 26, 1);
    expect(at06 / at03).toBeGreaterThan(1); // sigue siendo monótona
    expect(at03 / silent).toBeGreaterThan(1.5); // reacción clara ya a 0.3
  });

  it("sin duración válida no avanza (odómetro intacto)", () => {
    expect(azimuthalAdvance(5, 1, 0, 1)).toBe(5);
    expect(azimuthalAdvance(5, 1, NaN, 1)).toBe(5);
  });
});

describe("azimuthalFold — fin de recorrido", () => {
  it("clamp: se detiene en C (13) y no baja de 0", () => {
    expect(azimuthalFold(0, "clamp")).toBe(0);
    expect(azimuthalFold(13, "clamp")).toBe(13);
    expect(azimuthalFold(20, "clamp")).toBe(13);
    expect(azimuthalFold(-2, "clamp")).toBe(0);
  });

  it("bounce: rebote triangular C→A por el mismo camino, sin salto en los extremos", () => {
    expect(azimuthalFold(0, "bounce")).toBe(0);
    expect(azimuthalFold(13, "bounce")).toBe(13);
    expect(azimuthalFold(14, "bounce")).toBe(12); // vuelve por el mismo camino
    expect(azimuthalFold(20, "bounce")).toBe(6);
    expect(azimuthalFold(26, "bounce")).toBe(0);
    expect(azimuthalFold(27, "bounce")).toBe(1);
    // los extremos NO saltan: 12→13→13→12 y 1→0→0→1 (continuidad)
    expect(azimuthalFold(12.5, "bounce")).toBeCloseTo(12.5, 9);
    expect(azimuthalFold(13.5, "bounce")).toBeCloseTo(12.5, 9);
    expect(azimuthalFold(0.5, "bounce")).toBeCloseTo(0.5, 9);
    expect(azimuthalFold(-0.5, "bounce")).toBeCloseTo(0.5, 9);
    // nunca sale de [0, 13]
    for (const odo of [0, 3.7, 13, 19.9, 26, 33.3]) {
      const p = azimuthalFold(odo, "bounce");
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(13);
    }
  });
});

describe("azimuthalFrameIndex — frame activo = round(pos)", () => {
  it("redondea y clampa a [0, 13]", () => {
    expect(azimuthalFrameIndex(0)).toBe(0);
    expect(azimuthalFrameIndex(0.4)).toBe(0);
    expect(azimuthalFrameIndex(0.5)).toBe(1);
    expect(azimuthalFrameIndex(6.49)).toBe(6);
    expect(azimuthalFrameIndex(6.5)).toBe(7);
    expect(azimuthalFrameIndex(13)).toBe(13);
    expect(azimuthalFrameIndex(99)).toBe(13);
    expect(azimuthalFrameIndex(-3)).toBe(0);
  });
});
