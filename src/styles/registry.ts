/**
 * Registro de estilos del conversor (pluggable).
 *
 * Cada estilo declara su editor como lazy import, así el asistente (Wizard)
 * no conoce los conversores concretos: añadir Line Art, Posterizado o
 * Azimuthal en el futuro será registrar aquí su entrada + su componente,
 * SIN tocar el asistente.
 *
 * Contrato del componente de estilo (StyleEditorProps): recibe onDocument,
 * que se llama tras cada regeneración con el documento de puntos generado
 * (y el WebP de referencia, si el estilo lo produce).
 */
import type { ComponentType } from "react";
import type { Layer } from "../converter/format";
import type { AzimuthalKeyframe } from "../converter/azimuthal";

/**
 * Documento generado por un editor de estilo, elevado al asistente.
 * - Puntillista: `points` plano v1, params {step, maxRadius, multiplicador}.
 * - Posterizado: `layers` (v3, paths), params {hueGlobal, layerAlpha, bw,
 *   grayTone, minRegion, removeBackground}; `points` queda vacío.
 * - Line Art (LA-2): `segments` plano (v3 lineart), params {step, maxLength,
 *   strokeWidth}; `points` vacío y `layers` null.
 * - Azimutal (AZ-2): `frames` (14 estados) + `keyframes` [3 × roll/pitch/
 *   yaw], params {step, maxRadius, multiplicador}; `points` vacío.
 */
export interface StyleDocument {
  points: number[];
  layers?: Layer[] | null;
  /** Segmentos planos [x, y, angle, len, rgb] del estilo Line Art. */
  segments?: number[] | null;
  /** 14 estados precomputados [x, y, r, rgb] del estilo Azimutal. */
  frames?: number[][] | null;
  /** Los 3 keyframes (5 grados de libertad) del estilo Azimutal. */
  keyframes?: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] | null;
  /** Parámetros reales del estilo (van al JSON de su versión;
   *  orbitMode del azimutal es un string: 'clamp' | 'bounce'). */
  params: Record<string, number | number[] | boolean | string>;
  width: number;
  height: number;
  name: string;
  seed: number;
  maxVisibleRatio: number;
  /** WebP de referencia (JPEG si el navegador no codifica WebP). */
  webp: Blob | null;
  webpName: string | null;
  /** JPEG posterizado a 4 colores (artefacto de trabajo del posterizado). */
  posterizedJpeg?: Blob | null;
  posterizedJpegName?: string | null;
}

export interface StyleEditorProps {
  onDocument: (doc: StyleDocument) => void;
}

export interface StyleDef {
  id: string;
  nombre: string;
  descripcion: string;
  /** false → visible en el selector pero deshabilitado ("próximamente"). */
  disponible: boolean;
  /** Editor del estilo (lazy import). Solo requerido si disponible. */
  componente?: () => Promise<{ default: ComponentType<StyleEditorProps> }>;
}

export const STYLES: StyleDef[] = [
  {
    id: "puntillista",
    nombre: "Puntillista",
    descripcion: "Rejilla de puntos: radio ∝ oscuridad, muestreo probabilístico por luminosidad.",
    disponible: true,
    componente: () =>
      import("../converter/PuntillistConverter").then((m) => ({ default: m.default })),
  },
  {
    id: "line-art",
    nombre: "Line Art",
    descripcion:
      "Trazos que siguen los contornos de la imagen, como un grabado; el audio los dibuja y los hace vibrar.",
    disponible: true,
    componente: () =>
      import("../converter/LineArtConverter").then((m) => ({ default: m.default })),
  },
  {
    id: "posterizado",
    nombre: "Posterizado 4 capas",
    descripcion:
      "La imagen se reduce a 4 colores; cada color responde a un rango de frecuencia (el más oscuro a los graves, el más claro a los agudos).",
    disponible: true,
    componente: () =>
      import("../converter/PosterizedConverter").then((m) => ({ default: m.default })),
  },
  {
    id: "azimuthal",
    nombre: "Azimutal",
    descripcion:
      "Los bordes principales de tu imagen en líneas negras que orbitan como un mapa deformado; el tema avanza la órbita y los picos la hacen respirar.",
    disponible: true,
    componente: () =>
      import("../converter/AzimuthalConverter").then((m) => ({ default: m.default })),
  },
];

export const DEFAULT_STYLE_ID = "puntillista";

export function getStyle(id: string): StyleDef | undefined {
  return STYLES.find((s) => s.id === id);
}
