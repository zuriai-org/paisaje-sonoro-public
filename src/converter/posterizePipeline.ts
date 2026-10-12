/**
 * Pipeline estructural del posterizado (corrección 2026-09-22) — replica el
 * flujo manual validado por el usuario:
 *
 *   Krita posterizar → exportar JPEG → Inkscape traza ese JPEG
 *
 *   1. Imagen original → redimensionar a 900 px de ALTO (ANtes de todo;
 *      guardarraíl de memoria para imágenes enormes).
 *   2. De la imagen redimensionada: (a) WebP de referencia editorial y
 *      (b) POSTERIZAR a 4 colores (método vigente: retícula + top-6 del
 *          histograma con fusión del par más cercano hasta 4)
 *      → raster exacto de 4 colores + paleta (`renderRaster`).
 *   3. Ese raster se codifica como JPEG calidad 92 (~100 KB por ser colores
 *      planos). El JPEG ES el artefacto de trabajo: se muestra en pantalla,
 *      se sube al backend y ES la entrada del trazado.
 *   4. Trazado: decodificar el JPEG → `assignToPalette` (re-snap: el JPEG
 *      desplaza ligeramente los colores; volver a la paleta estabiliza los
 *      bordes, determinista) → máscaras → filtro mayoritario → trazado.
 *
 * PROHIBIDO: decodificar el WebP para procesar en cualquier punto.
 *
 * Las funciones de este módulo son las únicas dos entradas que usa el
 * editor (PosterizedConverter). Los pasos son inyectables (`deps`) para
 * poder testear el ORDEN del pipeline con mocks (sin canvas ni imágenes
 * reales: los tests corren en entorno node).
 */
import {
  assignToPalette,
  posterizeImage,
  renderRaster,
  traceLayers,
  type ImageDataLike,
  type TraceResult,
} from "./posterize";
import { checkDimensions, decodeImageFile, normalizeHeight, type ResizedCanvas } from "./image";
import { convertCanvas, type ConversionResult } from "./webp";

/** Calidad del JPEG del raster posterizado (artefacto de trabajo). */
export const POSTERIZED_JPEG_QUALITY = 0.92;

/** Extensión y mime del artefacto de trabajo. */
export const POSTERIZED_JPEG_EXT = ".jpg";
export const POSTERIZED_JPEG_MIME = "image/jpeg";

// ─────────────────────────────────────────────────────────────────────────
// Pasos de canvas (solo navegador — los tests inyectan mocks)
// ─────────────────────────────────────────────────────────────────────────

function imageDataToCanvas(img: ImageDataLike): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D no disponible en este navegador.");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas;
}

/** Codifica el raster posterizado (4 colores planos) como JPEG q92. */
export async function encodeRasterJpeg(trace: TraceResult): Promise<Blob> {
  const canvas = imageDataToCanvas(renderRaster(trace));
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, POSTERIZED_JPEG_MIME, POSTERIZED_JPEG_QUALITY)
  );
  if (!blob || blob.type !== POSTERIZED_JPEG_MIME) {
    throw new Error("No se pudo codificar el JPEG posterizado (toBlob devolvió null).");
  }
  return blob;
}

/** Decodifica un Blob (JPEG del pipeline o cualquier imagen) a ImageData. */
export async function decodeBlobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D no disponible en este navegador.");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Fase A · Carga: resize → webp ref → posterizar → JPEG
// ─────────────────────────────────────────────────────────────────────────

export interface PosterizeLoadDeps {
  decodeImageFile?: (file: File) => Promise<ImageBitmap>;
  normalizeHeight?: (bitmap: ImageBitmap) => ResizedCanvas;
  convertCanvas?: (canvas: HTMLCanvasElement, baseFileName: string) => Promise<ConversionResult>;
  posterizeImage?: (img: ImageDataLike) => TraceResult;
  encodeRasterJpeg?: (trace: TraceResult) => Promise<Blob>;
}

export interface PosterizeLoadResult {
  fileName: string;
  /** Imagen ya redimensionada a 900 px de alto (ancho proporcional). */
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  /** WebP (o JPEG fallback) de REFERENCIA editorial — nunca se procesa. */
  webp: ConversionResult;
  /** Paleta + máscaras del raster exacto de 4 colores (fase 1). */
  trace: TraceResult;
  /** Artefacto de trabajo: el raster posterizado codificado como JPEG q92. */
  posterizedJpeg: Blob;
  /** Advertencia de dimensiones (imagen grande → menos detalle), si aplica. */
  warning: string | null;
}

/**
 * PASO 1+2+3 del pipeline. Orden contractual (lo verifican los tests con
 * mocks): decode → checkDimensions → **resize** → webp ref → **posterizar
 * (sobre la imagen YA redimensionada)** → **JPEG**. Si la imagen supera el
 * máximo, se bloquea ANTES de redimensionar (guardarraíl de memoria: una
 * foto de 8000×8000 nunca se materializa entera).
 */
export async function loadPosterizedImage(
  file: File,
  deps: PosterizeLoadDeps = {}
): Promise<PosterizeLoadResult> {
  const decode = deps.decodeImageFile ?? decodeImageFile;
  const normalize = deps.normalizeHeight ?? normalizeHeight;
  const toWebp = deps.convertCanvas ?? convertCanvas;
  const posterize = deps.posterizeImage ?? posterizeImage;
  const encodeJpeg = deps.encodeRasterJpeg ?? encodeRasterJpeg;

  const bitmap = await decode(file);
  const check = checkDimensions(bitmap.width, bitmap.height);
  if (check.blocked) {
    bitmap.close();
    throw new Error(check.blocked);
  }
  const { canvas, imageData } = normalize(bitmap);
  bitmap.close();

  const webp = await toWebp(canvas, file.name);
  const trace = posterize(imageData);
  const posterizedJpeg = await encodeJpeg(trace);

  return {
    fileName: file.name,
    canvas,
    imageData,
    webp,
    trace,
    posterizedJpeg,
    warning: check.warning,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fase B · Trazado desde el JPEG (re-snap → máscaras → contornos)
// ─────────────────────────────────────────────────────────────────────────

export interface TraceFromJpegDeps {
  decodeBlobToImageData?: (blob: Blob) => Promise<ImageData>;
  assignToPalette?: (
    img: ImageDataLike,
    palette: ReadonlyArray<readonly [number, number, number]>,
    opts?: { background?: readonly [number, number, number] | null }
  ) => TraceResult;
}

/**
 * PASO 4 del pipeline. Orden contractual: **decodificar el JPEG** →
 * **re-snap a la paleta** (`assignToPalette`) → devuelve el TraceResult con
 * el que se traza (`traceLayers`). NUNCA se decodifica el WebP.
 *
 * F2 (2026-10-11): si la fase 1 excluyó el fondo (`trace.backgroundExcluded`),
 * el re-snap recibe el color de fondo: los píxeles más cercanos a él que a
 * su color de paleta quedan SIN capa → la transparencia sobrevive al JPEG.
 */
export async function traceFromPosterizedJpeg(
  posterizedJpeg: Blob,
  trace: TraceResult,
  deps: TraceFromJpegDeps = {}
): Promise<TraceResult> {
  const decode = deps.decodeBlobToImageData ?? decodeBlobToImageData;
  const resnap = deps.assignToPalette ?? assignToPalette;
  const decoded = await decode(posterizedJpeg);
  return resnap(decoded, trace.palette, {
    background: trace.backgroundExcluded ? (trace.background ?? null) : null,
  });
}

/** Re-export para que el editor no importe de dos módulos. */
export { renderRaster, traceLayers };
