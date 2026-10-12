/**
 * Volcado de evidencia del posterizado: dado un .rgba (w×h), escribe
 *   <salida>.raster.png — el RASTER POSTERIZADO INTERMEDIO (imagen de
 *                          4 colores ANTES de trazar; comparable con el
 *                          "posterizar" manual de Krita del usuario);
 *   <salida>.svg          — los 4 paths trazados (ordenados oscura→clara,
 *                          con la banda de cada capa en <title>);
 * y mide púas (vértices <60°) con el parser corregido.
 *
 * Uso:
 *   npx tsx scripts/dump-posterized.ts <img.rgba> <w> <h> <salida> [--method=kmeans] [--minRegion=N] [--jpeg]
 *
 * --jpeg: corre el pipeline COMPLETO (raster → JPEG q92 con ffmpeg →
 * decodificar → re-snap a paleta) antes de trazar — el SVG resultante es
 * exactamente el de producción.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import {
  luminance,
  posterizeImage,
  assignToPalette,
  traceLayers,
  interiorAngleDeg,
  type PosterizeMethod,
} from "../src/converter/posterize";
import { POSTERIZED_BANDS } from "../src/converter/format";
import { parseRings } from "./check-spikes";

// ── PNG mínimo (RGBA 8-bit, filtros 0) ─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filtro None
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const [rawPath, wStr, hStr, outBase] = args;
const width = Number(wStr);
const height = Number(hStr);
let method: PosterizeMethod = "histogram";
let minRegion = 12;
let useJpeg = false;
for (const a of args.slice(4)) {
  if (a.startsWith("--method=")) method = a.split("=")[1] as PosterizeMethod;
  if (a.startsWith("--minRegion=")) minRegion = Number(a.split("=")[1]);
  if (a === "--jpeg") useJpeg = true;
}
if (!rawPath || !width || !height || !outBase) {
  console.error("Uso: npx tsx scripts/dump-posterized.ts <img.rgba> <w> <h> <salida> [--method=kmeans] [--minRegion=N] [--jpeg]");
  process.exit(1);
}

const data = new Uint8ClampedArray(fs.readFileSync(rawPath));
const t0 = Date.now();
const traceRaster = posterizeImage({ width, height, data }, { method });
let trace = traceRaster;

// Ronda JPEG q92 (pipeline completo): codifica el raster de 4 colores con
// ffmpeg, lo decodifica y re-snapea a la paleta. El raster volcado sigue
// siendo el intermedio (antes del JPEG).
if (useJpeg) {
  const raster = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const c = traceRaster.palette[traceRaster.idx[p]];
    raster[p * 4] = c[0]; raster[p * 4 + 1] = c[1]; raster[p * 4 + 2] = c[2]; raster[p * 4 + 3] = 255;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-"));
  const inRaw = path.join(dir, "in.rgba");
  const jpg = path.join(dir, "posterizado.jpg");
  const outRaw = path.join(dir, "out.rgba");
  fs.writeFileSync(inRaw, raster);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${width}x${height}`, "-i", inRaw, "-q:v", "2", jpg]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", jpg,
    "-f", "rawvideo", "-pix_fmt", "rgba", outRaw]);
  const decoded = new Uint8ClampedArray(fs.readFileSync(outRaw));
  fs.rmSync(dir, { recursive: true, force: true });
  trace = assignToPalette({ width, height, data: decoded }, traceRaster.palette);
}
const t1 = Date.now();
const traced = traceLayers(trace, minRegion);
const t2 = Date.now();

// 1) Raster posterizado intermedio (4 colores antes del JPEG y de trazar).
const raster = new Uint8ClampedArray(width * height * 4);
for (let p = 0; p < width * height; p++) {
  const c = traceRaster.palette[traceRaster.idx[p]];
  raster[p * 4] = c[0];
  raster[p * 4 + 1] = c[1];
  raster[p * 4 + 2] = c[2];
  raster[p * 4 + 3] = 255;
}
fs.writeFileSync(`${outBase}.raster.png`, encodePngRgba(width, height, raster));

// 2) SVG trazado (capas ordenadas oscura→clara, con banda en <title>).
const order = trace.palette
  .map((color, i) => ({ i, lum: luminance(color[0], color[1], color[2]) }))
  .sort((a, b) => a.lum - b.lum || a.i - b.i);
const paths = order.map((e, layerIdx) => {
  const fill = trace.palette[e.i];
  const n = (traced[e.i].path.match(/M/g) ?? []).length;
  return `<path d="${traced[e.i].path}" fill="rgb(${fill[0]},${fill[1]},${fill[2]})" fill-rule="evenodd" stroke="none"><title>capa ${layerIdx} · banda ${POSTERIZED_BANDS[layerIdx][0]}-${POSTERIZED_BANDS[layerIdx][1]} Hz · ${n} contornos</title></path>`;
});
fs.writeFileSync(
  `${outBase}.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${paths.join("")}</svg>`
);

// 3) Medición: <60° crudos y AGUJAS (estándar 2026-09-23: <60° interior con
//    una arista adyacente ≤ 2.5 px; los <60° de aristas largas son esquinas
//    naturales del borde real y los del marco son uniones genuinas).
let totalVerts = 0, minAngle = Infinity, puas = 0, agujas = 0;
const perLayer: string[] = [];
traced.forEach((layer, li) => {
  let lv = 0, lp = 0, la = 0;
  for (const ring of parseRings(layer.path)) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const ang = interiorAngleDeg(ring, i);
      totalVerts++; lv++;
      if (ang < minAngle) minAngle = ang;
      if (ang < 60) {
        puas++; lp++;
        const [x, y] = ring[i];
        if (x > 0.5 && y > 0.5 && x < width - 0.5 && y < height - 0.5) {
          const e1 = Math.hypot(ring[(i - 1 + n) % n][0] - x, ring[(i - 1 + n) % n][1] - y);
          const e2 = Math.hypot(ring[(i + 1) % n][0] - x, ring[(i + 1) % n][1] - y);
          if (Math.min(e1, e2) <= 2.5) { agujas++; la++; }
        }
      }
    }
  }
  perLayer.push(`c${li}:${lv}v/${lp}p/${la}a`);
});

console.log(`${rawPath.split("/").pop()} → ${outBase}.{raster.png,svg}  (método=${method}, minRegion=${minRegion}${useJpeg ? ", JPEG q92 + re-snap" : ""})`);
console.log(`  tiempos: posterizar ${t1 - t0} ms · trazar ${t2 - t1} ms`);
console.log(`  paleta: ${trace.palette.map((p) => `rgb(${p.join(",")})`).join(" | ")}`);
console.log(`  ${totalVerts} vértices · ángulo mínimo ${minAngle.toFixed(1)}° · <60°: ${puas} · AGUJAS: ${agujas}  [${perLayer.join(" ")}]`);
console.log(`  tamaños: raster ${(fs.statSync(`${outBase}.raster.png`).size / 1024).toFixed(0)} KB · svg ${(fs.statSync(`${outBase}.svg`).size / 1024).toFixed(0)} KB`);
