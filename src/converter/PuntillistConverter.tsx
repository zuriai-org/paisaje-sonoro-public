import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { generatePoints } from "./core";
import { type Layer } from "./format";
import { convertCanvas, type ConversionResult } from "./webp";
import {
  checkDimensions,
  decodeImageFile,
  drawPointsOnCanvas,
  normalizeHeight,
} from "./image";
import { ParamSlider } from "./ParamSlider";

const REGEN_DEBOUNCE_MS = 150;
/** Por encima de este tiempo de generación, tocaría moverlo a un Worker (§2.2). */
const WORKER_THRESHOLD_MS = 200;

interface Params {
  step: number;
  maxRadius: number;
  multiplicador: number;
  maxVisibleRatio: number;
  seed: number;
}

const DEFAULT_PARAMS: Params = {
  step: 12,
  maxRadius: 4,
  multiplicador: 3,
  maxVisibleRatio: 1, // corrección fase 5: peak máximo = imagen completa
  seed: 1,
};

/**
 * Documento generado, elevado al asistente (estado compartido de sesión).
 * El asistente lo sube al backend (POST /api/image); ya no hay descargas.
 */
export interface SessionDocument {
  points: number[];
  layers: Layer[] | null;
  params: Record<string, number>;
  width: number;
  height: number;
  name: string;
  seed: number;
  maxVisibleRatio: number;
  /** WebP (o JPEG fallback) de referencia generado al cargar la imagen. */
  webp: Blob | null;
  webpName: string | null;
}

interface PuntillistConverterProps {
  /** Se llama tras cada regeneración con los datos del documento. */
  onDocument?: (doc: SessionDocument) => void;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export default function PuntillistConverter({ onDocument }: PuntillistConverterProps) {
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;
  const [params, setParams] = useState<Params>({ ...DEFAULT_PARAMS, seed: randomSeed() });
  const [fileName, setFileName] = useState<string | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [webp, setWebp] = useState<ConversionResult | null>(null);
  const [points, setPoints] = useState<number[] | null>(null);
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

  const setParam = (key: keyof Params) => (v: number) =>
    setParams((p) => ({ ...p, [key]: v }));

  // ---------------------------------------------------------------
  // Carga de imagen: validar → redimensionar → WebP → avisos
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setWarning(null);
    setInfo(null);
    setBusy(true);
    setPoints(null);
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
      // Corrección fase 5: ahorro < 5% → mensaje neutro, no celebrarlo
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
  // Regeneración con debounce (~150 ms) mientras se arrastra
  // TODO(worker): si la generación supera ~200 ms con regularidad,
  // mover generatePoints a un Web Worker con el buffer transferible,
  // tal como prevé DISENO.md §2.2. Se deja en el hilo principal en
  // esta fase para priorizar que funcione.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!imageData) return;
    const t = window.setTimeout(() => {
      const start = performance.now();
      const pts = generatePoints(imageData, {
        step: Math.round(params.step),
        maxRadius: params.maxRadius,
        multiplicador: params.multiplicador,
        seed: params.seed,
      });
      const ms = performance.now() - start;
      if (ms > WORKER_THRESHOLD_MS) {
        console.info(
          `[paisaje-sonoro] generación en ${ms.toFixed(0)} ms (> ${WORKER_THRESHOLD_MS} ms): ` +
            "conviene moverla a un Web Worker (DISENO.md §2.2)."
        );
      }
      setGenMs(ms);
      setPoints(pts);
      // Estado compartido de sesión: elevar el documento al asistente,
      // con el WebP de referencia para el POST /api/image.
      const conv = webpRef.current;
      onDocumentRef.current?.({
        points: pts,
        layers: null,
        params: {
          step: Math.round(params.step),
          maxRadius: params.maxRadius,
          multiplicador: params.multiplicador,
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
  // Preview en vivo (canvas 2D)
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!points || !imageData || !canvasRef.current) return;
    drawPointsOnCanvas(canvasRef.current, imageData.width, imageData.height, points);
  }, [points, imageData]);

  const pointCount = points ? points.length / 4 : 0;

  return (
    <div className="paisaje-converter">
      <header className="paisaje-header">
        <h1>Conversor puntillista</h1>
        <p className="paisaje-subtitle">
          Imagen → puntos JSON + WebP · especificación DISENO.md §2
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
          Máximo 15 MB y 4096×4096 px · se redimensiona a 2048 px · png, jpg, webp…
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
            <ParamSlider
              label="step (densidad de puntos)"
              min={4}
              max={40}
              step={1}
              value={params.step}
              onChange={setParam("step")}
              help="Separación entre puntos, en píxeles. Valores bajos: más puntos y más detalle. Valores altos: estilo más abstracto y ligero."
            />
            <ParamSlider
              label="maxRadius (radio máximo)"
              min={1}
              max={10}
              step={0.1}
              value={params.maxRadius}
              onChange={setParam("maxRadius")}
              help="Tamaño máximo que alcanzan los puntos en las zonas más oscuras de la imagen."
            />
            <ParamSlider
              label="multiplicador del radio"
              min={1}
              max={5}
              step={0.1}
              value={params.multiplicador}
              onChange={setParam("multiplicador")}
              help="Escala global del tamaño de todos los puntos. Afina el grosor general sin cambiar la densidad."
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
              <div className="paisaje-param-controls">                <input
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
                Fija la distribución de puntos. El mismo número siempre da la
                misma imagen; el dado genera una variación nueva.
              </p>
            </div>

            <div className="paisaje-stats">
              <p>
                {pointCount.toLocaleString()} puntos
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
