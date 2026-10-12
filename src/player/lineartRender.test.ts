/**
 * Tests puros del render Line Art (LA-2): extremos de los <line> desde
 * (x, y, angle, len) y efecto dibujo (dash). Sin DOM: el ángulo se mide
 * desde el eje horizontal hacia abajo (convención SVG, y-down), el centro
 * del trazo está en (x, y) y media longitud a cada lado.
 */
import { describe, it, expect } from "vitest";
import { segmentEndpoints, lineDash } from "./PaisajePlayer";

describe("segmentEndpoints — extremos desde (x, y, angle, len)", () => {
  it("angle 0 → trazo horizontal centrado en (x, y)", () => {
    // y-down: 0° apunta a +x. len 8 → 4 px a cada lado.
    expect(segmentEndpoints(10, 20, 0, 8)).toEqual({ x1: 14, y1: 20, x2: 6, y2: 20 });
  });

  it("angle 90 → trazo vertical (tangente a un borde vertical)", () => {
    expect(segmentEndpoints(10, 20, 90, 8)).toEqual({ x1: 10, y1: 24, x2: 10, y2: 16 });
  });

  it("angle 180 → como 0 con extremos intercambiados (mismo trazo)", () => {
    const a = segmentEndpoints(10, 20, 0, 8);
    const b = segmentEndpoints(10, 20, 180, 8);
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([a.x2, a.y2, a.x1, a.y1]);
  });

  it("respeta la longitud: distancia entre extremos ≈ len (± redondeo 1 decimal)", () => {
    for (const angle of [0, 45, 90, 137.5, 270]) {
      const p = segmentEndpoints(50, 50, angle, 12);
      const d = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      // Los extremos van a 1 decimal (precisión del formato): el error de
      // distancia es ≤ ~0.15 px, no exacto en ángulos no axis-aligned.
      expect(Math.abs(d - 12)).toBeLessThanOrEqual(0.15);
    }
  });

  it("coordenadas a 1 decimal", () => {
    const p = segmentEndpoints(10, 10, 45, 7); // dx = dy = 7·cos45/2 ≈ 2.4749
    expect(p.x1).toBe(12.5); // redondeo de 12.4749
    expect(p.y2).toBe(7.5); // 10 − 2.4749 = 7.5251 → 7.5
  });
});

describe("lineDash — efecto dibujo (dasharray = len, offset ∝ energía)", () => {
  it("energía 0 → offset = len (trazo oculto); energía 1 → offset 0 (completo)", () => {
    expect(lineDash(8, 0)).toBe(8);
    expect(lineDash(8, 1)).toBe(0);
  });

  it("energía intermedia → offset = len·(1 − e)", () => {
    expect(lineDash(8, 0.5)).toBe(4);
    expect(lineDash(10, 0.25)).toBe(7.5);
  });

  it("clampa energía fuera de [0, 1]", () => {
    expect(lineDash(8, -0.5)).toBe(8);
    expect(lineDash(8, 1.7)).toBe(0);
  });
});
