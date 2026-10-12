import { describe, it, expect } from "vitest";
import { seededPermutation } from "./permutation";

function isValidPermutation(arr: number[], n: number): boolean {
  if (arr.length !== n) return false;
  const seen = new Set(arr);
  if (seen.size !== n) return false;
  for (let i = 0; i < n; i++) if (!seen.has(i)) return false;
  return true;
}

describe("seededPermutation", () => {
  it("es determinista: mismo seed → misma permutación", () => {
    expect(seededPermutation(500, 42)).toEqual(seededPermutation(500, 42));
  });

  it("seed distinto → permutación distinta (con alta probabilidad)", () => {
    const a = seededPermutation(500, 1);
    const b = seededPermutation(500, 2);
    expect(a).not.toEqual(b);
    expect(isValidPermutation(a, 500)).toBe(true);
    expect(isValidPermutation(b, 500)).toBe(true);
  });

  it("devuelve una permutación válida de 0..n−1 (muchos seeds)", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(isValidPermutation(seededPermutation(200, seed), 200)).toBe(true);
    }
  });

  it("casos límite: n=0 y n=1", () => {
    expect(seededPermutation(0, 7)).toEqual([]);
    expect(seededPermutation(1, 7)).toEqual([0]);
  });

  it("es una permutación REAL (no el orden de barrido)", () => {
    const p = seededPermutation(100, 42);
    expect(p).not.toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});
