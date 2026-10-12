/**
 * Formato de datos "paisaje-sonoro" (DISENO.md §1).
 *
 * Versiones, unión discriminada por `version`/`style`:
 * - v1 "puntillista" (sin style): points plano [x, y, r, rgb, ...].
 * - v2 "posterized" (era paletteIdx, pre-matiz): migra a v3.
 * - v3 "posterized": 4 capas de color plano con MATIZ GLOBAL + TRANSPARENCIA
 *   POR CAPA (F2 2026-10-11; reemplaza al matiz por capa de 2026-09-23); cada
 *   capa lleva su banda de frecuencia. Las bandas son FIJAS: la capa más
 *   oscura (menor luminancia final) va a los graves y la más clara a los
 *   agudos. Los docs con matiz por capa (hueShift[4]) se normalizan al
 *   cargarse: hueGlobal = 0, layerAlpha = [1,1,1,1], Layer.color intacto.
 * - v3 "lineart" (LA-1 2026-09-24, estilo NUEVO — sin migraciones): segmentos
 *   planos [x, y, angle, len, rgb] × N en `primitives.segments`. Misma
 *   versión que el posterizado v3, otra rama del `style`.
 * - v3 "azimuthal" (AZ-1 2026-09-25, estilo NUEVO — sin migraciones):
 *   14 estados precomputados de una deformación Lambert azimuthal
 *   (keyframes roll/pitch/yaw) en `primitives.frames` (14 × array plano
 *   [x, y, r, rgb], TODAS de igual longitud). `keyframes` top-level.
 *
 * Compatibilidad hacia atrás: los documentos v1 siguen siendo válidos TAL
 * CUAL (versión terminal, sin migración: cambia la estructura points →
 * layers). Las v2 posterized migran a v3 con MIGRATIONS[2] (hueGlobal = 0 +
 * layerAlpha plenas; la v2 no recoloreaba, así que el color se preserva
 * exacto).
 */

export const FORMAT_NAME = "paisaje-sonoro";
export const FORMAT_VERSION = 3;

/**
 * Bandas fijas del posterizado (Hz), de graves a agudos. La asignación
 * capa→banda es por luminancia de paleta: la capa más oscura toma la banda
 * 0 y la más clara la banda 3.
 */
export const POSTERIZED_BANDS: ReadonlyArray<readonly [number, number]> = [
  [60, 200],
  [200, 1000],
  [1000, 4000],
  [4000, 10000],
];

/** Parámetros con los que se generó el documento (reproducibilidad). */
export interface PaisajeParams {
  /** Separación de la rejilla en px. */
  step: number;
  /** Radio máximo base. */
  maxRadius: number;
  /** Escala global del radio. */
  multiplicador: number;
  /** Semilla del PRNG (reproducibilidad). */
  seed: number;
  /** Ratio de puntos visibles en el reproductor. */
  maxVisibleRatio: number;
}

export interface PaisajeGenerator {
  name: string;
  version: string;
}

export interface PaisajeImage {
  width: number;
  height: number;
  webp: string | null;
  /**
   * Nombre del JPEG posterizado (artefacto de trabajo, campo "posterized"
   * de POST /api/image). Opcional: las v1 y las v2 antiguas no lo tienen.
   */
  posterizedJpeg?: string | null;
}

/** v1 · puntillista: array plano [x, y, r, rgb] × N (SIN CAMBIOS). */
export interface PaisajeDocumentV1 {
  format: typeof FORMAT_NAME;
  version: 1;
  generator: PaisajeGenerator;
  image: PaisajeImage;
  params: PaisajeParams;
  /** Coordenadas enteras, r con 1 decimal, rgb entero empaquetado. */
  points: number[];
}

/**
 * Una capa del posterizado: banda + color original + color final + TODOS
 * sus contornos como UN string de path SVG (subtrayectos "M..Z", fill plano).
 */
export interface Layer {
  /** Rango de frecuencia [lowHz, highHz] que modula esta capa. */
  band: [number, number];
  /** Color original de la capa (entrada de la paleta de 4 colores). */
  palette: [number, number, number];
  /** Color final tras los ajustes (elección de color/B&W; usa el player). */
  color: [number, number, number];
  /** Contornos de la capa serializados: "M x,y L x,y ... Z" por contorno. */
  path: string;
}

/**
 * Parámetros del posterizado (v2, era pre-matiz): elección discreta de color
 * de paleta por capa + B&W global + tono de gris por capa + limpieza. Schema
 * VIEJO: solo llega vía MIGRATIONS[2] → v3 (hueGlobal/layerAlpha). Se
 * conserva para validar las v2 almacenadas antes de migrarlas.
 */
export interface PosterizeAdjustParamsV2 {
  /** (v2) Color de paleta elegido por capa (índices 0..3, por capa). */
  paletteIdx: number[];
  /** B&W global: true = todas las capas se dibujan en grises. */
  bw: boolean;
  /** Tono de gris por capa (0..255), aplicado cuando bw = true. */
  grayTone: number[];
  /** px² · descarta contornos con área menor (motas). Re-traza. */
  minRegion: number;
}

/**
 * Parámetros del posterizado (v3, F2 2026-10-11): MATIZ GLOBAL + TRANSPARENCIA
 * POR CAPA. El matiz es UNA rotación para las 4 capas (−180..+180, 0 =
 * colores originales; color final = rotateHue(paleta, hueGlobal), con la
 * garantía de perceptibilidad de rotateHue). Cada capa además tiene una
 * opacidad (layerAlpha, 0..1) que aplica el player como fill-opacity.
 *
 * REEMPLAZA al matiz por capa (params.hueShift[4], 2026-09-23): los docs
 * viejos se normalizan en validateAndMigrate (hueGlobal = 0, layerAlpha =
 * [1,1,1,1], Layer.color intacto → look EXACTO; los hueShift se descartan).
 */
export interface PosterizeAdjustParams {
  /** Rotación de matiz GLOBAL en grados (−180..+180; 0 = colores originales). */
  hueGlobal: number;
  /** Opacidad por capa en el ORDEN DE LAS CAPAS (layers[0..3], 0..1; 1 = plena). */
  layerAlpha: number[];
  /** B&W global: true = todas las capas se dibujan en grises. */
  bw: boolean;
  /** Tono de gris por capa (0..255), aplicado cuando bw = true (orden de paleta del editor). */
  grayTone: number[];
  /** px² · descarta contornos con área menor (motas). Re-traza. */
  minRegion: number;
  /** F2: "quitar fondo" — el color del anillo del borde se excluye de la
   *  paleta y sus píxeles quedan transparentes. Default false. */
  removeBackground?: boolean;
}

/** v2 · posterized (schema pre-matiz; migra a v3). */
export interface PaisajeDocumentV2 {
  format: typeof FORMAT_NAME;
  version: 2;
  style: "posterized";
  generator: PaisajeGenerator;
  image: PaisajeImage;
  params: PosterizeAdjustParamsV2;
  layers: Layer[];
}

/** v3 · posterized: 4 capas ordenadas de más oscura (graves) a más clara. */
export interface PaisajeDocumentV3 {
  format: typeof FORMAT_NAME;
  version: 3;
  style: "posterized";
  generator: PaisajeGenerator;
  image: PaisajeImage;
  params: PosterizeAdjustParams;
  layers: Layer[];
}

/**
 * Parámetros del Line Art (v3, estilo 'lineart', LA-1 2026-09-24). `minRegion`
 * NO aplica (no hay trazador de regiones en este estilo).
 */
export interface LineArtParams {
  /** Separación de la rejilla en px. */
  step: number;
  /** Longitud máxima de trazo en px (sombras). */
  maxLength: number;
  /** Grosor de trazo en px (lo usa el futuro render/player). */
  strokeWidth: number;
  /** Semilla del PRNG (reproducibilidad del muestreo). */
  seed: number;
  /** Ratio de segmentos visibles en el reproductor. */
  maxVisibleRatio: number;
  /** LA-4: 'luz' (def, muestreo por sombra) | 'bordes' (grabado negro). */
  mode?: "luz" | "bordes";
  /** Magnitud de borde mínima en modo 'bordes' (0.05–0.6, def 0.15). */
  umbral?: number;
}

/** v3 · lineart: segmentos planos [x, y, angle, len, rgb] × N. */
export interface PaisajeDocumentLineArt {
  format: typeof FORMAT_NAME;
  version: 3;
  style: "lineart";
  generator: PaisajeGenerator;
  image: PaisajeImage;
  params: LineArtParams;
  /** Primitivas del estilo: los segmentos planos generados. */
  primitives: { segments: number[] };
}

/**
 * Keyframe del azimutal (AZ-3 reescritura): los 5 grados de libertad de la
 * esfera en grados. longitudCentral ±180, paraleloEstandar/pitch ±90,
 * roll/yaw ±180.
 */
export interface AzimuthalKeyframe {
  longitudCentral: number;
  paraleloEstandar: number;
  roll: number;
  pitch: number;
  yaw: number;
}

/**
 * v3 · azimuthal (AZ-3): 14 estados precomputados de la imagen-lineada
 * deformada. El medio son LÍNEAS DE BORDE negras (params del medio:
 * step/maxLength/strokeWidth/umbral — sin seed: los bordes son estructura,
 * determinista). `primitives.frames` = 14 × array plano de SEGMENTOS
 * [x, y, angle, len, rgb] con longitudes variables entre estados (los
 * docs azimutal de puntos de AZ-1/2 quedan inválidos: pre-lanzamiento).
 */
export interface AzimuthalStyleParams {
  /** Separación de la rejilla en px. */
  step: number;
  /** Longitud máxima de trazo en px (los bordes más fuertes). */
  maxLength: number;
  /** Grosor de trazo en px (lo usa el render/player). */
  strokeWidth: number;
  /** Magnitud de borde mínima para dibujar (0.05–0.6). */
  umbral: number;
  /** Ratio de segmentos visibles en el reproductor. */
  maxVisibleRatio: number;
  /**
   * Fin de recorrido de la órbita (AZ-4): 'clamp' (def) se detiene en la
   * vista C; 'bounce' regresa de C a A por el mismo camino. Opcional:
   * los docs previos a AZ-4 lo omiten y valen como 'clamp'.
   */
  orbitMode?: "clamp" | "bounce";
}

/**
 * v3 · azimuthal: 14 estados precomputados de una deformación Lambert
 * azimuthal. `keyframes` top-level [3 × {roll,pitch,yaw}]; los params del
 * doc ya NO llevan maxRadius/multiplicador/seed (era el medio puntillista).
 */
export interface PaisajeDocumentAzimuthal {
  format: typeof FORMAT_NAME;
  version: 3;
  style: "azimuthal";
  generator: PaisajeGenerator;
  image: PaisajeImage;
  params: AzimuthalStyleParams;
  /** Los 3 keyframes definidos por el usuario (roll/pitch/yaw en grados). */
  keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe];
  /** 14 frames de SEGMENTOS planos [x, y, angle, len, rgb] (longitudes
   *  variables entre estados — organicidad de la deformación). */
  primitives: { frames: number[][] };
}

export type PaisajeDocument =
  | PaisajeDocumentV1
  | PaisajeDocumentV2
  | PaisajeDocumentV3
  | PaisajeDocumentLineArt
  | PaisajeDocumentAzimuthal;

/** Empaqueta r,g,b (0–255) en un entero. */
export function packRGB(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | ((b & 0xff));
}

/** Desempaqueta un entero RGB en [r, g, b]. */
export function unpackRGB(packed: number): [number, number, number] {
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/** Redondea el radio a 1 decimal (DISENO.md §1.2). */
export function roundRadius(r: number): number {
  return Math.round(r * 10) / 10;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isValidParams(p: unknown): p is PaisajeParams {
  if (!isRecord(p)) return false;
  const { step, maxRadius, multiplicador, seed, maxVisibleRatio } = p;
  return (
    Number.isInteger(step) && (step as number) >= 1 &&
    typeof maxRadius === "number" && maxRadius > 0 &&
    typeof multiplicador === "number" && multiplicador > 0 &&
    Number.isInteger(seed) && (seed as number) >= 0 &&
    typeof maxVisibleRatio === "number" &&
    maxVisibleRatio > 0 && maxVisibleRatio <= 1
  );
}

function isValidPoints(points: unknown): points is number[] {
  if (!Array.isArray(points) || points.length % 4 !== 0) return false;
  const maxPacked = 0xffffff;
  for (let i = 0; i < points.length; i++) {
    const v = points[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    // Cada 4º valor es el color empaquetado; los 3 anteriores son x, y, r.
    if ((i + 1) % 4 === 0 && (!Number.isInteger(v) || v < 0 || v > maxPacked)) {
      return false;
    }
  }
  return true;
}

function isValidGenerator(g: unknown): g is PaisajeGenerator {
  return isRecord(g) && typeof g.name === "string";
}

function isValidImage(img: unknown): img is PaisajeImage {
  if (!isRecord(img)) return false;
  const { width, height, webp, posterizedJpeg } = img;
  return (
    Number.isInteger(width) && (width as number) > 0 &&
    Number.isInteger(height) && (height as number) > 0 &&
    (typeof webp === "string" || webp === null) &&
    (posterizedJpeg === undefined ||
      typeof posterizedJpeg === "string" ||
      posterizedJpeg === null)
  );
}

function isValidV1(doc: Record<string, unknown>): boolean {
  return (
    isValidGenerator(doc.generator) &&
    isValidImage(doc.image) &&
    isValidParams(doc.params) &&
    isValidPoints(doc.points)
  );
}

const MIN_BAND_HZ = 60;
const MAX_BAND_HZ = 10000;

function isValidBand(band: unknown): band is [number, number] {
  return (
    Array.isArray(band) &&
    band.length === 2 &&
    typeof band[0] === "number" &&
    typeof band[1] === "number" &&
    Number.isFinite(band[0]) &&
    Number.isFinite(band[1]) &&
    band[0] >= MIN_BAND_HZ &&
    band[0] < band[1] &&
    band[1] <= MAX_BAND_HZ
  );
}

function isValidPalette(palette: unknown): palette is [number, number, number] {
  return (
    Array.isArray(palette) &&
    palette.length === 3 &&
    palette.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 255)
  );
}

/** Array de 4 enteros en [min, max] (matiz por capa / tonos de gris). */
function isValidPerLayerIntArray(v: unknown, min: number, max: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every(
      (x) =>
        Number.isInteger(x) && (x as number) >= min && (x as number) <= max
    )
  );
}

/** Params v3: matiz global entero −180..180 + layerAlpha 4×[0..1]. */
function isValidLayerAlpha(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every(
      (x) => typeof x === "number" && Number.isFinite(x) && (x as number) >= 0 && (x as number) <= 1
    )
  );
}

function isValidPosterizeParams(p: unknown): p is PosterizeAdjustParams {
  if (!isRecord(p)) return false;
  return (
    Number.isInteger(p.hueGlobal) &&
    (p.hueGlobal as number) >= -180 &&
    (p.hueGlobal as number) <= 180 &&
    isValidLayerAlpha(p.layerAlpha) &&
    typeof p.bw === "boolean" &&
    isValidPerLayerIntArray(p.grayTone, 0, 255) &&
    typeof p.minRegion === "number" &&
    Number.isFinite(p.minRegion) &&
    (p.minRegion as number) >= 0 &&
    (p.removeBackground === undefined || typeof p.removeBackground === "boolean")
  );
}

/** Params v2 (schema viejo, pre-matiz): paletteIdx 0..3 por capa. */
function isValidPosterizeParamsV2(p: unknown): p is PosterizeAdjustParamsV2 {
  if (!isRecord(p)) return false;
  return (
    isValidPerLayerIntArray(p.paletteIdx, 0, 3) &&
    typeof p.bw === "boolean" &&
    isValidPerLayerIntArray(p.grayTone, 0, 255) &&
    typeof p.minRegion === "number" &&
    Number.isFinite(p.minRegion) &&
    (p.minRegion as number) >= 0
  );
}

/**
 * Capas v2: exactamente 4, bandas ascendentes sin solapamiento (graves →
 * agudos), paleta RGB válida y path SVG no vacío en cada capa.
 */
function isValidLayers(layers: unknown): layers is Layer[] {
  if (!Array.isArray(layers) || layers.length !== 4) return false;
  let prevHigh = -Infinity;
  for (const layer of layers) {
    if (!isRecord(layer)) return false;
    if (!isValidBand(layer.band)) return false;
    if (layer.band[0] < prevHigh) return false; // ascendente, sin solapar
    prevHigh = layer.band[1];
    if (!isValidPalette(layer.palette)) return false;
    if (!isValidPalette(layer.color)) return false;
    if (typeof layer.path !== "string" || layer.path.length === 0) return false;
  }
  return true;
}

function isValidV2(doc: Record<string, unknown>): boolean {
  return (
    doc.style === "posterized" &&
    isValidGenerator(doc.generator) &&
    isValidImage(doc.image) &&
    isValidPosterizeParamsV2(doc.params) &&
    isValidLayers(doc.layers)
  );
}

function isValidV3(doc: Record<string, unknown>): boolean {
  return (
    doc.style === "posterized" &&
    isValidGenerator(doc.generator) &&
    isValidImage(doc.image) &&
    isValidPosterizeParams(doc.params) &&
    isValidLayers(doc.layers)
  );
}

/** Params lineart: step entero ≥1, maxLength/strokeWidth > 0, seed ≥0,
 * maxVisibleRatio ∈ (0, 1]. `minRegion` NO existe en este estilo. LA-4:
 * `mode` ('luz'|'bordes') y `umbral` [0.05, 0.6] son OPCIONALES (los docs
 * previos los omiten y valen como 'luz'). */
function isValidLineArtParams(p: unknown): p is LineArtParams {
  if (!isRecord(p)) return false;
  const { step, maxLength, strokeWidth, seed, maxVisibleRatio, mode, umbral } = p;
  return (
    Number.isInteger(step) && (step as number) >= 1 &&
    typeof maxLength === "number" && maxLength > 0 &&
    typeof strokeWidth === "number" && strokeWidth > 0 &&
    Number.isInteger(seed) && (seed as number) >= 0 &&
    typeof maxVisibleRatio === "number" &&
    maxVisibleRatio > 0 && maxVisibleRatio <= 1 &&
    (mode === undefined || mode === "luz" || mode === "bordes") &&
    (umbral === undefined ||
      (typeof umbral === "number" && Number.isFinite(umbral) &&
        umbral >= 0.05 && umbral <= 0.6))
  );
}

/**
 * Segmentos lineart: longitud %5 === 0 ([x, y, angle, len, rgb]); ángulos en
 * [0, 360) (1 decimal), len > 0 y color empaquetado entero 0..0xffffff.
 */
function isValidSegments(segments: unknown): segments is number[] {
  if (!Array.isArray(segments) || segments.length % 5 !== 0) return false;
  const maxPacked = 0xffffff;
  for (let i = 0; i < segments.length; i++) {
    const v = segments[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    const k = i % 5;
    if (k === 2 && (v < 0 || v >= 360)) return false; // ángulo
    if (k === 3 && v <= 0) return false; // len
    if (k === 4 && (!Number.isInteger(v) || v < 0 || v > maxPacked)) return false; // rgb
  }
  return true;
}

function isValidLineArt(doc: Record<string, unknown>): boolean {
  return (
    doc.style === "lineart" &&
    isValidGenerator(doc.generator) &&
    isValidImage(doc.image) &&
    isValidLineArtParams(doc.params) &&
    isRecord(doc.primitives) &&
    isValidSegments(doc.primitives.segments)
  );
}

/** Keyframe azimutal: los 5 ángulos finitos en sus rangos (grados). */
function isValidAzimuthalKeyframe(k: unknown): k is AzimuthalKeyframe {
  if (!isRecord(k)) return false;
  const { longitudCentral, paraleloEstandar, roll, pitch, yaw } = k;
  const inRange = (v: unknown, min: number, max: number): boolean =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  return (
    inRange(longitudCentral, -180, 180) &&
    inRange(paraleloEstandar, -90, 90) &&
    inRange(roll, -180, 180) &&
    inRange(pitch, -90, 90) &&
    inRange(yaw, -180, 180)
  );
}

/** Params azimutales (AZ-3, medio de líneas de borde): sin seed. */
function isValidAzimuthalParams(p: unknown): p is AzimuthalStyleParams {
  if (!isRecord(p)) return false;
  const { step, maxLength, strokeWidth, umbral, maxVisibleRatio } = p;
  return (
    Number.isInteger(step) && (step as number) >= 1 &&
    typeof maxLength === "number" && maxLength > 0 &&
    typeof strokeWidth === "number" && strokeWidth > 0 &&
    typeof umbral === "number" && Number.isFinite(umbral) &&
    umbral >= 0.05 && umbral <= 0.6 &&
    typeof maxVisibleRatio === "number" &&
    maxVisibleRatio > 0 && maxVisibleRatio <= 1 &&
    (p.orbitMode === undefined ||
      p.orbitMode === "clamp" ||
      p.orbitMode === "bounce")
  );
}

/**
 * Frames azimutales (AZ-3): exactamente 14, cada uno un array plano de
 * SEGMENTOS válido (%5===0, ángulos [0,360), len > 0, colores enteros —
 * mismo validador que lineart). Las longitudes son VARIABLES entre estados
 * (los bordes entran y salen al deformarse): ya NO se exige igualdad.
 */
function isValidFrames(frames: unknown): frames is number[][] {
  if (!Array.isArray(frames) || frames.length !== 14) return false;
  for (const f of frames) {
    if (!isValidSegments(f)) return false;
  }
  return true;
}

function isValidAzimuthal(doc: Record<string, unknown>): boolean {
  return (
    doc.style === "azimuthal" &&
    isValidGenerator(doc.generator) &&
    isValidImage(doc.image) &&
    isValidAzimuthalParams(doc.params) &&
    Array.isArray(doc.keyframes) &&
    doc.keyframes.length === 3 &&
    doc.keyframes.every(isValidAzimuthalKeyframe) &&
    isRecord(doc.primitives) &&
    isValidFrames(doc.primitives.frames)
  );
}

/**
 * Type-guard de validación estricta (DISENO.md §1.3): unión discriminada —
 * version 1 → v1 (puntillista), version 2 → v2 (posterized pre-matiz),
 * version 3 + style 'posterized' → v3, version 3 + style 'lineart' →
 * Line Art (LA-1), version 3 + style 'azimuthal' → Azimutal (AZ-1). Sin
 * excepciones: devuelve true/false. Para error descriptivo usar
 * validateAndMigrate().
 */
export function isPaisajeDocument(doc: unknown): doc is PaisajeDocument {
  if (!isRecord(doc)) return false;
  if (doc.format !== FORMAT_NAME) return false;
  if (doc.version === 1) return isValidV1(doc);
  if (doc.version === 2) return isValidV2(doc);
  if (doc.version === 3) {
    if (doc.style === "lineart") return isValidLineArt(doc);
    if (doc.style === "azimuthal") return isValidAzimuthal(doc);
    return isValidV3(doc);
  }
  return false;
}

/**
 * Esqueleto de migración entre versiones (DISENO.md §1.3).
 * Cadena de migraciones: migrate_n → migrate_(n+1).
 *
 * - v1 es versión FINAL: no migra (cambia la estructura, points → layers).
 * - v2 → v3 (F2 2026-10-11): el slider COLOR pasa de "posición de paleta"
 *   (paletteIdx) a MATIZ GLOBAL + TRANSPARENCIA POR CAPA. El color final
 *   elegido vive en cada Layer.color; la v2 no recoloreaba (color == palette),
 *   así que hueGlobal = 0 lo preserva EXACTO. layerAlpha = [1,1,1,1].
 *   (La etapa intermedia hueShift[4] de 2026-09-23 se descarta: sus docs se
 *   normalizan en validateAndMigrate conservando Layer.color.)
 */
type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration> = {
  2: (doc) => {
    const params = { ...(doc.params as Record<string, unknown>) };
    delete params.paletteIdx;
    params.hueGlobal = 0;
    params.layerAlpha = [1, 1, 1, 1];
    return { ...doc, params };
  },
};

/**
 * Valida un documento cargado de fuente externa y migra versiones antiguas.
 * - Lanza Error con mensaje claro si la versión es MAYOR que la soportada.
 * - Lanza Error si la estructura es inválida.
 * - v1 (puntillista) se acepta tal cual: versión terminal, sin migración.
 * - v2 (posterized pre-matiz) migra a v3 por MIGRATIONS[2].
 * - v3 acepta TRES estilos: 'posterized' (capas), 'lineart' (segmentos,
 *   LA-1) y 'azimuthal' (14 frames, AZ-1) — estilos nuevos: sin migraciones,
 *   se validan directo.
 */
export function validateAndMigrate(raw: unknown): PaisajeDocument {
  if (!isRecord(raw)) throw new Error("Documento inválido: no es un objeto JSON.");
  if (raw.format !== FORMAT_NAME) {
    throw new Error(`Documento inválido: "format" debe ser "${FORMAT_NAME}".`);
  }
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("Documento inválido: versión ausente o no entera.");
  }
  if (version > FORMAT_VERSION) {
    throw new Error(
      `Formato generado por una versión más nueva (v${version} > v${FORMAT_VERSION}). Actualiza la herramienta.`
    );
  }

  // Migraciones encadenadas v_n → v_{n+1} → ... → v_actual (tabla MIGRATIONS).
  let doc: Record<string, unknown> = raw;
  for (let v = version; v < FORMAT_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) {
      // Versión terminal sin migración (v1 puntillista): se valida tal cual.
      if (!isPaisajeDocument(doc)) {
        throw new Error("Documento inválido: estructura o rangos incorrectos (points, params o image).");
      }
      return doc;
    }
    doc = migrate(doc);
    doc.version = v + 1;
  }

  // F2 (2026-10-11): normalización DENTRO de v3 posterizado — el matiz POR
  // CAPA (params.hueShift[4], 2026-09-23) se reemplaza por matiz GLOBAL +
  // transparencia por capa. Los docs viejos quedan válidos con hueGlobal = 0
  // y capas al 100 %, CONSERVANDO Layer.color tal cual (su look es EXACTO);
  // los hueShift antiguos se descartan (el color ya vive en Layer.color).
  if (
    doc.version === FORMAT_VERSION &&
    doc.style === "posterized" &&
    isRecord(doc.params) &&
    !("hueGlobal" in doc.params) &&
    Array.isArray(doc.params.hueShift)
  ) {
    const old = doc.params;
    doc = {
      ...doc,
      params: {
        hueGlobal: 0,
        layerAlpha: [1, 1, 1, 1],
        bw: old.bw,
        grayTone: old.grayTone,
        minRegion: old.minRegion,
      },
    };
  }

  if (!isPaisajeDocument(doc)) {
    // Mensaje claro para los docs azimutal de PUNTOS (AZ-1/AZ-2,
    // pre-lanzamiento): el medio ahora son líneas de borde — no migra.
    if (
      doc.style === "azimuthal" &&
      isRecord(doc.primitives) &&
      Array.isArray(doc.primitives.frames)
    ) {
      const fs = doc.primitives.frames;
      const parecenPuntos =
        fs.length === 14 &&
        fs.every(
          (f) => Array.isArray(f) && f.length % 4 === 0 && f.length % 5 !== 0
        );
      if (parecenPuntos) {
        throw new Error(
          "Documento azimutal de la versión de puntos (pre-AZ-3): el medio ahora son líneas de borde; regenera el documento con el conversor actual."
        );
      }
    }
    throw new Error("Documento inválido: estructura o rangos incorrectos (points, params o image).");
  }
  return doc;
}
