/**
 * Volcado por capa (un SVG por capa de paleta, fill negro) + estadísticas
 * de ensamblado: segmentos, anillos y su bbox — forense del encadenamiento.
 * Uso: npx tsx scripts/dump-layers.ts <img.rgba> <w> <h> <salida> [--jpeg]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  posterizeImage,
  assignToPalette,
  traceLayerMasks,
  type TraceResult,
} from "../src/converter/posterize";
import { parseRings } from "./check-spikes";

const args = process.argv.slice(2);
const [rawPath, wStr, hStr, outBase] = args;
const width = Number(wStr);
const height = Number(hStr);
let useJpeg = false;
for (const a of args.slice(4)) if (a === "--jpeg") useJpeg = true;

const data = new Uint8ClampedArray(fs.readFileSync(rawPath));
const trace0 = posterizeImage({ width, height, data });
let trace = trace0;
if (useJpeg) {
  const raster = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const c = trace0.palette[trace0.idx[p]];
    raster[p * 4] = c[0]; raster[p * 4 + 1] = c[1]; raster[p * 4 + 2] = c[2]; raster[p * 4 + 3] = 255;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layers-"));
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

const layers = traceLayerMasks(trace, 12);
for (const { layer, path: d, mask } of layers) {
  const rings = parseRings(d);
  let maskPx = 0;
  for (let p = 0; p < mask.length; p++) maskPx += mask[p];
  // Estadísticas de anillos.
  let stats = rings
    .map((r, i) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of r) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      return { i, n: r.length, area: ((maxX - minX) * (maxY - minY)) / 4, bbox: [minX, minY, maxX, maxY] };
    })
    .sort((a, b) => b.area - a.area);
  console.log(`capa ${layer}: máscara ${maskPx} px · ${rings.length} anillos · top:`);
  for (const s of stats.slice(0, 5)) {
    console.log(`   anillo ${s.i}: ${s.n}v · bbox(${s.bbox.map((v) => v.toFixed(0)).join(",")}) · área caja ${s.area.toFixed(0)}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/><path d="${d}" fill="black" fill-rule="evenodd" stroke="none"/></svg>`;
  fs.writeFileSync(`${outBase}.capa${layer}.svg`, svg);
  // también volcar la máscara del trazador como SVG de píxeles (rectángulos
  // serían enormes; usamos imagen png vía svg embebido no — mejor pgm)
  fs.writeFileSync(`${outBase}.capa${layer}.pgm`, Buffer.concat([
    Buffer.from(`P5\n${width} ${height}\n255\n`),
    Buffer.from(mask.map((v) => (v ? 0 : 255))),
  ]));
}
console.log(`${outBase}.capa{0..3}.{svg,pgm}`);
