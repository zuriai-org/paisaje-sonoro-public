import { describe, it, expect } from "vitest";
import { adjustColor, applyHue, applyViveza, finalLayerColors, hueShiftBetween, rgbToHsl, hslToRgb, rotateHue } from "./hsl";

describe("rgb ↔ hsl", () => {
  it("roundtrip: hslToRgb(rgbToHsl(c)) ≈ c (±1)", () => {
    for (const c of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [37, 111, 200], [128, 128, 128], [12, 34, 56]] as const) {
      const { h, s, l } = rgbToHsl(c[0], c[1], c[2]);
      expect(hslToRgb(h, s, l)).toEqual([c[0], c[1], c[2]].map((v) => v)); // colores exactos redondeables
    }
  });

  it("colores conocidos", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl(255, 255, 255)).toEqual({ h: 0, s: 0, l: 1 });
    expect(rgbToHsl(0, 0, 0)).toEqual({ h: 0, s: 0, l: 0 });
  });
});

describe("applyHue — rotación con wrap", () => {
  it("wrap correcto en ambos extremos", () => {
    expect(applyHue(350, 30)).toBeCloseTo(20, 5);
    expect(applyHue(10, -30)).toBeCloseTo(340, 5);
    expect(applyHue(180, 180)).toBe(0);
    expect(applyHue(0, 0)).toBe(0);
  });

  it("hue 0 no cambia el color", () => {
    expect(adjustColor([200, 80, 40], 0, 0)).toEqual([200, 80, 40]);
  });
});

describe("applyViveza — topes y suelos", () => {
  it("+100 sube S con tope 0.95 (nunca más)", () => {
    const { h, s, l } = applyViveza(rgbToHsl(100, 50, 50), 100);
    expect(s).toBeLessThanOrEqual(0.95);
    expect(s).toBeGreaterThan(rgbToHsl(100, 50, 50).s);
    expect(h).toBe(rgbToHsl(100, 50, 50).h);
    expect(l).toBe(rgbToHsl(100, 50, 50).l);
    // Color ya muy saturado: tope estricto.
    const capped = applyViveza(rgbToHsl(255, 0, 0), 100);
    expect(capped.s).toBe(0.95);
  });

  it("−100 baja S (suelo 0.30) y L (suelo 0.45): NUNCA negro, NUNCA blanco", () => {
    // Blanco puro: debe oscurecerse, no quedar blanco.
    const fromWhite = applyViveza({ h: 0, s: 0, l: 1 }, -100);
    expect(fromWhite.s).toBeCloseTo(0.3, 5);
    expect(fromWhite.l).toBeCloseTo(0.45, 5);
    // Negro puro: el suelo de L evita que sea negro.
    const fromBlack = applyViveza({ h: 0, s: 0, l: 0 }, -100);
    expect(fromBlack.l).toBeCloseTo(0.45, 5);
    const rgb = hslToRgb(fromBlack.h, fromBlack.s, fromBlack.l);
    expect(rgb[0]).toBeGreaterThan(100); // gris claro, no negro
  });

  it("0 = identidad; intermedios interpolan", () => {
    const hsl = { h: 200, s: 0.5, l: 0.5 };
    expect(applyViveza(hsl, 0)).toEqual(hsl);
    const half = applyViveza(hsl, -50);
    expect(half.s).toBeGreaterThan(0.3);
    expect(half.s).toBeLessThan(hsl.s);
    expect(half.l).toBeLessThan(hsl.l);
    expect(half.l).toBeGreaterThanOrEqual(0.45); // suelo
  });

  it("extremos combinados hue +100/−100 con viveza mantienen topes/suelos", () => {
    for (const hue of [-180, -90, 0, 90, 180]) {
      const darkened = adjustColor([255, 255, 255], hue, -100);
      for (const v of darkened) {
        expect(v).toBeGreaterThanOrEqual(80); // nunca negro: gris con L≥0.45
        expect(v).toBeLessThanOrEqual(200); // y queda apagado (no blanco)
      }
      const vivid = adjustColor([200, 30, 30], hue, 100);
      const { s } = rgbToHsl(...vivid);
      expect(s).toBeLessThanOrEqual(0.95);
    }
  });
});

describe("rotateHue — rotación de matiz libre (slider COLOR v3)", () => {
  it("hue 0 = identidad (el color original)", () => {
    expect(rotateHue([200, 30, 30], 0)).toEqual([200, 30, 30]);
    expect(rotateHue([0, 0, 0], 0)).toEqual([0, 0, 0]);
  });

  it("rotaciones cardinales primarias exactas", () => {
    expect(rotateHue([255, 0, 0], 120)).toEqual([0, 255, 0]); // rojo → verde
    expect(rotateHue([255, 0, 0], 240)).toEqual([0, 0, 255]); // rojo → azul
    expect(rotateHue([0, 255, 0], -120)).toEqual([255, 0, 0]); // verde → rojo
  });

  it("wrap ±180 en el círculo cromático", () => {
    // +180 y −180 equivalen (antípoda del círculo).
    expect(rotateHue([200, 30, 30], 180)).toEqual(rotateHue([200, 30, 30], -180));
    // −240 equivale a +120 (wrap).
    expect(rotateHue([255, 0, 0], -240)).toEqual(rotateHue([255, 0, 0], 120));
    // +360 = identidad.
    expect(rotateHue([10, 200, 60], 360)).toEqual(rotateHue([10, 200, 60], 0));
  });

  it("color ya perceptible: solo gira el matiz (S y L intactos)", () => {
    // [37,111,200]: S≈0.69, L≈0.46 — dentro de la banda [0.50]×[0.30,0.85],
    // así que la garantía de perceptibilidad no lo toca.
    const { s, l } = rgbToHsl(...rotateHue([37, 111, 200], 123));
    const orig = rgbToHsl(37, 111, 200);
    expect(s).toBeCloseTo(orig.s, 5);
    expect(l).toBeCloseTo(orig.l, 5);
  });

  it("los grises: matiz 0 = identidad; al deslizar toman el matiz pedido", () => {
    expect(rotateHue([128, 128, 128], 0)).toEqual([128, 128, 128]);
    expect(rotateHue([255, 255, 255], 0)).toEqual([255, 255, 255]);
    expect(rotateHue([0, 0, 0], 0)).toEqual([0, 0, 0]);
    // P1: un gris deslizado deja de ser gris (matiz indefinido → base h=0).
    const out = rotateHue([128, 128, 128], 90);
    expect(out).not.toEqual([128, 128, 128]);
    const { h, s, l } = rgbToHsl(...out);
    expect(h).toBeCloseTo(90, 0);
    expect(s).toBeGreaterThanOrEqual(0.5 - 0.005); // medio paso RGB de tolerancia
    expect(l).toBeGreaterThanOrEqual(0.3 - 0.005);
    expect(l).toBeLessThanOrEqual(0.85 + 0.005);
  });
});

describe("rotateHue — perceptibilidad garantizada (P1 2026-09-23)", () => {
  // Tolerancia = medio paso de la cuantización RGB (±1/255 en un canal ≈
  // ±0.002 en L/S al volver a rgbToHsl). Las bandas valen en el espacio HSL
  // de salida; el RGB entero redondeado puede desplazarlas ese epsilon.
  const TOL = 0.005;

  it("matiz 0 = identidad EXACTA, sin excepción (también negro/blanco)", () => {
    for (const c of [[0, 0, 0], [255, 255, 255], [26, 13, 10], [200, 30, 30], [240, 240, 245]] as const) {
      expect(rotateHue(c, 0)).toEqual([c[0], c[1], c[2]]);
    }
  });

  it("negro puro + 90° → visible: L ≥ 0.30, S ≥ 0.50, matiz ≈ 90°", () => {
    const out = rotateHue([0, 0, 0], 90);
    expect(out).not.toEqual([0, 0, 0]);
    const { h, s, l } = rgbToHsl(...out);
    expect(l).toBeGreaterThanOrEqual(0.3 - TOL);
    expect(s).toBeGreaterThanOrEqual(0.5 - TOL);
    expect(h).toBeCloseTo(90, 0); // el negro tiene h=0 por convención → verde
  });

  it("blanco puro + 90° → L ≤ 0.85, S ≥ 0.50, matiz ≈ 90°", () => {
    const out = rotateHue([255, 255, 255], 90);
    const { h, s, l } = rgbToHsl(...out);
    expect(l).toBeLessThanOrEqual(0.85 + TOL);
    expect(s).toBeGreaterThanOrEqual(0.5 - TOL);
    expect(h).toBeCloseTo(90, 0);
  });

  it("marrón casi negro + 90° → L=0.30, S=0.50, matiz = orig+90 (el elegido manda)", () => {
    const brown: [number, number, number] = [26, 13, 10];
    const orig = rgbToHsl(...brown); // L≈0.07, S≈0.45: invisible al girar
    const shifted = rgbToHsl(...rotateHue(brown, 90));
    expect(shifted.l).toBeCloseTo(0.3, 1); // sube al suelo 0.30
    expect(shifted.s).toBeCloseTo(0.5, 1); // sube al suelo 0.50
    expect(shifted.h).toBeCloseTo((orig.h + 90) % 360, 0);
  });

  it("color muy claro: L acotado a 0.85 (claro pero visible)", () => {
    const shifted = rgbToHsl(...rotateHue([245, 245, 250], 45));
    expect(shifted.l).toBeLessThanOrEqual(0.85 + TOL);
    expect(shifted.s).toBeGreaterThanOrEqual(0.5 - TOL);
  });

  it("color medio oscuro: L sube solo hasta el suelo, no más", () => {
    // L original ≈ 0.22 (< 0.30): deslizar lo sube a 0.30 exactos, no a 0.5.
    const shifted = rgbToHsl(...rotateHue([60, 40, 30], 120));
    expect(shifted.l).toBeCloseTo(0.3, 1);
    expect(shifted.s).toBeGreaterThanOrEqual(0.5 - TOL);
  });

  it("rotación de vuelta entera (±360) = identidad, como 0", () => {
    expect(rotateHue([26, 13, 10], 360)).toEqual([26, 13, 10]);
    expect(rotateHue([26, 13, 10], -360)).toEqual([26, 13, 10]);
  });
});

describe("hueShiftBetween — rotación que preserva un color (migración v2→v3)", () => {
  it("0 cuando from == to", () => {
    expect(hueShiftBetween([200, 30, 30], [200, 30, 30])).toBe(0);
  });

  it("devuelve la rotación aplicada (±1 por redondeo)", () => {
    const from: [number, number, number] = [200, 30, 30];
    for (const dh of [90, -45, 170]) {
      expect(hueShiftBetween(from, rotateHue(from, dh))).toBe(dh);
    }
  });

  it("wrap a (−180, +180]", () => {
    const from: [number, number, number] = [200, 30, 30];
    // rotateHue(from, 170) está a +170; la vuelta corta por +170, no −190.
    expect(hueShiftBetween(from, rotateHue(from, 170))).toBe(170);
    expect(Math.abs(hueShiftBetween(from, rotateHue(from, 170)))).toBeLessThanOrEqual(180);
  });

  it("from gris → 0 (matiz indefinido)", () => {
    expect(hueShiftBetween([120, 120, 120], [200, 30, 30])).toBe(0);
  });
});


describe("finalLayerColors — matiz global del posterizado (F2 2026-10-11)", () => {
  const palette: Array<[number, number, number]> = [
    [200, 30, 30], [30, 160, 60], [40, 60, 180], [220, 200, 90],
  ];
  const hueOf = (c: readonly [number, number, number]) => rgbToHsl(c[0], c[1], c[2]).h;

  it("0 = identidad exacta (colores originales)", () => {
    expect(finalLayerColors(palette, 0, false, [])).toEqual(palette);
    expect(finalLayerColors(palette, 360, false, [])).toEqual(palette); // vueltas enteras
  });

  it("la MISMA rotación para las 4 capas: las diferencias relativas de matiz se preservan (armonía)", () => {
    const rotated = finalLayerColors(palette, 90, false, []);
    for (let i = 1; i < 4; i++) {
      const before = (hueOf(palette[i]) - hueOf(palette[0]) + 360) % 360;
      const after = (hueOf(rotated[i]) - hueOf(rotated[0]) + 360) % 360;
      const dd = Math.abs(after - before) % 360;
      expect(Math.min(dd, 360 - dd)).toBeLessThan(2); // redondeo entero RGB
    }
    // y de hecho cada matiz rota ~90°
    for (let i = 0; i < 4; i++) {
      const d = (hueOf(rotated[i]) - hueOf(palette[i]) + 360) % 360;
      const diff = Math.min(d, 360 - d);
      expect(Math.abs(diff - 90)).toBeLessThan(2);
    }
  });

  it("perceptibilidad intacta en capas casi negras/blancas (S ≥ 0.5, L ∈ [0.30, 0.85])", () => {
    const darks: Array<[number, number, number]> = [[8, 6, 6], [5, 5, 5], [250, 250, 250], [30, 30, 30]];
    const rotated = finalLayerColors(darks, 120, false, []);
    for (const c of rotated) {
      const hsl = rgbToHsl(c[0], c[1], c[2]);
      expect(hsl.s).toBeGreaterThanOrEqual(0.5 - 2 / 255);
      expect(hsl.l).toBeGreaterThanOrEqual(0.3 - 2 / 255);
      expect(hsl.l).toBeLessThanOrEqual(0.85 + 2 / 255);
    }
  });

  it("B&W: tonos de gris por capa (el matiz global no aplica)", () => {
    expect(finalLayerColors(palette, 90, true, [0, 85, 170, 255])).toEqual([
      [0, 0, 0],
      [85, 85, 85],
      [170, 170, 170],
      [255, 255, 255],
    ]);
  });
});
