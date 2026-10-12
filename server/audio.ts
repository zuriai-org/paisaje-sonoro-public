/**
 * POST /api/audio — subida de audio con normalización EBU R128 (loudnorm,
 * dos pasadas) a AAC 192k .m4a. Límite 300 MB. Acepta mp3/wav/ogg/m4a/flac/aac.
 */
import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { applyLoudness, measureLoudness } from "./ffmpeg";
import { loadAudioRecords, saveAudioRecords, SERVER_DIR, type AudioRecord } from "./store";

const ACCEPTED = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);

const upload = multer({
  dest: path.join(SERVER_DIR, "tmp"),
  limits: { fileSize: 300 * 1024 * 1024 },
});

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function asNumber(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

export const audioRouter = Router();

audioRouter.post("/audio", upload.single("file"), async (req, res) => {
  const cleanup: string[] = [];
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Falta el archivo (campo multipart 'file')." });
    }
    cleanup.push(req.file.path);

    const originalFormat = extOf(req.file.originalname);
    if (!ACCEPTED.has(originalFormat)) {
      return res.status(400).json({
        error: `Formato no soportado: .${originalFormat}. Aceptados: ${[...ACCEPTED].join(", ")}.`,
      });
    }

    const id = nanoid(10);
    const outPath = path.join(SERVER_DIR, "uploads", "audio", `${id}.m4a`);

    // Pasada 1: medición → pasada 2: aplicación lineal con los valores medidos.
    const measured = await measureLoudness(req.file.path);
    const { loudnessAfter } = await applyLoudness(req.file.path, outPath, measured);

    const record: AudioRecord = {
      id,
      url: `/uploads/audio/${id}.m4a`,
      originalFormat,
      loudnessBefore: asNumber(measured.measuredI),
      loudnessAfter: asNumber(loudnessAfter),
      createdAt: new Date().toISOString(),
    };
    const records = loadAudioRecords();
    records.push(record);
    saveAudioRecords(records);

    return res.status(200).json(record);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: `No se pudo procesar el audio: ${msg}` });
  } finally {
    for (const f of cleanup) fs.unlink(f, () => undefined);
  }
});
