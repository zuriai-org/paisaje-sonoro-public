/**
 * Genera las fixtures sintéticas de los tests del trazador/posterizado:
 * imágenes GEOMÉTRICAS de bordes nítidos (rectángulos, disco, escalones)
 * en escala de grises sobre la retícula de snap de 8 niveles
 * (0, 73, 146, 255). Reemplazan a las fixtures derivadas de fotos de
 * personas (eliminadas del repo por privacidad en la higiene pre-entrega).
 *
 * Uso: node src/converter/__fixtures__/generate.mjs
 * Salida: synth-shapes-414x360.rgba, synth-blocks-360x360.rgba,
 *         synth-step-360x360.rgba (RGBA crudo, WxH en el nombre).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const BLACK = 0, DARK = 73, LIGHT = 146, WHITE = 255;

function makeImage(width, height, draw) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = draw(x, y);
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

/** Rectángulo relleno [x0,x1) × [y0,y1). */
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Disco sólido (borde duro, sin antialiasing). */
const disk = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Escalera: escalones de stepW px de ancho que crecen stepH px por nivel. */
const staircase = (x, y, x0, yBase, stepW, stepH, levels) => {
  const level = Math.floor((x - x0) / stepW);
  if (level < 0 || level >= levels) return false;
  return y >= yBase - stepH * (level + 1) && y < yBase;
};

const FIXTURES = [
  {
    file: "synth-shapes-414x360.rgba",
    width: 414,
    height: 360,
    draw: (x, y) => {
      if (rect(x, y, 40, 40, 180, 200)) return BLACK; // rectángulo
      if (disk(x, y, 290, 170, 85)) return DARK; // disco
      if (staircase(x, y, 20, 340, 45, 20, 5)) return LIGHT; // escalones
      return WHITE;
    },
  },
  {
    file: "synth-blocks-360x360.rgba",
    width: 360,
    height: 360,
    draw: (x, y) => {
      if (rect(x, y, 30, 30, 140, 140)) return BLACK; // cuadrado
      if (disk(x, y, 250, 100, 70)) return DARK; // disco
      if (rect(x, y, 30, 240, 330, 280)) return LIGHT; // barra
      return WHITE;
    },
  },
  {
    file: "synth-step-360x360.rgba",
    width: 360,
    height: 360,
    draw: (x, y) => {
      if (staircase(x, y, 40, 340, 64, 28, 5)) return BLACK; // escalones
      if (rect(x, y, 60, 40, 160, 100)) return DARK; // rectángulo
      if (disk(x, y, 270, 120, 65)) return LIGHT; // disco
      return WHITE;
    },
  },
];

for (const { file, width, height, draw } of FIXTURES) {
  const data = makeImage(width, height, draw);
  fs.writeFileSync(path.join(DIR, file), Buffer.from(data.buffer));
  console.log(`${file} (${width}x${height}, ${data.length} bytes)`);
}
