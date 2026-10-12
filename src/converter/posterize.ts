/**
 * Núcleo del conversor "Posterizado 4 capas" — CAPAS DE PATHS VECTORIALES
 * (formato v2, DISENO.md §1.5).
 *
 * Diseño en DOS FASES (rehacer 2026-09-22, flujo Inkscape del usuario):
 * 1. `posterizeImage(img)` — UNA VEZ por imagen: **posterizar de verdad**
 *    (estilo Krita) y cuantizar a 4 colores → máscaras limpias, sin motas.
 *    Selección de paleta (P2 2026-09-23): top-6 del histograma + fusión
 *    iterativa del par más cercano (`reducePalette`) hasta 4 — en fotos muy
 *    oscuras/claras el top-4 seco por frecuencia colapsaba los tonos.
 *    No depende de ningún parámetro de color.
 * 2. `traceLayers(trace, minRegion)` — máscaras (filtro mayoritario ya
 *    aplicado en fase 1 + cierre de agujeros < minRegion) y trazado a **0.5×
 *    de resolución con coordenadas escaladas ×2** (truco potrace: las púas
 *    de 1–2 px de origen desaparecen en la rejilla gruesa). Es el ÚNICO paso
 *    que se repite, y solo cuando cambia `minRegion`. Los ajustes de color
 *    NUNCA re-trazan.
 *
 * Corrección estructural 2026-09-22 (flujo Krita→JPEG→Inkscape del usuario):
 * el trazado NUNCA parte de la foto original ni del WebP (lossy con
 * degradados → artefactos → motas → púas). La imagen original se posteriza
 * a 4 colores → raster (`renderRaster`) → JPEG q92 (artefacto de trabajo) y
 * el trazado opera sobre ese JPEG re-decodificado, re-asignado a la paleta
 * con `assignToPalette` (re-snap determinista). Ver posterizePipeline.ts.
 *
 * Determinista: mismo input → mismos paths, sin seed.
 */
import {
  POSTERIZED_BANDS,
  type Layer,
} from "./format";

export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

// ─────────────────────────────────────────────────────────────────────────
// Posterización de canales estilo Krita (snap a niveles gruesos)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Niveles de cuantización por canal (estilo Krita "posterizar"): 8 niveles
 * ≈ {0, 36, 73, 109, 146, 182, 219, 255}. Píxeles vecinos similares caen en
 * el mismo nivel → regiones contiguas en lugar de motas de colores cercanos.
 */
export const SNAP_LEVELS = 8;

/**
 * Candidatos del histograma antes de la reducción por fusión (P2 2026-09-23):
 * 6 candidatos → `reducePalette` deja 4. Un recorte seco por frecuencia
 * (top-4) pierde tonos en fotos muy oscuras o claras.
 */
export const PALETTE_CANDIDATES = 6;

/** Cuantiza un canal 0–255 a la retícula gruesa (`levels` niveles). */
export function snapChannel(v: number, levels: number = SNAP_LEVELS): number {
  const step = 255 / (levels - 1);
  return Math.round(Math.round(v / step) * step);
}

/** Relleno determinista cuando la imagen tiene menos colores que los pedidos. */
const FILL_CANDIDATES: Array<[number, number, number]> = [
  [0, 0, 0], [90, 90, 90], [180, 180, 180], [255, 255, 255],
  [120, 40, 40], [40, 120, 40], [40, 40, 120], [200, 170, 60],
];

interface HistogramTop {
  /** Hasta `k` colores posterizados más frecuentes (orden frecuencia↓, RGB↑). */
  colors: Array<[number, number, number]>;
  /** Frecuencia de cada color (0 en los de relleno). */
  counts: number[];
}

/** Top-`k` del histograma de colores snapped, con frecuencias y relleno.
 *  `exclude`: color que NO debe entrar en el top (F2: el fondo detectado). */
function topHistogramColors(
  img: ImageDataLike,
  k: number,
  levels: number,
  exclude?: readonly [number, number, number] | null
): HistogramTop {
  const counts = new Map<number, number>();
  const total = img.width * img.height;
  const exKey = exclude ? (exclude[0] << 16) | (exclude[1] << 8) | exclude[2] : -1;
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    const r = snapChannel(img.data[o], levels);
    const g = snapChannel(img.data[o + 1], levels);
    const b = snapChannel(img.data[o + 2], levels);
    const key = (r << 16) | (g << 8) | b;
    if (key === exKey) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const colors: Array<[number, number, number]> = entries
    .slice(0, k)
    .map(([key]) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]);
  const freq = entries.slice(0, k).map(([, c]) => c);
  // Imagen con menos de k colores distintos: relleno determinista (frecuencia 0).
  for (const c of FILL_CANDIDATES) {
    if (colors.length >= k) break;
    if (!colors.some((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2])) {
      colors.push([...c]);
      freq.push(0);
    }
  }
  return { colors, counts: freq };
}

/**
 * DETECCIÓN DEL FONDO (F2 2026-10-11): color dominante del ANILLO DEL BORDE
 * (la fila/columna exterior de 1 px de la imagen). Cada píxel del anillo se
 * snapa a la retícula de niveles — igual que la cuantización — y manda el
 * más frecuente (empates por valor RGB ascendente: determinista, sin seed).
 * En un borde limpio coincide con la mediana del anillo; el snap hace la
 * detección robusta al ruido leve del borde. Imágenes diminutas (<3×3) →
 * null (sin anillo fiable). La opacidad del píxel se ignora (se mira RGB).
 */
export function detectBackgroundColor(
  img: ImageDataLike,
  levels: number = SNAP_LEVELS
): [number, number, number] | null {
  const { width, height } = img;
  if (width < 3 || height < 3) return null;
  const counts = new Map<number, number>();
  const push = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    const key =
      (snapChannel(img.data[o], levels) << 16) |
      (snapChannel(img.data[o + 1], levels) << 8) |
      snapChannel(img.data[o + 2], levels);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    push(0, y);
    push(width - 1, y);
  }
  let bestKey = -1;
  let bestCount = -1;
  for (const [key, c] of counts) {
    if (c > bestCount || (c === bestCount && key < bestKey)) {
      bestKey = key;
      bestCount = c;
    }
  }
  if (bestKey < 0) return null;
  return [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}

/**
 * Paleta por HISTOGRAMA: snap de canales sobre TODA la imagen y los `k`
 * colores posterizados más frecuentes = paleta (colores reales dominantes).
 * Determinista: orden por frecuencia descendente, empates por valor RGB
 * (sin seed). Si hay menos de `k` colores, rellena con candidatos fijos.
 * (La selección VIGENTE del conversor va un paso más allá: 6 candidatos +
 * `reducePalette`; ver posterizeImage.)
 */
export function histogramPalette(
  img: ImageDataLike,
  k = 4,
  levels: number = SNAP_LEVELS
): Array<[number, number, number]> {
  return topHistogramColors(img, k, levels).colors;
}

/**
 * Reducción de candidatos a `target` colores (selección de paleta vigente,
 * 2026-09-23): fusiona iterativamente el PAR MÁS CERCANO (distancia RGB
 * euclídea) hasta quedar en `target`. El superviviente del par es el candidato
 * MÁS FRECUENTE (su color no se altera; empate → el de menor índice, pues los
 * candidatos vienen ordenados frecuencia↓/RGB↑); el absorbido se registra en
 * `merged` (orden de fusión). Los píxeles del fusionado se reasignan al
 * superviviente más cercano en la cuantización posterior (cada píxel ya va a
 * su color de paleta más próximo). Determinista sin seed: empates de
 * distancia por par de índices (i, j).
 */
export function reducePalette(
  candidates: ReadonlyArray<readonly [number, number, number]>,
  target: number,
  counts?: ReadonlyArray<number>
): { palette: Array<[number, number, number]>; merged: Array<[number, number, number]> } {
  const colors = candidates.map((c) => [c[0], c[1], c[2]] as [number, number, number]);
  const freq = candidates.map((_, i) => counts?.[i] ?? 0);
  const merged: Array<[number, number, number]> = [];
  while (colors.length > target) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const dr = colors[i][0] - colors[j][0];
        const dg = colors[i][1] - colors[j][1];
        const db = colors[i][2] - colors[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const keep = freq[bi] >= freq[bj] ? bi : bj;
    const drop = keep === bi ? bj : bi;
    merged.push([...colors[drop]]);
    freq[keep] += freq[drop];
    colors.splice(drop, 1);
    freq.splice(drop, 1);
  }
  return { palette: colors, merged };
}

// ─────────────────────────────────────────────────────────────────────────
// Paleta k-means (MÉTODO ALTERNATIVO — se mantiene disponible por código)
// ─────────────────────────────────────────────────────────────────────────

/** Luminancia percibida (Rec. 601): ordena las capas oscura→clara. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Índice de la entrada de paleta más cercana a un color (euclídea RGB). */
export function nearestLayerIndex(
  palette: ReadonlyArray<readonly [number, number, number]>,
  r: number,
  g: number,
  b: number
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = palette[i][0] - r;
    const dg = palette[i][1] - g;
    const db = palette[i][2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Muestra determinista: cada `stride`-ésimo píxel (~60k en una imagen 900 px). */
export function samplePixels(img: ImageDataLike, target = 60000): Array<[number, number, number]> {
  const total = img.width * img.height;
  const stride = Math.max(1, Math.floor(total / target));
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < total; i += stride) {
    const o = i * 4;
    out.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
  }
  return out;
}

/**
 * k-means con k=4. Inicialización determinista (k muestras equiespaciadas)
 * y desambiguación de centroides duplicados determinista: misma muestra →
 * misma paleta, siempre.
 */
export function kmeansPalette(
  samples: Array<readonly [number, number, number]>,
  k = 4,
  maxIterations = 20
): Array<[number, number, number]> {
  if (samples.length === 0) return Array.from({ length: k }, () => [0, 0, 0]);
  const centroids: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i++) {
    const s = samples[Math.floor((i * (samples.length - 1)) / Math.max(1, k - 1))];
    centroids.push([s[0], s[1], s[2]]);
  }

  const assign = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let s = 0; s < samples.length; s++) {
      const idx = nearestLayerIndex(centroids, samples[s][0], samples[s][1], samples[s][2]);
      if (idx !== assign[s]) {
        assign[s] = idx;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let s = 0; s < samples.length; s++) {
      const c = assign[s];
      sums[c][0] += samples[s][0];
      sums[c][1] += samples[s][1];
      sums[c][2] += samples[s][2];
      sums[c][3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [
          sums[c][0] / sums[c][3],
          sums[c][1] / sums[c][3],
          sums[c][2] / sums[c][3],
        ];
      } // cluster vacío: conserva su centroide (desambiguación abajo)
    }
    if (!changed) break;
  }

  // Redondear y desduplicar de forma determinista.
  const colors: Array<[number, number, number]> = [];
  for (const c of centroids) {
    let candidate: [number, number, number] = [
      Math.round(c[0]),
      Math.round(c[1]),
      Math.round(c[2]),
    ];
    let guard = 0;
    while (
      colors.some(
        (p) =>
          Math.hypot(p[0] - candidate[0], p[1] - candidate[1], p[2] - candidate[2]) < 12
      ) &&
      guard < 16
    ) {
      const step = (guard + 1) * 16;
      candidate = [
        clamp255(candidate[0] + (guard % 2 === 0 ? step : -step)),
        clamp255(candidate[1] + (guard % 3 === 0 ? step : 0)),
        clamp255(candidate[2] + (guard % 2 === 1 ? step : -step)),
      ];
      guard++;
    }
    colors.push(candidate);
  }
  return colors;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 1 · Posterizar (una vez por imagen, sin parámetros de color)
// ─────────────────────────────────────────────────────────────────────────

export interface TraceResult {
  /** Índice de capa por píxel (0..3), YA filtrado mayoritariamente.
   *  −1 = SIN capa: píxel de fondo excluido (F2, solo con removeBackground). */
  idx: Int8Array;
  /** Confianza por píxel: dist(runner-up) − dist(mejor). Para sillas. */
  margins: Float32Array;
  palette: Array<[number, number, number]>;
  width: number;
  height: number;
  /**
   * Candidatos del histograma ABSORBIDOS en la reducción 6→4 (solo método
   * 'histogram'), en orden de fusión. Transparencia para la pantalla de
   * revisión; no afecta al formato ni al trazado.
   */
  merged?: Array<[number, number, number]>;
  /**
   * F2 (2026-10-11): color de fondo detectado en el anillo del borde
   * (solo cuando se pidió removeBackground). `backgroundExcluded` = true
   * si además estaba entre los candidatos de la paleta y se excluyó (sus
   * píxeles quedaron SIN capa); si no estaba, el toggle no tiene efecto
   * visible y la salida es idéntica a no haberlo pedido.
   */
  background?: [number, number, number];
  backgroundExcluded?: boolean;
}

/** Método de cuantización: 'histogram' (default, estilo Krita) o 'kmeans'. */
export type PosterizeMethod = "histogram" | "kmeans";

export interface PosterizeOptions {
  /** 'histogram' (default) o 'kmeans' (alternativo, disponible por código). */
  method?: PosterizeMethod;
  /** Niveles del snap de canales (solo método histogram). */
  levels?: number;
  /**
   * F2 (2026-10-11): "quitar fondo" — el color dominante del anillo del
   * borde se EXCLUYE de los candidatos de la paleta (la reducción 6→4 toma
   * el siguiente candidato) y sus píxeles quedan SIN capa (−1 → transparentes
   * en la pieza). Solo método 'histogram'. Si el color detectado no estaba
   * entre los candidatos, no hay efecto visible.
   */
  removeBackground?: boolean;
}

/**
 * Filtro mayoritario 3×3 sobre la cuadrícula de índices: un píxel sobrevive
 * si ≥ 5 de sus 9 vecinos comparten clase; si no, adopta la clase mayoritaria
 * del entorno. REGLAS con el fondo (−1, F2 2026-10-11):
 * - el fondo es una clase más a la hora de CONTAR: un píxel de fondo con
 *   ≥ 5 vecinos de capa se vuelve capa (borde interior del sujeto);
 * - una capa NUNCA se voltea a fondo por mayoría: la transparencia solo la
 *   decide la cuantización (y el re-snap del JPEG), no este filtro — así no
 *   se erosionan las zonas transparentes con ruido de borde.
 * (Empates: se mantiene la propia clase si está empatada en el máximo, si
 * no la de índice menor, como antes. Borde: se copia tal cual.)
 */
export function majorityFilter(idx: Int8Array, width: number, height: number, k = 4): Int8Array {
  const out = new Int8Array(idx);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const counts = new Array<number>(k).fill(0);
      let bgCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = idx[(y + dy) * width + (x + dx)];
          if (v < 0) bgCount++;
          else counts[v]++;
        }
      }
      const own = idx[y * width + x];
      const ownCount = own < 0 ? bgCount : counts[own];
      if (ownCount >= 5) continue;
      let winner = own; // −1: solo una capa con más vecinos lo desbanca
      let winnerCount = ownCount;
      for (let c = 0; c < k; c++) {
        if (counts[c] > winnerCount) {
          winner = c;
          winnerCount = counts[c];
        }
      }
      if (winner !== own) out[y * width + x] = winner;
    }
  }
  return out;
}

/**
 * Rompe las sillas (checkerboards 2×2) de la cuadrícula de índices: cada
 * ambigüedad se resuelve volteando el píxel de MENOR margen hacia la capa
 * de su vecino diagonal. Así el trazado posterior no encuentra casos de
 * silla y los anillos cierran siempre con grado 2 (sin T-junctions ni
 * púas por inconsistencia entre celdas vecinas). Itera hasta estabilizar.
 */
export function breakSaddles(
  idx: Int8Array,
  margins: Float32Array,
  width: number,
  height: number
): Int8Array {
  const out = new Int8Array(idx);
  for (let pass = 0; pass < 12; pass++) {
    let flips = 0;
    for (let j = 0; j < height - 1; j++) {
      for (let i = 0; i < width - 1; i++) {
        const p = j * width + i;
        const tl = out[p];
        const tr = out[p + 1];
        const bl = out[p + width];
        const br = out[p + width + 1];
        if (tr === bl && tr !== tl && tr !== br) {
          // Silla tipo 5 (TR+BL): voltea el de menor margen.
          if (margins[p + 1] <= margins[p + width]) out[p + 1] = br;
          else out[p + width] = tl;
          flips++;
        } else if (tl === br && tl !== tr && tl !== bl) {
          // Silla tipo 10 (TL+BR).
          if (margins[p] <= margins[p + width + 1]) out[p] = tr;
          else out[p + width + 1] = bl;
          flips++;
        }
      }
    }
    if (flips === 0) break;
  }
  return out;
}

/**
 * Posterizar (sin trazar): paleta + cuantización + filtro mayoritario.
 *
 * Método 'histogram' (default — la prueba A/B del usuario: Krita-posterizar
 * primero da paths limpios, k-means sobre la foto cruda da máscaras con
 * motas): snap de canales a 8 niveles → los **6** colores posterizados más
 * frecuentes = candidatos → **reducePalette** fusiona iterativamente el par
 * más cercano hasta quedar en 4 (P2 2026-09-23: en fotos muy oscuras o muy
 * claras el top-4 por frecuencia concentraba casi todos los píxeles en
 * niveles parecidos y los 4 ganadores salían casi iguales; con 6 candidatos
 * y fusión del par más cercano, dos tonos oscuros distintos pueden
 * sobrevivir → mejor separación tonal). Los píxeles de los fusionados se
 * reasignan al superviviente más cercano (cada píxel va a su color de
 * paleta más próximo): la mayoría mapea EXACTO → máscanas limpias y
 * regiones contiguas.
 *
 * Método 'kmeans': el pipeline original (k-means sobre muestra determinista),
 * conservado como alternativa por código.
 */
export function posterizeImage(img: ImageDataLike, opts: PosterizeOptions = {}): TraceResult {
  const method: PosterizeMethod = opts.method ?? "histogram";
  const levels = opts.levels ?? SNAP_LEVELS;
  const total = img.width * img.height;
  let palette: Array<[number, number, number]>;
  let merged: Array<[number, number, number]> | undefined;
  // F2 · quitar fondo: detectar el color del anillo del borde y, SOLO si
  // estaba entre los 6 candidatos, excluirlo (entra el siguiente color del
  // histograma) y dejar sus píxeles sin capa. Si no estaba, sin efecto.
  const background =
    method === "histogram" && opts.removeBackground
      ? (detectBackgroundColor(img, levels) ?? undefined)
      : undefined;
  let backgroundExcluded = false;
  if (method === "histogram") {
    let top = topHistogramColors(img, PALETTE_CANDIDATES, levels);
    if (background) {
      const bgKey = (background[0] << 16) | (background[1] << 8) | background[2];
      if (top.colors.some((c) => ((c[0] << 16) | (c[1] << 8) | c[2]) === bgKey)) {
        top = topHistogramColors(img, PALETTE_CANDIDATES, levels, background);
        backgroundExcluded = true;
      }
    }
    const reduced = reducePalette(top.colors, 4, top.counts);
    palette = reduced.palette;
    merged = reduced.merged;
  } else {
    palette = kmeansPalette(samplePixels(img), 4);
  }
  const idx = new Int8Array(total);
  const margins = new Float32Array(total);
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    let r = img.data[o];
    let g = img.data[o + 1];
    let b = img.data[o + 2];
    if (method === "histogram") {
      r = snapChannel(r, levels);
      g = snapChannel(g, levels);
      b = snapChannel(b, levels);
      // F2: el píxel del color de fondo excluido queda SIN capa (−1).
      if (
        backgroundExcluded &&
        background &&
        r === background[0] &&
        g === background[1] &&
        b === background[2]
      ) {
        idx[p] = -1;
        margins[p] = 0;
        continue;
      }
    }
    // Mejor y runner-up (para el margen de confianza).
    let best = 0;
    let bestD = Infinity;
    let secondD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = palette[i][0] - r;
      const dg = palette[i][1] - g;
      const db = palette[i][2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = i;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    idx[p] = best;
    margins[p] = Math.sqrt(secondD) - Math.sqrt(bestD);
  }
  const filtered = majorityFilter(idx, img.width, img.height);
  return {
    idx: breakSaddles(filtered, margins, img.width, img.height),
    margins,
    palette,
    width: img.width,
    height: img.height,
    merged,
    background,
    backgroundExcluded: backgroundExcluded || undefined,
  };
}

/**
 * Re-snap a paleta FIJA (corrección estructural 2026-09-22): cada píxel se
 * asigna al color de paleta más cercano (distancia RGB) — SIN snap de
 * canales ni histograma. Es la entrada del trazado cuando la imagen de
 * trabajo es el JPEG posterizado: el códec desplaza ligeramente los colores
 * planos y esto los estabiliza de vuelta a los 4 exactos, de forma
 * determinista. Mismo post-proceso que posterizeImage: filtro mayoritario +
 * resolución de sillas.
 *
 * F2 (2026-10-11): con `background`, un píxel cuya distancia al color de
 * fondo es MENOR que la de su paleta asignada queda SIN capa (−1): restaura
 * la transparencia del fondo tras la pérdida del JPEG (el raster la aplana
 * al color de fondo). El empate (pixel equidistante) se queda coloreado.
 */
export function assignToPalette(
  img: ImageDataLike,
  palette: ReadonlyArray<readonly [number, number, number]>,
  opts: { background?: readonly [number, number, number] | null } = {}
): TraceResult {
  const total = img.width * img.height;
  const bg = opts.background ?? null;
  const idx = new Int8Array(total);
  const margins = new Float32Array(total);
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    let best = 0;
    let bestD = Infinity;
    let secondD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = palette[i][0] - r;
      const dg = palette[i][1] - g;
      const db = palette[i][2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = i;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    if (bg) {
      const dr = bg[0] - r;
      const dg = bg[1] - g;
      const db = bg[2] - b;
      const dBg = dr * dr + dg * dg + db * db;
      if (dBg < bestD) {
        idx[p] = -1;
        margins[p] = 0;
        continue;
      }
    }
    idx[p] = best;
    margins[p] = Math.sqrt(secondD) - Math.sqrt(bestD);
  }
  const filtered = majorityFilter(idx, img.width, img.height, palette.length);
  return {
    idx: breakSaddles(filtered, margins, img.width, img.height),
    margins,
    palette: palette.map((c) => [c[0], c[1], c[2]] as [number, number, number]),
    width: img.width,
    height: img.height,
    background: bg ? ([bg[0], bg[1], bg[2]] as [number, number, number]) : undefined,
    backgroundExcluded: bg ? true : undefined,
  };
}

/**
 * Raster exacto de 4 colores (la imagen posterizada INTERMEDIA, inspeccionable
 * como dato antes de trazar): cada píxel toma el color de paleta de su capa.
 * F2: los píxeles SIN capa (−1) se aplatan al color de fondo detectado (el
 * JPEG no tiene alfa; al reaparecer en el re-snap quedan transparentes de
 * nuevo). Sin fondo conocido, negro.
 */
export function renderRaster(trace: TraceResult): ImageDataLike {
  const total = trace.width * trace.height;
  const data = new Uint8ClampedArray(total * 4);
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    const i = trace.idx[p];
    const c = i >= 0 ? (trace.palette[i] ?? [0, 0, 0]) : (trace.background ?? [0, 0, 0]);
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  }
  return { width: trace.width, height: trace.height, data };
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 2 · Máscaras + trazado (solo cuando cambia minRegion)
// ─────────────────────────────────────────────────────────────────────────

const DP_EPSILON = 0.6; // px (en la rejilla trazada: 0.5× → ≈1.2 px reales)
/**
 * Desviación máxima que puede introducir la eliminación de una púa, en
 * unidades de la rejilla trazada: 1.25 → 2.5 px reales tras el ×2 del
 * diezmado 0.5× (en el fallback a resolución plena es simplemente 1.25 px,
 * más estricto). Corta la cascada que exportaba cuerdas lejos de la
 * frontera real (bug 2026-09-23, ver removeSpikes).
 */
const SPIKE_MAX_DEVIATION = 1.25;

function perpDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + tc * dx), p[1] - (a[1] + tc * dy));
}

/** Douglas-Peucker sobre una cadena abierta (íterativa). */
export function douglasPeucker(
  pts: Array<[number, number]>,
  epsilon: number = DP_EPSILON
): Array<[number, number]> {
  if (pts.length <= 2) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    let maxD = -1;
    let maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = perpDistance(pts[i], pts[i0], pts[i1]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = true;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function shoelaceArea(ring: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** Ángulo interno (grados) del vértice i de un anillo cerrado. */
export function interiorAngleDeg(
  ring: Array<[number, number]>,
  i: number
): number {
  const n = ring.length;
  const [px, py] = ring[(i - 1 + n) % n];
  const [cx, cy] = ring[i];
  const [nx, ny] = ring[(i + 1) % n];
  const v1x = px - cx, v1y = py - cy;
  const v2x = nx - cx, v2y = ny - cy;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (m === 0) return 180;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / m));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Elimina púas: quita ITERATIVAMENTE (hasta que una pasada no cambie nada,
 * tope 100) los vértices con ángulo interno < 60° — PERO solo si quitarlos
 * desplaza el path menos de `maxDeviation` unidades del anillo: la distancia
 * perpendicular del vértice a la cuerda entre sus vecinos supervivientes.
 *
 * Re-baseline del invariante 2026-09-23 (debug forense): el criterio de
 * ángulo puro cortaba vértices GENUINOS (p. ej. la unión entre el borde del
 * contenido y el marco padBackground, ángulo ~5°) y la cascada de
 * eliminaciones acababa exportando cuerdas que se alejaban hasta ~13 px de
 * la frontera real de la máscara. El tope de desviación frena la cascada:
 * cada eliminación individual introduce como mucho `maxDeviation` de error.
 */
export interface RemoveSpikesOptions {
  /**
   * Desviación máxima admisible (unidades del anillo) entre el vértice
   * eliminado y la cuerda que lo sustituye. Default Infinity (solo ángulo).
   */
  maxDeviation?: number;
}

export function removeSpikes(
  ring: Array<[number, number]>,
  minDeg = 60,
  maxPasses = 100,
  opts: RemoveSpikesOptions = {}
): Array<[number, number]> {
  const cap = opts.maxDeviation ?? Infinity;
  let r = ring;
  for (let pass = 0; pass < maxPasses; pass++) {
    const n = r.length;
    if (n < 3) return r;
    const flag = new Array<boolean>(n).fill(false);
    let any = false;
    for (let i = 0; i < n; i++) {
      flag[i] = interiorAngleDeg(r, i) < minDeg;
      if (flag[i]) any = true;
    }
    if (!any) return r;
    // Supervivientes de esta pasada (no marcados). Si no hay al menos 2,
    // no se puede sustituir nada por cuerdas.
    const survivors: number[] = [];
    for (let i = 0; i < n; i++) if (!flag[i]) survivors.push(i);
    if (survivors.length < 2) return r;
    const out: Array<[number, number]> = [];
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!flag[i]) {
        out.push(r[i]);
        continue;
      }
      // Vecinos supervivientes más cercanos a izquierda y derecha (cíclico).
      let prev = survivors[0];
      for (const s of survivors) {
        if (s < i) prev = s;
        else break;
      }
      if (prev >= i) prev = survivors[survivors.length - 1]; // envolver por la izquierda
      let next = survivors[0];
      for (const s of survivors) {
        if (s > i) {
          next = s;
          break;
        }
      }
      if (next <= i) next = survivors[0]; // envolver por la derecha
      const dev = perpDistance(r[i], r[prev], r[next]);
      if (dev <= cap) {
        changed = true;
        continue;
      }
      out.push(r[i]); // púa genuina: conservar
    }
    r = out;
    if (!changed) return r;
  }
  return r;
}

/**
 * Cierre morfológico simple: rellena los AGUJEROS de la capa `layer` con
 * área (px²) menor que `maxArea`. Un agujero = componente de fondo (píxeles
 * que NO son de la capa) que no toca el borde de la imagen. Mata las motas
 * internas que sobrevivieron al filtro mayoritario. In situ sobre `grid`.
 */
function fillHolesSmallerThan(
  grid: Int8Array,
  width: number,
  height: number,
  layer: number,
  maxArea: number
): void {
  if (maxArea <= 0) return;
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack: number[] = [];
  for (let start = 0; start < total; start++) {
    if (visited[start] || grid[start] === layer) continue;
    // BFS del componente de fondo.
    let touchesBorder = false;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x > 0 && !visited[p - 1] && grid[p - 1] !== layer) { visited[p - 1] = 1; stack.push(p - 1); }
      if (x < width - 1 && !visited[p + 1] && grid[p + 1] !== layer) { visited[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !visited[p - width] && grid[p - width] !== layer) { visited[p - width] = 1; stack.push(p - width); }
      if (y < height - 1 && !visited[p + width] && grid[p + width] !== layer) { visited[p + width] = 1; stack.push(p + width); }
    }
    if (!touchesBorder && size < maxArea) {
      // Agujero pequeño: se rellena con la capa (mata la mota interna).
      stack.length = 0;
      stack.push(start);
      grid[start] = layer;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const x = p % width;
        const y = (p / width) | 0;
        if (x > 0 && grid[p - 1] !== layer) { grid[p - 1] = layer; stack.push(p - 1); }
        if (x < width - 1 && grid[p + 1] !== layer) { grid[p + 1] = layer; stack.push(p + 1); }
        if (y > 0 && grid[p - width] !== layer) { grid[p - width] = layer; stack.push(p - width); }
        if (y < height - 1 && grid[p + width] !== layer) { grid[p + width] = layer; stack.push(p + width); }
      }
    }
  }
}

/**
 * Diezma la rejilla a 0.5× (truco potrace): cada celda gruesa toma la capa
 * mayoritaria de su bloque 2×2 (empates: mayor suma de márgenes, luego
 * índice menor) y el margen máximo del bloque. Las púas de 1–2 px de
 * origen no sobreviven a la mayoría 2×2. Determinista.
 */
function downsample2x(
  idx: Int8Array,
  margins: Float32Array,
  width: number,
  height: number
): { idx: Int8Array; margins: Float32Array; width: number; height: number } {
  const w2 = Math.floor(width / 2);
  const h2 = Math.floor(height / 2);
  const idx2 = new Int8Array(w2 * h2);
  const margins2 = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const p0 = (2 * y) * width + 2 * x;
      // La rejilla puede contener valores fuera de 0..3 (p. ej. −1 = fondo
      // en las máscaras sintéticas de los tests): contador genérico.
      const stats = new Map<number, { count: number; marginSum: number }>();
      let maxMargin = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = p0 + dy * width + dx;
          const c = idx[p];
          const s = stats.get(c) ?? { count: 0, marginSum: 0 };
          s.count++;
          s.marginSum += margins[p];
          stats.set(c, s);
          if (margins[p] > maxMargin) maxMargin = margins[p];
        }
      }
      let winner = Infinity;
      let winnerCount = -1;
      let winnerMargin = -1;
      for (const [c, s] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
        if (
          s.count > winnerCount ||
          (s.count === winnerCount && s.marginSum > winnerMargin)
        ) {
          winner = c;
          winnerCount = s.count;
          winnerMargin = s.marginSum;
        }
      }
      idx2[y * w2 + x] = winner;
      margins2[y * w2 + x] = maxMargin;
    }
  }
  return { idx: idx2, margins: margins2, width: w2, height: h2 };
}

/** Resuelve el caso de silla (5 y 10) con los márgenes de confianza. */
function saddleAwareCase(
  c: number,
  margins: Float32Array,
  p: number,
  width: number,
  SEPARATE: Array<[number, number]>,
  JOIN: Array<[number, number]>
): Array<[number, number]> | null {
  switch (c) {
    case 0: return null;
    case 1: return [[3, 2]];
    case 2: return [[2, 1]];
    case 3: return [[3, 1]];
    case 4: return [[0, 1]];
    case 6: return [[0, 2]];
    case 7: return [[0, 3]];
    case 8: return [[0, 3]];
    case 9: return [[0, 2]];
    case 11: return [[0, 1]];
    case 12: return [[3, 1]];
    case 13: return [[2, 1]];
    case 14: return [[3, 2]];
    case 15: return null;
    case 5: {
      // TR + BL: unir la diagonal "on" si sus márgenes son más fuertes.
      const mTR = margins[p + 1];
      const mBL = margins[p + width];
      const mTL = margins[p];
      const mBR = margins[p + width + 1];
      return mTR + mBL > mTL + mBR ? JOIN : SEPARATE;
    }
    case 10: {
      // TL + BR.
      const mTL = margins[p];
      const mBR = margins[p + width + 1];
      const mTR = margins[p + 1];
      const mBL = margins[p + width];
      return mTL + mBR > mTR + mBL ? JOIN : SEPARATE;
    }
    default: return null;
  }
}

/**
 * Divide un anillo autotangente (un punto visitado dos veces, típico de
 * canales de 1 px de la máscara) en sus lazos simples. Recursivo.
 */
export function splitSelfTouching(
  ring: Array<[number, number]>
): Array<Array<[number, number]>> {
  const pos = new Map<string, number>();
  for (let i = 0; i < ring.length; i++) {
    const k = `${ring[i][0]},${ring[i][1]}`;
    if (pos.has(k)) {
      const a = pos.get(k)!;
      const loop1 = ring.slice(a, i + 1);
      const loop2 = [...ring.slice(i), ...ring.slice(0, a + 1)];
      return [...splitSelfTouching(loop1), ...splitSelfTouching(loop2)];
    }
    pos.set(k, i);
  }
  return [ring];
}

/**
 * Snap de chamfers: el marching squares sobre datos binarios corta las
 * esquinas con un segmento diagonal de ≈ 0.707 px entre dos aristas. Este
 * pre-paso detecta ese patrón (segmento de longitud ≈ 0.707 cuyas aristas
 * vecinas son aprox. perpendiculares) y lo sustituye por la ESQUINA exacta
 * (intersección de las aristas). En curvas suaves (círculos) los pasos
 * diagonales tienen cuerdas casi paralelas → no se tocan.
 */
export function snapChamfers(ring: Array<[number, number]>): Array<[number, number]> {
  const n = ring.length;
  if (n < 6) return ring;
  const removed = new Array<boolean>(n).fill(false);
  const cornerAt = new Array<[number, number] | null>(n).fill(null);

  const intersect = (
    p1: [number, number], p2: [number, number],
    p3: [number, number], p4: [number, number]
  ): [number, number] | null => {
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
    return [p1[0] + t * d1x, p1[1] + t * d1y];
  };

  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < 0.55 || d > 0.85) continue;
    const pa = ring[(i - 1 + n) % n];
    const pb = ring[(i + 2) % n];
    const u1 = [a[0] - pa[0], a[1] - pa[1]];
    const u2 = [pb[0] - b[0], pb[1] - b[1]];
    const m1 = Math.hypot(u1[0], u1[1]);
    const m2 = Math.hypot(u2[0], u2[1]);
    if (m1 < 1e-9 || m2 < 1e-9) continue;
    const cos = Math.abs((u1[0] * u2[0] + u1[1] * u2[1]) / (m1 * m2));
    if (cos > 0.5) continue; // aristas no perpendiculares: curva, no esquina
    const corner = intersect(pa, a, b, pb);
    if (!corner) continue;
    if (Math.hypot(corner[0] - a[0], corner[1] - a[1]) > 1.2) continue;
    if (Math.hypot(corner[0] - b[0], corner[1] - b[1]) > 1.2) continue;
    removed[i] = true;
    removed[(i + 1) % n] = true;
    cornerAt[i] = corner;
    i++; // FIX 2026-09-23: no aceptar un segundo chamfer solapado — los
         // marcados @i y @i+1 comparten el vértice i+1 y el rebuild lo
         // emitía DOS VECES (vértice consecutivo duplicado en el path).
  }

  if (!removed.some(Boolean)) return ring;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (cornerAt[i]) {
      out.push([round1(cornerAt[i]![0]), round1(cornerAt[i]![1])]);
      i++; // saltar también el segundo punto del chamfer
    } else if (!removed[i]) {
      out.push(ring[i]);
    }
  }
  return out.length >= 3 ? out : ring;
}

function decodeKey(key: number): [number, number] {
  const x2 = Math.floor(key / 100000);
  const y2 = key - x2 * 100000;
  return [x2 / 2, y2 / 2];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Marching squares sobre una cuadrícula de índices, con píxeles como
 * puntos de retícula (segmentos entre puntos medios de aristas, pasos de
 * 0.5 px en la rejilla trazada). Los casos de silla (5 y 10) se resuelven
 * con un decisor asintótico: se conecta la diagonal cuyos píxeles tienen
 * mayor margen de confianza (los más seguros de pertenecer a la capa); en
 * empate, separación. Devuelve anillos cerrados YA simplificados (DP ε 0.6
 * en la rejilla trazada) y limpios de púas (removeSpikes convergente).
 */
export function traceRings(
  idx: Int8Array,
  margins: Float32Array,
  width: number,
  height: number,
  layer: number
): Array<Array<[number, number]>> {
  const T = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j;
  const R = (i: number, j: number) => (2 * i + 2) * 100000 + 2 * j + 1;
  const B = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j + 2;
  const L = (i: number, j: number) => (2 * i) * 100000 + 2 * j + 1;

  const SEPARATE: Array<[number, number]> = [[0, 1], [3, 2]]; // corta TL↔BR
  const JOIN: Array<[number, number]> = [[0, 3], [2, 1]]; // une la diagonal "on"

  const segments: Array<[number, number]> = [];
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const tl = idx[j * width + i] === layer ? 8 : 0;
      const tr = idx[j * width + i + 1] === layer ? 4 : 0;
      const br = idx[(j + 1) * width + i + 1] === layer ? 2 : 0;
      const bl = idx[(j + 1) * width + i] === layer ? 1 : 0;
      const segs = saddleAwareCase(tl | tr | br | bl, margins, j * width + i, width, SEPARATE, JOIN);
      if (!segs) continue;
      for (let e = 0; e < segs.length; e++) {
        const [a, b] = segs[e];
        segments.push([
          a === 0 ? T(i, j) : a === 1 ? R(i, j) : a === 2 ? B(i, j) : L(i, j),
          b === 0 ? T(i, j) : b === 1 ? R(i, j) : b === 2 ? B(i, j) : L(i, j),
        ]);
      }
    }
  }
  if (segments.length === 0) return [];

  // Ensamblar anillos. Dos casos por punto:
  // - grado 2 (lo habitual): única arista no usada → seguir por ella.
  // - grado 4 (cuellos de 1 celda: el contorno pasa DOS veces por el punto,
  //   que NO es una silla y breakSaddles no lo toca): hay que EMPAREJAR las
  //   aristas por oposición de direcciones (la salida es la arista más
  //   colineal y contraria a la de entrada). Elegir la "primera no usada"
  //   por orden de inserción CRUZA los lazos → el anillo figura-8 se reparte
  //   en dos contornos ficticios y el relleno evenodd dibuja puentes/
  //   triángulos entre regiones disjuntas (bug 2026-09-22).
  const adjacency = new Map<number, Array<[number, number]>>();
  segments.forEach(([a, b], id) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push([b, id]);
    adjacency.get(b)!.push([a, id]);
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const rings: Array<Array<[number, number]>> = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const [a0, b0] = segments[s];
    const ring: Array<[number, number]> = [decodeKey(a0), decodeKey(b0)];
    let cur = b0;
    let entryId = s; // arista por la que se llega al punto actual
    let guard = 0;
    while (cur !== a0 && guard++ <= segments.length + 1) {
      const candidates = adjacency.get(cur)!;
      let next: [number, number] | undefined;
      if (candidates.length <= 2) {
        next = candidates.find(([, id]) => !used[id]);
      } else {
        debugWalkDegree4.count++;
        debugWalkDegree4.points.push(decodeKey(cur));
        // Grado 4 (cuello de 1 celda / contacto con el marco): el emparejamiento
        // correcto es el NO CRUZADO — las aristas se ordenan por ángulo alrededor
        // del punto y cada una se empareja con la OPUESTA en el orden circular.
        // (El criterio de "más opuesta a la de entrada" por producto escalar
        // fallaba en los contactos con el marco, donde el contorno gira 90°:
        // bug 2026-09-22.)
        const dirs = candidates.map(([other]) =>
          Math.atan2(
            (other % 100000) - (cur % 100000),
            Math.floor(other / 100000) - Math.floor(cur / 100000)
          )
        );
        const order = candidates
          .map((_, i) => i)
          .sort((a, b) => dirs[a] - dirs[b] || candidates[a][0] - candidates[b][0]);
        const entryIdx = candidates.findIndex(([, id]) => id === entryId);
        if (entryIdx >= 0 && order.length === 4) {
          const partner = candidates[order[(order.indexOf(entryIdx) + 2) % 4]];
          if (!used[partner[1]]) next = partner;
        }
        if (!next) {
          // Defensivo (no debería ocurrir): primera arista no usada.
          next = candidates.find(([, id]) => !used[id]);
        }
      }
      if (!next) break;
      used[next[1]] = true;
      entryId = next[1];
      cur = next[0];
      if (cur !== a0) ring.push(decodeKey(cur));
    }
    if (ring.length >= 3) {
      // Un canal de 1 celda de la máscara hace que el contorno pase DOS veces
      // por el mismo punto (grado 4): el anillo resulta autotangente. Se
      // divide en lazos simples; los bolsillos degenerados mueren luego por
      // las reglas de triángulos y de área.
      for (const loop of splitSelfTouching(ring)) {
        if (loop.length >= 3) rings.push(snapChamfers(loop));
      }
    }
  }

  // Simplificar (DP) y limpiar púas (removeSpikes convergente) en la rejilla
  // trazada (0.5× cuando aplica): una sola pasada de exportación.
  const out: Array<Array<[number, number]>> = [];
  for (const ring of rings) {
    // Abrir el anillo en su punto lexicográficamente menor (determinista).
    let start = 0;
    for (let i = 1; i < ring.length; i++) {
      if (ring[i][0] < ring[start][0] ||
          (ring[i][0] === ring[start][0] && ring[i][1] < ring[start][1])) {
        start = i;
      }
    }
    const rotated = [...ring.slice(start), ...ring.slice(0, start), ring[start]];
    const simplified = douglasPeucker(rotated, DP_EPSILON);
    if (simplified.length < 4) continue;
    const closed = simplified.slice(0, simplified.length - 1); // cierre duplicado fuera
    // El DP conserva las puntas de las púas (máxima desviación): hay que
    // quitarlas explícitamente — removeSpikes converge (los vértices <60°
    // que crea la cascada de eliminaciones se barren en pasadas sucesivas),
    // con tope de desviación para no cortar vértices genuinos (unión
    // contenido↔marco, istmos reales de la máscara).
    const cleaned = removeSpikes(closed, 60, 100, { maxDeviation: SPIKE_MAX_DEVIATION });
    if (cleaned.length >= 3) out.push(cleaned);
  }
  return out;
}

/** Escala los anillos trazados a 0.5× de vuelta a resolución completa
 *  (×2, +0.5: el centro del bloque 2×2 cae en mitad de píxel) y aplica las
 *  reglas de exportación en unidades de resolución completa:
 *  - triángulos de 3 vértices con ángulo <60° o área < 2·minRegion → fuera;
 *  - área mínima ≥ minRegion (px² de resolución completa). */
export function scaleAndFilterRings(
  rings: Array<Array<[number, number]>>,
  scale2x: boolean,
  minRegion: number
): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  for (const ring of rings) {
    const scaled = scale2x
      ? ring.map(([x, y]) => [round1(x * 2 + 0.5), round1(y * 2 + 0.5)] as [number, number])
      : ring.map(([x, y]) => [round1(x), round1(y)] as [number, number]);
    if (scaled.length === 3) {
      const minAngle = Math.min(
        interiorAngleDeg(scaled, 0),
        interiorAngleDeg(scaled, 1),
        interiorAngleDeg(scaled, 2)
      );
      if (minAngle < 60 || shoelaceArea(scaled) < 2 * minRegion) continue;
    }
    if (scaled.length >= 3 && shoelaceArea(scaled) >= minRegion) {
      out.push(scaled);
    }
  }
  return out;
}

/**
 * Marching squares + anillos + simplificación + filtros, con diezmado a
 * 0.5× interno (rejillas ≥6×6): las coordenadas exportadas quedan en
 * resolución completa (×2, +0.5, redondeo 1 decimal) y `minRegion` se
 * interpreta en px² de resolución completa. Añade el marco de fondo de
 * 1 px (padBackground) para cerrar los contornos que tocan el borde de
 * la imagen — igual que el pipeline principal (traceLayers).
 */
export function extractContours(
  idx: Int8Array,
  margins: Float32Array,
  width: number,
  height: number,
  layer: number,
  minRegion: number
): Array<Array<[number, number]>> {
  const padded = padBackground(idx, width, height);
  const pmargins = padMargins(margins, width, height);
  if (padded.width >= 6 && padded.height >= 6) {
    const coarse = downsample2x(padded.idx, pmargins, padded.width, padded.height);
    const saddleFree = breakSaddles(coarse.idx, coarse.margins, coarse.width, coarse.height);
    return unpadRings(scaleAndFilterRings(
      traceRings(saddleFree, coarse.margins, coarse.width, coarse.height, layer),
      true,
      minRegion
    ));
  }
  return unpadRings(scaleAndFilterRings(
    traceRings(padded.idx, pmargins, padded.width, padded.height, layer), false, minRegion
  ));
}

/** Serializa los contornos de una capa como UN string de path SVG. */
export function serializeLayerPath(contours: Array<Array<[number, number]>>): string {
  return contours
    .map((ring) => {
      const pts = ring.map(([x, y]) => `${x},${y}`).join(" L");
      return `M${pts} Z`;
    })
    .join(" ");
}

/**
 * Rejilla con 2 px de FONDO (−1) alrededor de toda la imagen. Sin este marco,
 * los píxeles de capa que tocan el borde de la imagen dejan puntos medios con
 * una sola arista (el marching squares solo crea celdas i<w−1, j<h−1): el
 * ensamblado corta la cadena y el cierre "Z" del serializer une los extremos
 * EN LÍNEA RECTA a través de la imagen → líneas largas y triángulos evenodd
 * (bug 2026-09-22). El marco de 2 px garantiza que, también tras el diezmado
 * 0.5×, haya una celda gruesa de fondo completa en cada lado: todo contorno
 * cierra por el marco y todo punto de frontera tiene sus 2 celdas. downsample2x
 * ya acepta índices −1.
 */
const PAD = 2;

function padBackground(
  idx: Int8Array,
  width: number,
  height: number
): { idx: Int8Array; width: number; height: number } {
  const w2 = width + 2 * PAD;
  const h2 = height + 2 * PAD;
  const out = new Int8Array(w2 * h2).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(y + PAD) * w2 + (x + PAD)] = idx[y * width + x];
    }
  }
  return { idx: out, width: w2, height: h2 };
}

/** Igual que padBackground pero para los márgenes (Float32, borde 0). */
function padMargins(margins: Float32Array, width: number, height: number): Float32Array {
  const w2 = width + 2 * PAD;
  const h2 = height + 2 * PAD;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(y + PAD) * w2 + (x + PAD)] = margins[y * width + x];
    }
  }
  return out;
}

/**
 * Rejillas preparadas para el trazado (cierre de agujeros + marco de fondo +
 * diezmado 0.5× + resolución de sillas), COMPARTIDAS por traceLayers y
 * traceLayerMasks para que la validación del invariante pruebe exactamente
 * el camino de producción.
 */
interface PreparedGrids {
  /** Rejilla completa post-cierre de agujeros (no mutada por el trazado). */
  work: Int8Array;
  margins: Float32Array;
  width: number;
  height: number;
  /** Rejilla 0.5× (solo si ≥6×6); null si el trazado va a resolución plena. */
  coarse: { idx: Int8Array; margins: Float32Array; width: number; height: number } | null;
  /** Rejilla gruesa con sillas resueltas (misma para todas las capas). */
  saddleFree: Int8Array | null;
}

function prepareGrids(trace: TraceResult, minRegion: number): PreparedGrids {
  const work = new Int8Array(trace.idx);
  for (let layer = 0; layer < trace.palette.length; layer++) {
    fillHolesSmallerThan(work, trace.width, trace.height, layer, minRegion);
  }
  const padded = padBackground(work, trace.width, trace.height);
  const margins = padMargins(trace.margins, trace.width, trace.height);
  if (padded.width >= 6 && padded.height >= 6) {
    const coarse = downsample2x(padded.idx, margins, padded.width, padded.height);
    return {
      work: padded.idx,
      margins,
      width: padded.width,
      height: padded.height,
      coarse,
      saddleFree: breakSaddles(coarse.idx, coarse.margins, coarse.width, coarse.height),
    };
  }
  return {
    work: padded.idx,
    margins,
    width: padded.width,
    height: padded.height,
    coarse: null,
    saddleFree: null,
  };
}

/** Desplaza los anillos de la rejilla paddeada (−PAD px en cada eje). */
function unpadRings(
  rings: Array<Array<[number, number]>>
): Array<Array<[number, number]>> {
  return rings.map((ring) => ring.map(([x, y]) => [round1(x - PAD), round1(y - PAD)] as [number, number]));
}

/** Anillos de UNA capa por el mismo camino que traceLayers. */
function ringsForLayer(
  g: PreparedGrids,
  _trace: TraceResult,
  layer: number,
  minRegion: number
): Array<Array<[number, number]>> {
  if (g.coarse && g.saddleFree) {
    return unpadRings(scaleAndFilterRings(
      traceRings(g.saddleFree, g.coarse.margins, g.coarse.width, g.coarse.height, layer),
      true,
      minRegion
    ));
  }
  return unpadRings(scaleAndFilterRings(
    traceRings(g.work, g.margins, g.width, g.height, layer),
    false,
    minRegion
  ));
}

/**
 * Traza las 4 capas (paths + paleta). Depende SOLO de minRegion: cierra
 * agujeros < minRegion en las máscaras, diezma a 0.5× y traza. Los ajustes
 * de color no pasan por aquí.
 */
export function traceLayers(
  trace: TraceResult,
  minRegion: number
): Array<{ palette: [number, number, number]; path: string }> {
  const g = prepareGrids(trace, minRegion);
  return trace.palette.map((palette, layer) => {
    const contours = ringsForLayer(g, trace, layer, minRegion);
    return {
      palette,
      path: contours.length > 0 ? serializeLayerPath(contours) : "M0 0 Z",
    };
  });
}

/**
 * VALIDACIÓN/DEPURACIÓN (test de invariante): traza cada capa y además
 * devuelve la MÁSCARA BINARIA EXACTA que el trazador trazó — la rejilla
 * gruesa 0.5× (post-sillas) re-escalada a bloques 2×2 en resolución plena,
 * o la rejilla completa cuando no hubo diezmado (<6×6). Con (mask, path) se
 * puede verificar el invariante geométrico: vértices a ≤tol px de un píxel
 * de frontera y segmentos sin saltos (todo punto del segmento cerca de la
 * frontera).
 */
export interface TracerLayerMask {
  layer: number;
  path: string;
  /** Máscara binaria 0/1 en resolución completa (lo que el trazador vio). */
  mask: Uint8Array;
  width: number;
  height: number;
  /** true si el trazado se hizo en la rejilla 0.5× (tol ≈ 1.1 px). */
  coarse: boolean;
}

export function traceLayerMasks(trace: TraceResult, minRegion: number): TracerLayerMask[] {
  const g = prepareGrids(trace, minRegion);
  const { width, height } = trace;
  return trace.palette.map((_, layer) => {
    const contours = ringsForLayer(g, trace, layer, minRegion);
    const path = contours.length > 0 ? serializeLayerPath(contours) : "M0 0 Z";
    if (!g.coarse || !g.saddleFree) {
      // Rejilla paddeada: el píxel original (x, y) está en (x+PAD, y+PAD).
      const mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          mask[y * width + x] = g.work[(y + PAD) * g.width + (x + PAD)] === layer ? 1 : 0;
        }
      }
      return { layer, path, mask, width, height, coarse: false };
    }
    // Equivalente exacto del diezmado sobre la rejilla paddeada: el píxel
    // original (x, y) está en padded (x+PAD, y+PAD) → celda gruesa
    // (⌊(x+PAD)/2⌋, ⌊(y+PAD)/2⌋).
    const cw = g.coarse.width;
    const ch = g.coarse.height;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cx = Math.floor((x + PAD) / 2);
        const cy = Math.floor((y + PAD) / 2);
        mask[y * width + x] =
          cx < cw && cy < ch && g.saddleFree[cy * cw + cx] === layer ? 1 : 0;
      }
    }
    return { layer, path, mask, width, height, coarse: true };
  });
}

/**
 * DEPURACIÓN del invariante: segmentos EXACTOS que el trazador ensambla
 * para una capa (misma rejilla preparada que traceLayers: cierre de
 * agujeros + diezmado 0.5× + resolución de sillas), con el grado de cada
 * punto de la retícula. La validación topológica los usa para distinguir
 * empalmes reales de artefactos.
 */
export function debugTracerSegments(
  trace: TraceResult,
  minRegion: number,
  layer: number
): {
  segments: Array<[number, number]>;
  degrees: Map<number, number>;
  coarse: boolean;
} {
  const g = prepareGrids(trace, minRegion);
  const idx = g.saddleFree ?? g.work;
  const w = g.coarse ? g.coarse.width : trace.width;
  const h = g.coarse ? g.coarse.height : trace.height;
  const T = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j;
  const R = (i: number, j: number) => (2 * i + 2) * 100000 + 2 * j + 1;
  const B = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j + 2;
  const L = (i: number, j: number) => (2 * i) * 100000 + 2 * j + 1;
  const SEPARATE: Array<[number, number]> = [[0, 1], [3, 2]];
  const JOIN: Array<[number, number]> = [[0, 3], [2, 1]];
  const segments: Array<[number, number]> = [];
  const degrees = new Map<number, number>();
  const bump = (p: number) => degrees.set(p, (degrees.get(p) ?? 0) + 1);
  const margins = g.coarse ? g.coarse.margins : trace.margins;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const tl = idx[j * w + i] === layer ? 8 : 0;
      const tr = idx[j * w + i + 1] === layer ? 4 : 0;
      const br = idx[(j + 1) * w + i + 1] === layer ? 2 : 0;
      const bl = idx[(j + 1) * w + i] === layer ? 1 : 0;
      const segs = saddleAwareCase(tl | tr | br | bl, margins, j * w + i, w, SEPARATE, JOIN);
      if (!segs) continue;
      for (const [a, b] of segs) {
        const pa = a === 0 ? T(i, j) : a === 1 ? R(i, j) : a === 2 ? B(i, j) : L(i, j);
        const pb = b === 0 ? T(i, j) : b === 1 ? R(i, j) : b === 2 ? B(i, j) : L(i, j);
        segments.push([pa, pb]);
        bump(pa);
        bump(pb);
      }
    }
  }
  return { segments, degrees, coarse: g.coarse !== null };
}

/**
 * DEPURACIÓN: anillos crudos (pre-DP/snap/removeSpikes) de una capa, tal
 * como cierran en el ensamblador. Permite localizar saltos/empalmes.
 */
export function debugRawRings(
  trace: TraceResult,
  minRegion: number,
  layer: number
): Array<Array<[number, number]>> {
  const g = prepareGrids(trace, minRegion);
  const idx = g.saddleFree ?? g.work;
  const w = g.coarse ? g.coarse.width : g.width;
  const h = g.coarse ? g.coarse.height : g.height;
  const margins = g.coarse ? g.coarse.margins : g.margins;
  const T = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j;
  const R = (i: number, j: number) => (2 * i + 2) * 100000 + 2 * j + 1;
  const B = (i: number, j: number) => (2 * i + 1) * 100000 + 2 * j + 2;
  const L = (i: number, j: number) => (2 * i) * 100000 + 2 * j + 1;
  const SEPARATE: Array<[number, number]> = [[0, 1], [3, 2]];
  const JOIN: Array<[number, number]> = [[0, 3], [2, 1]];
  const segments: Array<[number, number]> = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const tl = idx[j * w + i] === layer ? 8 : 0;
      const tr = idx[j * w + i + 1] === layer ? 4 : 0;
      const br = idx[(j + 1) * w + i + 1] === layer ? 2 : 0;
      const bl = idx[(j + 1) * w + i] === layer ? 1 : 0;
      const segs = saddleAwareCase(tl | tr | br | bl, margins, j * w + i, w, SEPARATE, JOIN);
      if (!segs) continue;
      for (const [a, b] of segs) {
        segments.push([
          a === 0 ? T(i, j) : a === 1 ? R(i, j) : a === 2 ? B(i, j) : L(i, j),
          b === 0 ? T(i, j) : b === 1 ? R(i, j) : b === 2 ? B(i, j) : L(i, j),
        ]);
      }
    }
  }
  const adjacency = new Map<number, Array<[number, number]>>();
  segments.forEach(([a, b], id) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push([b, id]);
    adjacency.get(b)!.push([a, id]);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const rings: Array<Array<[number, number]>> = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const [a0, b0] = segments[s];
    const ring: Array<[number, number]> = [
      [Math.floor(a0 / 100000) / 2, (a0 % 100000) / 2],
      [Math.floor(b0 / 100000) / 2, (b0 % 100000) / 2],
    ];
    let cur = b0;
    let guard = 0;
    while (cur !== a0 && guard++ <= segments.length + 1) {
      const next = adjacency.get(cur)!.find(([, id]) => !used[id]);
      if (!next) break;
      used[next[1]] = true;
      cur = next[0];
      if (cur !== a0) {
        ring.push([Math.floor(cur / 100000) / 2, (cur % 100000) / 2]);
      }
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Convenio completo (posterizar + trazar + orden por luminancia), con
 * color = palette (sin ajustes HSL). El editor hace el ordenamiento con los
 * colores finales; esto se usa en tests y como API de una sola llamada.
 */
export function generatePosterized(
  img: ImageDataLike,
  minRegion: number
): Layer[] {
  const trace = posterizeImage(img);
  const traced = traceLayers(trace, minRegion);
  const order = trace.palette
    .map((color, i) => ({ i, lum: luminance(color[0], color[1], color[2]) }))
    .sort((a, b) => a.lum - b.lum || a.i - b.i)
    .map((e) => e.i);
  return order.map((p, layerIdx) => ({
    band: [POSTERIZED_BANDS[layerIdx][0], POSTERIZED_BANDS[layerIdx][1]] as [number, number],
    palette: [...trace.palette[p]] as [number, number, number],
    color: [...trace.palette[p]] as [number, number, number],
    path: traced[p].path,
  }));
}

/** Contador DEPURACIÓN: cuántas veces el ensamblador de producción ve un
 *  punto de grado > 2 (candidatas a emparejamiento no cruzado). */
export const debugWalkDegree4: { count: number; points: Array<[number, number]> } = {
  count: 0,
  points: [],
};
