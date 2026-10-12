/**
 * Piezas publicadas (demo). "Base de datos" = server/data/pieces.json.
 * - POST /api/piece        → crea pieza { imageId, audioId, mode, veil, title }
 * - GET  /api/piece/:id    → pieza con URLs resueltas (404 si no existe)
 * - GET  /api/pieces       → listado completo con URLs resueltas
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  loadAudioRecords,
  loadPieces,
  savePieces,
  type Piece,
  SERVER_DIR,
} from "./store";

export const piecesRouter = Router();

/** Límite de caracteres del título de la pieza (F1 2026-10-11). */
export const PIECE_TITLE_MAX = 120;

/**
 * Valida el título de una pieza (F1): string con 1–120 caracteres tras
 * recortar. Devuelve el título limpio o null si no vale.
 */
export function validatePieceTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length >= 1 && t.length <= PIECE_TITLE_MAX ? t : null;
}

function imageFilesExist(imageId: string): boolean {
  const dir = path.join(SERVER_DIR, "uploads", "image");
  return (
    fs.existsSync(path.join(dir, `${imageId}.json`)) &&
    fs.existsSync(path.join(dir, `${imageId}.webp`))
  );
}

/** Pieza con las URLs (y loudness del audio) resueltas para el cliente. */
function resolvePiece(p: Piece) {
  const audio = loadAudioRecords().find((a) => a.id === p.audioId) ?? null;
  return {
    id: p.id,
    title: p.title ?? null,
    mode: p.mode,
    veil: p.veil,
    offsetX: p.offsetX ?? 0,
    offsetY: p.offsetY ?? 0,
    createdAt: p.createdAt,
    audio: audio && {
      url: audio.url,
      originalFormat: audio.originalFormat,
      loudnessBefore: audio.loudnessBefore,
      loudnessAfter: audio.loudnessAfter,
    },
    image: {
      jsonUrl: `/uploads/image/${p.imageId}.json`,
      webpUrl: `/uploads/image/${p.imageId}.webp`,
      // JPEG posterizado (estilo posterizado): solo si se subió (opcional).
      posterizedJpegUrl: fs.existsSync(path.join(SERVER_DIR, "uploads", "image", `${p.imageId}.jpeg`))
        ? `/uploads/image/${p.imageId}.jpeg`
        : null,
    },
  };
}

piecesRouter.post("/piece", (req, res) => {
  const { imageId, audioId, mode, veil, title, offsetX, offsetY } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof imageId !== "string" || typeof audioId !== "string") {
    return res.status(400).json({ error: "Se requieren 'imageId' y 'audioId' (string)." });
  }
  if (mode !== "amplitude" && mode !== "spectrum") {
    return res.status(400).json({ error: "'mode' debe ser 'amplitude' o 'spectrum'." });
  }
  const cleanTitle = validatePieceTitle(title);
  if (cleanTitle === null) {
    return res
      .status(400)
      .json({ error: "'title' es obligatorio (texto de 1 a 120 caracteres)." });
  }
  const veilNum = typeof veil === "number" && Number.isFinite(veil) ? veil : 0.35;
  const veilClamped = Math.min(1, Math.max(0, veilNum));
  // F2.5 · encuadre: desplazamiento del contenido dentro del círculo (unidades
  // del viewBox). Opcional; clamp generoso contra basura/extremos.
  const clampOff = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(20000, Math.max(-20000, v)) : 0;

  const audio = loadAudioRecords().find((a) => a.id === audioId);
  if (!audio) {
    return res.status(400).json({ error: `No existe ningún audio con id '${audioId}'.` });
  }
  if (!imageFilesExist(imageId)) {
    return res.status(400).json({ error: `No existe ninguna imagen con id '${imageId}'.` });
  }

  const piece: Piece = {
    id: nanoid(8),
    imageId,
    audioId,
    title: cleanTitle,
    mode,
    veil: veilClamped,
    offsetX: clampOff(offsetX),
    offsetY: clampOff(offsetY),
    createdAt: new Date().toISOString(),
  };
  const pieces = loadPieces();
  pieces.push(piece);
  savePieces(pieces);

  return res.status(200).json({ id: piece.id });
});

piecesRouter.get("/piece/:id", (req, res) => {
  const piece = loadPieces().find((p) => p.id === req.params.id);
  if (!piece) {
    return res.status(404).json({ error: `No existe ninguna pieza con id '${req.params.id}'.` });
  }
  return res.status(200).json(resolvePiece(piece));
});

piecesRouter.get("/pieces", (_req, res) => {
  return res.status(200).json(loadPieces().map(resolvePiece));
});
