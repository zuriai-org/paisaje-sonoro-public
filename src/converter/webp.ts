/**
 * Conversión de imagen a WebP con fallback JPEG (DISENO.md §2.5).
 * Corre 100% en el navegador (canvas.toBlob). Safari < 16 no codifica WebP:
 * se usa JPEG 0.85 con aviso. La herramienta NUNCA borra el original.
 */

export const WEBP_QUALITY = 0.9;
export const JPEG_FALLBACK_QUALITY = 0.85;

export interface ConversionResult {
  blob: Blob;
  mime: "image/webp" | "image/jpeg";
  /** true si el navegador no soportó WebP y se usó JPEG. */
  fallbackUsed: boolean;
  /** Aviso para mostrar al usuario cuando se usa el fallback. */
  warning: string | null;
  /** Tamaño del blob generado (bytes). */
  size: number;
  /** Nombre sugerido para la descarga (extensión según formato real). */
  suggestedName: string;
}

const FALLBACK_WARNING =
  "Tu navegador no soporta la codificación WebP: se ha generado un JPEG " +
  "(calidad 0.85). El archivo es algo más pesado. El WebP lo puedes " +
  "generar después desde otro navegador si lo necesitas.";

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Codifica un canvas a WebP; si el navegador devuelve otro tipo (Safari
 * antiguo devuelve PNG en lugar de fallar), reintenta con JPEG.
 */
export async function convertCanvas(
  canvas: HTMLCanvasElement,
  baseFileName: string
): Promise<ConversionResult> {
  const webp = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY);
  if (webp && webp.type === "image/webp") {
    return {
      blob: webp,
      mime: "image/webp",
      fallbackUsed: false,
      warning: null,
      size: webp.size,
      suggestedName: `${baseName(baseFileName)}.webp`,
    };
  }

  const jpeg = await canvasToBlob(canvas, "image/jpeg", JPEG_FALLBACK_QUALITY);
  if (!jpeg) {
    throw new Error("No se pudo codificar la imagen (toBlob devolvió null).");
  }
  return {
    blob: jpeg,
    mime: "image/jpeg",
    fallbackUsed: true,
    warning: FALLBACK_WARNING,
    size: jpeg.size,
    suggestedName: `${baseName(baseFileName)}.jpg`,
  };
}

/** Convierte un File de imagen a WebP/JPEG redibujándolo en un canvas. */
export async function convertImageFile(file: File): Promise<ConversionResult> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D no disponible en este navegador.");
    ctx.drawImage(bitmap, 0, 0);
    return await convertCanvas(canvas, file.name);
  } finally {
    bitmap.close();
  }
}
