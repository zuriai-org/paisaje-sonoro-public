import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { POSTERIZED_BANDS, type Layer } from "./format";
import { luminance, posterizeImage, traceLayers, type TraceResult } from "./posterize";
import { finalLayerColors } from "./hsl";
import {
  encodeRasterJpeg,
  loadPosterizedImage,
  traceFromPosterizedJpeg,
  type PosterizeLoadResult,
} from "./posterizePipeline";
import type { StyleDocument } from "../styles/registry";
import { ParamSlider } from "./ParamSlider";

/**
 * Editor del estilo "Posterizado 4 capas" (v3 · PATHS + matiz global y
 * transparencia por capa, F2 2026-10-11) — corrección estructural 2026-09-22:
 * replica el flujo manual validado por el usuario (Krita posterizar →
 * exportar JPEG → Inkscape traza ese JPEG).
 *
 * Tres pantallas:
 * 1. SUBIR imagen → WebP de referencia + JPEG posterizado a 4 colores
 *    (pipeline: resize 900 → posterizar → JPEG q92; ver posterizePipeline.ts).
 * 2. REVISIÓN: se muestra el JPEG posterizado con las 4 muestras de paleta
 *    (+ los 2 candidatos fundidos en la selección 6→4, tachados).
 *    Nada que ajustar (es determinista); [Trazar y continuar].
 * 3. EDITOR: 4 capas-path. Toggle "Quitar fondo" (re-posteriza: el color del
 *    anillo del borde deja de ser candidato y sus píxeles quedan transparentes)
 *    + slider MATIZ GENERAL (rotación libre −180..+180 para las 4 capas,
 *    recolorea en vivo SIN re-trazar) + slider TRANSPARENCIA por capa (en
 *    vivo) + toggle global B&W (quedan los Tonos) + Limpieza (re-traza).
 *    La asignación capa→banda es por luminancia FINAL.
 *
 * El trazado opera SOBRE el JPEG re-decodificado (re-snap a paleta); el WebP
 * es solo referencia editorial y NUNCA se procesa.
 */

const TRACE_DEBOUNCE_MS = 250;

/** Etiquetas de banda según la posición tras ordenar por luminancia final. */
const BAND_LABELS = [
  "→ Graves 60–200 Hz",
  "→ Medios 200–1k",
  "→ Presencia 1–4k",
  "→ Agudos 4–10k",
];

interface PosterizedConverterProps {
  onDocument: (doc: StyleDocument) => void;
}

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Tono de gris que conserva la luminancia relativa de los colores elegidos. */
function grayTonesFromColors(
  colors: ReadonlyArray<readonly [number, number, number]>
): number[] {
  return colors.map((c) => Math.round(luminance(c[0], c[1], c[2])));
}

export default function PosterizedConverter({ onDocument }: PosterizedConverterProps) {
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;

  // Fase A (subida): resultado del pipeline resize→webp→posterizar→JPEG.
  const [load, setLoad] = useState<PosterizeLoadResult | null>(null);
  const [jpegUrl, setJpegUrl] = useState<string | null>(null);
  // Fase B (trazado): re-snap del JPEG → máscaras (única entrada del trazado).
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [traced, setTraced] = useState<Array<{ palette: [number, number, number]; path: string }> | null>(null);

  // Ajustes del editor (matiz global + transparencia por capa + B&W +
  // quitar fondo + limpieza). F2 2026-10-11.
  const [hueGlobal, setHueGlobal] = useState(0);
  const [layerAlpha, setLayerAlpha] = useState<number[]>([1, 1, 1, 1]);
  const [removeBg, setRemoveBg] = useState(false);
  const [bw, setBw] = useState(false);
  const [grayTone, setGrayTone] = useState<number[]>([0, 85, 170, 255]);
  const [minRegion, setMinRegion] = useState(12);

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragDepth = useRef(0);
  const jpegUrlRef = useRef<string | null>(null);
  const loadRef = useRef<PosterizeLoadResult | null>(null);
  loadRef.current = load;

  // ---------------------------------------------------------------
  // SUBIDA: pipeline completo → WebP ref + JPEG posterizado.
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setWarning(null);
    setInfo(null);
    setBusy(true);
    setLoad(null);
    setTrace(null);
    setTraced(null);
    setHueGlobal(0);
    setLayerAlpha([1, 1, 1, 1]);
    setRemoveBg(false);
    setBw(false);
    setMinRegion(12);
    if (jpegUrlRef.current) {
      URL.revokeObjectURL(jpegUrlRef.current);
      jpegUrlRef.current = null;
    }
    setJpegUrl(null);
    try {
      const result = await loadPosterizedImage(file);
      const url = URL.createObjectURL(result.posterizedJpeg);
      jpegUrlRef.current = url;
      setJpegUrl(url);
      setLoad(result);
      setGrayTone(grayTonesFromColors(result.trace.palette));

      const webp = result.webp;
      const saving = (1 - webp.size / file.size) * 100;
      setInfo(
        (saving >= 5
          ? `Referencia editorial: ${webp.suggestedName} (~${Math.round(webp.size / 1024)} KB, −${saving.toFixed(0)}% vs. original). `
          : `Referencia editorial: ${webp.suggestedName}. `) +
          `JPEG posterizado: ${Math.round(result.posterizedJpeg.size / 1024)} KB (4 colores planos).`
      );
      const warnings = [result.warning, webp.warning].filter((w): w is string => !!w);
      if (warnings.length > 0) setWarning(warnings.join("\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Revocar el object URL al desmontar.
  useEffect(
    () => () => {
      if (jpegUrlRef.current) URL.revokeObjectURL(jpegUrlRef.current);
    },
    []
  );

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
  // REVISIÓN → TRAZADO: decodifica el JPEG, re-snap a paleta, traza.
  // ---------------------------------------------------------------
  const handleTrace = useCallback(async () => {
    const l = loadRef.current;
    if (!l) return;
    setBusy(true);
    setError(null);
    try {
      const t = await traceFromPosterizedJpeg(l.posterizedJpeg, l.trace);
      setTrace(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // ---------------------------------------------------------------
  // QUITAR FONDO (F2): la PALETA cambia (el color del anillo del borde deja
  // de ser candidato y entra el siguiente), así que no basta un re-trazado:
  // hay que RE-POSTERIZAR desde la imagen (fase 1), re-emitir el JPEG de
  // trabajo y re-trazar desde él — el mismo camino de carga, con la opción.
  // El re-snap del JPEG recibe el color de fondo: sus píxeles vuelven a
  // quedar sin capa (transparencia) tras la pérdida de alfa del JPEG.
  // ---------------------------------------------------------------
  const handleToggleBackground = useCallback(async (on: boolean) => {
    const l = loadRef.current;
    if (!l) {
      setRemoveBg(on);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trace0 = posterizeImage(l.imageData, { removeBackground: on });
      const jpeg = await encodeRasterJpeg(trace0);
      if (jpegUrlRef.current) URL.revokeObjectURL(jpegUrlRef.current);
      const url = URL.createObjectURL(jpeg);
      jpegUrlRef.current = url;
      setJpegUrl(url);
      setLoad({ ...l, trace: trace0, posterizedJpeg: jpeg });
      const t = await traceFromPosterizedJpeg(jpeg, trace0);
      setTrace(t);
      setRemoveBg(on);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // ---------------------------------------------------------------
  // LIMPIEZA de regiones: re-traza desde el JPEG (último TraceResult).
  // Los ajustes de color NO pasan por aquí.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!trace) return;
    const t = window.setTimeout(() => {
      setTraced(traceLayers(trace, minRegion));
    }, TRACE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [trace, minRegion]);

  // ---------------------------------------------------------------
  // COLOR: matiz GLOBAL (misma rotación para las 4 capas, 0 = originales)
  // o grises B&W. La asignación capa→banda se reordena por luminancia del
  // color FINAL (incluido B&W). Los ajustes de color no re-trazan.
  // ---------------------------------------------------------------
  const colorState = useMemo(() => {
    if (!trace) return null;
    const palette = trace.palette;
    const finalColors = finalLayerColors(palette, hueGlobal, bw, grayTone);
    const order = palette
      .map((_, i) => i)
      .sort((a, b) => {
        const la = luminance(...finalColors[a]);
        const lb = luminance(...finalColors[b]);
        return la - lb || a - b;
      });
    return { palette, finalColors, order };
  }, [trace, hueGlobal, bw, grayTone]);

  const layers = useMemo<Layer[] | null>(() => {
    if (!colorState || !traced) return null;
    return colorState.order.map((p, layerIdx) => ({
      band: [POSTERIZED_BANDS[layerIdx][0], POSTERIZED_BANDS[layerIdx][1]] as [number, number],
      palette: [...colorState.palette[p]] as [number, number, number],
      color: colorState.finalColors[p],
      path: traced[p].path,
    }));
  }, [colorState, traced]);

  // Elevar el documento al asistente (cambia con color O limpieza). La
  // transparencia se guarda en el ORDEN DE LAS CAPAS (layers[0..3], el que
  // consume el player); en el editor los sliders están indexados por color
  // de paleta (p) y se reordenan aquí con `colorState.order`.
  useEffect(() => {
    const l = loadRef.current;
    if (!layers || !l) return;
    onDocumentRef.current?.({
      points: [],
      layers,
      params: {
        hueGlobal,
        layerAlpha: colorState!.order.map((p) => layerAlpha[p] ?? 1),
        bw,
        grayTone: [...grayTone],
        minRegion,
        removeBackground: removeBg,
      },
      width: l.imageData.width,
      height: l.imageData.height,
      name: l.fileName,
      seed: 0, // v3 determinista: sin seed
      maxVisibleRatio: 1,
      webp: l.webp.blob,
      webpName: l.webp.suggestedName,
      posterizedJpeg: l.posterizedJpeg,
      posterizedJpegName: `${baseName(l.fileName)}.posterizado.jpg`,
    });
  }, [layers, load, hueGlobal, layerAlpha, bw, grayTone, minRegion, removeBg, colorState]);

  // ---------------------------------------------------------------
  // Preview en vivo (canvas 2D, Path2D): colores finales con la
  // TRANSPARENCIA por capa aplicada (globalAlpha por capa, en vivo).
  // ---------------------------------------------------------------
  useEffect(() => {
    const l = loadRef.current;
    if (!layers || !l || !colorState || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const scale = Math.min(1, 720 / Math.max(l.imageData.width, l.imageData.height));
    canvas.width = Math.max(1, Math.round(l.imageData.width * scale));
    canvas.height = Math.max(1, Math.round(l.imageData.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    const alphas = colorState.order.map((p) => layerAlpha[p] ?? 1);
    layers.forEach((layer, layerIdx) => {
      ctx.globalAlpha = alphas[layerIdx];
      ctx.fillStyle = `rgb(${layer.color[0]},${layer.color[1]},${layer.color[2]})`;
      ctx.fill(new Path2D(layer.path), "evenodd");
    });
    ctx.globalAlpha = 1;
  }, [layers, colorState, layerAlpha]);

  const setLayerAlphaPct = (i: number) => (v: number) =>
    setLayerAlpha((s) =>
      s.map((x, j) => (j === i ? Math.min(1, Math.max(0, Math.round(v) / 100)) : x))
    );
  const setTone = (i: number) => (v: number) =>
    setGrayTone((s) => s.map((x, j) => (j === i ? Math.round(v) : x)));

  const toggleBw = () => {
    setBw((prev) => {
      if (!prev) {
        // ON: grises que conservan la luminancia relativa de los colores
        // finales elegidos en este momento (tras el matiz global).
        const l = loadRef.current;
        if (l) {
          setGrayTone(
            grayTonesFromColors(finalLayerColors(l.trace.palette, hueGlobal, false, grayTone))
          );
        }
      }
      return !prev;
    });
  };

  const palette = load?.trace.palette ?? null;

  return (
    <div className="paisaje-converter">
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

      {error && (
        <div className="paisaje-banner paisaje-banner-error" role="alert">{error}</div>
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

      {/* ---------- PANTALLA INTERMEDIA · JPEG posterizado + paleta ---------- */}
      {load && palette && !trace && (
        <div className="paisaje-grid">
          <section className="paisaje-panel" aria-label="Revisión del posterizado">
            <h2>Imagen posterizada (4 colores)</h2>
            {jpegUrl && (
              <img
                src={jpegUrl}
                alt="Raster posterizado a 4 colores: es la entrada del trazado"
                className="paisaje-canvas wz-raster-preview"
              />
            )}
            <div className="wz-palette-row" role="list" aria-label="Paleta de 4 colores">
              {palette.map((c, i) => (
                <span key={i} className="wz-swatch" data-testid={`palette-swatch-${i}`}
                  role="listitem"
                  style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }}
                  title={`rgb(${c[0]}, ${c[1]}, ${c[2]})`}
                />
              ))}
            </div>
            {load.trace.merged && load.trace.merged.length > 0 && (
              <div className="wz-palette-row wz-merged-row" role="list" aria-label="Colores fundidos">
                {load.trace.merged.map((c, i) => (
                  <span key={i} className="wz-swatch wz-swatch-merged"
                    data-testid={`palette-merged-${i}`}
                    role="listitem"
                    style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }}
                    title={`rgb(${c[0]}, ${c[1]}, ${c[2]}) — fundido: estaba demasiado cerca de otro color de la paleta`}
                  />
                ))}
                <span className="paisaje-help">fundidos (demasiado cercanos a otro color)</span>
              </div>
            )}
            <p className="paisaje-help">
              El trazado partirá de esta imagen (JPEG de 4 colores planos), igual que
              tu flujo Krita → Inkscape. El posterizado es determinista: no hay nada
              que ajustar aquí.
            </p>
            <button
              type="button"
              className="paisaje-btn paisaje-btn-primary"
              onClick={() => void handleTrace()}
              disabled={busy}
            >
              {busy ? "Trazando…" : "Trazar y continuar"}
            </button>
          </section>
        </div>
      )}

      {/* ---------- EDITOR · 4 capas-path ---------- */}
      {trace && layers && colorState && (
        <div className="paisaje-grid">
          <section className="paisaje-panel" aria-label="Capas">
            <h2>Capas de color</h2>
            <p className="paisaje-help">
              Cada color de la imagen es una capa que responde a su rango de
              frecuencia. Cambia el matiz de conjunto o la transparencia de cada
              capa en vivo; los ajustes de color no re-trazan.
            </p>

            <label className="paisaje-mode-selector wz-bw-toggle">
              <input
                type="checkbox"
                checked={removeBg}
                disabled={busy}
                onChange={(e) => void handleToggleBackground(e.target.checked)}
              />{" "}
              Quitar fondo
              <span className="paisaje-help" style={{ marginLeft: 8 }}>
                (El color que toca los bordes de la imagen se vuelve transparente.
                Útil para recortar el fondo de un retrato u objeto.)
              </span>
            </label>
            {busy && removeBg !== null && (
              <p className="paisaje-hint" data-testid="bg-busy">
                Re-posterizando con fondo transparente…
              </p>
            )}

            <label className="paisaje-mode-selector wz-bw-toggle">
              <input type="checkbox" checked={bw} onChange={toggleBw} /> Blanco y negro
              <span className="paisaje-help" style={{ marginLeft: 8 }}>
                (ON: cada capa se dibuja en gris conservando su luminosidad relativa;
                su slider pasa a ser el tono negro→blanco)
              </span>
            </label>

            {!bw && (
              <ParamSlider
                label="Matiz general"
                min={-180}
                max={180}
                step={1}
                value={hueGlobal}
                onChange={(v) => setHueGlobal(Math.round(Math.min(180, Math.max(-180, v))))}
                help="Cambia el color de toda la imagen de golpe. Las combinaciones siempre quedan equilibradas."
              />
            )}

            {colorState.palette.map((_, p) => {
              const layerIdx = colorState.order.indexOf(p);
              const shown = colorState.finalColors[p];
              return (
                <div className="wz-layer-card" key={p} data-layer-card={p}>
                  <div className="wz-layer-head">
                    <span
                      className="wz-swatch"
                      data-testid={`swatch-${p}`}
                      style={{ background: `rgb(${shown[0]},${shown[1]},${shown[2]})` }}
                    />
                    <strong>Capa {p + 1}</strong>
                    <span className="wz-band-label" data-testid={`band-label-${p}`}>
                      {BAND_LABELS[layerIdx] ?? ""}
                    </span>
                  </div>
                  <ParamSlider
                    label="Transparencia"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round((layerAlpha[p] ?? 1) * 100)}
                    onChange={setLayerAlphaPct(p)}
                    help="Opacidad de la capa: 100 % = plena; 0 % = invisible. Se aplica en vivo y en la pieza publicada."
                  />
                  {bw && (
                    <ParamSlider
                      label="Tono"
                      min={0}
                      max={255}
                      step={1}
                      value={grayTone[p] ?? 0}
                      onChange={setTone(p)}
                      help="Tono continuo de gris: negro (izquierda) → blanco (derecha)."
                    />
                  )}
                </div>
              );
            })}

            <div className="paisaje-param" style={{ marginTop: 14 }}>
              <span className="paisaje-param-label">Limpieza de regiones</span>
              <div className="paisaje-param-controls">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={minRegion}
                  aria-label="Limpieza de regiones"
                  onChange={(e) => setMinRegion(Number(e.target.value))}
                />
                <input
                  type="number"
                  className="paisaje-param-num"
                  min={0}
                  max={100}
                  value={minRegion}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0 && v <= 100) setMinRegion(v);
                  }}
                />
              </div>
              <p className="paisaje-help">
                Elimina manchas pequeñas y ruido. Re-traza desde el JPEG posterizado.
              </p>
            </div>

            <div className="paisaje-stats">
              <p>
                4 capas ·{" "}
                {layers.reduce((n, l) => n + (l.path.match(/M/g) ?? []).length, 0)} contornos
              </p>
              <p>
                lienzo {trace.width}×{trace.height} px · los ajustes de color no re-trazan
              </p>
            </div>
          </section>

          <section className="paisaje-panel paisaje-preview" aria-label="Vista previa">
            <h2>Vista previa</h2>
            <canvas ref={canvasRef} className="paisaje-canvas" />
          </section>
        </div>
      )}
    </div>
  );
}
