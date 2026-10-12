/**
 * Volcado anillo a anillo de UNA capa (un SVG por anillo, fill negro) para
 * aislar qué anillo produce el artefacto visual. Muestra también el grado de
 * cada punto de la retícula (cuántos puntos tienen grado 4).
 * Uso: npx tsx scripts/dump-rings.ts <img.rgba> <w> <h> <capa> <salida> [--jpeg]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  posterizeImage,
  assignToPalette,
  traceLayerMasks,
  debugTracerSegments,
  type TraceResult,
} from "../src/converter/posterize";
import { parseRings } from "./check-spikes";

const args = process.argv.slice(2);
const [rawPath, wStr, hStr, layerStr, outBase] = args;
const width = Number(wStr);
const height = Number(hStr);
const layerIdx = Number(layerStr);
let useJpeg = false;
for (const a of args.slice(5)) if (a === "--jpeg") useJpeg = true;

const data = new Uint8ClampedArray(fs.readFileSync(rawPath));
const trace0 = posterizeImage({ width, height, data });
let trace = trace0;
if (useJpeg) {
  const raster = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const c = trace0.palette[trace0.idx[p]];
    raster[p * 4] = c[0]; raster[p * 4 + 1] = c[1]; raster[p * 4 + 2] = c[2]; raster[p * 4 + 3] = 255;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rings-"));
  const inRaw = path.join(dir, "in.rgba");
  const jpg = path.join(dir, "p.jpg");
  const outRaw = path.join(dir, "out.rgba");
  fs.writeFileSync(inRaw, raster);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${width}x${height}`, "-i", inRaw, "-q:v", "2", jpg]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", jpg, "-f", "rawvideo", "-pix_fmt", "rgba", outRaw]);
  trace = assignToPalette({ width, height, data: new Uint8ClampedArray(fs.readFileSync(outRaw)) }, trace0.palette);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Grados y segmentos EXACTOS del trazador (misma rejilla preparada).
const { segments, degrees } = debugTracerSegments(trace, 12, layerIdx);
const degHist = new Map<number, number>();
for (const d of degrees.values()) degHist.set(d, (degHist.get(d) ?? 0) + 1);
console.log(`segmentos: ${segments.length} · grados: ${[...degHist.entries()].sort().map(([d, n]) => `g${d}:${n}`).join(" ")}`);
const odd = [...degrees.entries()].filter(([, d]) => d !== 2);
console.log(`puntos con grado ≠ 2: ${odd.length}`);
for (const [k, d] of odd.slice(0, 30)) {
  console.log(`   (${(Math.floor(k / 100000) / 2).toFixed(1)}, ${((k % 100000) / 2).toFixed(1)}) grado ${d}`);
}

// Réplica del ensamblado sobre los segmentos reales (con grado 2 es único).
const adjacency = new Map<number, Array<[number, number]>>();
segments.forEach(([a, b], id) => {
  if (!adjacency.has(a)) adjacency.set(a, []);
  if (!adjacency.has(b)) adjacency.set(b, []);
  adjacency.get(a)!.push([b, id]);
  adjacency.get(b)!.push([a, id]);
});
const used = new Array<boolean>(segments.length).fill(false);
const rawRings: number[][] = [];
let broken = 0;
for (let s = 0; s < segments.length; s++) {
  if (used[s]) continue;
  used[s] = true;
  const [a0, b0] = segments[s];
  const ringKeys = [a0, b0];
  let cur = b0;
  let guard = 0;
  while (cur !== a0 && guard++ <= segments.length + 1) {
    const next = adjacency.get(cur)!.find(([, id]) => !used[id]);
    if (!next) { broken++; break; }
    used[next[1]] = true;
    cur = next[0];
    if (cur !== a0) ringKeys.push(cur);
  }
  rawRings.push(ringKeys);
}
console.log(`anillos ensamblados: ${rawRings.length} · anillos ROTOS (sin cerrar): ${broken}`);
// Puntos repetidos dentro de cada anillo (autotangencia).
rawRings.forEach((rk, i) => {
  const seen = new Set<number>();
  let repeats = 0;
  for (const k of rk) { if (seen.has(k)) repeats++; seen.add(k); }
  if (repeats > 0) {
    console.log(`anillo crudo ${i}: ${rk.length} puntos · ${repeats} repetido(s)`);
    const first = rk.find((k) => rk.indexOf(k) !== rk.lastIndexOf(k));
    if (first !== undefined) {
      console.log(`   punto repetido: (${(Math.floor(first / 100000) / 2).toFixed(1)}, ${((first % 100000) / 2).toFixed(1)})`);
    }
  }
});

// Un SVG por anillo del path final.
const rings = parseRings(traceLayerMasks(trace, 12)[layerIdx].path);
rings.forEach((ring, i) => {
  const d = `M${ring.map(([x, y]) => `${x},${y}`).join(" L")} Z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/><path d="${d}" fill="black" fill-rule="evenodd" stroke="none"/></svg>`;
  fs.writeFileSync(`${outBase}.anillo${i}.svg`, svg);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  console.log(`anillo ${i}: ${ring.length}v · bbox(${minX.toFixed(0)},${minY.toFixed(0)},${maxX.toFixed(0)},${maxY.toFixed(0)})`);
});
