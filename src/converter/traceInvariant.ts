/**
 * VALIDADOR DE INVARIANTE del trazador (test de propiedad, permanente).
 *
 * Dada la máscara binaria de UNA capa (la que el trazador realmente vio —
 * ver `traceLayerMasks`) y su path resultante, verifica:
 *
 *  (a) INVARIANTE DE VÉRTICES: todo vértice yace a ≤ tolVertex px de la
 *      FRONTERA de la máscara.
 *  (b) INVARIANTE DE SEGMENTOS: todo punto de todo segmento sigue la
 *      frontera — se muestrea cada `sampleStep` px y cada muestra debe estar
 *      a ≤ tolSegment de la frontera. Un segmento que "salta" a través de la
 *      región (cruza el interior o el exterior lejano) deja muestras lejos
 *      de la frontera → violación con coordenadas.
 *
 * Métrica (re-baseline 2026-09-23, debug forense): DISTANCIA PERPENDICULAR
 * REAL a la curva de frontera. Se computan dos transformadas de distancia
 * euclídea exactas (EDT de Felzenszwalb, O(n)) sobre la máscara: distancia
 * al píxel de la capa más cercano y al de fuera más cercano; la distancia
 * de un punto a la CURVA de frontera es
 *
 *      d = min(edtDentro, edtFuera) − 0.5   (acotada a ≥ 0)
 *
 * (la frontera yace entre centros de píxeles vecinos, a 0.5 de cada uno).
 * Así una cuerda de simplificación válida mide su desviación real (~≤1.7 px
 * para DP ε 0.6 en rejilla 0.5×) y no su "salto". La medida anterior (a
 * centros de píxel de frontera) sobredimensionaba esas cuerdas ~0.5–1 px.
 *
 * Marco padBackground: la máscara se valida CON el marco de 2 px de fondo
 * de producción (padBackground): los cierres del anillo que pasean por el
 * marco quedan a ≤ ~1 px de la frontera del marco → válidos por diseño. Un
 * cierre que CUT desde el contenido al marco (el bug de la cascada de
 * removeSpikes) sigue midiendo su desviación real → se detecta.
 *
 * Tolerancia permanente del proyecto: 2.5 px (0 violaciones graves en las
 * 3 fotos reales).
 */

export interface InvariantViolation {
  kind: "vertex" | "segment";
  /** Índice del anillo (subtrayecto M…Z) dentro del path. */
  ring: number;
  /** Índice del vértice infractor (o vértice inicial del segmento). */
  vertexIndex: number;
  /** Punto infractor: el vértice, o la primera muestra del segmento en fallo. */
  point: [number, number];
  /** Distancia perpendicular real a la curva de frontera (px). */
  distance: number;
  /** Para kind === "segment": extremos del segmento y nº de muestras en fallo. */
  segment?: { from: [number, number]; to: [number, number]; failingSamples: number; samples: number };
}

export interface ValidateOptions {
  /** Tolerancia de vértices (px). Default 2.5. */
  tolVertex?: number;
  /** Tolerancia de muestras de segmento (px). Default 2.5. */
  tolSegment?: number;
  /** Paso de muestreo a lo largo de cada segmento (px). Default 0.25. */
  sampleStep?: number;
  /** Máximo de violaciones devueltas (evita inundación). Default 500. */
  maxViolations?: number;
}

/** Parsea "M x,y L x,y … Z M … Z" en anillos de [x, y]. */
export function parsePathRings(path: string): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  for (const sub of path.split("Z")) {
    const trimmed = sub.trim();
    if (!trimmed.startsWith("M")) continue;
    const pts: Array<[number, number]> = [];
    for (const token of trimmed.slice(1).split("L")) {
      const [x, y] = token.trim().split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
    if (pts.length >= 3) rings.push(pts);
  }
  return rings;
}

/** Grosor del marco de fondo de producción (padBackground en posterize.ts). */
const PAD = 2;

/** EDT 1D exacta (parábolas, Felzenszwalb–Huttenlocher) sobre f[0..n). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distancia euclídea de cada píxel al píxel más cercano con valor `target`. */
function edt(binary: Uint8Array, w: number, h: number, target: number): Float64Array {
  const INF = 1e20;
  const d = new Float64Array(w * h);
  let hasTarget = false;
  for (let p = 0; p < w * h; p++) {
    if (binary[p] === target) hasTarget = true;
    d[p] = binary[p] === target ? 0 : INF;
  }
  if (!hasTarget) return d; // todo INF: sin píxeles de ese valor
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const tmp = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    edt1d(f, h, tmp, v, z);
    for (let y = 0; y < h; y++) d[y * w + x] = tmp[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    edt1d(f, w, tmp, v, z);
    for (let x = 0; x < w; x++) d[y * w + x] = tmp[x];
  }
  for (let p = 0; p < w * h; p++) d[p] = Math.sqrt(d[p]);
  return d;
}

/**
 * Verifica el invariante (mask, path). Devuelve TODAS las violaciones
 * encontradas (hasta maxViolations). Si la capa no tiene píxeles (máscara
 * vacía), no hay invariante que exigir: [] (el path "M0 0 Z" es la
 * convención de capa vacía).
 */
export function validateLayerPath(
  mask: Uint8Array,
  width: number,
  height: number,
  path: string,
  opts: ValidateOptions = {}
): InvariantViolation[] {
  const tolVertex = opts.tolVertex ?? 2.5;
  const tolSegment = opts.tolSegment ?? 2.5;
  const sampleStep = opts.sampleStep ?? 0.25;
  const maxViolations = opts.maxViolations ?? 500;

  let maskCount = 0;
  for (let p = 0; p < mask.length; p++) maskCount += mask[p];
  if (maskCount === 0) return [];

  // Máscara con el marco de fondo de producción (2 px de fondo alrededor).
  const w2 = width + 2 * PAD;
  const h2 = height + 2 * PAD;
  const padded = new Uint8Array(w2 * h2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      padded[(y + PAD) * w2 + (x + PAD)] = mask[y * width + x];
    }
  }
  const edtIn = edt(padded, w2, h2, 1);
  const edtOut = edt(padded, w2, h2, 0);

  // Distancia perpendicular real de (x, y) (coords reales, sin pad) a la
  // curva de frontera de la máscara.
  const dist = (x: number, y: number): number => {
    const ix = Math.min(w2 - 1, Math.max(0, Math.round(x + PAD)));
    const iy = Math.min(h2 - 1, Math.max(0, Math.round(y + PAD)));
    const p = iy * w2 + ix;
    const d = Math.min(edtIn[p], edtOut[p]) - 0.5;
    return d > 0 ? d : 0;
  };

  const violations: InvariantViolation[] = [];
  const push = (v: InvariantViolation) => {
    if (violations.length < maxViolations) violations.push(v);
  };

  const rings = parsePathRings(path);
  rings.forEach((ring, ringIdx) => {
    // (a) vértices.
    ring.forEach((pt, i) => {
      const d = dist(pt[0], pt[1]);
      if (d > tolVertex) {
        push({ kind: "vertex", ring: ringIdx, vertexIndex: i, point: pt, distance: d });
      }
    });
    // (b) segmentos (incluido el de cierre Z). La distancia reportada es la
    // MÁXIMA sobre TODAS las muestras del segmento (no solo las que superan
    // el umbral): así la evidencia no depende de la tolerancia elegida.
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const samples = Math.max(1, Math.ceil(len / sampleStep));
      let failing = 0;
      let maxDist = -1;
      let worstPoint: [number, number] = a;
      for (let s = 0; s <= samples; s++) {
        const t = s / samples;
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        const d = dist(x, y);
        if (d > maxDist) {
          maxDist = d;
          worstPoint = [x, y];
        }
        if (d > tolSegment) failing++;
      }
      if (failing > 0) {
        push({
          kind: "segment",
          ring: ringIdx,
          vertexIndex: i,
          point: worstPoint,
          distance: maxDist,
          segment: { from: a, to: b, failingSamples: failing, samples: samples + 1 },
        });
      }
    }
  });
  return violations;
}
