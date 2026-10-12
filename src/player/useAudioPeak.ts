import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  createNormalizerState,
  normalizeInstant,
  resetNormalizer,
} from "./normalize";
import {
  assignBinsToBands,
  bandEnergies,
  createBandNormalizers,
  normalizeBand,
  resetBandNormalizers,
  type BandNormalizers,
} from "./spectrum";

/**
 * Cadena de audio + peak suavizado (DISENO.md §3.2–3.3, riesgo R2).
 *
 * - UN SOLO AudioContext, creado en el PRIMER GESTO del usuario (click play),
 *   con ctx.resume() (política de autoplay, riesgo R6).
 * - source → GainNode → analyser → destination. El GainNode restaura el
 *   control de volumen que createMediaElementSource rompe (R2): la UI mueve
 *   el gain, no audio.volume (salvo que aún no exista grafo).
 * - Peak por frame (rAF): máximo de |v−128|/128 sobre getByteTimeDomainData,
 *   con **normalización adaptativa** (corrección fase 6): runningMax por
 *   reproducción con decaimiento 0.999, piso anti-ruido 0.08 y drive
 *   multiplicativo previo → el pico más intenso sonado = 1.0 = imagen
 *   completa visible. El suavizado exponencial se aplica DESPUÉS.
 * - Al pausar/terminar el target es 0 → decaimiento forzado (los puntos se
 *   apagan, no se congelan).
 * - runningMax se resetea al cambiar de audio (resetKey) o al reiniciar la
 *   reproducción desde cero (seek a ~0).
 * - Cleanup completo al desmontar: cancelAnimationFrame + ctx.close() +
 *   desconexión de nodos.
 */

interface AudioGraph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  /** Buffer para getByteFrequencyData (modo espectral). */
  freq: Uint8Array<ArrayBuffer>;
}

interface UseAudioPeakOptions {
  /** α del suavizado exponencial (DISENO.md §3.2), default 0.25. */
  smoothing: number;
  /** false en modo reduced-motion 'static': sin grafo Web Audio, sin loop. */
  useGraph: boolean;
  /**
   * Ganancia multiplicativa sobre el peak instantáneo ANTES de normalizar
   * (corrección fase 6). Default 1.0, rango razonable 0.5–3: sube la
   * propiedad `drive` si la pieza es muy plana y no llega a abrir la imagen.
   */
  drive?: number;
  /** Cambio de URL de audio → reset del runningMax (nueva reproducción). */
  resetKey?: string;
  /**
   * 'amplitude' (default): un solo peak global. 'spectrum': bandas de
   * frecuencia con normalización y suavizado propios por banda (§3).
   */
  peakMode?: "amplitude" | "spectrum";
  /** Nº de bandas en modo espectral (default 6, rango 2–12). */
  bands?: number;
  /**
   * Bordes de banda EXPLÍCITOS (v2 posterizado): bands+1 Hz. Si se omite,
   * se usan los bordes logarítmicos por defecto (v1).
   */
  bandEdges?: number[];
  onPeak?: (peak: number) => void;
}

interface UseAudioPeakResult {
  /** Peak suavizado 0..1 (un re-render por frame, ver R1). */
  peak: number;
  /**
   * Peaks suavizados por banda (modo espectral); array vacío en modo
   * amplitud. Longitud = bands.
   */
  bandPeaks: number[];
  /** true si el AudioContext está suspended (pulsar play lo reanuda). */
  suspended: boolean;
  /** Crear el grafo (llamar solo desde un gesto del usuario). */
  ensureGraph: () => void;
  setVolume: (v: number) => void;
  setMuted: (muted: boolean) => void;
}

function getAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext!;
}

const EMPTY_BANDS: number[] = [];

export function useAudioPeak(
  audioRef: RefObject<HTMLAudioElement | null>,
  {
    smoothing,
    useGraph,
    drive = 1,
    resetKey,
    peakMode = "amplitude",
    bands = 6,
    bandEdges,
    onPeak,
  }: UseAudioPeakOptions
): UseAudioPeakResult {
  const [peak, setPeak] = useState(0);
  const [bandPeaks, setBandPeaks] = useState<number[]>(EMPTY_BANDS);
  const [suspended, setSuspended] = useState(false);

  const graphRef = useRef<AudioGraph | null>(null);
  const rafRef = useRef(0);
  const peakRef = useRef(0);
  const normRef = useRef(createNormalizerState());
  const bandNormRef = useRef<BandNormalizers>(createBandNormalizers(bands));
  const binMapRef = useRef<{ bands: number; map: Uint8Array } | null>(null);
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const smoothingRef = useRef(smoothing);
  const driveRef = useRef(drive);
  const modeRef = useRef(peakMode);
  const bandsRef = useRef(bands);
  const edgesRef = useRef<number[] | undefined>(bandEdges);
  const onPeakRef = useRef(onPeak);

  smoothingRef.current = smoothing;
  driveRef.current = drive;
  modeRef.current = peakMode;
  bandsRef.current = bands;
  edgesRef.current = bandEdges;
  onPeakRef.current = onPeak;

  // Si cambia el nº de bandas, recrear sus normalizadores (y limpiar peaks).
  useEffect(() => {
    bandNormRef.current = createBandNormalizers(bands);
    binMapRef.current = null;
    setBandPeaks(EMPTY_BANDS);
  }, [bands]);

  const loop = useCallback(() => {
    const g = graphRef.current;
    const audio = audioRef.current;

    let target = 0;
    if (g && audio && !audio.paused && !audio.ended) {
      g.analyser.getByteTimeDomainData(g.data);
      let instant = 0;
      for (let i = 0; i < g.data.length; i++) {
        const v = Math.abs(g.data[i] - 128) / 128;
        if (v > instant) instant = v;
      }
      // Normalización adaptativa (drive → runningMax → piso 0.08) y DESPUÉS
      // el suavizado exponencial sobre el peak normalizado (corrección fase 6)
      target = normalizeInstant(instant, driveRef.current, normRef.current);
    }

    const a = smoothingRef.current;
    peakRef.current = a * target + (1 - a) * peakRef.current;
    if (target === 0 && peakRef.current < 0.001) peakRef.current = 0;

    setPeak(peakRef.current);

    // ---- Modo espectral: energía por banda, normalización y suavizado
    // propios por banda (§3.2). El pulso global de amplitud se sigue
    // calculando arriba para la escala del grupo raíz (§3.4).
    if (modeRef.current === "spectrum" && g) {
      const bn = bandNormRef.current;
      const nb = bandsRef.current;
      if (g && audio && !audio.paused && !audio.ended) {
        if (!binMapRef.current || binMapRef.current.bands !== nb) {
          binMapRef.current = {
            bands: nb,
            map: assignBinsToBands(
              nb,
              g.analyser.frequencyBinCount,
              g.ctx.sampleRate,
              edgesRef.current
            ),
          };
        }
        g.analyser.getByteFrequencyData(g.freq);
        const energies = bandEnergies(g.freq, binMapRef.current.map, nb);
        for (let b = 0; b < nb; b++) {
          const normB = normalizeBand(energies[b], bn.states[b]);
          bn.smooth[b] = a * normB + (1 - a) * bn.smooth[b];
        }
      } else {
        // Pausa/parada: decaimiento forzado por banda (los puntos se apagan)
        for (let b = 0; b < bn.smooth.length; b++) {
          bn.smooth[b] = (1 - a) * bn.smooth[b];
          if (bn.smooth[b] < 0.001) bn.smooth[b] = 0;
        }
      }
      setBandPeaks([...bn.smooth]);
    }

    onPeakRef.current?.(peakRef.current);
    setSuspended(g ? g.ctx.state === "suspended" : false);

    rafRef.current = requestAnimationFrame(loop);
  }, [audioRef]);

  const ensureGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || graphRef.current) return;
    const ctx = new (getAudioContextCtor())();
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    // source → gain (volumen) → analyser → destination (R2)
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);

    gain.gain.value = mutedRef.current ? 0 : volumeRef.current;
    graphRef.current = {
      ctx,
      source,
      gain,
      analyser,
      data: new Uint8Array(analyser.fftSize / 2),
      freq: new Uint8Array(analyser.frequencyBinCount),
    };

    void ctx.resume();
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop);
  }, [audioRef, loop]);

  const applyVolume = useCallback(() => {
    const g = graphRef.current;
    const audio = audioRef.current;
    const v = mutedRef.current ? 0 : volumeRef.current;
    if (g) {
      g.gain.gain.value = v; // MediaElementSource rompe audio.volume (R2)
    } else if (audio) {
      audio.volume = v;
    }
  }, [audioRef]);

  const setVolume = useCallback(
    (v: number) => {
      volumeRef.current = Math.min(1, Math.max(0, v));
      applyVolume();
    },
    [applyVolume]
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      mutedRef.current = muted;
      applyVolume();
    },
    [applyVolume]
  );

  // Reset del runningMax: cambio de audio (resetKey) o reproducción
  // reiniciada desde cero (seek a ~0, p. ej. replay tras 'ended').
  const resetPeaks = useCallback(() => {
    resetNormalizer(normRef.current);
    resetBandNormalizers(bandNormRef.current);
    peakRef.current = 0;
    setPeak(0);
    setBandPeaks(EMPTY_BANDS);
  }, []);

  useEffect(() => {
    resetPeaks();
  }, [resetKey, resetPeaks]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onSeeked = () => {
      if (audio.currentTime < 0.05) resetPeaks();
    };
    audio.addEventListener("seeked", onSeeked);
    return () => audio.removeEventListener("seeked", onSeeked);
  }, [audioRef, resetPeaks]);

  // Detener el loop si el modo lo desactiva (reduced-motion 'static').
  useEffect(() => {
    if (!useGraph) cancelAnimationFrame(rafRef.current);
  }, [useGraph]);

  // Cleanup completo al desmontar (DISENO.md §3.3).
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      const g = graphRef.current;
      if (g) {
        g.source.disconnect();
        g.gain.disconnect();
        g.analyser.disconnect();
        void g.ctx.close();
        graphRef.current = null;
      }
    },
    []
  );

  return { peak, bandPeaks, suspended, ensureGraph, setVolume, setMuted };
}
