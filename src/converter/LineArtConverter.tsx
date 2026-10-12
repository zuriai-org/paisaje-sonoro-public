import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { generateSegments } from "./lineart";
import { convertCanvas, type ConversionResult } from "./webp";
import {
  checkDimensions,
  decodeImageFile,
  drawSegmentsOnCanvas,
  normalizeHeight,
} from "./image";
import { ParamSlider } from "./ParamSlider";

const REGEN_DEBOUNCE_MS = 150;
/** Por encima de este tiempo de generación, tocaría moverlo a un Worker (§2.2). */
const WORKER_THRESHOLD_MS = 200;

interface Params {
  step: number;
  maxLength: number;
  strokeWidth: number;
  maxVisibleRatio: number;
  seed: number;
  /** LA-4: 'luz' (muestreo por sombra, color) | 'bordes' (grabado negro). */
  mode: "luz" | "bordes";
  /** Magnitud de borde mínima en modo 'bordes'. */
  umbral: number;
}

const DEFAULT_PARAMS: Params = {
  step: 14,
  maxLength: 16,
  strokeWidth: 2,
  maxVisibleRatio: 1, // peak máximo = imagen completa
  seed: 1,
  mode: "luz",
  umbral: 0.15,
};

/**
 * Documento Line Art, elevado al asistente (estado compartido de sesión).
 * `segments` es el array plano [x, y, angle, len, rgb] (formato v3 lineart);
 * `points` queda vacío (no hay puntos en este estilo).
 */
export interface LineArtSessionDocument {
  points: number[];
  layers: null;
  segments: number[];
  params: Record<string, number | string>; // mode ('luz'|'bordes') es string
  width: number;
  height: number;
  name: string;
  seed: number;
  maxVisibleRatio: number;
  /** WebP (o JPEG fallback) de referencia generado al cargar la imagen. */
  webp: Blob | null;
  webpName: string | null;
}

interface LineArtConverterProps {
  /** Se llama tras cada regeneración con los datos del documento. */
  onDocument?: (doc: LineArtSessionDocument) => void;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Editor del estilo "Line Art" (LA-2 2026-09-24) — hermano del puntillista:
 * misma rejilla y mismo muestreo estocástico por oscuridad con azar
 * sembrado, pero cada celda aceptada emite un SEGMENTO orientado a lo largo
 * del gradiente Sobel de la imagen (tangente al borde). Trabaja sobre el
 * ImageData ORIGINAL (sin JPEG intermedio); el WebP de referencia se genera
 * igual que en el puntillista.
 */
export default function LineArtConverter({ onDocument }: LineArtConverterProps) {
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;
  const [params, setParams] = useState<Params>({ ...DEFAULT_PARAMS, seed: randomSeed() });
  const [fileName, setFileName] = useState<string | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [webp, setWebp] = useState<ConversionResult | null>(null);
  const [segments, setSegments] = useState<number[] | null>(null);
  const [genMs, setGenMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragDepth = useRef(0);
  // El WebP se genera al cargar el archivo; se expone al padre vía ref para
  // que el debounce de regeneración siempre vea el blob actual.
  const webpRef = useRef<ConversionResult | null>(null);
  webpRef.current = webp;

  const setParam =
    (key: keyof Params) => (v: Params[keyof Params]) =>
      setParams((p) => ({ ...p, [key]: v }));

  // ---------------------------------------------------------------
  // Carga de imagen: validar → redimensionar → WebP → avisos
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setWarning(null);
    setInfo(null);
    setBusy(true);
    setSegments(null);
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
  // Regeneración con debounce (~150 ms) mientras se arrastra.
  // TODO(worker): si la generación supera ~200 ms con regularidad, mover
  // generateSegments a un Web Worker (DISENO.md §2.2).
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!imageData) return;
    const t = window.setTimeout(() => {
      const start = performance.now();
      const segs = generateSegments(
        imageData,
        {
          step: Math.round(params.step),
          maxLength: params.maxLength,
          strokeWidth: params.strokeWidth,
          seed: params.seed,
          maxVisibleRatio: params.maxVisibleRatio,
          mode: params.mode,
          umbral: params.umbral,
        },
        undefined // PRNG de producción: mulberry32(params.seed) (modo 'luz')
      );
      const ms = performance.now() - start;
      if (ms > WORKER_THRESHOLD_MS) {
        console.info(
          `[paisaje-sonoro] generación en ${ms.toFixed(0)} ms (> ${WORKER_THRESHOLD_MS} ms): ` +
            "conviene moverla a un Web Worker (DISENO.md §2.2)."
        );
      }
      setGenMs(ms);
      setSegments(segs);
      // Estado compartido de sesión: elevar el documento al asistente,
      // con el WebP de referencia para el POST /api/image.
      const conv = webpRef.current;
      onDocumentRef.current?.({
        points: [],
        layers: null,
        segments: segs,
        params: {
          step: Math.round(params.step),
          maxLength: params.maxLength,
          strokeWidth: params.strokeWidth,
          mode: params.mode,
          umbral: params.umbral,
        },
        width: imageData.width,
        height: imageData.height,
        name: fileName ?? "sin-nombre",
        seed: params.seed,
        maxVisibleRatio: params.maxVisibleRatio,
        webp: conv ? conv.blob : null,
        webpName: conv ? conv.suggestedName : null,
      });
    }, REGEN_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [imageData, params, fileName]);

  // ---------------------------------------------------------------
  // Preview en vivo (canvas 2D): segmentos con extremos desde angle/len
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!segments || !imageData || !canvasRef.current) return;
    drawSegmentsOnCanvas(
      canvasRef.current,
      imageData.width,
      imageData.height,
      segments,
      params.strokeWidth
    );
  }, [segments, imageData, params.strokeWidth]);

  const nSegments = segments ? segments.length / 5 : 0;

  return (
    <div className="paisaje-converter">
      <header className="paisaje-header">
        <h1>Conversor Line Art</h1>
        <p className="paisaje-subtitle">
          Imagen → trazos JSON + WebP · especificación DISENO.md §2
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
        <div className="paisaje-grid">
          {/* ---------- Parámetros ---------- */}
          <section className="paisaje-panel" aria-label="Parámetros">
            <h2>Parámetros</h2>
            <p className="paisaje-help">
              La imagen se convierte en trazos que siguen los contornos, como un
              grabado. El audio los dibuja y los hace vibrar.
            </p>
            <div className="paisaje-param">
              <span className="paisaje-param-label">modo de trazo</span>
              <div className="paisaje-param-controls la-mode">
                <label>
                  <input
                    type="radio"
                    name="la-mode"
                    checked={params.mode === "luz"}
                    onChange={() => setParam("mode")("luz")}
                  />{" "}
                  Sombras (color)
                </label>
                <label>
                  <input
                    type="radio"
                    name="la-mode"
                    checked={params.mode === "bordes"}
                    onChange={() => setParam("mode")("bordes")}
                  />{" "}
                  Bordes en negro (grabado)
                </label>
              </div>
              <p className="paisaje-help">
                Sombras: trazos donde la imagen es oscura, con su color. Bordes:
                solo los contornos, en líneas negras — el estilo grabado del Azimutal.
              </p>
            </div>
            {params.mode === "bordes" && (
              <ParamSlider
                label="umbral (borde mínimo)"
                min={0.05}
                max={0.6}
                step={0.01}
                value={params.umbral}
                onChange={setParam("umbral")}
                help="Qué tan marcado debe ser un borde para dibujarse. Más alto: solo los contornos principales; más bajo: entra textura."
              />
            )}
            <ParamSlider
              label="step (separación entre trazos)"
              min={4}
              max={40}
              step={1}
              value={params.step}
              onChange={setParam("step")}
              help="Separación entre trazos. Valores bajos: más detalle. Valores altos: estilo más sintético."
            />
            <ParamSlider
              label="maxLength (longitud máxima)"
              min={4}
              max={40}
              step={1}
              value={params.maxLength}
              onChange={setParam("maxLength")}
              help="Longitud máxima de los trazos en las zonas oscuras; en las claras se acortan hasta un 30%."
            />
            <ParamSlider
              label="strokeWidth (grosor del trazo)"
              min={1}
              max={5}
              step={0.5}
              value={params.strokeWidth}
              onChange={setParam("strokeWidth")}
              help="Grosor de los trazos."
            />
            <ParamSlider
              label="maxVisibleRatio (reproductor)"
              min={0.1}
              max={1}
              step={0.05}
              value={params.maxVisibleRatio}
              onChange={setParam("maxVisibleRatio")}
              help="Cuánta imagen puede mostrarse como máximo cuando el audio es más intenso. 1.0 = la imagen completa."
            />
            <div className="paisaje-param">
              <span className="paisaje-param-label">seed (reproducibilidad)</span>
              <div className="paisaje-param-controls">
                <input
                  type="number"
                  className="paisaje-param-num paisaje-seed"
                  aria-label="seed"
                  min={0}
                  step={1}
                  value={params.seed}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isNaN(v) && v >= 0) setParam("seed")(v);
                  }}
                />
                <button
                  type="button"
                  className="paisaje-btn"
                  title="Semilla aleatoria"
                  onClick={() => setParam("seed")(randomSeed())}
                >
                  🎲
                </button>
              </div>
              <p className="paisaje-help">
                Fija la distribución de los trazos. El mismo número siempre da la
                misma imagen; el dado genera una variación nueva.
              </p>
            </div>

            <div className="paisaje-stats">
              <p>
                {nSegments.toLocaleString()} trazos
                {genMs !== null && ` · generado en ${genMs.toFixed(0)} ms`}
              </p>
              <p>
                lienzo {imageData.width}×{imageData.height} px
              </p>
            </div>
            {/**
             * Sin botón de exportación: el documento se eleva al asistente
             * (onDocument) y este lo sube al backend. Todo vive en sesión.
             */}
          </section>

          {/* ---------- Preview ---------- */}
          <section className="paisaje-panel paisaje-preview" aria-label="Vista previa">
            <h2>Vista previa</h2>
            <canvas ref={canvasRef} className="paisaje-canvas" />
          </section>
        </div>
      )}
    </div>
  );
}
