import { describe, it, expect } from "vitest";
import {
  FORMAT_NAME,
  FORMAT_VERSION,
  isPaisajeDocument,
  validateAndMigrate,
  packRGB,
  unpackRGB,
  roundRadius,
  POSTERIZED_BANDS,
  type Layer,
  type PaisajeDocument,
} from "./format";

function makeDoc(overrides: Record<string, unknown> = {}): PaisajeDocument {
  return {
    format: FORMAT_NAME,
    version: 1,
    generator: { name: "paisaje-sonoro-converter", version: "0.1.0" },
    image: { width: 100, height: 100, webp: "foto.webp" },
    params: { step: 12, maxRadius: 4, multiplicador: 3, seed: 42, maxVisibleRatio: 0.4 },
    points: [0, 0, 3, packRGB(255, 0, 128)],
    ...overrides,
  } as unknown as PaisajeDocument;
}

function makeLayer(band: [number, number], palette: [number, number, number], path: string): Layer {
  return { band, palette, color: [...palette], path };
}

const V3_PARAMS = {
  hueGlobal: 0,
  layerAlpha: [1, 1, 1, 1],
  bw: false,
  grayTone: [0, 85, 170, 255],
  minRegion: 12,
};
/** Params del schema viejo (v2 pre-matiz), solo para los tests de migración. */
const V2_PARAMS = { paletteIdx: [0, 1, 2, 3], bw: false, grayTone: [0, 85, 170, 255], minRegion: 12 };

function makeV3(overrides: Record<string, unknown> = {}): PaisajeDocument {
  const mk = (i: number): Layer =>
    makeLayer(
      [POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]],
      [i * 60, i * 60, i * 60],
      `M${i},0 L${i + 4},0 L${i + 4},4 Z`
    );
  return {
    format: FORMAT_NAME,
    version: 3,
    style: "posterized",
    generator: { name: "paisaje-sonoro-converter", version: "0.1.0" },
    image: { width: 100, height: 100, webp: "foto.webp" },
    params: { ...V3_PARAMS },
    layers: [mk(0), mk(1), mk(2), mk(3)],
    ...overrides,
  } as unknown as PaisajeDocument;
}

function makeV2old(overrides: Record<string, unknown> = {}): PaisajeDocument {
  const mk = (i: number): Layer =>
    makeLayer(
      [POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]],
      [i * 60, i * 60, i * 60],
      `M${i},0 L${i + 4},0 L${i + 4},4 Z`
    );
  return {
    format: FORMAT_NAME,
    version: 2,
    style: "posterized",
    generator: { name: "paisaje-sonoro-converter", version: "0.1.0" },
    image: { width: 100, height: 100, webp: "foto.webp" },
    params: { ...V2_PARAMS },
    layers: [mk(0), mk(1), mk(2), mk(3)],
    ...overrides,
  } as unknown as PaisajeDocument;
}

describe("packRGB / unpackRGB", () => {
  it("round-trip", () => {
    expect(unpackRGB(packRGB(255, 0, 128))).toEqual([255, 0, 128]);
    expect(unpackRGB(packRGB(0, 0, 0))).toEqual([0, 0, 0]);
    expect(unpackRGB(packRGB(255, 255, 255))).toEqual([255, 255, 255]);
  });
});

describe("roundRadius", () => {
  it("redondea a 1 decimal", () => {
    expect(roundRadius(8.67)).toBe(8.7);
    expect(roundRadius(3.04)).toBe(3);
    expect(roundRadius(12)).toBe(12);
  });
});

describe("isPaisajeDocument", () => {
  it("acepta un documento válido", () => {
    expect(isPaisajeDocument(makeDoc())).toBe(true);
  });

  it("rechaza points con longitud no múltiplo de 4", () => {
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3] }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3, 0, 1] }))).toBe(false);
  });

  it("rechaza colores fuera de rango o no enteros", () => {
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3, -1] }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3, 0xffffff + 1] }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3, 3.5] }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ points: [0, 0, 3, "rojo"] }))).toBe(false);
  });

  it("rechaza valores no finitos en x/y/r", () => {
    expect(isPaisajeDocument(makeDoc({ points: [NaN, 0, 3, 0] }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ points: [0, Infinity, 3, 0] }))).toBe(false);
  });

  it("rechaza params fuera de rango", () => {
    expect(isPaisajeDocument(makeDoc({ params: { step: 0, maxRadius: 4, multiplicador: 3, seed: 1, maxVisibleRatio: 0.4 } }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ params: { step: 12, maxRadius: -1, multiplicador: 3, seed: 1, maxVisibleRatio: 0.4 } }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ params: { step: 12, maxRadius: 4, multiplicador: 3, seed: 1, maxVisibleRatio: 1.5 } }))).toBe(false);
  });

  it("rechaza formato/version distintos y no-objetos", () => {
    expect(isPaisajeDocument(null)).toBe(false);
    expect(isPaisajeDocument("texto")).toBe(false);
    expect(isPaisajeDocument(makeDoc({ format: "otro" }))).toBe(false);
    expect(isPaisajeDocument(makeDoc({ version: 999 }))).toBe(false);
  });

  it("acepta image.webp === null", () => {
    expect(isPaisajeDocument(makeDoc({ image: { width: 10, height: 10, webp: null } }))).toBe(true);
  });
});

describe("validateAndMigrate", () => {
  it("devuelve el documento válido sin tocar", () => {
    const doc = makeDoc();
    expect(validateAndMigrate(doc)).toEqual(doc);
  });

  it("lanza error claro si la versión es MAYOR que la soportada", () => {
    expect(() => validateAndMigrate(makeDoc({ version: FORMAT_VERSION + 1 }))).toThrow(
      /versión más nueva/
    );
  });

  it("lanza error si el format no coincide", () => {
    expect(() => validateAndMigrate(makeDoc({ format: "x" }))).toThrow(/format/);
  });

  it("lanza error si la estructura es inválida tras migrar", () => {
    expect(() => validateAndMigrate(makeDoc({ points: [1, 2] }))).toThrow(/inválido/);
  });

  it("lanza error con no-objetos", () => {
    expect(() => validateAndMigrate(42)).toThrow(/objeto/);
  });

  it("v1 sigue siendo la versión 1 (no se migra a v2): compatibilidad hacia atrás", () => {
    const doc = makeDoc();
    const validated = validateAndMigrate(doc);
    expect(validated.version).toBe(1);
    expect(isPaisajeDocument(validated)).toBe(true);
  });
});

describe("isPaisajeDocument — v3 posterized (matiz libre)", () => {
  it("acepta un documento v3 válido (4 capas, bandas fijas ascendentes)", () => {
    expect(isPaisajeDocument(makeV3())).toBe(true);
    const d = validateAndMigrate(makeV3());
    expect(d.version).toBe(3);
  });

  it("rechaza 3 capas (o 5)", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    expect(isPaisajeDocument(makeV3({ layers: doc.layers.slice(0, 3) }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ layers: [...doc.layers, doc.layers[0]] }))).toBe(false);
  });

  it("rechaza bandas descendentes o solapadas", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    const bad = doc.layers.slice().reverse(); // 4000-10000 primero → descendente
    expect(isPaisajeDocument(makeV3({ layers: bad }))).toBe(false);
  });

  it("rechaza bandas fuera de rango", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    const layers = doc.layers.slice();
    layers[0] = makeLayer([20, 200], layers[0].palette, layers[0].path); // < 60 Hz
    expect(isPaisajeDocument(makeV3({ layers }))).toBe(false);
  });

  it("rechaza path vacío dentro de una capa", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    const layers = doc.layers.slice();
    layers[1] = makeLayer(layers[1].band, layers[1].palette, "");
    expect(isPaisajeDocument(makeV3({ layers }))).toBe(false);
    const badType = doc.layers.slice();
    badType[2] = { ...badType[2], path: 42 } as unknown as Layer;
    expect(isPaisajeDocument(makeV3({ layers: badType }))).toBe(false);
  });

  it("rechaza hueGlobal/layerAlpha/grayTone fuera de rango o mal formados, bw no booleano y minRegion negativo", () => {
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, hueGlobal: 181 } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, hueGlobal: -181 } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, hueGlobal: 10.5 } }))).toBe(false); // entero
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, layerAlpha: [0.5, 1, 1] } }))).toBe(false); // longitud
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, layerAlpha: [1.1, 1, 1, 1] } }))).toBe(false); // >1
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, layerAlpha: [1, -0.1, 1, 1] } }))).toBe(false); // <0
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, layerAlpha: ["1", 1, 1, 1] } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, removeBackground: "sí" } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, grayTone: [0, -1, 0, 0] } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, grayTone: [0, 300, 0, 0] } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, bw: "sí" } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, minRegion: -1 } }))).toBe(false);
    expect(isPaisajeDocument(makeV3({ params: { minRegion: 12 } }))).toBe(false); // faltan params
    // El validador es estructural (no closed-world): campos extra se ignoran.
    expect(isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, paletteIdx: [0, 1, 2, 3] } }))).toBe(true);
  });

  it("removeBackground es OPCIONAL (los docs sin él son válidos; default false)", () => {
    // V3_PARAMS no incluye removeBackground: los docs que lo omiten son válidos.
    expect(isPaisajeDocument(makeV3({ params: V3_PARAMS }))).toBe(true);
    expect(
      isPaisajeDocument(makeV3({ params: { ...V3_PARAMS, removeBackground: true } }))
    ).toBe(true);
  });

  it("acepta image.posterizedJpeg (string o null) y también su ausencia", () => {
    expect(
      isPaisajeDocument(makeV3({ image: { width: 100, height: 100, webp: "foto.webp", posterizedJpeg: "foto.posterizado.jpg" } }))
    ).toBe(true);
    expect(
      isPaisajeDocument(makeV3({ image: { width: 100, height: 100, webp: "foto.webp", posterizedJpeg: null } }))
    ).toBe(true);
    // Ausencia (documentos v1 y v2 antiguas): sigue siendo válida la imagen.
    expect(isPaisajeDocument(makeV3())).toBe(true);
    expect(isPaisajeDocument(makeDoc())).toBe(true);
  });

  it("rechaza capa sin color final", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    const layers = doc.layers.slice();
    layers[0] = { ...layers[0], color: [999, 0, 0] } as unknown as Layer;
    expect(isPaisajeDocument(makeV3({ layers }))).toBe(false);
  });

  it("rechaza paleta fuera de 0–255 o incompleta", () => {
    const doc = makeV3() as unknown as { layers: Layer[] };
    const layers = doc.layers.slice();
    layers[2] = makeLayer(layers[2].band, [300, 0, 0], layers[2].path);
    expect(isPaisajeDocument(makeV3({ layers }))).toBe(false);
  });

  it("rechaza v3 con style distinto de 'posterized'", () => {
    expect(isPaisajeDocument(makeV3({ style: "line-art" }))).toBe(false);
  });

  it("validateAndMigrate rechaza v3 inválido con error claro", () => {
    expect(() => validateAndMigrate(makeV3({ layers: [] }))).toThrow(/inválido/);
  });
});

describe("MIGRACIÓN v2 (paletteIdx) → v3 (hueGlobal + layerAlpha)", () => {
  it("un documento v2 viejo valida en el guard y migra a v3", () => {
    expect(isPaisajeDocument(makeV2old())).toBe(true); // schema viejo reconocido
    const migrated = validateAndMigrate(makeV2old());
    expect(migrated.version).toBe(3);
    expect(isPaisajeDocument(migrated)).toBe(true);
    const params = migrated.params as { hueGlobal: number; layerAlpha: number[]; paletteIdx?: number[] };
    expect(params.hueGlobal).toBe(0);
    expect(params.layerAlpha).toEqual([1, 1, 1, 1]);
    expect(params.paletteIdx).toBeUndefined();
  });

  it("la migración PRESERVA el color final EXACTO (Layer.color no se toca)", () => {
    // Capas con colores finales arbitrarios (incluida una "rotación"):
    // la v2 no recoloreaba por su semántica, y la v3 nueva tampoco toca el
    // color guardado: hueGlobal = 0 = identidad.
    const palette: Array<[number, number, number]> = [
      [200, 30, 30], [30, 160, 60], [40, 60, 180], [220, 200, 90],
    ];
    const finalColors: Array<[number, number, number]> = [
      [200, 30, 30], [210, 90, 40], [90, 60, 220], [220, 200, 90],
    ];
    const layers = palette.map((p, i) => ({
      ...makeLayer(
        [POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]],
        p,
        `M${i},0 L${i + 4},0 L${i + 4},4 Z`
      ),
      color: finalColors[i],
    }));
    const migrated = validateAndMigrate(makeV2old({ layers }));
    expect(migrated.version).toBe(3);
    (migrated as unknown as { layers: Layer[] }).layers.forEach((layer, i) => {
      expect(layer.color).toEqual(finalColors[i]);
    });
  });

  it("v2 con params incompletos se rechaza (no migra basura)", () => {
    expect(() =>
      validateAndMigrate(makeV2old({ params: { minRegion: 12 } }))
    ).toThrow(/inválido/);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// F2 (2026-10-11): normalización del v3 con matiz POR CAPA (hueShift, 2026-09-23)
// ─────────────────────────────────────────────────────────────────────────

const V3_OLD_PARAMS = { hueShift: [45, -30, 90, 0], bw: false, grayTone: [0, 85, 170, 255], minRegion: 12 };

describe("F2 · normalización v3 hueShift[4] → hueGlobal + layerAlpha", () => {
  it("un doc v3 viejo (matiz por capa) NO pasa el guard directo, pero validateAndMigrate lo normaliza", () => {
    const old = makeV3({ params: { ...V3_OLD_PARAMS } });
    expect(isPaisajeDocument(old)).toBe(false); // schema descartado
    const migrated = validateAndMigrate(old);
    expect(isPaisajeDocument(migrated)).toBe(true);
    const params = migrated.params as { hueGlobal: number; layerAlpha: number[]; hueShift?: number[] };
    expect(params.hueGlobal).toBe(0);
    expect(params.layerAlpha).toEqual([1, 1, 1, 1]);
    expect(params.hueShift).toBeUndefined(); // descartados
  });

  it("el look queda EXACTO: Layer.color se conserva bit a bit aunque hueShift no sea 0", () => {
    const palette: Array<[number, number, number]> = [
      [200, 30, 30], [30, 160, 60], [40, 60, 180], [220, 200, 90],
    ];
    // Colores finales distintos de la paleta (el usuario había girado matices):
    const finalColors: Array<[number, number, number]> = [
      [30, 200, 90], [160, 60, 30], [90, 180, 220], [90, 40, 220],
    ];
    const layers = palette.map((p, i) => ({
      ...makeLayer(
        [POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]],
        p,
        `M${i},0 L${i + 4},0 L${i + 4},4 Z`
      ),
      color: finalColors[i],
    }));
    const migrated = validateAndMigrate(makeV3({ params: { ...V3_OLD_PARAMS }, layers }));
    (migrated as unknown as { layers: Layer[] }).layers.forEach((layer, i) => {
      expect(layer.color).toEqual(finalColors[i]);
    });
  });

  it("conserva bw/grayTone/minRegion del doc viejo", () => {
    const migrated = validateAndMigrate(
      makeV3({ params: { ...V3_OLD_PARAMS, bw: true, grayTone: [10, 80, 160, 250], minRegion: 30 } })
    );
    const params = migrated.params as { bw: boolean; grayTone: number[]; minRegion: number };
    expect(params.bw).toBe(true);
    expect(params.grayTone).toEqual([10, 80, 160, 250]);
    expect(params.minRegion).toBe(30);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// v3 · style 'lineart' (LA-1 2026-09-24) — estilo nuevo, sin migraciones
// ─────────────────────────────────────────────────────────────────────────

const LINEART_PARAMS = { step: 8, maxLength: 12, strokeWidth: 2, seed: 42, maxVisibleRatio: 1 };

function makeLineArt(overrides: Record<string, unknown> = {}): PaisajeDocument {
  return {
    format: FORMAT_NAME,
    version: 3,
    style: "lineart",
    generator: { name: "paisaje-sonoro-converter", version: "0.1.0" },
    image: { width: 100, height: 100, webp: "foto.webp" },
    params: { ...LINEART_PARAMS },
    primitives: { segments: [0, 0, 90, 8.6, packRGB(10, 20, 30)] },
    ...overrides,
  } as unknown as PaisajeDocument;
}

describe("v3 · lineart (LA-1 2026-09-24)", () => {
  it("documento válido pasa el guard y validateAndMigrate lo devuelve tal cual (sin migración)", () => {
    const doc = makeLineArt();
    expect(isPaisajeDocument(doc)).toBe(true);
    const out = validateAndMigrate(doc);
    expect(out.version).toBe(3);
    expect((out as { style: string }).style).toBe("lineart");
    expect(isPaisajeDocument(out)).toBe(true);
  });

  it("rechaza segments cuya longitud no es múltiplo de 5", () => {
    const doc = makeLineArt() as unknown as { primitives: { segments: number[] } };
    doc.primitives.segments = [0, 0, 90, 8.6, 0, 4]; // 6 valores
    expect(isPaisajeDocument(doc)).toBe(false);
  });

  it("rechaza ángulos fuera de [0, 360)", () => {
    for (const bad of [-0.1, 360, 400]) {
      const doc = makeLineArt() as unknown as { primitives: { segments: number[] } };
      doc.primitives.segments = [0, 0, bad, 8.6, 0];
      expect(isPaisajeDocument(doc)).toBe(false);
    }
  });

  it("rechaza len ≤ 0", () => {
    for (const bad of [0, -3]) {
      const doc = makeLineArt() as unknown as { primitives: { segments: number[] } };
      doc.primitives.segments = [0, 0, 90, bad, 0];
      expect(isPaisajeDocument(doc)).toBe(false);
    }
  });

  it("rechaza colores no enteros o fuera de 0..0xffffff", () => {
    for (const bad of [12.5, -1, 0x1000000]) {
      const doc = makeLineArt() as unknown as { primitives: { segments: number[] } };
      doc.primitives.segments = [0, 0, 90, 8.6, bad];
      expect(isPaisajeDocument(doc)).toBe(false);
    }
  });

  it("LA-4: mode/umbral opcionales ('luz' por defecto, 'bordes' válido)", () => {
    const base = {
      step: 8,
      maxLength: 12,
      strokeWidth: 2,
      seed: 42,
      maxVisibleRatio: 1,
    };
    // sin mode/umbral → válido (docs previos a LA-4)
    expect(isPaisajeDocument(makeLineArt({ params: base }))).toBe(true);
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...base, mode: "bordes", umbral: 0.2 } }))
    ).toBe(true);
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...base, mode: "grabado" } }))
    ).toBe(false);
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...base, mode: "bordes", umbral: 0.9 } }))
    ).toBe(false);
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...base, umbral: 0.01 } }))
    ).toBe(false);
  });

  it("rechaza params incompletos o fuera de rango (strokeWidth, maxVisibleRatio)", () => {
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...LINEART_PARAMS, strokeWidth: 0 } }))
    ).toBe(false);
    expect(
      isPaisajeDocument(makeLineArt({ params: { ...LINEART_PARAMS, maxVisibleRatio: 1.5 } }))
    ).toBe(false);
    const { strokeWidth: _omit, ...noStroke } = LINEART_PARAMS;
    expect(isPaisajeDocument(makeLineArt({ params: noStroke }))).toBe(false);
  });

  it("rechaza version 3 con style desconocido o ausente", () => {
    expect(isPaisajeDocument(makeLineArt({ style: "unknown" }))).toBe(false);
    expect(isPaisajeDocument(makeLineArt({ style: undefined }))).toBe(false);
  });

  it("el posterized v3 sigue validando por su rama (regresión del guard)", () => {
    expect(isPaisajeDocument(makeV3())).toBe(true);
    expect(isPaisajeDocument(makeLineArt())).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// v3 · style 'azimuthal' (AZ-3 reescritura 2026-09-26) — mapa-esfera con
// keyframes de 5 parámetros (longitudCentral/paraleloEstandar/roll/pitch/
// yaw), medio de líneas de borde (params {step, maxLength, strokeWidth,
// umbral, maxVisibleRatio}, sin seed) y primitives.frames = 14 × segmentos
// [x, y, angle, len, rgb] con longitudes variables.

const AZ_PARAMS = { step: 12, maxLength: 16, strokeWidth: 2, umbral: 0.15, maxVisibleRatio: 1 };

function makeAzimuthal(overrides: Record<string, unknown> = {}): PaisajeDocument {
  const frame = [0, 0, 90, 8.6, 0];
  const frames = Array.from({ length: 14 }, () => [...frame]);
  return {
    format: FORMAT_NAME,
    version: 3,
    style: "azimuthal",
    generator: { name: "paisaje-sonoro-converter", version: "0.1.0" },
    image: { width: 100, height: 100, webp: "foto.webp" },
    params: { ...AZ_PARAMS },
    keyframes: [
      { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
      { longitudCentral: 30, paraleloEstandar: 10, roll: 45, pitch: -5, yaw: 0 },
      { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 40 },
    ],
    primitives: { frames },
    ...overrides,
  } as unknown as PaisajeDocument;
}

describe("v3 · azimuthal (AZ-3 reescritura, mapa-esfera)", () => {
  it("documento válido pasa el guard y validateAndMigrate lo devuelve tal cual (sin migración)", () => {
    const doc = makeAzimuthal();
    expect(isPaisajeDocument(doc)).toBe(true);
    const out = validateAndMigrate(doc);
    expect(out.version).toBe(3);
    expect((out as { style: string }).style).toBe("azimuthal");
    expect(isPaisajeDocument(out)).toBe(true);
  });

  it("rechaza menos de 14 frames", () => {
    const doc = makeAzimuthal() as unknown as { primitives: { frames: number[][] } };
    doc.primitives.frames = doc.primitives.frames.slice(0, 13);
    expect(isPaisajeDocument(doc)).toBe(false);
  });

  it("admite longitudes VARIABLES entre frames (organicidad de la deformación)", () => {
    const doc = makeAzimuthal() as unknown as { primitives: { frames: number[][] } };
    doc.primitives.frames[7] = [...doc.primitives.frames[7], 5, 5, 45, 3.2, 0]; // más largo
    expect(isPaisajeDocument(doc)).toBe(true);
  });

  it("rechaza frames de PUNTOS (%4) o segmentos con ángulo/len inválidos", () => {
    const doc = makeAzimuthal() as unknown as { primitives: { frames: number[][] } };
    doc.primitives.frames[3] = [0, 0, 3, 0]; // punto, no segmento
    expect(isPaisajeDocument(doc)).toBe(false);
    const doc2 = makeAzimuthal() as unknown as { primitives: { frames: number[][] } };
    doc2.primitives.frames[3] = [0, 0, 360, 8.6, 0]; // ángulo fuera de [0,360)
    expect(isPaisajeDocument(doc2)).toBe(false);
    const doc3 = makeAzimuthal() as unknown as { primitives: { frames: number[][] } };
    doc3.primitives.frames[3] = [0, 0, 90, 0, 0]; // len ≤ 0
    expect(isPaisajeDocument(doc3)).toBe(false);
  });

  it("rechaza keyframes con los 5 parámetros fuera de rango o incompletos", () => {
    const Z = { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 };
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [{ ...Z, longitudCentral: 200 }, Z, Z] }))
    ).toBe(false); // longitudCentral ±180
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [{ ...Z, paraleloEstandar: 120 }, Z, Z] }))
    ).toBe(false); // paraleloEstandar ±90
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [{ ...Z, pitch: 120 }, Z, Z] }))
    ).toBe(false); // pitch ±90
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [{ ...Z, roll: -190 }, Z, Z] }))
    ).toBe(false); // roll ±180
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [Z, Z] }))
    ).toBe(false); // solo 2 keyframes
    expect(
      isPaisajeDocument(makeAzimuthal({ keyframes: [{ roll: 0, pitch: 0, yaw: 0 }, Z, Z] }))
    ).toBe(false); // keyframe viejo de 3 campos
  });

  it("orbitMode: opcional (docs previos válidos), 'clamp'/'bounce' admitidos, otros rechazados", () => {
    expect(isPaisajeDocument(makeAzimuthal())).toBe(true); // sin orbitMode → 'clamp' por defecto
    expect(
      isPaisajeDocument(makeAzimuthal({ params: { ...AZ_PARAMS, orbitMode: "bounce" } }))
    ).toBe(true);
    expect(
      isPaisajeDocument(makeAzimuthal({ params: { ...AZ_PARAMS, orbitMode: "wrap" } }))
    ).toBe(false);
  });

  it("rechaza params inválidos: umbral fuera de [0.05, 0.6] u old shape (seed/radios)", () => {
    expect(
      isPaisajeDocument(makeAzimuthal({ params: { ...AZ_PARAMS, umbral: 0.7 } }))
    ).toBe(false);
    expect(
      isPaisajeDocument(makeAzimuthal({ params: { ...AZ_PARAMS, umbral: 0.01 } }))
    ).toBe(false);
    expect(
      isPaisajeDocument(
        makeAzimuthal({
          params: { step: 12, maxRadius: 4, multiplicador: 3, seed: 42, maxVisibleRatio: 1 },
        })
      )
    ).toBe(false);
  });

  it("los docs azimutal de PUNTOS (AZ-1/2) quedan inválidos con mensaje claro", () => {
    const oldDoc = makeAzimuthal({
      params: { step: 12, maxRadius: 4, multiplicador: 3, seed: 42, maxVisibleRatio: 1 },
      primitives: { frames: Array.from({ length: 14 }, () => [0, 0, 3, 0]) },
    });
    expect(isPaisajeDocument(oldDoc)).toBe(false);
    expect(() => validateAndMigrate(oldDoc)).toThrow(/pre-AZ-3|líneas de borde/);
  });

  it("rechaza version 3 con style desconocido (regresión de ramas)", () => {
    expect(isPaisajeDocument(makeAzimuthal({ style: "warp" }))).toBe(false);
    expect(isPaisajeDocument(makeV3())).toBe(true); // posterized intacto
    expect(isPaisajeDocument(makeLineArt())).toBe(true); // lineart intacto
  });
});
