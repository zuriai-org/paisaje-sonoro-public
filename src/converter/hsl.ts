/**
 * Ajustes de color en espacio HSL (rehacer 2026-09-22, flujo Inkscape del
 * usuario: ajustar HSL por path SIN tocar la geometría).
 *
 * - Hue: rotación del matiz −180..+180 (0 = color original), con wrap.
 *   2026-09-23: el slider COLOR del editor posterizado es una rotación de
 *   matiz libre por capa (`rotateHue`); el antiguo ajuste por "posición de
 *   paleta" queda reemplazado (formato v3, params hueShift).
 *   P1 (2026-09-23): al deslizar (rotación no nula) el resultado es SIEMPRE
 *   perceptible — S ≥ 0.50 y L ∈ [0.30, 0.85] — incluso en capas casi negras
 *   o casi blancas (los grises toman el matiz pedido, base h = 0).
 * - Viveza: −100..+100 (0 = color original):
 *   · > 0: sube S con tope → s' = min(s · (1 + 0.5·v/100), 0.95); en +100:
 *     min(s · 1.5, 0.95). Nunca se satura de más (sin que "se vuelva otro
 *     color" ni blanco).
 *   · < 0: baja S con suelo 0.30 y baja L con suelo 0.45 → nunca negro,
 *     nunca blanco.
 * Todo puro y determinista.
 */

export interface HSL {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

/** RGB (0–255) → HSL. */
export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

/** HSL → RGB (0–255, enteros redondeados). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(channel(hn + 1 / 3) * 255),
    Math.round(channel(hn) * 255),
    Math.round(channel(hn - 1 / 3) * 255),
  ];
}

/** Rotación de matiz con wrap (dh en grados, −180..+180). */
export function applyHue(h: number, dh: number): number {
  return (((h + dh) % 360) + 360) % 360;
}

/** Viveza: >0 sube S (tope 0.95); <0 baja S (suelo 0.30) y L (suelo 0.45). */
export function applyViveza(hsl: HSL, viveza: number): HSL {
  if (viveza === 0) return hsl;
  if (viveza > 0) {
    const s = Math.min(hsl.s * (1 + 0.5 * (viveza / 100)), 0.95);
    return { h: hsl.h, s, l: hsl.l };
  }
  const k = -viveza / 100; // 0..1
  const s = Math.max(hsl.s * (1 - 0.7 * k), 0.3);
  const l = Math.max(hsl.l * (1 - 0.55 * k), 0.45);
  return { h: hsl.h, s, l };
}

/**
 * Ajusta un color RGB con hue (−180..180) y viveza (−100..100).
 * 0/0 → el color original (roundtrip rgb→hsl→rgb dentro de ±1).
 */
export function adjustColor(
  rgb: readonly [number, number, number],
  hue: number,
  viveza: number
): [number, number, number] {
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const adjusted = applyViveza({ h: applyHue(hsl.h, hue), s: hsl.s, l: hsl.l }, viveza);
  return hslToRgb(adjusted.h, adjusted.s, adjusted.l);
}

/**
 * Rotación de matiz de un color RGB (dh en grados, −180..+180; 0 = el color
 * original). P1 2026-09-23 — perceptibilidad garantizada al deslizar:
 *   · Rotación efectiva nula (dh ≡ 0 mód 360) → color original INTACTO.
 *   · En cualquier otro caso el matiz elegido manda SIEMPRE (h + dh con
 *     wrap) y el resultado es claramente perceptible:
 *       S' = max(S, 0.50)             (un casi-negro/casi-blanco toma color)
 *       L' = min(max(L, 0.30), 0.85)  (nunca se pierde por oscuro ni por claro)
 * Los grises (S = 0, matiz indefinido) usan h = 0 como base (convención de
 * rgbToHsl): rotarlos produce un color visible del matiz pedido — antes
 * quedaban grises, que era justo el defecto en capas casi negras o blancas.
 * Es el ajuste del slider MATIZ del editor posterizado (formato v3): color
 * final = rotateHue(paleta[i], hueShift[i]).
 */
export function rotateHue(
  rgb: readonly [number, number, number],
  dh: number
): [number, number, number] {
  // Rotación nula (0 o vueltas enteras) → identidad exacta, sin excepción.
  if (((dh % 360) + 360) % 360 === 0) return [rgb[0], rgb[1], rgb[2]];
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const s = Math.max(hsl.s, 0.5);
  const l = Math.min(Math.max(hsl.l, 0.3), 0.85);
  return hslToRgb(applyHue(hsl.h, dh), s, l);
}

/**
 * Rotación de matiz que lleva `from` a `to` (ambos RGB), en grados con wrap
 * a (−180, +180]. Para la migración v2→v3 (hueShift que preserva el color
 * final elegido). Si `from` es gris (matiz indefinido) devuelve 0: rotar un
 * gris no produce ningún color.
 */
export function hueShiftBetween(
  from: readonly [number, number, number],
  to: readonly [number, number, number]
): number {
  const a = rgbToHsl(from[0], from[1], from[2]);
  if (a.s === 0) return 0;
  const b = rgbToHsl(to[0], to[1], to[2]);
  let dh = b.h - a.h;
  while (dh > 180) dh -= 360;
  while (dh <= -180) dh += 360;
  return Math.round(dh);
}

/**
 * Colores finales de las capas del posterizado (F2 2026-10-11): MATIZ GLOBAL
 * —la MISMA rotación para las 4 paletas, así que las diferencias relativas
 * entre capas se preservan y las combinaciones quedan equilibradas— o
 * grises B&W (tono por capa). 0 → identidad exacta (rotateHue). El resultado
 * es SIEMPRE perceptible al deslizar (garantía de rotateHue, P1): incluso
 * las capas casi negras/blancas toman un color visible.
 */
export function finalLayerColors(
  palette: ReadonlyArray<readonly [number, number, number]>,
  hueGlobal: number,
  bw: boolean,
  grayTone: ReadonlyArray<number>
): Array<[number, number, number]> {
  return palette.map((c, i) => {
    if (bw) {
      const t = Math.round(grayTone[i] ?? 0);
      return [t, t, t] as [number, number, number];
    }
    return rotateHue(c, hueGlobal);
  });
}
