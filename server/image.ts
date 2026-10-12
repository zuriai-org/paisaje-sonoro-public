/**
 * POST /api/image — subida de una pieza visual: points (.paisaje.json) + webp.
 * Campo OPCIONAL adicional: "posterized" (image/jpeg) — el JPEG posterizado
 * a 4 colores, artefacto de trabajo del estilo posterizado (se valida con
 * mime + firma de bytes). El JSON se valida con el MISMO type-guard del
 * frontend (src/converter/format.ts) — código compartido, no duplicado.
 */
import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { isPaisajeDocument } from "../src/converter/format";
import { hasJpegSignature } from "./jpeg";
import { SERVER_DIR } from "./store";

const upload = multer({
  dest: path.join(SERVER_DIR, "tmp"),
  limits: { fileSize: 50 * 1024 * 1024 },
});

export const imageRouter = Router();

imageRouter.post("/image", upload.fields([
  { name: "points", maxCount: 1 },
  { name: "webp", maxCount: 1 },
  { name: "posterized", maxCount: 1 },
]), (req, res) => {
  const cleanup: string[] = [];
  try {
    const fields = req.files as Record<string, Express.Multer.File[] | undefined>;
    const pointsFile = fields.points?.[0];
    const webpFile = fields.webp?.[0];
    const posterizedFile = fields.posterized?.[0];
    if (pointsFile) cleanup.push(pointsFile.path);
    if (webpFile) cleanup.push(webpFile.path);
    if (posterizedFile) cleanup.push(posterizedFile.path);

    if (!pointsFile || !webpFile) {
      return res.status(400).json({
        error: "Faltan archivos: se requieren 'points' (.paisaje.json) y 'webp' (.webp).",
      });
    }

    // --- Validar el JSON de puntos con el type-guard compartido ---
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(pointsFile.path, "utf8"));
    } catch {
      return res.status(400).json({ error: "El archivo 'points' no es JSON válido." });
    }
    if (!isPaisajeDocument(raw)) {
      return res.status(400).json({
        error: "El JSON no es un documento 'paisaje-sonoro' válido (format/version/points/params incorrectos).",
      });
    }

    const isWebp =
      webpFile.mimetype === "image/webp" ||
      webpFile.originalname.toLowerCase().endsWith(".webp");
    if (!isWebp) {
      return res.status(400).json({ error: "El archivo 'webp' debe ser una imagen .webp." });
    }

    // --- JPEG posterizado (opcional): mime + firma de bytes reales ---
    let posterizedJpegUrl: string | null = null;
    if (posterizedFile) {
      const isJpegMime =
        posterizedFile.mimetype === "image/jpeg" ||
        posterizedFile.mimetype === "image/jpg" ||
        /\.jpe?g$/i.test(posterizedFile.originalname);
      const bytes = fs.readFileSync(posterizedFile.path);
      if (!isJpegMime || !hasJpegSignature(bytes)) {
        return res.status(400).json({
          error: "El archivo 'posterized' debe ser un JPEG real (mime image/jpeg + firma de bytes).",
        });
      }
    }

    const id = nanoid(10);
    const dir = path.join(SERVER_DIR, "uploads", "image");
    fs.renameSync(pointsFile.path, path.join(dir, `${id}.json`));
    cleanup.pop(); // ya movido, no borrar en finally
    fs.renameSync(webpFile.path, path.join(dir, `${id}.webp`));
    cleanup.pop();
    if (posterizedFile) {
      fs.renameSync(posterizedFile.path, path.join(dir, `${id}.jpeg`));
      cleanup.pop();
      posterizedJpegUrl = `/uploads/image/${id}.jpeg`;
    }

    return res.status(200).json({
      id,
      jsonUrl: `/uploads/image/${id}.json`,
      webpUrl: `/uploads/image/${id}.webp`,
      posterizedJpegUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: `No se pudo guardar la imagen: ${msg}` });
  } finally {
    for (const f of cleanup) fs.unlink(f, () => undefined);
  }
});
