/**
 * Núcleo del conversor "Azimutal" (AZ-3 reescritura, 2026-09-26) — la imagen
 * como MAPA EQUIRECTANGULAR de la ESFERA COMPLETA (ancho = 360° de
 * longitud, alto = 180° de latitud; arriba = polo norte). La vista es un
 * DISCO: el hemisferio visible de d3.geoAzimuthalEquidistant (scale =
 * min(w,h)/π → el hemisferio llena el disco de diámetro min(w,h); translate
 * al centro; clipAngle 90). El exterior del disco es transparente.
 *
 * TINTA: segmentos de borde NEGROS sobre transparente (Sobel reutilizado de
 * lineart; param 'umbral'; len ∝ fuerza del borde). Muestreo por celda:
 * invert-proyectar el centro → lon/lat → pixel fuente → bilineal de
 * (magnitud, dirección). Celdas fuera del disco: nada. 14 estados
 * interpolando k1→k2→k3 (camino angular corto); longitudes variables; %5.
 *
 * 5 parámetros por keyframe (grados de libertad de la esfera, nombres para
 * periodistas): longitudCentral / paraleloEstandar (punto de vista),
 * roll (giro en pantalla), pitch / yaw (rotación del mapa sobre la esfera).
 * La costura del antimeridiano es auténtica (el mapa es global), no un bug.
 * La herramienta NO busca que el contenido salga de cuadro: la vista previa
 * es fiel y el usuario ajusta; solo se AVISA (vista casi vacía < 20 trazos).
 */
import {
  geoAzimuthalEquidistant,
  geoRotation,
  type GeoProjection,
  type GeoRotation,
} from "d3-geo";
import {
  borderField,
  sampleField,
  type BorderField,
} from "./lineart";

// El campo de bordes vive en lineart.ts desde LA-4 (hogar natural, encima
// de sobelGradients); se re-exporta aquí para no romper a los consumidores.
export { borderField, sampleField };
export type { BorderField };
import type { ImageDataLike } from "./core";

/** Nº de estados precomputados (player: órbita por progreso + vaivén). */
export const FRAME_COUNT = 14;
/** Aviso discreto de "vista casi vacía": menos trazos que esto en un frame. */
export const VISTA_VACIA_MIN = 20;

/** Umbral por defecto de magnitud de borde. */
export const DEFAULT_UMBRAL = 0.15;

/** Keyframe de rotación: los 5 grados de libertad (grados). */
export interface AzimuthalKeyframe {
  /** Punto de vista: paneo este-oeste (−180..180). + mueve el contenido al oeste. */
  longitudCentral: number;
  /** Punto de vista: inclinación norte-sur (−90..90). +90 lleva el contenido central al borde inferior del disco. */
  paraleloEstandar: number;
  /** Giro en el plano de la pantalla (−180..180). */
  roll: number;
  /** Rotación del mapa: baja/sube sobre la esfera (−90..90). */
  pitch: number;
  /** Rotación del mapa: alrededor del eje vertical (−180..180). */
  yaw: number;
}

/** Keyframe todo en cero (vista por defecto: centro del mapa al centro). */
export const ZERO_KEYFRAME: AzimuthalKeyframe = {
  longitudCentral: 0,
  paraleloEstandar: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
};

/** Parámetros del medio (subconjunto de AzimuthalParams). */
export interface AzimuthalSampling {
  step: number;
  maxLength: number;
  strokeWidth: number;
  /** Magnitud de borde mínima para dibujar (0.05–0.6). */
  umbral: number;
}

/** Parámetros del doc + los 3 keyframes. Sin seed: determinista. */
export interface AzimuthalParams extends AzimuthalSampling {
  maxVisibleRatio: number;
  keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe];
}

/** Devuelve true si un frame genera muy pocos segmentos (aviso, no bloqueo). */
export function vistaCasiVacia(segmentCount: number): boolean {
  return segmentCount < VISTA_VACIA_MIN;
}


// ─────────────────────────────────────────────────────────────────────────
// Modelo esférico: mapa equirectangular completo + disco hemisférico
// ─────────────────────────────────────────────────────────────────────────

function wrapLon(lambda: number): number {
  let l = ((lambda + 180) % 360 + 360) % 360;
  if (l < 0) l += 360;
  return l - 180;
}

/** Pixel → esfera [λ°, φ°] (mapa equirectangular completo; arriba = polo norte). */
export function pixelToSphere(x: number, y: number, w: number, h: number): [number, number] {
  return [(x / w) * 360 - 180, 90 - (y / h) * 180];
}

/** Esfera [λ°, φ°] → pixel fuente (la longitud se envuelve al antimeridiano). */
export function sphereToPixel(lambda: number, phi: number, w: number, h: number): [number, number] {
  const l = wrapLon(lambda);
  const p = Math.min(90, Math.max(-90, phi));
  return [((l + 180) / 360) * w, ((90 - p) / 180) * h];
}

/**
 * Vista DISCO: d3.geoAzimuthalEquidistant con scale = min(w,h)/π (el
 * hemisferio llena el disco de diámetro min(w,h)), translate al centro y
 * clipAngle(90): el exterior del hemisferio queda fuera (transparente).
 */
export function createProjection(w: number, h: number): GeoProjection {
  return geoAzimuthalEquidistant()
    .scale(Math.min(w, h) / Math.PI)
    .translate([w / 2, h / 2])
    .clipAngle(90);
}

/**
 * Rotación de VISTA (dónde mira el observador): longitudCentral hacia el
 * ESTE desplaza el contenido al OESTE, y paraleloEstandar +90 lleva el
 * contenido central al borde INFERIOR del disco — por eso la vista usa los
 * negados. roll es el giro en el plano de la pantalla (signo calibrado en
 * los tests: ver bitácora AZ-3).
 */
function viewRotation(k: AzimuthalKeyframe): [number, number, number] {
  return [-k.longitudCentral, -k.paraleloEstandar, k.roll];
}

/** Rotación del MAPA sobre la esfera (pitch = latitud, yaw = longitud). */
function mapRotation(k: AzimuthalKeyframe): GeoRotation {
  return geoRotation([k.yaw, k.pitch, 0]);
}

/**
 * Muestreo bilineal de un pixel RGB (API pública desde AZ-1; el medio usa
 * sampleField).
 */
export function sampleBilinear(
  img: ImageDataLike,
  x: number,
  y: number
): [number, number, number] {
  const { width, height, data } = img;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  const ch = (o: number) =>
    Math.round(
      (data[i00 + o] * (1 - fx) + data[i10 + o] * fx) * (1 - fy) +
        (data[i01 + o] * (1 - fx) + data[i11 + o] * fx) * fy
    );
  return [ch(0), ch(1), ch(2)];
}

// ─────────────────────────────────────────────────────────────────────────
// Interpolación de keyframes (camino angular corto, wrap ±180°)
// ─────────────────────────────────────────────────────────────────────────

/** Envuelve un ángulo a (−180, 180]. */
function wrap180(v: number): number {
  let a = v % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

const mixAngle = (a: number, b: number, t: number): number => {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return wrap180(a + d * t);
};

/** Interpolación de keyframes completa (los 5 ángulos por camino corto). */
export function interpolateKeyframes(
  k1: AzimuthalKeyframe,
  k2: AzimuthalKeyframe,
  t: number
): AzimuthalKeyframe {
  return {
    longitudCentral: mixAngle(k1.longitudCentral, k2.longitudCentral, t),
    paraleloEstandar: mixAngle(k1.paraleloEstandar, k2.paraleloEstandar, t),
    roll: mixAngle(k1.roll, k2.roll, t),
    pitch: mixAngle(k1.pitch, k2.pitch, t),
    yaw: mixAngle(k1.yaw, k2.yaw, t),
  };
}

/**
 * Al activar la pestaña de un frame SIN TOCAR: hereda los valores del
 * frame anterior (movimiento progresivo). El frame 1 abre siempre en 0.
 * Editable en cualquier orden después (touched[i] = true).
 */
export function activateKeyframeTab(
  keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe],
  touched: [boolean, boolean, boolean],
  j: 0 | 1 | 2
): {
  keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe];
  touched: [boolean, boolean, boolean];
} {
  if (touched[j]) return { keyframes, touched };
  const next: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] = [
    { ...keyframes[0] },
    { ...keyframes[1] },
    { ...keyframes[2] },
  ];
  if (j > 0) next[j] = { ...next[j - 1] };
  const touchedNext: [boolean, boolean, boolean] = [touched[0], touched[1], touched[2]];
  touchedNext[j] = true;
  return { keyframes: next, touched: touchedNext };
}

/** Rotación del estado s de 14 (t global uniforme; k2 en t = 0.5). */
function stateRotation(
  keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe],
  s: number
): AzimuthalKeyframe {
  const t = s / (FRAME_COUNT - 1);
  const [k1, k2, k3] = keyframes;
  return t <= 0.5
    ? interpolateKeyframes(k1, k2, t * 2)
    : interpolateKeyframes(k2, k3, (t - 0.5) * 2);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ─────────────────────────────────────────────────────────────────────────
// Generación: tinta de bordes deformada, longitudes variables
// ─────────────────────────────────────────────────────────────────────────

/**
 * Segmentos [x, y, angle, len, rgb] de UN estado: para cada centro de
 * celda, invert-proyectar → lon/lat del mapa → pixel fuente → (m, gx, gy)
 * bilineal; si m ≥ umbral, emitir el segmento tangente con len ∝ m. rgb
 * siempre negro (0). Fuera del disco: nada.
 */
function segmentsForRotation(
  field: BorderField,
  sampling: AzimuthalSampling,
  rotation: AzimuthalKeyframe,
  w: number,
  h: number
): number[] {
  const step = Math.max(1, Math.floor(sampling.step));
  const proj = createProjection(w, h);
  proj.rotate(viewRotation(rotation));
  const invert = proj.invert?.bind(proj);
  if (!invert) throw new Error("geoAzimuthalEquidistant sin invert: imposible muestrear.");
  const mapRot = mapRotation(rotation);
  const unrotateMap = mapRot.invert.bind(mapRot);

  const out: number[] = [];
  const discRadius = Math.min(w, h) / 2; // hemisferio visible
  for (let y = 0; y < h; y += step) {
    const y1 = Math.min(y + step, h);
    for (let x = 0; x < w; x += step) {
      const x1 = Math.min(x + step, w);
      const cx = (x + x1) / 2;
      const cy = (y + y1) / 2;
      // invert NO respeta el clip: más allá del hemisferio devuelve el
      // hemisferio TRASERO. Se descarta por radio de pantalla.
      if (Math.hypot(cx - w / 2, cy - h / 2) > discRadius) continue;
      const p = invert([cx, cy]);
      if (!p) continue; // fuera del disco: aquí no hay nada que dibujar
      const src = unrotateMap(p); // lon/lat fuente del mapa equirectangular
      const [sx, sy] = sphereToPixel(src[0], src[1], w, h);
      const { m, gx, gy } = sampleField(field, sx, sy);
      if (m < sampling.umbral) continue;
      // Tangente al borde (misma convención que lineart): atan2(gy,gx)+90.
      const angle =
        gx === 0 && gy === 0
          ? 0
          : ((round1((Math.atan2(gy, gx) * 180) / Math.PI + 90) % 360) + 360) % 360;
      const len = round1(sampling.maxLength * (0.4 + 0.6 * m));
      out.push(round1(cx), round1(cy), angle, len, 0);
    }
  }
  return out;
}

/** Segmentos de UN estado para el editor (preview de una vista). Barato. */
export function generateStateSegments(
  img: ImageDataLike,
  sampling: AzimuthalSampling,
  rotation: AzimuthalKeyframe
): number[] {
  return segmentsForRotation(borderField(img), sampling, rotation, img.width, img.height);
}

/**
 * Los 14 estados precomputados: { frames, keyframes }. Cada frame es un
 * array plano de segmentos (%5===0) con LONGITUD VARIABLE (los bordes
 * entran y salen al deformarse). Determinista (sin seed).
 */
export function generateFrames(
  img: ImageDataLike,
  params: AzimuthalParams
): { frames: number[][]; keyframes: AzimuthalKeyframe[] } {
  const field = borderField(img);
  const w = img.width;
  const h = img.height;
  const frames: number[][] = [];
  const keyframes: AzimuthalKeyframe[] = [];
  for (let s = 0; s < FRAME_COUNT; s++) {
    const k = stateRotation(params.keyframes, s);
    keyframes.push({
      longitudCentral: round1(k.longitudCentral),
      paraleloEstandar: round1(k.paraleloEstandar),
      roll: round1(k.roll),
      pitch: round1(k.pitch),
      yaw: round1(k.yaw),
    });
    frames.push(segmentsForRotation(field, params, k, w, h));
  }
  return { frames, keyframes };
}
