import { describe, it, expect } from "vitest";
import { mulberry32 } from "./prng";

describe("mulberry32", () => {
  it("es determinista: mismo seed → misma secuencia", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("seed distinto → secuencia distinta", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("devuelve valores en [0, 1)", () => {
    const rnd = mulberry32(123456789);
    for (let i = 0; i < 10_000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("tolera seeds fuera de rango 32-bit (coerce con >>>)", () => {
    const a = mulberry32(0xffffffff + 5);
    const b = mulberry32(4); // 0xffffffff + 5 === 2^32 + 4 → >>> 0 === 4
    expect(a()).toBe(b());
  });

  it("seed 0 es válido y no produce NaN", () => {
    const rnd = mulberry32(0);
    const v = rnd();
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
