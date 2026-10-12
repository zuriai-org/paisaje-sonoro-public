/**
 * PRNG mulberry32 (DISENO.md §1.4).
 * Generador determinista de 32 bits: mismo seed → misma secuencia.
 * Devuelve números en [0, 1).
 */
export type PRNG = () => number;

export function mulberry32(seed: number): PRNG {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
