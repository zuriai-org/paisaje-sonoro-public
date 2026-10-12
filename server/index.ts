/**
 * Backend de demo — paisaje-sonoro.
 * Node 18 + Express 4. Requiere ffmpeg/ffprobe DEL SISTEMA (sin binarios
 * embebidos): se usan vía child_process para la normalización de audio.
 *
 * Arranque:  npm run server   (tsx watch, recarga al editar)
 * Puerto:    8787 por defecto (env PORT para cambiarlo).
 */
import "./crypto-polyfill"; // ANTES que nanoid (Node 18 no tiene crypto global)
import express from "express";
import path from "node:path";
import { requireFfmpeg } from "./ffmpeg";
import { ensureDirs, SERVER_DIR } from "./store";
import { audioRouter } from "./audio";
import { imageRouter } from "./image";
import { piecesRouter } from "./pieces";

// --- Precondiciones de arranque -------------------------------------------
requireFfmpeg(); // aborta con mensaje claro si falta ffmpeg/ffprobe
ensureDirs();

const app = express();
app.use(express.json());

// --- CORS restrictivo: solo mismo origen ----------------------------------
// Con el proxy de Vite el frontend habla en mismo origen, así que no hace
// falta CORS abierto. Peticiones cross-origin de navegador (Origin distinto
// del Host) se rechazan; clientes sin Origin (curl, proxy) pasan.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return res.status(403).json({ error: "Origen no permitido (mismo origen requerido)." });
    }
  }
  next();
});

// --- Rutas API -------------------------------------------------------------
app.get("/api/health", (_req, res) => res.status(200).json({ ok: true }));
app.use("/api", audioRouter);
app.use("/api", imageRouter);
app.use("/api", piecesRouter);

// --- Estáticos: /uploads → server/uploads ----------------------------------
app.use("/uploads", express.static(path.join(SERVER_DIR, "uploads"), { fallthrough: false }));

// --- 404 para rutas API desconocidas + manejador de errores ----------------
app.use("/api", (_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Errores típicos de multer (límite de tamaño, etc.)
  const status = /LIMIT_FILE_SIZE/.test(msg) ? 413 : 500;
  res.status(status).json({ error: msg });
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`[paisaje-sonoro] backend en http://localhost:${port}`);
  console.log(`[paisaje-sonoro] /api/audio · /api/image · /api/piece(s) · /uploads`);
});
