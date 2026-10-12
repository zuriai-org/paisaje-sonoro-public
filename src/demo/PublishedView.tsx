import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PaisajePlayer from "../player/PaisajePlayer";
import type { PeakMode } from "../player/PaisajePlayer";

/**
 * Vista publicada /p/:id — lo que ve el lector de la revista.
 * Configuración FIJA (modo y velo de la pieza): sin selector ni slider;
 * variant='minimal': pieza dentro de un círculo + título debajo + botón
 * circular play/pausa (sin barra de progreso, tiempo ni volumen —
 * P3 2026-09-24; círculo y título F1 2026-10-11).
 */

interface PieceData {
  id: string;
  /** Título de la pieza (F1): null en piezas anteriores a F1. */
  title: string | null;
  mode: PeakMode;
  veil: number;
  /** F2.5: encuadre (desplazamiento del contenido dentro del círculo). */
  offsetX: number;
  offsetY: number;
  audio: {
    url: string;
    originalFormat: string;
    loudnessBefore: number | null;
    loudnessAfter: number | null;
  } | null;
  image: { jsonUrl: string; webpUrl: string };
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; piece: PieceData };

export default function PublishedView() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`/api/piece/${id}`)
      .then(async (res) => {
        const data: PieceData & { error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!cancelled) setState({ kind: "ok", piece: data });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") {
    return <p className="paisaje-player-hint wz-published">Cargando pieza…</p>;
  }

  if (state.kind === "error") {
    return (
      <div className="paisaje-converter wz-published">
        <div className="paisaje-banner paisaje-banner-error" role="alert">
          No se pudo cargar la pieza: {state.message}
        </div>
        <p>
          <Link to="/">← Crear otro paisaje sonoro</Link>
        </p>
      </div>
    );
  }

  const { piece } = state;

  return (
    <div className="paisaje-converter wz-published" data-testid="published">
      <PaisajePlayer
        jsonUrl={piece.image.jsonUrl}
        audioUrl={piece.audio?.url ?? ""}
        peakMode={piece.mode}
        veil={piece.veil}
        variant="minimal"
        offset={[piece.offsetX ?? 0, piece.offsetY ?? 0]}
        title={piece.title ?? undefined}
        description={
          piece.audio
            ? `audio ${piece.audio.originalFormat} · normalizado ${piece.audio.loudnessBefore} → ${piece.audio.loudnessAfter} LUFS`
            : undefined
        }
      />
      <p className="wz-create-another">
        <Link to="/">← Crear otro paisaje sonoro</Link>
      </p>
    </div>
  );
}
