/**
 * Tests de buildPaisajeJson (Wizard, LA-2): el asistente escribe el JSON del
 * estilo elegido y el type-guard del backend lo valida.
 * - Line Art → v3 lineart (segments + params {step, maxLength, strokeWidth,
 *   seed, maxVisibleRatio}).
 * - Regresión: puntillista → v1; posterizado → v3 posterized.
 */
import { describe, it, expect } from "vitest";
import { buildPaisajeJson } from "./Wizard";
import {
  isPaisajeDocument,
  packRGB,
  POSTERIZED_BANDS,
  type Layer,
} from "../converter/format";
import type { StyleDocument } from "../styles/registry";

function baseDoc(overrides: Partial<StyleDocument> = {}): StyleDocument {
  return {
    points: [],
    layers: null,
    segments: null,
    params: {},
    width: 100,
    height: 100,
    name: "foto.jpg",
    seed: 42,
    maxVisibleRatio: 1,
    webp: null,
    webpName: "foto.webp",
    ...overrides,
  };
}

async function parse(blob: Blob): Promise<unknown> {
  return JSON.parse(await blob.text()) as unknown;
}

describe("buildPaisajeJson (asistente)", () => {
  it("lineart → v3 lineart que valida con el type-guard", async () => {
    const doc = baseDoc({
      segments: [10, 10, 90, 8, packRGB(255, 0, 0)],
      params: { step: 14, maxLength: 16, strokeWidth: 2 },
    });
    const json = await parse(buildPaisajeJson(doc));
    expect(isPaisajeDocument(json)).toBe(true);
    const d = json as {
      version: number;
      style: string;
      params: Record<string, number>;
      primitives: { segments: number[] };
    };
    expect(d.version).toBe(3);
    expect(d.style).toBe("lineart");
    expect(d.params).toEqual({
      step: 14,
      maxLength: 16,
      strokeWidth: 2,
      seed: 42,
      maxVisibleRatio: 1,
      mode: "luz",
      umbral: 0.15,
    });
    expect(d.primitives.segments).toHaveLength(5);
  });

  it("puntillista → v1 intacto (regresión)", async () => {
    const doc = baseDoc({
      points: [0, 0, 3, packRGB(1, 2, 3)],
      params: { step: 12, maxRadius: 4, multiplicador: 3 },
    });
    const json = await parse(buildPaisajeJson(doc));
    expect(isPaisajeDocument(json)).toBe(true);
    expect((json as { version: number }).version).toBe(1);
  });

  it("posterizado → v3 posterized intacto (regresión)", async () => {
    const layers: Layer[] = [0, 1, 2, 3].map((i) => ({
      band: [POSTERIZED_BANDS[i][0], POSTERIZED_BANDS[i][1]] as [number, number],
      palette: [i * 60, i * 60, i * 60] as [number, number, number],
      color: [i * 60, i * 60, i * 60] as [number, number, number],
      path: `M${i},0 L${i + 4},0 L${i + 4},4 Z`,
    }));
    const doc = baseDoc({
      layers,
      params: {
        hueGlobal: 25,
        layerAlpha: [1, 0.6, 1, 0.2],
        bw: false,
        grayTone: [0, 85, 170, 255],
        minRegion: 12,
        removeBackground: true,
      },
    });
    const json = await parse(buildPaisajeJson(doc));
    expect(isPaisajeDocument(json)).toBe(true);
    const d = json as { version: number; style: string; params: Record<string, unknown> };
    expect(d.version).toBe(3);
    expect(d.style).toBe("posterized");
    // F2: matiz global + transparencia por capa + quitar fondo, persistidos.
    expect(d.params.hueGlobal).toBe(25);
    expect(d.params.layerAlpha).toEqual([1, 0.6, 1, 0.2]);
    expect(d.params.removeBackground).toBe(true);
  });
});


describe("buildPaisajeJson · azimutal (AZ-3)", () => {
  it("azimutal → v3 azimuthal (líneas de borde) que valida con el type-guard", async () => {
    const frame = [0, 0, 90, 8.6, 0]; // segmento negro
    const frames = Array.from({ length: 14 }, () => [...frame]);
    const keyframes: [
      { longitudCentral: number; paraleloEstandar: number; roll: number; pitch: number; yaw: number },
      { longitudCentral: number; paraleloEstandar: number; roll: number; pitch: number; yaw: number },
      { longitudCentral: number; paraleloEstandar: number; roll: number; pitch: number; yaw: number }
    ] = [
      { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
      { longitudCentral: 30, paraleloEstandar: 10, roll: 45, pitch: -5, yaw: 0 },
      { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 45 },
    ];
    const doc = baseDoc({
      frames,
      keyframes,
      params: { step: 12, maxLength: 16, strokeWidth: 2, umbral: 0.2 },
    });
    const json = await parse(buildPaisajeJson(doc));
    expect(isPaisajeDocument(json)).toBe(true);
    const d = json as {
      version: number;
      style: string;
      params: Record<string, number>;
      keyframes: Array<{ longitudCentral: number; paraleloEstandar: number; roll: number; pitch: number; yaw: number }>;
      primitives: { frames: number[][] };
    };
    expect(d.version).toBe(3);
    expect(d.style).toBe("azimuthal");
    expect(d.params).toEqual({
      step: 12,
      maxLength: 16,
      strokeWidth: 2,
      umbral: 0.2,
      maxVisibleRatio: 1,
      orbitMode: "clamp", // default del editor cuando no se elige rebote
    });
    expect(d.keyframes).toEqual(keyframes);
    expect(d.primitives.frames).toHaveLength(14);
  });
});
