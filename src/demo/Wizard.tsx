import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import PaisajePlayer, { type PeakMode } from "../player/PaisajePlayer";
import {
  FORMAT_NAME,
  type PaisajeDocument,
} from "../converter/format";
import {
  DEFAULT_STYLE_ID,
  STYLES,
  getStyle,
  type StyleDocument,
} from "../styles/registry";
import * as W from "./wizardState";
import * as A from "./audioUploadState";
import { step2PreviewJsonUrl } from "./step2Preview";

/**
 * Asistente por pasos (sustituye a las antiguas pestañas Conversor/Reproductor).
 * 1 · Imagen y estilo → 2 · Audio y reproductor → 3 · Resumen → /p/:id
 * El modo espectral y el velo del reproductor NO se tocan aquí: solo se
 * fijan como configuración de la pieza.
 */

interface AudioInfo {
  id: string;
  url: string;
  originalFormat: string;
  loudnessBefore: number | null;
  loudnessAfter: number | null;
}

/**
 * Construye el .paisaje.json que validará el backend (esquema §1).
 * Unión discriminada: frames → v3 azimuthal; segments → v3 lineart;
 * capas → v3 posterized; points → v1 puntillista (las v1 siguen siendo
 * válidas tal cual: compatibilidad hacia atrás).
 */
export function buildPaisajeJson(doc: StyleDocument): Blob {
  const generator = { name: "paisaje-sonoro-converter", version: "0.1.0" };
  const image = {
    width: doc.width,
    height: doc.height,
    webp: doc.webpName,
    // JPEG posterizado (artefacto de trabajo del estilo posterizado).
    posterizedJpeg: doc.posterizedJpegName ?? null,
  };
  const params = {
    step: doc.params.step as number,
    maxRadius: doc.params.maxRadius as number,
    multiplicador: doc.params.multiplicador as number,
    seed: doc.seed,
    maxVisibleRatio: doc.maxVisibleRatio,
  };
  const json: PaisajeDocument = doc.frames
    ? {
        format: FORMAT_NAME,
        version: 3,
        style: "azimuthal",
        generator,
        image,
        // Medio de líneas de borde (AZ-3): sin seed ni radios.
        params: {
          step: doc.params.step as number,
          maxLength: doc.params.maxLength as number,
          strokeWidth: doc.params.strokeWidth as number,
          umbral: doc.params.umbral as number,
          maxVisibleRatio: doc.maxVisibleRatio,
          orbitMode: (doc.params.orbitMode as string) === "bounce" ? "bounce" : "clamp",
        },
        keyframes: doc.keyframes ?? [
          { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
          { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
          { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
        ],
        primitives: { frames: doc.frames },
      }
    : doc.segments
      ? {
          format: FORMAT_NAME,
          version: 3,
          style: "lineart",
          generator,
          image,
          params: {
            step: doc.params.step as number,
            maxLength: doc.params.maxLength as number,
            strokeWidth: doc.params.strokeWidth as number,
            seed: doc.seed,
            maxVisibleRatio: doc.maxVisibleRatio,
            mode: (doc.params.mode as string) === "bordes" ? "bordes" : "luz",
            umbral: (doc.params.umbral as number) ?? 0.15,
          },
          primitives: { segments: doc.segments },
        }
      : doc.layers
        ? {
            format: FORMAT_NAME,
            version: 3,
            style: "posterized",
            generator,
            image,
            // v3 (F2 2026-10-11): matiz GLOBAL + transparencia por capa +
            // quitar fondo; reemplaza al matiz individual (hueShift).
            params: {
              hueGlobal: (doc.params.hueGlobal as number | undefined) ?? 0,
              layerAlpha: (doc.params.layerAlpha as number[] | undefined) ?? [1, 1, 1, 1],
              bw: (doc.params.bw as boolean | undefined) ?? false,
              grayTone: (doc.params.grayTone as number[] | undefined) ?? [0, 85, 170, 255],
              minRegion: (doc.params.minRegion as number | undefined) ?? 12,
              removeBackground: (doc.params.removeBackground as boolean | undefined) ?? false,
            },
            layers: doc.layers,
          }
        : {
            format: FORMAT_NAME,
            version: 1,
            generator,
            image,
            params,
            points: doc.points,
          };
  return new Blob([JSON.stringify(json)], { type: "application/json" });
}

export default function Wizard() {
  const navigate = useNavigate();

  // --- Máquina de estados del flujo (lógica pura en wizardState.ts) -------
  const [wiz, setWiz] = useState<W.WizardState>(W.createInitialState);

  // --- Payload paso 1: estilo + documento + imageId en backend ------------
  const [styleId, setStyleId] = useState(DEFAULT_STYLE_ID);
  const [doc, setDoc] = useState<StyleDocument | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // --- Payload paso 2: audio + config del reproductor ---------------------
  const [audio, setAudio] = useState<AudioInfo | null>(null);
  const [audioObjUrl, setAudioObjUrl] = useState<string | null>(null);
  const audioObjUrlRef = useRef<string | null>(null);
  /** Fases de la subida (audioUploadState.ts): idle→uploading→processing→ready|error. */
  const [upload, setUpload] = useState<A.AudioUploadState>(A.initialAudioUploadState());
  /** Mensaje transitorio de éxito con los valores de loudness reales. */
  const [audioSuccess, setAudioSuccess] = useState<string | null>(null);
  /** “Listo” tras completar: visible ~2 s y desaparece con fundido. */
  const [readyVisible, setReadyVisible] = useState(false);
  const [mode, setMode] = useState<PeakMode>("amplitude");
  const [veilPct, setVeilPct] = useState(35);
  const audioLocked = A.isAudioUploadLocked(upload);

  // --- Paso 3 --------------------------------------------------------------
  const [pieceBusy, setPieceBusy] = useState(false);
  const [pieceError, setPieceError] = useState<string | null>(null);
  /** Título de la pieza (F1): obligatorio para [TERMINAR]. */
  const [pieceTitle, setPieceTitle] = useState("");
  /** F2.5 (2026-10-11): encuadre elegido en la vista previa del paso 3 —
   *  desplazamiento [x, y] del contenido dentro del círculo, en unidades
   *  del viewBox. Arrastre libre; [0,0] = centrado. */
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const style = getStyle(styleId);
  const StyleEditor = useMemo(
    () => (style?.disponible && style.componente ? lazy(style.componente) : null),
    [style]
  );

  // ------------------------------------------------------------- paso 1
  const handleDocument = useCallback((d: StyleDocument) => {
    setDoc(d);
    setImageId(null); // el subido (si lo había) queda obsoleto
    setImageError(null);
    setOffset([0, 0]); // F2.5: otra imagen → el encuadre elegido ya no aplica
    // Cualquier regeneración sobre un paso confirmado lo desconfirma;
    // los pasos posteriores se conservan (wizardState.editStep).
    setWiz((w) => W.editStep(w, 0));
  }, []);

  const handleStyleChange = (id: string) => {
    if (id === styleId) return;
    setStyleId(id);
    setImageId(null);
    setWiz((w) => W.editStep(w, 0));
  };

  const handleUseImage = useCallback(async () => {
    if (!doc) return;
    if (!doc.webp) {
      setImageError("No se generó el WebP de referencia; vuelve a cargar la imagen.");
      return;
    }
    setImageBusy(true);
    setImageError(null);
    try {
      const form = new FormData();
      form.append("points", buildPaisajeJson(doc), `${doc.name}.paisaje.json`);
      form.append("webp", doc.webp, doc.webpName ?? "referencia.webp");
      // JPEG posterizado (estilo posterizado): campo opcional del backend.
      if (doc.posterizedJpeg) {
        form.append("posterized", doc.posterizedJpeg, doc.posterizedJpegName ?? "posterizado.jpg");
      }
      const res = await fetch("/api/image", { method: "POST", body: form });
      const data: { id?: string; error?: string } = await res.json();
      if (!res.ok || !data.id) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setImageId(data.id);
      setWiz((w) => W.confirmStep(w, 0));
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  }, [doc]);

  // ------------------------------------------------------------- paso 2
  // Subida con XMLHttpRequest (fetch no da progreso de subida):
  // fase SUBIDA con % real (upload.onprogress) y fase PROCESADO indeterminada.
  // El audio anterior del wizard NO se toca hasta que el POST responde 200:
  // si falla, queda usable y se muestra el error.
  const handleAudioFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAudioSuccess(null);
    setReadyVisible(false);
    setUpload((s) => A.startAudioUpload(s));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/audio");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        setUpload((s) => A.setAudioUploadProgress(s, (ev.loaded / ev.total) * 100));
      }
    };
    // La subida terminó: ahora el servidor procesa (loudnorm + AAC).
    xhr.upload.onload = () => setUpload((s) => A.audioUploadComplete(s));
    xhr.onload = () => {
      let data: (Partial<AudioInfo> & { error?: string }) | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id && data.url) {
        if (audioObjUrlRef.current) URL.revokeObjectURL(audioObjUrlRef.current);
        const objUrl = URL.createObjectURL(file); // reproducción local en el wizard
        audioObjUrlRef.current = objUrl;
        const info: AudioInfo = {
          id: data.id,
          url: data.url,
          originalFormat: data.originalFormat ?? "",
          loudnessBefore: data.loudnessBefore ?? null,
          loudnessAfter: data.loudnessAfter ?? null,
        };
        setAudio(info);
        setAudioObjUrl(objUrl);
        setUpload((s) => A.audioUploadSucceed(s));
        setReadyVisible(true);
        window.setTimeout(() => setReadyVisible(false), 2000);
        setAudioSuccess(
          `✓ Nuevo audio procesado (${fmtDb(info.loudnessBefore)} → ${fmtDb(info.loudnessAfter)}). ` +
            "Ya puedes probar el reproductor."
        );
        // Solo en éxito: el paso 2 se desconfirma ("Usar reproductor"
        // vuelve a aparecer); el paso 1 y su imageId se conservan.
        setWiz((w) => W.editStep(w, 1));
      } else {
        setUpload((s) =>
          A.audioUploadFail(s, data?.error ?? `El servidor respondió HTTP ${xhr.status}.`)
        );
      }
    };
    xhr.onerror = () =>
      setUpload((s) => A.audioUploadFail(s, "Error de red al subir el audio."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  }, []);

  const handleUsePlayer = useCallback(() => {
    setWiz((w) => W.confirmStep(w, 1));
  }, []);

  // ---------------------------------------------------------------
  // F2.5 · ENCUADRE: arrastre libre de la imagen detrás del círculo en la
  // vista previa del paso 3. El gesto se convierte a unidades del viewBox
  // con la escala real del SVG en pantalla; el círculo se queda fijo y el
  // contenido se desplaza. Sin clamp (decisión del usuario: opción 1).
  // ---------------------------------------------------------------
  const handlePanStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const svg = el.querySelector("svg.paisaje-svg") as SVGSVGElement | null;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!rect.height || !vb.height) return;
    const scale = vb.height / rect.height; // unidades del viewBox por px CSS
    const startX = e.clientX;
    const startY = e.clientY;
    const base: [number, number] = [offsetRef.current[0], offsetRef.current[1]];
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setOffset([base[0] + (ev.clientX - startX) * scale, base[1] + (ev.clientY - startY) * scale]);
    };
    const up = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ya liberado */
      }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }, []);

  // ------------------------------------------------------------- paso 3
  const handleFinish = useCallback(async () => {
    if (!imageId || !audio || !W.isPieceTitleValid(pieceTitle)) return;
    setPieceBusy(true);
    setPieceError(null);
    try {
      const res = await fetch("/api/piece", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageId,
          audioId: audio.id,
          mode,
          veil: veilPct / 100,
          title: pieceTitle.trim(),
          offsetX: Math.round(offset[0] * 10) / 10,
          offsetY: Math.round(offset[1] * 10) / 10,
        }),
      });
      const data: { id?: string; error?: string } = await res.json();
      if (!res.ok || !data.id) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      navigate(`/p/${data.id}`);
    } catch (e) {
      setPieceError(e instanceof Error ? e.message : String(e));
    } finally {
      setPieceBusy(false);
    }
  }, [imageId, audio, mode, veilPct, pieceTitle, offset, navigate]);

  // ------------------------------------------------------------- footer
  const primary = useMemo(() => {
    if (wiz.current === 0) {
      return wiz.status[0] === "confirmed"
        ? { label: "SIGUIENTE", onClick: () => setWiz((w) => W.next(w)), disabled: false }
        : {
            label: imageBusy ? "Subiendo…" : "USAR",
            onClick: () => void handleUseImage(),
            disabled: !doc || imageBusy,
          };
    }
    if (wiz.current === 1) {
      return wiz.status[1] === "confirmed"
        ? {
            label: audioLocked ? "Procesando audio…" : "SIGUIENTE",
            onClick: () => setWiz((w) => W.next(w)),
            disabled: audioLocked, // no avanzar mientras se sube/procesa
          }
        : {
            label: audioLocked ? "Procesando audio…" : "Usar reproductor",
            onClick: handleUsePlayer,
            disabled: !audio || audioLocked,
          };
    }
    return {
      label: pieceBusy ? "Publicando…" : "TERMINAR",
      onClick: () => void handleFinish(),
      // F1: sin título válido no se publica (mismo contrato que el backend).
      disabled: pieceBusy || !imageId || !audio || !W.isPieceTitleValid(pieceTitle),
    };
  }, [wiz, imageBusy, doc, handleUseImage, audioLocked, audio, handleUsePlayer, pieceBusy, imageId, handleFinish, pieceTitle]);

  const fmtDb = (v: number | null) => (v === null ? "—" : `${v} LUFS`);

  return (
    <div className="paisaje-converter wz">
      <header className="paisaje-header">
        <h1>Paisaje sonoro</h1>
        <p className="paisaje-subtitle">Asistente: imagen y estilo → audio y reproductor → resumen</p>
      </header>

      {/* ---------- Indicador de progreso ---------- */}
      <ol className="wz-progress" aria-label="Progreso del asistente">
        {W.STEP_TITLES.map((t, i) => (
          <li
            key={t}
            className={
              i === wiz.current ? "is-active" : wiz.status[i] === "confirmed" ? "is-done" : ""
            }
            data-step-indicator={i + 1}
          >
            <span className="wz-step-num">{i + 1}</span> {t}
            {wiz.status[i] === "confirmed" && <span className="wz-check"> ✓</span>}
          </li>
        ))}
      </ol>

      {/* ---------- PASO 1 · Imagen y estilo ---------- */}
      <section data-step="1" hidden={wiz.current !== 0} aria-label="Paso 1: imagen y estilo">
        <div className="wz-styles" role="radiogroup" aria-label="Estilo">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              data-style={s.id}
              className={`wz-style${s.id === styleId ? " is-active" : ""}`}
              disabled={!s.disponible}
              title={s.descripcion}
              onClick={() => handleStyleChange(s.id)}
            >
              <strong>{s.nombre}</strong>
              {!s.disponible && <span className="wz-soon">Próximamente</span>}
            </button>
          ))}
        </div>

        {StyleEditor && (
          <Suspense fallback={<p className="paisaje-hint">Cargando editor…</p>}>
            <StyleEditor onDocument={handleDocument} />
          </Suspense>
        )}

        {imageError && (
          <div className="paisaje-banner paisaje-banner-error" role="alert">{imageError}</div>
        )}
        {wiz.status[0] === "confirmed" && imageId && (
          <p className="wz-ok" data-testid="image-ok">
            ✓ Imagen subida al servidor (id <code>{imageId}</code>)
          </p>
        )}
      </section>

      {/* ---------- PASO 2 · Audio y reproductor ---------- */}
      <section data-step="2" hidden={wiz.current !== 1} aria-label="Paso 2: audio y reproductor">
        <div className="paisaje-dropzone">
          <p>
            <label className="paisaje-file-label">
              1 · Sube el audio
              <input
                type="file"
                accept="audio/*"
                className="paisaje-file-input wz-audio-input"
                onChange={(e) => void handleAudioFile(e)}
              />
            </label>
          </p>
          <p className="paisaje-hint">
            mp3, wav, ogg, m4a, flac, aac · se normaliza a −16 LUFS (AAC 192k)
          </p>
        </div>

        {/* ---------- Estado de la subida: dos fases distinguibles ---------- */}
        {(upload.phase === "uploading" || upload.phase === "processing") && (
          <div
            className="wz-upload-status"
            data-testid="upload-status"
            data-phase={upload.phase}
          >
            <p>{upload.phase === "uploading" ? "Subiendo audio…" : "Procesando audio…"}</p>
            <div
              className="wz-indeterminate"
              role="progressbar"
              aria-label={upload.phase === "uploading" ? "Subiendo audio" : "Procesando audio"}
            >
              <span className="wz-indeterminate-bar" />
            </div>
          </div>
        )}
        {readyVisible && upload.phase === "ready" && (
          <p className="wz-upload-status wz-ready" data-testid="upload-ready">Listo</p>
        )}
        {upload.phase === "error" && (
          <div className="paisaje-banner paisaje-banner-error" role="alert">
            {upload.error} El audio anterior sigue disponible.
          </div>
        )}
        {audioSuccess && upload.phase === "ready" && (
          <p className="wz-audio-ok" data-testid="audio-ok">{audioSuccess}</p>
        )}

        {audio && (
          <>
            <p className="wz-loudness" data-testid="loudness">
              Audio <strong>{audio.id}</strong> ({audio.originalFormat}) · loudness antes{" "}
              <strong>{fmtDb(audio.loudnessBefore)}</strong> → después{" "}
              <strong>{fmtDb(audio.loudnessAfter)}</strong> (normalizado a −16 LUFS)
            </p>

            <div className="paisaje-mode-selector wz-player-config">
              <label>
                Modo:{" "}
                <select
                  className="wz-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PeakMode)}
                >
                  <option value="amplitude">Amplitud</option>
                  <option value="spectrum">Espectro</option>
                </select>
              </label>
              <label>
                Velo:{" "}
                <input
                  type="range"
                  className="wz-veil"
                  min={0}
                  max={100}
                  step={5}
                  value={veilPct}
                  aria-label="Velo de opacidad (porcentaje)"
                  onChange={(e) => setVeilPct(Number(e.target.value))}
                />
                {veilPct} %
              </label>
            </div>

            {imageId && audioObjUrl && (
              // Vista previa servida desde el BACKEND (jsonUrl del imageId
              // confirmado), no desde el documento local: el player refetchea
              // cuando cambia jsonUrl, así al cambiar la imagen en el paso 1
              // la vista previa refleja la nueva (regresión 2026-09-21).
              // seed/maxVisibleRatio/viewBox llegan dentro del propio JSON.
              <div className="wz-player-wrap">
                <PaisajePlayer
                  jsonUrl={step2PreviewJsonUrl(imageId)!}
                  audioUrl={audioObjUrl}
                  title="Vista previa del paisaje sonoro"
                  description={doc?.name}
                  peakMode={mode}
                  veil={veilPct / 100}
                  locked={audioLocked}
                />
                {audioLocked && (
                  // Capa semitransparente que refuerza el bloqueo del player
                  // (sus controles ya van disabled vía prop `locked`).
                  <div className="wz-player-lock" data-testid="player-lock" role="status">
                    {upload.phase === "uploading" ? "Subiendo audio…" : "Procesando audio…"}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------- PASO 3 · Resumen ---------- */}
      <section data-step="3" hidden={wiz.current !== 2} aria-label="Paso 3: resumen">
        <div className="wz-title-field">
          <label htmlFor="wz-piece-title">
            Título de la pieza{" "}
            <span className="wz-required" aria-hidden="true">(obligatorio)</span>
          </label>
          <input
            id="wz-piece-title"
            type="text"
            className="wz-title-input"
            value={pieceTitle}
            maxLength={W.PIECE_TITLE_MAX}
            required
            aria-required="true"
            aria-describedby="wz-title-hint"
            placeholder="Ponle un título reconocible"
            onChange={(e) => setPieceTitle(e.target.value)}
          />
          <p className="paisaje-hint" id="wz-title-hint" data-testid="title-hint">
            {W.isPieceTitleValid(pieceTitle)
              ? "Se mostrará dentro del cuadro, sobre el botón de play, en la vista publicada."
              : "El título es obligatorio para poder publicar (1–120 caracteres)."}
          </p>
        </div>

        {/* ---------- F2.5 · Vista previa del encuadre: tal cual se verá
        publicada (mismo círculo, play inerte), con ARRASTRE LIBRE de la
        imagen detrás del círculo para elegir qué parte cae dentro. */}
        {imageId && audio && (
          <div className="wz-pan-block">
            <p className="paisaje-hint">
              Vista previa de la pieza. <strong>Arrastra la imagen</strong> para
              elegir qué parte del dibujo cae dentro del círculo.
            </p>
            <div className="wz-pan-wrap" onPointerDown={handlePanStart}>
              <PaisajePlayer
                jsonUrl={step2PreviewJsonUrl(imageId)!}
                audioUrl={audioObjUrl ?? ""}
                peakMode={mode}
                veil={veilPct / 100}
                variant="minimal"
                locked
                staticPreview
                offset={offset}
                title={W.isPieceTitleValid(pieceTitle) ? pieceTitle.trim() : undefined}
                description={`audio ${audio.originalFormat} · normalizado ${audio.loudnessBefore} → ${audio.loudnessAfter} LUFS`}
              />
            </div>
            <p className="paisaje-hint">
              Encuadre: {Math.round(offset[0])}, {Math.round(offset[1])}
              <button
                type="button"
                className="paisaje-btn wz-pan-reset"
                onClick={() => setOffset([0, 0])}
              >
                Recentrar
              </button>
            </p>
          </div>
        )}
        <ul className="wz-summary" data-testid="summary">
          <li>
            Imagen: <strong>{style?.nombre}</strong>
            {doc && (
              <>
                {" "}
                · {doc.name} ·{" "}
                {doc.frames
                  ? `14 estados · ${doc.frames[0].length / 5} trazos`
                  : doc.segments
                    ? `${doc.segments.length / 5} trazos`
                    : `${doc.points.length / 4} puntos`}{" "}
                · seed {doc.seed}
              </>
            )}
            {imageId && <> · subida como <code>{imageId}</code></>}
          </li>
          <li>
            Audio: {audio ? (
              <>
                <strong>{audio.originalFormat}</strong> → AAC 192k · loudness{" "}
                {fmtDb(audio.loudnessBefore)} → {fmtDb(audio.loudnessAfter)} ·{" "}
                <code>{audio.id}</code>
              </>
            ) : "—"}
          </li>
          <li>
            Configuración del reproductor: modo{" "}
            <strong>{mode === "spectrum" ? "Espectro" : "Amplitud"}</strong> · velo{" "}
            <strong>{veilPct} %</strong>
          </li>
        </ul>
        {pieceError && (
          <div className="paisaje-banner paisaje-banner-error" role="alert">{pieceError}</div>
        )}
      </section>

      {/* ---------- Navegación ---------- */}
      <footer className="wz-footer">
        <button
          type="button"
          className="paisaje-btn wz-back"
          disabled={!W.canGoBack(wiz)}
          onClick={() => setWiz((w) => W.back(w))}
        >
          ← ATRÁS
        </button>
        <button
          type="button"
          className="paisaje-btn paisaje-btn-primary wz-primary"
          disabled={primary.disabled}
          onClick={primary.onClick}
        >
          {primary.label}
        </button>
      </footer>
    </div>
  );
}
