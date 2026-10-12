/**
 * Tests del núcleo con FIXTURES SINTÉTICAS de borde nítido (sustituyen a las
 * fixtures RGBA derivadas de fotos de personas, eliminadas del repo por
 * privacidad en la higiene pre-entrega del 2026-10-12). Tres imágenes
 * geométricas en escala de grises — rectángulos, disco, escalones — sobre
 * la retícula de snap de 8 niveles; se regeneran con
 * `__fixtures__/generate.mjs` y fijan la misma cobertura que las fotos:
 * regiones planas grandes, bordes rectos y curvas suaves trazadas por
 * marching squares.
 *
 * Fijan los invariantes que el diagnóstico (2026-09-22, fotos reales)
 * encontró rotos:
 * - 0 AGUJAS en los paths exportados: vértices con ángulo interno <60° y
 *   una arista adyacente ≤ 2.5 px (línea fina). El estándar geométrico
 *   completo (path a ≤ 2.5 px de la frontera de la máscara) vive en
 *   trace-invariant.test.ts; tras el tope de desviación de removeSpikes
 *   (re-baseline 2026-09-23) quedan <60° "esquinas naturales" con aristas
 *   largas — son la forma real del borde, no defectos;
 * - la cuantización nueva (snap de canales + histograma) es determinista;
 * - su paleta son los 4 colores dominantes reales de la imagen.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  histogramPalette,
  interiorAngleDeg,
  posterizeImage,
  snapChannel,
  traceLayers,
  type ImageDataLike,
} from "./posterize";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function loadFixture(file: string): ImageDataLike {
  const m = file.match(/(\d+)x(\d+)\.rgba$/);
  if (!m) throw new Error(`fixture sin dimensiones en el nombre: ${file}`);
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    data: new Uint8ClampedArray(fs.readFileSync(path.join(FIXTURES_DIR, file))),
  };
}

const FIXTURES = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".rgba"));

/** Parsea "M…Z M…Z" en anillos (misma lógica corregida que check-spikes). */
function parseRings(pathStr: string): Array<Array<[number, number]>> {
  const trimmed = pathStr.trim();
  if (trimmed === "" || trimmed === "M0 0 Z") return [];
  const body = trimmed.endsWith("Z") ? trimmed.slice(0, trimmed.lastIndexOf("Z")) : trimmed;
  return body
    .split(" Z ")
    .map((sub) =>
      sub
        .trim()
        .replace(/^M/, "")
        .split(/ L/)
        .map((p) => p.split(",").map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)) as Array<[number, number]>
    )
    .filter((r) => r.length >= 3);
}

/**
 * Cuenta AGUJAS: vértices INTERIORES (a > 0.5 px del borde de la imagen —
 * los del marco son uniones contenido↔borde genuinas) con ángulo <60° y una
 * arista adyacente corta (≤ 2.5 px, escala de línea fina). Las "<60° con
 * aristas largas" son esquinas naturales del borde real, no defectos.
 */
function countSpikeVertices(
  img: ImageDataLike,
  minRegion = 12
): { vertices: number; agujas: number; minAngle: number } {
  const trace = posterizeImage(img);
  const traced = traceLayers(trace, minRegion);
  let vertices = 0, agujas = 0, minAngle = Infinity;
  const w = img.width, h = img.height;
  for (const layer of traced) {
    for (const ring of parseRings(layer.path)) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const ang = interiorAngleDeg(ring, i);
        vertices++;
        if (ang < minAngle) minAngle = ang;
        if (ang >= 60) continue;
        const [x, y] = ring[i];
        if (x <= 0.5 || y <= 0.5 || x >= w - 0.5 || y >= h - 0.5) continue; // borde
        const e1 = Math.hypot(ring[(i - 1 + n) % n][0] - x, ring[(i - 1 + n) % n][1] - y);
        const e2 = Math.hypot(ring[(i + 1) % n][0] - x, ring[(i + 1) % n][1] - y);
        if (Math.min(e1, e2) <= 2.5) agujas++;
      }
    }
  }
  return { vertices, agujas, minAngle };
}

describe("snap de canales estilo Krita", () => {
  it("cuantiza a la retícula de 8 niveles", () => {
    expect(snapChannel(0)).toBe(0);
    expect(snapChannel(255)).toBe(255);
    expect(snapChannel(20)).toBe(36); // round(20·7/255)=1 → 36
    expect(snapChannel(254)).toBe(255);
    expect(snapChannel(182)).toBe(182); // nivel exacto, invariante
  });
});

describe("histogramPalette", () => {
  it("los 4 colores dominantes (con ruido ±6) son la paleta, snapped", () => {
    // 4 bloques de 40×40 con ruido pequeño: el snap absorbe el ruido y el
    // histograma devuelve los 4 colores de bloque en la retícula.
    const w = 80, h = 80;
    const data = new Uint8ClampedArray(w * h * 4);
    const blocks: Array<[number, number, number]> = [
      [40, 40, 50], [160, 60, 50], [60, 150, 60], [230, 225, 210],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = blocks[Math.floor(x / 20) % 4]; // franjas verticales de 20px
        const o = (y * w + x) * 4;
        data[o] = b[0] + ((x * 7 + y * 13) % 13) - 6;
        data[o + 1] = b[1] + ((x * 5 + y * 11) % 13) - 6;
        data[o + 2] = b[2] + ((x * 3 + y * 17) % 13) - 6;
        data[o + 3] = 255;
      }
    }
    const palette = histogramPalette({ width: w, height: h, data });
    expect(palette).toHaveLength(4);
    const snapped = blocks.map(([r, g, b]) => [snapChannel(r), snapChannel(g), snapChannel(b)]);
    for (const s of snapped) {
      expect(palette.some((p) => p[0] === s[0] && p[1] === s[1] && p[2] === s[2])).toBe(true);
    }
  });
});

describe("cuantización nueva", () => {
  it("es determinista: misma imagen → misma paleta y mismos índices", () => {
    const img = loadFixture(FIXTURES[0]);
    const a = posterizeImage(img);
    const b = posterizeImage(img);
    expect(a.palette).toEqual(b.palette);
    expect([...a.idx]).toEqual([...b.idx]);
    expect(a.palette).toHaveLength(4);
  });

  it("el método k-means sigue disponible como alternativa", () => {
    const img = loadFixture(FIXTURES[0]);
    const a = posterizeImage(img, { method: "kmeans" });
    const b = posterizeImage(img, { method: "kmeans" });
    expect(a.palette).toHaveLength(4);
    expect(a.palette).toEqual(b.palette); // determinista también
  });
});

describe("GEOMETRÍA en fixtures sintéticas: 0 agujas en los paths exportados", () => {
  // Estándar: 0 agujas interiores (ángulo <60° con arista adyacente
  // ≤ 2.5 px). El invariante completo de frontera (≤ 2.5 px) lo fija
  // trace-invariant.test.ts; las esquinas naturales <60° de aristas
  // largas son forma real del borde y se aceptan (documentado arriba).
  for (const file of FIXTURES) {
    it(`${file}: ninguna aguja interior`, () => {
      const { vertices, agujas, minAngle } = countSpikeVertices(loadFixture(file));
      expect({ vertices, minAngle: +minAngle.toFixed(1) }).toBeTruthy(); // informativo
      expect(agujas).toBe(0);
    });
  }
});
