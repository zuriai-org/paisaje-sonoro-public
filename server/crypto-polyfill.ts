/**
 * Polyfill mínimo para Node 18: el `crypto` global (WebCrypto) solo está
 * disponible sin flags desde Node 19, y nanoid v6 lo usa (getRandomValues).
 * Debe importarse ANTES que cualquier módulo que use nanoid.
 */
import { webcrypto } from "node:crypto";

const g = globalThis as { crypto?: Crypto };
if (!g.crypto) {
  g.crypto = webcrypto as unknown as Crypto;
}
