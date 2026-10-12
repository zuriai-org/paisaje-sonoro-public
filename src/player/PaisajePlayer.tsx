import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { validateAndMigrate, unpackRGB, type Layer } from "../converter/format";
import { seededPermutation } from "./permutation";
import {
  partitionPointsByBand,
  pointBandEnergy,
  veiledOpacity,
  TRANSITION_CELLS,
} from "./spectrum";
import { useAudioPeak } from "./useAudioPeak";
import "./player.css";

/**
 * <PaisajePlayer /> — reproductor audio-reactivo (DISENO.md §3).
 * Renderiza los puntos como <circle> React (D4: nunca innerHTML).
 */

export type ReducedMotionFallback = "static" | "fade";
export type PeakMode = "amplitude" | "spectrum";

interface PaisajePlayerBaseProps {
  audioUrl: string;
  width?: number | string;
  /** Default: dimensiones del documento JSON. */
  viewBox?: [number, number];
  /** Default: params.maxVisibleRatio del JSON, si no 1.0 (corrección fase 5). */
  maxVisibleRatio?: number;
  /** Default 0.7 (heredado del comportamiento auditado). */
  maxOpacity?: number;
  /** Default 0.03, micro-escala del grupo por peak. */
  scaleAmount?: number;
  /** Default 0.25, α del suavizado exponencial. */
  smoothing?: number;
  /**
   * Default 0.7, curva de sensibilidad del subset (corrección fase 5):
   * visibleCount = floor(peak^gamma · N · maxVisibleRatio).
   * gamma < 1 = más sensible en niveles bajos/medios.
   */
  gamma?: number;
  /**
   * Semilla de la permutación de revelado cuando se usa `points` prop
   * (con `jsonUrl` se lee `params.seed` del documento). Si se omite, 0.
   */
  seed?: number;
  /**
   * Default 1.0, rango razonable 0.5–3 (corrección fase 6): ganancia sobre
   * el peak instantáneo ANTES de la normalización adaptativa. Sube drive si
   * la pieza es muy plana y la imagen no llega a abrirse por completo.
   */
  drive?: number;
  /**
   * 'amplitude' (default): un solo peak global (comportamiento actual).
   * 'spectrum': franjas de frecuencia — cada punto revela según la energía
   * de su banda (mapeo espacial: graves izquierda → agudos derecha).
   */
  peakMode?: PeakMode;
  /** Nº de bandas en modo espectral (default 6, rango 2–12). */
  bands?: number;
  /**
   * Default 0.35 (rango 0–1): velo de opacidad por banda/peak.
   * opacity = maxOpacity · (1 − veil · (1 − energía)).
   * 0 = opacidad plena siempre; 1 = velo total (opacity = maxOpacity·energía).
   * Aplica igual en 'amplitude' (peak global) y 'spectrum' (por banda).
   */
  veil?: number;
  /** Default 0.02: por debajo, opacity 0 (silencio). */
  silenceThreshold?: number;
  title?: string;
  description?: string;
  /**
   * F2.5 (2026-10-11): desplazamiento [x, y] en unidades del viewBox aplicado
   * al CONTENIDO (dentro del clip del círculo): deja que el usuario elija
   * qué parte de la obra cae dentro del círculo (arrastre libre en el paso
   * Resumen del asistente). El círculo se queda fijo y centrado; la obra se
   * mueve detrás. Default [0,0] = centrado (comportamiento previo).
   */
  offset?: [number, number];
  /**
   * F2.5 (2026-10-11): render ESTÁTICO forzado — la obra entera a opacidad
   * plena, sin esperar al audio (reutiliza la rama reduced-motion 'static').
   * Se usa en la vista previa de encuadre del paso Resumen: ahí no hay
   * reproducción y el peak sería 0 (lienzo vacío), así que se muestra el
   * dibujo completo para poder arrastrarlo aunque no suene nada.
   */
  staticPreview?: boolean;
  /** Modo cuando el usuario tiene prefers-reduced-motion (§3, R5). */
  reducedMotionFallback?: ReducedMotionFallback;
  /**
   * Bloqueo de controles (UX 2026-09-21): mientras el asistente sube/procesa
   * un nuevo audio, el reproductor queda inerte — pausa la reproducción y
   * deshabilita play/pause, seek, volumen y mute (disabled real: también
   * inaccesible por teclado). El consumidor añade su propia capa visual.
   */
  locked?: boolean;
  /**
   * Chrome de la vista (P3 2026-09-24, círculo + título F1 2026-10-11):
   * - 'full' (default): controles completos (progreso, tiempo, volumen,
   *   mute) — el asistente (paso 2) y la demo.
   * - 'minimal': la pieza animada DENTRO DE UN CÍRCULO (clipPath SVG sobre
   *   disco blanco) + título y descripción debajo + un botón circular
   *   play/pausa sobre el SVG (vista publicada /p/:id). El lector no ve
   *   barra de progreso, tiempo ni volumen; el volumen queda al dispositivo
   *   del lector.
   * La animación (analyser) es idéntica en ambas.
   */
  variant?: "full" | "minimal";
  onReady?: () => void;
  onPeak?: (peak: number) => void;
  onError?: (e: Error) => void;
}

export type PaisajePlayerProps = PaisajePlayerBaseProps &
  ({ points: number[]; jsonUrl?: never } | { jsonUrl: string; points?: never });

/** Circle memoizado: solo re-renderiza si cambia alguna prop (mitiga R1). */
const Circle = memo(function Circle({
  cx,
  cy,
  r,
  fill,
  opacity,
}: {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  opacity: number;
}) {
  return <circle cx={cx} cy={cy} r={r} fill={fill} opacity={opacity} />;
});

interface LoadedDoc {
  /** Puntos planos v1. En v2 es [] (los puntos viven en las capas). */
  points: number[];
  /** Capas v2 (posterized) o null en v1. */
  layers: Layer[] | null;
  /** Opacidad por capa del posterizado (F2; orden de layers[0..3]; null si no aplica). */
  layerAlpha: number[] | null;
  /** Segmentos planos v3 lineart (LA-2) o null en los demás estilos. */
  segments: number[] | null;
  /** 14 estados precomputados v3 azimuthal (AZ-2) o null. */
  frames: number[][] | null;
  /** Fin de recorrido de la órbita (AZ-4): 'clamp' (def) o 'bounce'. */
  orbitMode: AzimuthalOrbitMode;
  /** Grosor de trazo lineart (params.strokeWidth; default 2). */
  strokeWidth: number;
  width: number;
  height: number;
  /** maxVisibleRatio guardado en el JSON (si existe). */
  storedRatio: number | null;
  /** seed del JSON para la permutación sembrada (null con points prop). */
  seed: number | null;
  /**
   * step del JSON: ancho de la zona de transición entre bandas del modo
   * espectral (TRANSITION_CELLS · step px). Con points prop no hay params:
   * se estima 12 (el default del conversor).
   */
  step: number;
}

/** Estimación de step cuando se usa la prop `points` (default del conversor). */
const FALLBACK_STEP = 12;

const FALLBACK_VIEWBOX: [number, number] = [1000, 1000];

/**
 * Escala del círculo de la vista publicada (ajuste del usuario, F1
 * 2026-10-11): el círculo (clip + disco) es un 25 % MÁS PEQUEÑO que el
 * máximo posible — r = min(w,h)/2 · 0.75. Deja aire alrededor y deja sitio
 * al título dentro del cuadro; se lee más limpio y editorial.
 */
export const MINIMAL_CIRCLE_SCALE = 0.75;

/** Array vacío estable para el memo de puntos efectivos (azimutal/v1 sin datos). */
const EMPTY_POINTS: number[] = [];

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Line Art (LA-2) — helpers puros, exportados para tests
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extremos de un segmento lineart desde (x, y, angle°, len): el ángulo se
 * mide desde el eje horizontal hacia abajo (convención SVG, y-down), el
 * centro del trazo está en (x, y) y media longitud a cada lado. Coordenadas
 * a 1 decimal (la precisión con la que el formato guarda angle/len).
 */
export function segmentEndpoints(
  x: number,
  y: number,
  angle: number,
  len: number
): { x1: number; y1: number; x2: number; y2: number } {
  const rad = (angle * Math.PI) / 180;
  const dx = (Math.cos(rad) * len) / 2;
  const dy = (Math.sin(rad) * len) / 2;
  return {
    x1: Math.round((x + dx) * 10) / 10,
    y1: Math.round((y + dy) * 10) / 10,
    x2: Math.round((x - dx) * 10) / 10,
    y2: Math.round((y - dy) * 10) / 10,
  };
}

/**
 * Efecto dibujo (LA-2, solo lineart): el trazo se dibuja con el audio —
 * stroke-dasharray = len y stroke-dashoffset = len·(1 − energía).
 * Energía 0 → trazo oculto; 1 → completo. Coste nulo: len es dato del
 * documento (PROHIBIDO getTotalLength). Devuelve el offset (1 decimal).
 */
export function lineDash(len: number, energy: number): number {
  const e = Math.min(1, Math.max(0, energy));
  return Math.round(len * (1 - e) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────
// Azimutal (AZ-4) — órbita de odómetro: velocidad híbrida (reloj + energía)
// y modo de fin de recorrido (clamp o rebote triangular, sin salto)
// ─────────────────────────────────────────────────────────────────────────

/** Último índice de estado (14 frames → 0..13). */
export const AZIMUTHAL_LAST = 13;
/** Modo de fin de recorrido: se detiene en C o rebota de C a A. */
export type AzimuthalOrbitMode = "clamp" | "bounce";
/** Cuánto acelera la órbita un pico a tope: velocidad ×(1 + gain·peak). */
export const AZIMUTHAL_ENERGY_GAIN = 1.5;
/**
 * Curva de reacción sobre el peak (AZ-4, ajuste del usuario): las piezas
 * casi nunca llegan a peak 1.0 (el rango útil es ~0.2–0.6), así que el
 * pico entra con gamma 0.7 — mismo idiom que el resto del reproductor.
 * Efecto: un pico 0.3 actúa como 0.43, uno 0.6 como 0.70, y el tope se
 * mantiene en ×(1 + gain) = 2.5 con peak 1.
 */
export const AZIMUTHAL_PEAK_GAMMA = 0.7;

/**
 * Avance del odómetro de la órbita (modo de juego AZ-4): la velocidad es
 * híbrida — (1 + gain·peak^gamma)·(13/duration) estados/segundo. En
 * silencio (peak 0) completa A→C exactamente una vez por tema; los picos
 * la aceleran (una carreta sonora la recorre brusco y rápido). Sin
 * duración válida no avanza.
 */
export function azimuthalAdvance(
  odometer: number,
  peak: number,
  duration: number,
  dt: number,
  gain: number = AZIMUTHAL_ENERGY_GAIN,
  gamma: number = AZIMUTHAL_PEAK_GAMMA
): number {
  if (!Number.isFinite(duration) || duration <= 0) return odometer;
  const baseRate = AZIMUTHAL_LAST / duration; // estados por segundo
  const p = Math.pow(Math.min(1, Math.max(0, peak)), gamma);
  const rate = (1 + p * gain) * baseRate;
  return odometer + rate * Math.max(0, dt);
}

/**
 * Pliegue del odómetro a [0, 13] según el modo de fin de recorrido:
 * - 'clamp': se detiene en C (el tema completa A→C una vez).
 * - 'bounce': rebote triangular — al llegar a C vuelve de C a A por el
 *   mismo camino (los extremos no saltan: 12→13→13→12, 1→0→0→1).
 */
export function azimuthalFold(odometer: number, mode: AzimuthalOrbitMode): number {
  if (mode === "clamp") return Math.min(AZIMUTHAL_LAST, Math.max(0, odometer));
  const span = AZIMUTHAL_LAST * 2; // 26
  let p = ((odometer % span) + span) % span;
  if (p > AZIMUTHAL_LAST) p = span - p;
  return p;
}

/** Frame activo = round(pos), clampado a [0, 13] (UN solo frame renderiza). */
export function azimuthalFrameIndex(pos: number): number {
  return Math.min(AZIMUTHAL_LAST, Math.max(0, Math.round(pos)));
}

// ─────────────────────────────────────────────────────────────────────────
// Segmentos (lineart / azimuthal) — construcción compartida del render
// ─────────────────────────────────────────────────────────────────────────

interface SegLine {
  key: number;
  cx: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  stroke: string;
}

/**
 * Techo de montaje (N·ratio primeros de la permutación) + extremos desde
 * (x, y, angle, len) para un array plano de segmentos. Compartido por el
 * Line Art (doc entero) y el Azimutal (frame activo de la órbita).
 */
function buildSegLines(
  segs: number[],
  nSegs: number,
  ratio: number,
  order: number[]
): SegLine[] {
  const maxCount = Math.floor(nSegs * ratio);
  const out: SegLine[] = [];
  for (let k = 0; k < maxCount; k++) {
    const i = order[k];
    const x = segs[i * 5];
    const y = segs[i * 5 + 1];
    const angle = segs[i * 5 + 2];
    const len = segs[i * 5 + 3];
    const packed = segs[i * 5 + 4];
    const [r, g, b] = unpackRGB(packed);
    out.push({
      key: i,
      cx: x,
      ...segmentEndpoints(x, y, angle, len),
      len,
      stroke: `rgb(${r},${g},${b})`,
    });
  }
  return out;
}

/** Partición de segmentos en franjas verticales por x (misma regla que
 * partitionPointsByBand, stride 5 en vez de 4). */
function partitionSegBandMap(
  segs: number[],
  nSegs: number,
  width: number,
  bands: number
): { map: Int16Array; counts: number[] } {
  const map = new Int16Array(nSegs);
  const counts = new Array<number>(bands).fill(0);
  for (let i = 0; i < nSegs; i++) {
    let b = Math.floor((segs[i * 5] / width) * bands);
    if (b >= bands) b = bands - 1;
    if (b < 0) b = 0;
    counts[b]++;
    map[i] = b;
  }
  return { map, counts };
}

export default function PaisajePlayer({
  audioUrl,
  points: pointsProp,
  jsonUrl,
  width, // si se omite: 900 px de alto CSS, max-height 90vh (corrección fase 5)
  viewBox,
  maxVisibleRatio: ratioProp,
  maxOpacity = 0.7,
  scaleAmount = 0.03,
  smoothing = 0.25,
  gamma = 0.7,
  seed: seedProp,
  drive = 1,
  peakMode = "amplitude",
  bands: bandsProp = 6,
  veil = 0.35,
  silenceThreshold = 0.02,
  title,
  description,
  offset,
  staticPreview = false,
  reducedMotionFallback = "fade",
  locked = false,
  variant = "full",
  onReady,
  onPeak,
  onError,
}: PaisajePlayerProps) {
  // ---------------------------------------------------------------
  // Carga del documento JSON (validado con el type-guard del conversor)
  // ---------------------------------------------------------------
  const [doc, setDoc] = useState<LoadedDoc | null>(
    pointsProp
      ? {
          points: pointsProp,
          layers: null,
          layerAlpha: null,
          segments: null,
          frames: null,
          orbitMode: "clamp",
          strokeWidth: 2,
          width: FALLBACK_VIEWBOX[0],
          height: FALLBACK_VIEWBOX[1],
          storedRatio: null,
          seed: seedProp ?? null,
          step: FALLBACK_STEP,
        }
      : null
  );
  const [loading, setLoading] = useState(!pointsProp && !!jsonUrl);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!jsonUrl) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(jsonUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`No se pudo cargar el JSON (HTTP ${r.status}).`);
        return r.json();
      })
      .then((raw: unknown) => {
        if (cancelled) return;
        const d = validateAndMigrate(raw); // type-guard + migración (§1.3)
        // Unión discriminada: v1 → points; v2/v3 posterized → layers;
        // v3 lineart → primitives.segments; v3 azimuthal →
        // primitives.frames (AZ-2: órbita por progreso + vaivén).
        // validateAndMigrate migra v2 → v3, pero aceptamos ambas por si el
        // documento ya venía en versión actual.
        const isLineArt = d.version === 3 && d.style === "lineart";
        const isAzimuthal = d.version === 3 && d.style === "azimuthal";
        setDoc({
          points: d.version === 1 ? d.points : [],
          layers:
            d.version === 2 || (d.version === 3 && d.style === "posterized")
              ? d.layers
              : null,
          // F2: transparencia por capa (params.layerAlpha; las v2 migradas y
          // las normalizadas ya lo traen; fallback pleno por si acaso).
          layerAlpha:
            d.version === 2 || (d.version === 3 && d.style === "posterized")
              ? ((d.params as { layerAlpha?: number[] }).layerAlpha ?? [1, 1, 1, 1])
              : null,
          segments: isLineArt ? d.primitives.segments : null,
          frames: isAzimuthal ? d.primitives.frames : null,
          orbitMode:
            isAzimuthal && d.params.orbitMode === "bounce" ? "bounce" : "clamp",
          strokeWidth:
            isLineArt || isAzimuthal ? d.params.strokeWidth : 2,
          width: d.image.width,
          height: d.image.height,
          // v1, lineart y azimuthal guardan maxVisibleRatio/step en params;
          // el seed de permutación solo existe en v1 y lineart (el azimutal
          // es determinista: permutación con seed 0 por frame).
          storedRatio:
            d.version === 1 || isLineArt || isAzimuthal
              ? d.params.maxVisibleRatio
              : null,
          seed: d.version === 1 || isLineArt ? d.params.seed : null,
          step:
            d.version === 1 || isLineArt || isAzimuthal
              ? d.params.step
              : FALLBACK_STEP,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        onError?.(err);
        setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jsonUrl, onError]);

  // viewBox efectivo: prop > JSON > fallback
  const [vbW, vbH] = viewBox ?? (doc ? [doc.width, doc.height] : FALLBACK_VIEWBOX);
  const ratio = ratioProp ?? doc?.storedRatio ?? 1; // default 1.0: peak máximo = imagen completa

  // ---------------------------------------------------------------
  // prefers-reduced-motion (R5)
  // ---------------------------------------------------------------
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const mode: "normal" | "static" | "fade" = staticPreview
    ? "static"
    : reduced
      ? reducedMotionFallback
      : "normal";

  // ---------------------------------------------------------------
  // Audio: elemento nativo + controles propios (§3.5, D1)
  // ---------------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMutedState] = useState(false);

  // Bandas del modo espectral: v2 → las 4 bandas del documento (bordes
  // explícitos); v1 → 6 logarítmicas por defecto (comportamiento actual).
  // Declaradas ANTES de useAudioPeak, que las consume.
  const layers = doc?.layers ?? null;
  const bands = layers ? layers.length : Math.min(12, Math.max(2, Math.round(bandsProp)));
  const bandEdges = useMemo(
    () => (layers ? [layers[0].band[0], ...layers.map((l) => l.band[1])] : undefined),
    [layers]
  );

  const { peak, bandPeaks, suspended, ensureGraph, setVolume, setMuted } = useAudioPeak(audioRef, {
    smoothing,
    useGraph: mode !== "static",
    drive,
    resetKey: audioUrl,
    peakMode,
    bands,
    bandEdges,
    onPeak,
  });

  // Bloqueo: al activarse, pausa la reproducción actual.
  useEffect(() => {
    if (locked) audioRef.current?.pause();
  }, [locked]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || locked) return;
    if (a.paused) {
      // El grafo se crea SOLO en este gesto del usuario (§3.3, R6)
      if (mode !== "static") ensureGraph();
      void a.play();
    } else {
      a.pause();
    }
  };

  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a || locked || !Number.isFinite(t)) return;
    a.currentTime = t;
    setCurrentTime(t);
  };

  const changeVolume = (v: number) => {
    setVolumeState(v);
    setVolume(v);
  };

  const toggleMute = () => {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
  };

  // ---------------------------------------------------------------
  // Puntos: orden de revelado = permutación sembrada (corrección fase 5).
  // Mismo seed → misma secuencia en cada carga; evita el encendido de
  // arriba a abajo del orden de barrido. Memoizada por seed.
  // ---------------------------------------------------------------
  // AZ-4 (azimutal): órbita de ODOMETRO — la velocidad es híbrida
  // ((1 + gain·peak)·13/duration estados/s: en silencio completa A→C una vez
  // por tema; los picos la aceleran) y el odómetro se pliega según el modo
  // de fin de recorrido del doc ('clamp' detiene en C; 'bounce' regresa de
  // C a A por el mismo camino). El seek resincroniza el odómetro con la
  // posición del tema. Reduced-motion: frame central fijo, sin odómetro.
  const azFrames = doc?.frames ?? null;
  const azMode: AzimuthalOrbitMode = doc?.orbitMode ?? "clamp";
  const azOdoRef = useRef(0);
  const azLastTsRef = useRef(0);
  const azLastCurrentTimeRef = useRef(0);
  useEffect(() => {
    // Cambio de audio: el odómetro vuelve a 0.
    azOdoRef.current = 0;
    azLastTsRef.current = 0;
    azLastCurrentTimeRef.current = 0;
  }, [audioUrl]);
  const azPos = (() => {
    if (mode !== "normal") return 6;
    if (!Number.isFinite(duration) || duration <= 0) {
      azOdoRef.current = 0;
      azLastTsRef.current = 0;
      return 0;
    }
    const now = performance.now();
    const prev = azLastTsRef.current || now;
    const dt = Math.min(0.1, Math.max(0, (now - prev) / 1000)); // tope anti-saltos
    azLastTsRef.current = now;
    // Seek/salto grande: resincroniza el odómetro con la posición del tema.
    if (Math.abs(currentTime - azLastCurrentTimeRef.current) > 1.5) {
      azOdoRef.current =
        (Math.min(Math.max(currentTime, 0), duration) / duration) * AZIMUTHAL_LAST;
    }
    azLastCurrentTimeRef.current = currentTime;
    azOdoRef.current = azimuthalAdvance(azOdoRef.current, peak, duration, dt);
    return azimuthalFold(azOdoRef.current, azMode);
  })();
  const azIndex = azFrames ? azimuthalFrameIndex(azPos) : 0;
  // Puntos efectivos: frame activo (azimutal) o points (v1). La maquinaria
  // de abajo (permutación, subset, bandas, velo) opera sobre este array.
  // El azimutal (AZ-3) renderiza LÍNEAS DE BORDE (rama de segmentos de
  // abajo), no círculos: los puntos efectivos quedan vacíos cuando hay órbita.
  const renderPoints: number[] = azFrames
    ? EMPTY_POINTS
    : (doc?.points ?? EMPTY_POINTS);

  const nTotal = renderPoints.length / 4;
  const seed = doc?.seed ?? 0;
  const order = useMemo(() => seededPermutation(nTotal, seed), [nTotal, seed]);

  const circles = useMemo(() => {
    if (nTotal === 0) return [];
    // Techo de montaje: solo los N·ratio primeros de la permutación
    const maxCount = Math.floor(nTotal * ratio);
    const out: { key: number; cx: number; cy: number; r: number; fill: string }[] = [];
    for (let k = 0; k < maxCount; k++) {
      const i = order[k];
      const r = renderPoints[i * 4 + 2];
      if (r <= 0) continue; // radio 0: punto invisible, no se dibuja
      const packed = renderPoints[i * 4 + 3];
      out.push({
        key: i,
        cx: renderPoints[i * 4],
        cy: renderPoints[i * 4 + 1],
        r,
        fill: `rgb(${(packed >> 16) & 0xff},${(packed >> 8) & 0xff},${packed & 0xff})`,
      });
    }
    return out;
  }, [renderPoints, nTotal, ratio, order]);

  // ---- v2 posterizado: un <path> por capa (fill plano, fill-rule evenodd
  // para que los agujeros de los contornos queden bien orientados o no).
  const layerPaths = doc?.layers ?? null;
  // F2: transparencia por capa — el player la aplica como fill-opacity
  // multiplicando la opacidad que ya calcule el modo/velo.
  const layerAlphaArr = doc?.layerAlpha ?? null;
  const alphaOf = (b: number) => layerAlphaArr?.[b] ?? 1;

  // -------------------------------------------------------------
  // Modo espectral: partición de puntos en franjas verticales
  // (banda = floor(x / width · bands), graves a la izquierda). Dentro de
  // cada banda, el orden de revelado sigue la permutación sembrada global
  // filtrada por banda. Memoizado por seed/seedProp.
  // -------------------------------------------------------------
  const bandMap = useMemo(() => {
    if (!doc || doc.layers || peakMode !== "spectrum") return null;
    const parts = partitionPointsByBand(renderPoints, doc.width, bands);
    const map = new Int16Array(nTotal);
    const counts = new Array<number>(bands).fill(0);
    parts.forEach((idxs, b) => {
      counts[b] = idxs.length;
      for (const i of idxs) map[i] = b;
    });
    return { map, counts };
  }, [doc, renderPoints, peakMode, bands, nTotal]);

  const bandCircles = useMemo(() => {
    if (!bandMap) return null;
    const out: { key: number; cx: number; cy: number; r: number; fill: string }[][] =
      Array.from({ length: bands }, () => []);
    for (const c of circles) out[bandMap.map[c.key]].push(c);
    return out;
  }, [circles, bandMap, bands]);

  // -------------------------------------------------------------
  // Segmentos (lineart LA-2 / azimuthal AZ-3): MISMA maquinaria de
  // revelado que los puntos (permutación, techo N·ratio, subset
  // peak^gamma·N·ratio, franjas espectrales por x), pero cada elemento es
  // un <line>. Efecto dibujo: dasharray = len y dashoffset = len·(1 −
  // energía). El azimutal añade la ÓRBITA (AZ-2): el frame activo cambia
  // con el tema (pos = progreso + vaivén) y su permutación es POR FRAME
  // (las longitudes son variables entre estados). Reduced-motion: sin dash.
  // -------------------------------------------------------------
  const nSegs = doc?.segments ? doc.segments.length / 5 : 0;
  const segSeed = doc?.seed ?? 0;
  const segOrder = useMemo(() => seededPermutation(nSegs, segSeed), [nSegs, segSeed]);
  const segLines = useMemo(
    () => (doc?.segments ? buildSegLines(doc.segments, nSegs, ratio, segOrder) : null),
    [doc, nSegs, ratio, segOrder]
  );
  const segBandMap = useMemo(() => {
    if (!doc?.segments || peakMode !== "spectrum") return null;
    return partitionSegBandMap(doc.segments, nSegs, doc.width, bands);
  }, [doc, peakMode, bands, nSegs]);
  const segBandLines = useMemo(() => {
    if (!segBandMap || !segLines) return null;
    const out: SegLine[][] = Array.from({ length: bands }, () => []);
    for (const s of segLines) out[segBandMap.map[s.key]].push(s);
    return out;
  }, [segLines, segBandMap, bands]);

  // Azimutal (AZ-3): segmentos del FRAME ACTIVO de la órbita.
  const azSegments = azFrames ? (azFrames[azIndex] ?? null) : null;
  const nAzSegs = azSegments ? azSegments.length / 5 : 0;
  const azOrder = useMemo(() => seededPermutation(nAzSegs, 0), [nAzSegs]);
  const azSegLines = useMemo(
    () => (azSegments ? buildSegLines(azSegments, nAzSegs, ratio, azOrder) : null),
    [azSegments, nAzSegs, ratio, azOrder]
  );
  const azSegBandMap = useMemo(() => {
    if (!azSegments || !doc || peakMode !== "spectrum") return null;
    return partitionSegBandMap(azSegments, nAzSegs, doc.width, bands);
  }, [azSegments, doc, peakMode, bands, nAzSegs]);
  const azSegBandLines = useMemo(() => {
    if (!azSegBandMap || !azSegLines) return null;
    const out: SegLine[][] = Array.from({ length: bands }, () => []);
    for (const s of azSegLines) out[azSegBandMap.map[s.key]].push(s);
    return out;
  }, [azSegLines, azSegBandMap, bands]);

  // Rama de <line> activa: lineart (doc entero) o azimuthal (frame activo).
  // Fondo transparente en ambas (ninguna rama pinta rect de fondo).
  const lines = segLines ?? azSegLines;
  const linesBandMap = segBandMap ?? azSegBandMap;
  const bandLines = segBandLines ?? azSegBandLines;
  const activeSegCount = segLines ? nSegs : nAzSegs;

  const strokeWidth = doc?.strokeWidth ?? 2;

  // Ancho de la zona de transición entre bandas vecinas (modo espectral):
  // ~1.5 celdas de step a cada lado del borde (corrección 2026-09-20).
  const transitionPx = TRANSITION_CELLS * (doc?.step ?? FALLBACK_STEP);

  // R1: aviso no bloqueante de rendimiento espectral con muchos puntos.
  useEffect(() => {
    if (peakMode === "spectrum" && nTotal > 15000) {
      console.warn(
        `[paisaje-sonoro] rendimiento espectral degradado con ${nTotal} puntos (>15000)`
      );
    }
  }, [peakMode, nTotal]);

  // Subset visible: primeros floor(peak^gamma · N · ratio) de la permutación
  const visibleCount =
    mode === "static"
      ? circles.length
      : Math.floor(Math.pow(peak, gamma) * nTotal * ratio);
  // Equivalente de segmentos (misma fórmula, N = segmentos de la rama activa).
  const segVisibleCount =
    mode === "static"
      ? (lines?.length ?? 0)
      : Math.floor(Math.pow(peak, gamma) * activeSegCount * ratio);
  // Opacidad con velo (ajuste fino 2026-09-20): coherente entre modos.
  // Antes: min(peak·0.8, maxOpacity). Ver veiledOpacity() en spectrum.ts.
  const circleOpacity =
    peak < silenceThreshold ? 0 : veiledOpacity(peak, veil, maxOpacity);

  // NOTA R1 (rendimiento): aquí hay UN re-render por frame (useState de peak)
  // y los <Circle> memoizados saltan si sus props no cambian (solo cambian
  // los del borde del subset y los visibles cuando varía la opacidad). Si el
  // perfilado con >15k puntos mostrara caídas de fps, la alternativa documentada
  // es: renderizar los círculos UNA vez (refs) y mutar en useEffect solo los
  // atributos opacity/transform del subset visible, sin pasar por React.

  // Escala centrada: translate(c) scale(s) translate(−c) para que el
  // zoom sea respecto al centro del viewBox, no al origen (0,0).
  const s = 1 + peak * scaleAmount;
  const groupTransform = `translate(${vbW / 2} ${vbH / 2}) scale(${s}) translate(${-vbW / 2} ${-vbH / 2})`;

  // ---------------------------------------------------------------
  // Presentación en círculo (F1 2026-10-11, SOLO variant='minimal'):
  // el contenido animado queda recortado por una clipPath circular
  // centrada (r = min(ancho, alto)/2 · MINIMAL_CIRCLE_SCALE, un 25 %
  // menor que el tope) sobre un disco de fondo blanco (--paisaje-disc,
  // transparente si se anula). El título va DENTRO DEL CUADRO, esquina
  // inferior derecha, justo encima del botón; la descripción (opcional)
  // se muestra bajo el cuadro en cuerpo menor. En 'full' el header de
  // siempre sigue encima del stage y no hay círculo.
  // ---------------------------------------------------------------
  const isMinimal = variant === "minimal";
  const discCx = vbW / 2;
  const discCy = vbH / 2;
  const discR = (Math.min(vbW, vbH) / 2) * MINIMAL_CIRCLE_SCALE;
  const discClipId = `paisaje-disc-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Ramas de contenido del SVG (compartidas entre variantes). El ternario
  // estrecha doc: las ramas usan doc.width y el SVG solo se monta con doc.
  const svgContent = doc ? (
    <>
      {mode === "normal" && peakMode === "spectrum" && layerPaths && (
              // Posterizado (v2): cada CAPA es un <path> cuya opacidad
              // responde a la energía de SU banda (velo, §ajuste 2026-09-21),
              // dentro del <g> raíz con el pulso de conjunto. F2: la
              // transparencia de la capa (params.layerAlpha) se multiplica
              // como fill-opacity.
              <g transform={groupTransform}>
                {layerPaths.map((layer, b) => {
                  const e = bandPeaks[b] ?? 0;
                  if (e < silenceThreshold) return null;
                  const op = veiledOpacity(e, veil, maxOpacity);
                  return (
                    <path
                      key={b}
                      d={layer.path}
                      fill={`rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`}
                      stroke="none"
                      fillRule="evenodd"
                      fillOpacity={op * alphaOf(b)}
                    />
                  );
                })}
              </g>
            )}
            {mode === "normal" && peakMode === "amplitude" && layerPaths && (
              // Posterizado (v2) en amplitud: los 4 paths responden TODOS
              // al peak global (misma opacidad de conjunto que v1). F2:
              // fill-opacity por capa multiplica a la del grupo.
              <g transform={groupTransform}>
                <g opacity={circleOpacity}>
                  {layerPaths.map((layer, b) => (
                    <path
                      key={b}
                      d={layer.path}
                      fill={`rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`}
                      stroke="none"
                      fillRule="evenodd"
                      fillOpacity={alphaOf(b)}
                    />
                  ))}
                </g>
              </g>
            )}
            {mode === "normal" && peakMode === "spectrum" && bandCircles && bandMap && !lines && (
              // Modo espectral v1 (corregido 2026-09-20, velo añadido): las bandas
              // modulan CUÁNTOS puntos se encienden (count por banda, con
              // normalización/gamma/ratio como antes), el RADIO de cada punto
              // (0.7 + 0.3 · energía efectiva interpolada en los bordes → sin
              // líneas divisorias) y la OPACIDAD del grupo con velo suave
              // (veiledOpacity: velo=0 → plena; velo=1 → velo total).
              <g transform={groupTransform}>
                {bandCircles.map((arr, b) => {
                  const e = bandPeaks[b] ?? 0;
                  if (e < silenceThreshold) return null;
                  const count = Math.floor(
                    Math.pow(e, gamma) * bandMap.counts[b] * ratio
                  );
                  const op = veiledOpacity(e, veil, maxOpacity);
                  return (
                    <g key={b} opacity={op}>
                      {arr.slice(0, count).map((c) => {
                        const ePoint = pointBandEnergy(
                          c.cx,
                          doc.width,
                          bands,
                          bandPeaks,
                          transitionPx
                        );
                        return (
                          <Circle
                            key={c.key}
                            cx={c.cx}
                            cy={c.cy}
                            r={c.r * (0.7 + 0.3 * ePoint)}
                            fill={c.fill}
                            opacity={1}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            )}
            {mode === "normal" && peakMode === "amplitude" && !layerPaths && !lines && (
              // v1: subset visible del flat con el peak global.
              <g transform={groupTransform}>
                {circles.slice(0, visibleCount).map((c) => (
                  <Circle key={c.key} cx={c.cx} cy={c.cy} r={c.r} fill={c.fill} opacity={circleOpacity} />
                ))}
              </g>
            )}
            {mode === "normal" && peakMode === "spectrum" && bandLines && linesBandMap && (
              // Line Art (LA-2) en espectro: MISMA regla que los puntos —
              // las bandas modulan CUÁNTOS trazos se encienden (count por
              // banda) y cuánto se DIBUJA de cada uno (energía efectiva
              // interpolada en los bordes de franja → sin líneas divisorias).
              <g transform={groupTransform}>
                {bandLines.map((arr, b) => {
                  const e = bandPeaks[b] ?? 0;
                  if (e < silenceThreshold) return null;
                  const count = Math.floor(
                    Math.pow(e, gamma) * linesBandMap.counts[b] * ratio
                  );
                  const op = veiledOpacity(e, veil, maxOpacity);
                  return (
                    <g key={b} opacity={op}>
                      {arr.slice(0, count).map((s) => {
                        const ePoint = pointBandEnergy(
                          s.cx,
                          doc.width,
                          bands,
                          bandPeaks,
                          transitionPx
                        );
                        return (
                          <line
                            key={s.key}
                            x1={s.x1}
                            y1={s.y1}
                            x2={s.x2}
                            y2={s.y2}
                            stroke={s.stroke}
                            strokeWidth={strokeWidth}
                            strokeLinecap="round"
                            fill="none"
                            strokeDasharray={s.len}
                            strokeDashoffset={lineDash(s.len, ePoint)}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            )}
            {mode === "normal" && peakMode === "amplitude" && lines && (
              // Line Art (LA-2) en amplitud: subset visible (misma regla que
              // v1) + EFECTO DIBUJO: dasharray = len y dashoffset = len·(1−peak)
              // → cada trazo se dibuja con el audio.
              <g transform={groupTransform}>
                <g opacity={circleOpacity}>
                  {lines.slice(0, segVisibleCount).map((s) => (
                    <line
                      key={s.key}
                      x1={s.x1}
                      y1={s.y1}
                      x2={s.x2}
                      y2={s.y2}
                      stroke={s.stroke}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      fill="none"
                      strokeDasharray={s.len}
                      strokeDashoffset={lineDash(s.len, peak)}
                    />
                  ))}
                </g>
              </g>
            )}
            {mode === "fade" && (
              // Solo opacidad lenta en el grupo, sin escala (R5). F2: la
              // transparencia de la capa se aplica como fill-opacity.
              <g style={{ opacity: circleOpacity, transition: "opacity 0.8s ease-out" }}>
                {layerPaths
                  ? layerPaths.map((layer, b) => (
                      <path
                        key={b}
                        d={layer.path}
                        fill={`rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`}
                        stroke="none"
                        fillRule="evenodd"
                        fillOpacity={alphaOf(b)}
                      />
                    ))
                  : lines
                    ? lines.map((s) => (
                        // Reduced-motion 'fade': trazos estáticos, SIN efecto dash.
                        <line
                          key={s.key}
                          x1={s.x1}
                          y1={s.y1}
                          x2={s.x2}
                          y2={s.y2}
                          stroke={s.stroke}
                          strokeWidth={strokeWidth}
                          strokeLinecap="round"
                          fill="none"
                          opacity={1}
                        />
                      ))
                    : circles.map((c) => (
                        <Circle key={c.key} cx={c.cx} cy={c.cy} r={c.r} fill={c.fill} opacity={1} />
                      ))}
              </g>
            )}
            {mode === "static" && (
              // Puntos (v1), paths (v2) o trazos (lineart) fijos, sin
              // animación ni efecto dibujo (R5). F2: fill-opacity por capa
              // en el posterizado.
              <g>
                {layerPaths
                  ? layerPaths.map((layer, b) => (
                      <path
                        key={b}
                        d={layer.path}
                        fill={`rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`}
                        stroke="none"
                        fillRule="evenodd"
                        fillOpacity={maxOpacity * alphaOf(b)}
                      />
                    ))
                  : lines
                    ? lines.map((s) => (
                        <line
                          key={s.key}
                          x1={s.x1}
                          y1={s.y1}
                          x2={s.x2}
                          y2={s.y2}
                          stroke={s.stroke}
                          strokeWidth={strokeWidth}
                          strokeLinecap="round"
                          fill="none"
                          opacity={maxOpacity}
                        />
                      ))
                    : circles.map((c) => (
                        <Circle key={c.key} cx={c.cx} cy={c.cy} r={c.r} fill={c.fill} opacity={maxOpacity} />
                      ))}
              </g>
            )}
    </>
  ) : null;

  // F2.5 · encuadre: el offset desplaza TODO el contenido (las ramas ya llevan
  // su propio pulso interno) dentro del clip del círculo. Con [0,0] o sin
  // prop no se añade grupo extra: el DOM queda idéntico a antes.
  const offsetTransform =
    offset && (offset[0] !== 0 || offset[1] !== 0)
      ? `translate(${offset[0]} ${offset[1]})`
      : undefined;
  const content = offsetTransform ? <g transform={offsetTransform}>{svgContent}</g> : svgContent;

  return (
    <div className="paisaje-player">
      {variant === "full" && (title || description) && (
        <header className="paisaje-player-header">
          {title && <h2 className="paisaje-player-title">{title}</h2>}
          {description && <p className="paisaje-player-desc">{description}</p>}
        </header>
      )}

      <div className="paisaje-player-stage">
        {loadError && (
          <div className="paisaje-banner paisaje-banner-error" role="alert">
            {loadError}
          </div>
        )}
        {loading && <p className="paisaje-player-hint">Cargando puntos…</p>}

        {doc && !loadError && (
          <svg
            className="paisaje-svg"
            viewBox={`0 0 ${vbW} ${vbH}`}
            {...(width !== undefined ? { width } : {})}
            role="img"
            aria-label={title ?? "Visualización puntillista del audio"}
          >
            {isMinimal && (
              // Disco de fondo + recorte circular (F1): el disco va DETRÁS
              // del contenido; la clipPath recorta las ramas animadas para
              // que la pieza respire DENTRO del círculo.
              <>
                <defs>
                  <clipPath id={discClipId}>
                    <circle cx={discCx} cy={discCy} r={discR} />
                  </clipPath>
                </defs>
                <circle className="paisaje-disc" cx={discCx} cy={discCy} r={discR} />
              </>
            )}
            {isMinimal ? (
              <g clipPath={`url(#${discClipId})`}>{content}</g>
            ) : (
              content
            )}
          </svg>
        )}

        {suspended && mode !== "static" && (
          <button type="button" className="paisaje-suspended" onClick={ensureGraph}>
            🔇 Pulsa play para habilitar el audio
          </button>
        )}

        {/* ---------- Título dentro del cuadro (F1, ajuste del usuario
        2026-10-11): esquina inferior DERECHA del stage, justo encima del
        botón de play (absolute, right 16 px). Va ANTES del chrome en el
        DOM: los lectores de pantalla leen título → botón → tiempo. ------ */}
        {variant === "minimal" && title && (
          <h2 className="paisaje-minimal-title">{title}</h2>
        )}

        {/* ---------- Variante 'minimal': chrome sobrio del lector (P3,
        esquina inferior DERECHA del stage): círculo play/pausa + contador
        m:ss debajo (duración en pausa, cuenta regresiva sonando). Accesible:
        <button> real, focable, estado anunciado; el tiempo es role="timer"
        con aria-live off (un anuncio por segundo sería ruido para SR). ------ */}
        {variant === "minimal" && (
          <div className="paisaje-minimal-chrome">
            <button
              type="button"
              className="paisaje-play-minimal"
              onClick={togglePlay}
              disabled={locked}
              aria-label={playing ? "Pausar" : "Reproducir paisaje sonoro"}
              aria-pressed={playing}
              aria-disabled={locked}
            >
              {playing ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="6" y="5" width="4" height="14" />
                  <rect x="14" y="5" width="4" height="14" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M8 5 L19 12 L8 19 Z" />
                </svg>
              )}
            </button>
            <span className="paisaje-minimal-time" role="timer" aria-live="off">
              {playing
                ? formatTime(Math.max(0, duration - currentTime))
                : formatTime(duration)}
            </span>
          </div>
        )}
      </div>

      {/* ---------- F1 (2026-10-11): en 'minimal' la descripción opcional
      (loudness) se muestra bajo el cuadro, centrada y en cuerpo menor;
      el título vive dentro del cuadro (arriba). En 'full' ambos siguen
      en el header de arriba. */}
      {variant === "minimal" && description && (
        <div className="paisaje-minimal-caption">
          <p className="paisaje-minimal-desc">{description}</p>
        </div>
      )}

      {/* ---------- Controles propios (§3.5): accesibles por teclado ---------- */}
      {variant === "full" && (
        <div className="paisaje-controls">
          <button
            type="button"
            className="paisaje-btn paisaje-play"
            onClick={togglePlay}
            disabled={locked}
            aria-label={playing ? "Pausar" : "Reproducir"}
            aria-disabled={locked}
          >
            {playing ? "⏸" : "▶"}
          </button>

          <span className="paisaje-time">{formatTime(currentTime)}</span>

          <input
            type="range"
            className="paisaje-progress"
            aria-label="Progreso"
            disabled={locked}
            aria-disabled={locked}
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
          />

          <span className="paisaje-time">{formatTime(duration)}</span>

          <button
            type="button"
            className="paisaje-btn"
            onClick={toggleMute}
            disabled={locked}
            aria-label={muted ? "Activar sonido" : "Silenciar"}
            aria-disabled={locked}
          >
            {muted || volume === 0 ? "🔇" : "🔊"}
          </button>

          <input
            type="range"
            className="paisaje-volume"
            aria-label="Volumen"
            disabled={locked}
            aria-disabled={locked}
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(parseFloat(e.target.value))}
          />
        </div>
      )}

      {/*
       * <audio> nativo (D1): el elemento sigue siendo reproducible aunque
       * falle la animación (progressive enhancement, R5).
       */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        className="paisaje-audio-element"
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          onReady?.();
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          const err = new Error("No se pudo cargar el audio.");
          onError?.(err);
          setLoadError(err.message);
        }}
      />
    </div>
  );
}
