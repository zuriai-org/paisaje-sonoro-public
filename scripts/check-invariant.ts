/**
 * EVIDENCIA DEL VALIDADOR DE INVARIANTE (debug forense del trazador).
 *
 * Para cada .rgba dado, corre el pipeline COMPLETO como en producción:
 *   posterizeImage → raster → JPEG q92 (ffmpeg) → decodificar → re-snap
 *   (assignToPalette) → traceLayerMasks → validateLayerPath
 * y vuelca por capa: nº de violaciones del invariante (vértices >1.1 px de
 * un píxel de frontera / segmentos que saltan lejos de la frontera) con
 * coordenadas, más el entorno LITERAL de las peores púas.
 *
 * También corre el trazado DIRECTO (sin ronda JPEG) para comparar.
 *
 * Uso:
 *   npx tsx scripts/check-invariant.ts <img.rgba> <w> <h> [--minRegion=N]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import {
  posterizeImage,
  assignToPalette,
  traceLayerMasks,
  interiorAngleDeg,
  type TraceResult,
} from "../src/converter/posterize";
import {
  validateLayerPath,
  parsePathRings,
  type InvariantViolation,
} from "../src/converter/traceInvariant";

const args = process.argv.slice(2);
const [rawPath, wStr, hStr] = args;
const width = Number(wStr);
const height = Number(hStr);
let minRegion = 12;
for (const a of args.slice(3)) {
  if (a.startsWith("--minRegion=")) minRegion = Number(a.split("=")[1]);
}
if (!rawPath || !width || !height) {
  console.error("Uso: npx tsx scripts/check-invariant.ts <img.rgba> <w> <h> [--minRegion=N]");
  process.exit(1);
}

const data = new Uint8ClampedArray(fs.readFileSync(rawPath));

/** Ronda JPEG q92 real con ffmpeg (codifica el raster de 4 colores). */
function jpegRoundTrip(trace: TraceResult): TraceResult {
  const raster = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const c = trace.palette[trace.idx[p]];
    raster[p * 4] = c[0];
    raster[p * 4 + 1] = c[1];
    raster[p * 4 + 2] = c[2];
    raster[p * 4 + 3] = 255;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  const inRaw = path.join(dir, "in.rgba");
  const jpg = path.join(dir, "posterizado.jpg");
  const outRaw = path.join(dir, "out.rgba");
  fs.writeFileSync(inRaw, raster);
  // -q:v 2 ≈ calidad alta (~q92 del navegador) sobre colores planos.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${width}x${height}`, "-i", inRaw, "-q:v", "2", jpg]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", jpg,
    "-f", "rawvideo", "-pix_fmt", "rgba", outRaw]);
  const decoded = new Uint8ClampedArray(fs.readFileSync(outRaw));
  fs.rmSync(dir, { recursive: true, force: true });
  return assignToPalette({ width, height, data: decoded }, trace.palette);
}

interface Report {
  vertices: number;
  minAngle: number;
  violations: InvariantViolation[];
}

function analyze(trace: TraceResult, label: string): void {
  console.log(`\n═══ ${label} ═══`);
  const layers = traceLayerMasks(trace, minRegion);
  let totalViolations = 0;
  for (const { layer, path: d, mask, width: w, height: h, coarse } of layers) {
    const rings = parsePathRings(d);
    let vertices = 0;
    let minAngle = Infinity;
    let spikeVerts: Array<{ ring: number; i: number; angle: number }> = [];
    rings.forEach((ring, ri) => {
      ring.forEach((_, i) => {
        const a = interiorAngleDeg(ring, i);
        vertices++;
        if (a < minAngle) minAngle = a;
        if (a < 60) spikeVerts.push({ ring: ri, i, angle: a });
      });
    });
    const violations = validateLayerPath(mask, w, h, d);
    totalViolations += violations.length;
    const vCount = violations.filter((v) => v.kind === "vertex").length;
    const sCount = violations.filter((v) => v.kind === "segment").length;
    console.log(
      `capa ${layer} (${coarse ? "rejilla 0.5×" : "resolución plena"}): ` +
      `${vertices}v · ángulo mín ${minAngle.toFixed(1)}° · púas<60°: ${spikeVerts.length} · ` +
      `VIOLACIONES: ${violations.length} (${vCount} vértices, ${sCount} segmentos)`
    );
    // Detalle: TODAS las violaciones ORDENADAS POR DISTANCIA (las graves primero).
    const byDist = [...violations].sort((a, b) => b.distance - a.distance);
    for (const v of byDist.slice(0, 10)) {
      if (v.kind === "vertex") {
        console.log(
          `   ✗ VÉRTICE anillo ${v.ring}#[${v.vertexIndex}] (${v.point[0]}, ${v.point[1]}) ` +
          `a ${v.distance.toFixed(2)} px de la frontera`
        );
      } else {
        const seg = v.segment!;
        console.log(
          `   ✗ SEGMENTO anillo ${v.ring}#[${v.vertexIndex}] (${seg.from}) → (${seg.to}) ` +
          `· ${seg.failingSamples}/${seg.samples} muestras fuera · 1ª en (${v.point[0].toFixed(1)}, ${v.point[1].toFixed(1)}) a ${v.distance.toFixed(2)} px`
        );
      }
    }
    // Entorno LITERAL de hasta 3 púas (vértices <60°): 4 vértices antes/después.
    for (const s of spikeVerts.slice(0, 3)) {
      const ring = rings[s.ring];
      const n = ring.length;
      const ctx: string[] = [];
      for (let k = -4; k <= 4; k++) {
        const pt = ring[(s.i + k + n) % n];
        ctx.push(`(${pt[0]},${pt[1]})${k === 0 ? "◄PÚA " + s.angle.toFixed(1) + "°" : ""}`);
      }
      console.log(`   ▼ púa anillo ${s.ring}#[${s.i}]: ${ctx.join(" ")}`);
    }
  }
  console.log(`→ TOTAL violaciones invariante: ${totalViolations}`);
}

const trace0 = posterizeImage({ width, height, data });
analyze(trace0, `${path.basename(rawPath)} · DIRECTO (sin ronda JPEG) · minRegion=${minRegion}`);
const traceJ = jpegRoundTrip(trace0);
analyze(traceJ, `${path.basename(rawPath)} · PIPELINE COMPLETO (JPEG q92 → re-snap) · minRegion=${minRegion}`);
