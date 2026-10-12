// Análisis de púas: traza fotos reales y mide los ángulos internos de todos
// los contornos generados. Uso:
//   npx tsx scripts/check-spikes.ts [--method=kmeans] <img.rgba> <w> <h> [img2...]
//
// FIX 2026-09-22: el split anterior (" Z") dejaba el subpath siguiente como
// " M…" (con espacio inicial); el replace(/^M/) no actuaba, el anillo se
// medía SIN su primer vértice y se inventaban cientos de púas falsas
// (352 contados vs 12 reales en krita3).
import fs from "node:fs";
import { posterizeImage, traceLayers, type PosterizeMethod } from "../src/converter/posterize";

function interiorAngles(ring: Array<[number, number]>): number[] {
  const n = ring.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = ring[(i - 1 + n) % n];
    const [cx, cy] = ring[i];
    const [nx, ny] = ring[(i + 1) % n];
    const v1x = px - cx, v1y = py - cy;
    const v2x = nx - cx, v2y = ny - cy;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    out.push(m === 0 ? 180 : (Math.acos(Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / m))) * 180) / Math.PI);
  }
  return out;
}

/** Parsea "M…Z M…Z" en anillos, robusto al separador. */
export function parseRings(path: string): Array<Array<[number, number]>> {
  const trimmed = path.trim();
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

const isMain = !!process.argv[1]?.endsWith("check-spikes.ts");

if (isMain) {
  const args = process.argv.slice(2);
  let method: PosterizeMethod = "histogram";
  if (args[0]?.startsWith("--method=")) {
    method = args.shift()!.split("=")[1] as PosterizeMethod;
  }

  for (let a = 0; a < args.length; a += 3) {
  const rawPath = args[a];
  const w = Number(args[a + 1]);
  const h = Number(args[a + 2]);
  const data = new Uint8ClampedArray(fs.readFileSync(rawPath));
  const t0 = Date.now();
  const trace = posterizeImage({ width: w, height: h, data }, { method });
  const t1 = Date.now();
  const traced = traceLayers(trace, 12);
  const t2 = Date.now();

  let totalVerts = 0, minAngle = Infinity, puas = 0, agujas = 0;
  const perLayer: string[] = [];
  traced.forEach((layer, li) => {
    let lv = 0, lp = 0, la = 0, lmin = Infinity;
    for (const ring of parseRings(layer.path)) {
      const n = ring.length;
      const angles = interiorAngles(ring);
      for (let i = 0; i < n; i++) {
        const ang = angles[i];
        totalVerts++; lv++;
        if (ang < minAngle) minAngle = ang;
        if (ang < lmin) lmin = ang;
        if (ang < 60) {
          puas++; lp++;
          // AGUJA (estándar 2026-09-23): <60° INTERIOR (a > 0.5 px del
          // borde — los del marco son uniones contenido↔borde genuinas) y
          // con una arista adyacente ≤ 2.5 px (escala de línea fina). El
          // resto de <60° son esquinas naturales del borde real.
          const [x, y] = ring[i];
          if (x > 0.5 && y > 0.5 && x < w - 0.5 && y < h - 0.5) {
            const e1 = Math.hypot(ring[(i - 1 + n) % n][0] - x, ring[(i - 1 + n) % n][1] - y);
            const e2 = Math.hypot(ring[(i + 1) % n][0] - x, ring[(i + 1) % n][1] - y);
            if (Math.min(e1, e2) <= 2.5) { agujas++; la++; }
          }
        }
      }
    }
    perLayer.push(`c${li}:${lv}v/${lp}p/${la}a`);
  });
  console.log(`${rawPath.split("/").pop()} (${w}×${h}, método=${method}): posterizar ${t1 - t0} ms + trazar ${t2 - t1} ms`);
  console.log(`  ${traced.length} capas · ${totalVerts} vértices totales · ángulo interno mínimo ${minAngle.toFixed(1)}° · <60°: ${puas} · AGUJAS: ${agujas}  [${perLayer.join(" ")}]`);
  console.log(`  paleta: ${trace.palette.map((p) => `rgb(${p.join(",")})`).join(" | ")}`);
  }
}
