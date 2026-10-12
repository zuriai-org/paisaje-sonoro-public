import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  activateKeyframeTab,
  generateFrames,
  generateStateSegments,
  vistaCasiVacia,
  DEFAULT_UMBRAL,
  ZERO_KEYFRAME,
  type AzimuthalKeyframe,
} from "./azimuthal";
import type { StyleDocument } from "../styles/registry";
import { convertCanvas, type ConversionResult } from "./webp";
import {
  checkDimensions,
  decodeImageFile,
  drawSegmentsOnCanvas,
  normalizeHeight,
} from "./image";
import { ParamSlider } from "./ParamSlider";

const REGEN_DEBOUNCE_MS = 200;
/** Por encima de este tiempo de generación, tocaría moverlo a un Worker (§2.2). */
const WORKER_THRESHOLD_MS = 400;

/** Parámetros del medio (tinta de bordes). Sin seed: determinista. */
interface SamplingParams {
  step: number;
  maxLength: number;
  strokeWidth: number;
  umbral: number;
  maxVisibleRatio: number;
}

const DEFAULT_SAMPLING: SamplingParams = {
  step: 12,
  maxLength: 16,
  strokeWidth: 2,
  umbral: DEFAULT_UMBRAL,
  maxVisibleRatio: 1, // peak máximo = imagen completa
};

const KF_LABELS = ["frame 1", "frame 2", "frame 3"] as const;
const SEQ_FPS = { lenta: 0.75, normal: 1.5, rapida: 3 } as const;
type SeqSpeed = keyof typeof SEQ_FPS;

/** Los 5 principales (grados de libertad de la esfera) con sus ayudas. */
const MAIN_PARAMS: Array<{
  key: keyof AzimuthalKeyframe;
  label: string;
  min: number;
  max: number;
  help: string;
}> = [
  { key: "longitudCentral", label: "longitudCentral", min: -180, max: 180,
    help: "Desplaza el punto de vista hacia el este u oeste." },
  { key: "paraleloEstandar", label: "paraleloEstandar", min: -90, max: 90,
    help: "Inclina el punto de vista hacia el norte o sur." },
  { key: "roll", label: "roll", min: -180, max: 180,
    help: "Gira la vista como un volante." },
  { key: "pitch", label: "pitch", min: -90, max: 90,
    help: "Baja o sube el mapa sobre la esfera." },
  { key: "yaw", label: "yaw", min: -180, max: 180,
    help: "Desplaza el mapa alrededor del eje vertical." },
];

/**
 * Editor del estilo "Azimutal" (AZ-3 reescritura 2026-09-26): la imagen es
 * un mapa equirectangular de la esfera completa y la vista es el DISCO del
 * hemisferio visible (d3.geoAzimuthalEquidistant). Tinta de bordes NEGRA
 * sobre transparente. Interfaz: UN preview grande (canvas blanco; exterior
 * del disco blanco SOLO en preview), parámetros a la IZQUIERDA y PESTAÑAS
 * bajo el preview: [frame 1] [frame 2] [frame 3] [Secuencia]. Los frames 2
 * y 3 HEREDAN los valores del anterior al abrirse (movimiento progresivo);
 * cada frame trae "Restablecer a 0"; [Secuencia] anima la interpolación en
 * bucle. Aviso discreto (no bloqueo) si una vista genera < 20 trazos.
 */
export default function AzimuthalConverter({
  onDocument,
}: {
  onDocument?: (doc: StyleDocument) => void;
}) {
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;

  const [sampling, setSampling] = useState<SamplingParams>({ ...DEFAULT_SAMPLING });
  const [orbitMode, setOrbitMode] = useState<"clamp" | "bounce">("clamp");
  const [keyframes, setKeyframes] = useState<
    [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe]
  >([{ ...ZERO_KEYFRAME }, { ...ZERO_KEYFRAME }, { ...ZERO_KEYFRAME }]);
  const [touched, setTouched] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const [tab, setTab] = useState<0 | 1 | 2 | 3>(0); // 3 = Secuencia
  const [seqSpeed, setSeqSpeed] = useState<SeqSpeed>("normal");

  const [fileName, setFileName] = useState<string | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [webp, setWebp] = useState<ConversionResult | null>(null);
  const [frames, setFrames] = useState<number[][] | null>(null);
  const [viewCounts, setViewCounts] = useState<[number, number, number] | null>(null);
  const [genMs, setGenMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const dragDepth = useRef(0);
  const webpRef = useRef<ConversionResult | null>(null);
  webpRef.current = webp;
  const heroRef = useRef<HTMLCanvasElement>(null);

  const setParam =
    (key: keyof SamplingParams) => (v: number) =>
      setSampling((p) => ({ ...p, [key]: v }));

  const setAxis =
    (key: keyof AzimuthalKeyframe) => (v: number) => {
      if (tab < 0 || tab > 2) return;
      const j = tab as 0 | 1 | 2;
      setKeyframes((prev): [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] => {
        const next: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] = [
          { ...prev[0] },
          { ...prev[1] },
          { ...prev[2] },
        ];
        next[j] = { ...next[j], [key]: v };
        return next;
      });
      setTouched((t) => {
        if (t[j]) return t;
        const n: [boolean, boolean, boolean] = [t[0], t[1], t[2]];
        n[j] = true;
        return n;
      });
    };

  const activateTab = (j: 0 | 1 | 2) => {
    const r = activateKeyframeTab(keyframes, touched, j);
    setKeyframes(r.keyframes);
    setTouched(r.touched);
    setTab(j);
  };

  const resetFrame = (j: 0 | 1 | 2) => {
    setKeyframes((prev): [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] => {
      const next: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] = [
        { ...prev[0] },
        { ...prev[1] },
        { ...prev[2] },
      ];
      next[j] = { ...ZERO_KEYFRAME };
      return next;
    });
    setTouched((t) => {
      const n: [boolean, boolean, boolean] = [t[0], t[1], t[2]];
      n[j] = true;
      return n;
    });
  };

  // ---------------------------------------------------------------
  // Carga de imagen: validar → redimensionar → WebP → avisos
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setWarning(null);
    setInfo(null);
    setBusy(true);
    setFrames(null);
    setViewCounts(null);
    try {
      const bitmap = await decodeImageFile(file);
      const check = checkDimensions(bitmap.width, bitmap.height);
      if (check.blocked) {
        bitmap.close();
        setError(check.blocked);
        return;
      }
      if (check.warning) setWarning(check.warning);

      const { canvas, imageData: data } = normalizeHeight(bitmap);
      bitmap.close();

      const conv = await convertCanvas(canvas, file.name);
      setWebp(conv);

      const saving = (1 - conv.size / file.size) * 100;
      setInfo(
        saving >= 5
          ? `Se generó ${conv.suggestedName} (~${Math.round(conv.size / 1024)} KB, ` +
            `−${saving.toFixed(0)}% vs. original). El JSON no lo necesita; ` +
            `conserva el ${conv.mime === "image/webp" ? "WebP" : "JPEG"} como referencia editorial.`
          : `Se generó ${conv.suggestedName} como referencia editorial ` +
            `(peso similar al original, ~${Math.round(conv.size / 1024)} KB).`
      );
      if (conv.warning) setWarning((w) => (w ? `${w}\n${conv.warning}` : conv.warning));

      setFileName(file.name);
      setImageData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  // ---------------------------------------------------------------
  // Regeneración con debounce (~200 ms): 14 estados + previews de las
  // 3 vistas (conteo para el aviso de "vista casi vacía"). El HÉROE se
  // dibuja aparte (pestaña activa o Secuencia).
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!imageData) return;
    const t = window.setTimeout(() => {
      const start = performance.now();
      const samplingCore = {
        step: Math.round(sampling.step),
        maxLength: sampling.maxLength,
        strokeWidth: sampling.strokeWidth,
        umbral: sampling.umbral,
      };
      const result = generateFrames(imageData, {
        ...samplingCore,
        maxVisibleRatio: sampling.maxVisibleRatio,
        keyframes,
      });
      const counts: [number, number, number] = [0, 0, 0];
      keyframes.forEach((kf, j) => {
        counts[j] = generateStateSegments(imageData, samplingCore, kf).length / 5;
      });
      const ms = performance.now() - start;
      if (ms > WORKER_THRESHOLD_MS) {
        console.info(
          `[paisaje-sonoro] generación en ${ms.toFixed(0)} ms (> ${WORKER_THRESHOLD_MS} ms): ` +
            "conviene moverla a un Web Worker (DISENO.md §2.2)."
        );
      }
      setGenMs(ms);
      setFrames(result.frames);
      setViewCounts(counts);
      const conv = webpRef.current;
      onDocumentRef.current?.({
        points: [],
        layers: null,
        segments: null,
        frames: result.frames,
        // Los 3 keyframes DEL USUARIO (los 14 interpolados ya viven en
        // primitives.frames).
        keyframes: [keyframes[0], keyframes[1], keyframes[2]],
        params: { ...samplingCore, orbitMode },
        width: imageData.width,
        height: imageData.height,
        name: fileName ?? "sin-nombre",
        seed: 0, // sin seed: el medio es determinista
        maxVisibleRatio: sampling.maxVisibleRatio,
        webp: conv ? conv.blob : null,
        webpName: conv ? conv.suggestedName : null,
      });
    }, REGEN_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [imageData, sampling, keyframes, fileName]);

  // ---------------------------------------------------------------
  // Preview grande: pestaña de frame → sus segmentos; [Secuencia] →
  // anima la interpolación en bucle (~1.5 fps, velocidad ajustable).
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!imageData) return;
    if (tab <= 2) {
      const j = tab as 0 | 1 | 2; // pestaña de frame activa
      const kf = keyframes[j];
      const samplingCore = {
        step: Math.round(sampling.step),
        maxLength: sampling.maxLength,
        strokeWidth: sampling.strokeWidth,
        umbral: sampling.umbral,
      };
      const t = window.setTimeout(() => {
        const segs = generateStateSegments(imageData, samplingCore, kf);
        if (heroRef.current) {
          drawSegmentsOnCanvas(
            heroRef.current,
            imageData.width,
            imageData.height,
            segs,
            sampling.strokeWidth,
            560,
            "#ffffff"
          );
        }
      }, 120);
      return () => window.clearTimeout(t);
    }
    // Secuencia: bucle sobre los 14 estados ya generados.
    if (!frames) return;
    let idx = 0;
    const draw = () => {
      const segs = frames[idx % frames.length];
      if (heroRef.current) {
        drawSegmentsOnCanvas(
          heroRef.current,
          imageData.width,
          imageData.height,
          segs,
          sampling.strokeWidth,
          560,
          "#ffffff"
        );
      }
      idx++;
    };
    draw();
    const interval = window.setInterval(draw, Math.round(1000 / SEQ_FPS[seqSpeed]));
    return () => window.clearInterval(interval);
  }, [tab, frames, seqSpeed, imageData, sampling, keyframes]);

  const activeKf: AzimuthalKeyframe | null = tab <= 2 ? keyframes[tab as 0 | 1 | 2] : null;

  return (
    <div className="paisaje-converter">
      <header className="paisaje-header">
        <h1>Conversor Azimutal</h1>
        <p className="paisaje-subtitle">
          Bordes → disco hemisférico → órbita de 14 estados JSON + WebP · DISENO.md §2
        </p>
      </header>

      {/* ---------- Zona de carga ---------- */}
      <div
        className={`paisaje-dropzone${dragging ? " is-dragging" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <p>
          Arrastra una imagen aquí, o{" "}
          <label className="paisaje-file-label">
            selecciónala
            <input
              type="file"
              accept="image/*"
              className="paisaje-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </p>
        <p className="paisaje-hint">
          Máximo 15 MB y 4096×4096 px · se normaliza a 900 px de alto · png, jpg, webp…
        </p>
        {busy && <p className="paisaje-hint">Procesando…</p>}
      </div>

      {/* ---------- Avisos ---------- */}
      {error && (
        <div className="paisaje-banner paisaje-banner-error" role="alert">
          {error}
        </div>
      )}
      {warning && (
        <div className="paisaje-banner paisaje-banner-warning">
          {warning.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {info && (
        <div className="paisaje-banner paisaje-banner-info">
          <p>{info}</p>
        </div>
      )}

      {imageData && (
        <div className="az-editor-layout">
          {/* ---------- Parámetros (izquierda) ---------- */}
          <aside className="paisaje-panel az-params" aria-label="Parámetros">
            <h2>Parámetros</h2>
            {activeKf ? (
              MAIN_PARAMS.map((p) => (
                <ParamSlider
                  key={p.key}
                  label={`${p.label} (${Math.round(activeKf[p.key])}°)`}
                  min={p.min}
                  max={p.max}
                  step={1}
                  value={activeKf[p.key]}
                  onChange={setAxis(p.key)}
                  help={p.help}
                />
              ))
            ) : (
              <p className="paisaje-help">
                La Secuencia reproduce la órbita entre los tres frames. Vuelve a un frame
                para editar sus ángulos.
              </p>
            )}

            <details className="az-advanced">
              <summary>Avanzado (muestreo)</summary>
              <ParamSlider
                label="umbral (borde mínimo)"
                min={0.05}
                max={0.6}
                step={0.01}
                value={sampling.umbral}
                onChange={setParam("umbral")}
                help="Qué tan marcado debe ser un borde para dibujarse. Más alto: solo los contornos principales; más bajo: entra textura."
              />
              <ParamSlider
                label="step (separación entre trazos)"
                min={4}
                max={40}
                step={1}
                value={sampling.step}
                onChange={setParam("step")}
                help="Separación entre trazos. Valores bajos: más detalle. Valores altos: estilo más sintético."
              />
              <ParamSlider
                label="maxLength (longitud máxima)"
                min={4}
                max={40}
                step={1}
                value={sampling.maxLength}
                onChange={setParam("maxLength")}
                help="Longitud máxima de los trazos en los bordes más fuertes; los más débiles se acortan hasta un 40%."
              />
              <ParamSlider
                label="strokeWidth (grosor del trazo)"
                min={1}
                max={5}
                step={0.5}
                value={sampling.strokeWidth}
                onChange={setParam("strokeWidth")}
                help="Grosor de los trazos."
              />
              <ParamSlider
                label="maxVisibleRatio (reproductor)"
                min={0.1}
                max={1}
                step={0.05}
                value={sampling.maxVisibleRatio}
                onChange={setParam("maxVisibleRatio")}
                help="Cuánta imagen puede mostrarse como máximo cuando el audio es más intenso. 1.0 = la imagen completa."
              />
              <div className="paisaje-param">
                <span className="paisaje-param-label">al terminar el recorrido</span>
                <div className="paisaje-param-controls az-orbit-mode">
                  <label>
                    <input
                      type="radio"
                      name="orbit-mode"
                      checked={orbitMode === "clamp"}
                      onChange={() => setOrbitMode("clamp")}
                    />{" "}
                    Se detiene en C
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="orbit-mode"
                      checked={orbitMode === "bounce"}
                      onChange={() => setOrbitMode("bounce")}
                    />{" "}
                    Rebote: vuelve de C a A
                  </label>
                </div>
                <p className="paisaje-help">
                  La órbita avanza con el tema y los picos la aceleran. Clamp:
                  completa A→C una vez y descansa en la última vista. Rebote: al
                  llegar a C regresa por el mismo camino (sin salto brusco).
                </p>
              </div>
            </details>
          </aside>

          {/* ---------- Vista previa grande + pestañas ---------- */}
          <section className="paisaje-panel az-main" aria-label="Vista previa del disco">
            <canvas
              ref={heroRef}
              className="paisaje-canvas az-hero-canvas"
              aria-label="Vista previa del disco hemisférico: líneas negras de borde"
            />
            <div className="az-tabs" role="tablist" aria-label="Frames y secuencia">
              {KF_LABELS.map((label, j) => (
                <button
                  key={j}
                  type="button"
                  role="tab"
                  aria-selected={tab === j}
                  className={`paisaje-btn az-tab${tab === j ? " is-active" : ""}`}
                  onClick={() => activateTab(j as 0 | 1 | 2)}
                >
                  {label}
                  {viewCounts && vistaCasiVacia(viewCounts[j as 0 | 1 | 2]) && (
                    <span className="az-tab-warning" title="Esta vista genera muy pocos trazos">
                      {" "}⚠ vista casi vacía
                    </span>
                  )}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={tab === 3}
                className={`paisaje-btn az-tab${tab === 3 ? " is-active" : ""}`}
                onClick={() => setTab(3)}
              >
                Secuencia
              </button>
              {tab <= 2 && (
                <button
                  type="button"
                  className="paisaje-btn az-tab-reset"
                  onClick={() => resetFrame(tab as 0 | 1 | 2)}
                >
                  Restablecer a 0
                </button>
              )}
              {tab === 3 && (
                <span className="az-seq-speed" role="group" aria-label="Velocidad de la secuencia">
                  {(["lenta", "normal", "rapida"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`paisaje-btn az-speed${seqSpeed === s ? " is-active" : ""}`}
                      onClick={() => setSeqSpeed(s)}
                    >
                      {s}
                    </button>
                  ))}
                </span>
              )}
            </div>
            <p className="paisaje-help">
              El Azimutal dibuja los bordes principales de tu imagen en líneas negras y
              los deforma como un mapa. Define tres vistas: el tema avanza la órbita y los
              picos la hacen respirar. La costura vertical del mapa (antimeridiano) es
              parte de la proyección, no un error.
            </p>
            <div className="paisaje-stats">
              <p>
                {frames
                  ? `${(frames[0].length / 5).toLocaleString()} trazos en el estado 0`
                  : "…"}
                {genMs !== null && ` · 14 estados en ${genMs.toFixed(0)} ms`}
              </p>
              <p>
                lienzo {imageData.width}×{imageData.height} px · disco de{" "}
                {Math.min(imageData.width, imageData.height)} px
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
