import { mulberry32 } from "../converter/prng";

/**
 * Permutación determinista de índices con seed (corrección fase 5):
 * mulberry32(params.seed) + Fisher-Yates. Mismo seed → misma permutación;
 * el reproductor revela los puntos en este orden (no en el de barrido),
 * evitando el encendido de arriba a abajo.
 */

export function seededPermutation(n: number, seed: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  if (n <= 1) return arr;
  const rnd = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
