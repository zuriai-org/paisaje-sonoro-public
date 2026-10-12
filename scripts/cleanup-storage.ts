/**
 * Limpieza del storage local (F3 2026-10-11) — poda de eras muertas.
 *
 * - Poda PIEZAS: una pieza se elimina si su documento (`uploads/image/{id}.json`)
 *   no supera `validateAndMigrate` (type-guard + migraciones: el mismo camino
 *   que usa el player al cargar) o si su audio no existe en el registro.
 * - Borra los FICHEROS de upload huérfanos: los de imagen (json/webp/jpeg)
 *   no referenciados por ninguna pieza viva y los de audio (.m4a) igual.
 * - Alinea `server/data/audio.json`: solo registros referenciados por una
 *   pieza viva cuyo archivo existe.
 *
 * USO DESTRUCTIVO: hacer backup antes (tar czf de server/data + server/uploads).
 * Uso: npx tsx scripts/cleanup-storage.ts        ( backend parado o vivo: los
 * datos se leen/escriben por solicitud; mejor con el backend parado )
 */
import fs from "node:fs";
import path from "node:path";
import { validateAndMigrate } from "../src/converter/format";
import {
  loadAudioRecords,
  loadPieces,
  saveAudioRecords,
  savePieces,
  SERVER_DIR,
  type Piece,
} from "../server/store";

const imageDir = path.join(SERVER_DIR, "uploads", "image");
const audioDir = path.join(SERVER_DIR, "uploads", "audio");

function pieceDocIsValid(p: Piece): boolean {
  const docFile = path.join(imageDir, `${p.imageId}.json`);
  if (!fs.existsSync(docFile)) return false;
  try {
    validateAndMigrate(JSON.parse(fs.readFileSync(docFile, "utf8")));
    return true;
  } catch {
    return false; // era muerta: docs de puntos, params fotográficos, etc.
  }
}

const pieces = loadPieces();
const audioRecords = loadAudioRecords();
const audioIds = new Set(audioRecords.map((a) => a.id));

const kept: Piece[] = [];
const removed: Piece[] = [];
for (const p of pieces) {
  if (pieceDocIsValid(p) && audioIds.has(p.audioId)) kept.push(p);
  else removed.push(p);
}
savePieces(kept);

const usedImages = new Set(kept.map((p) => p.imageId));
const usedAudio = new Set(kept.map((p) => p.audioId));

const deletedFiles: string[] = [];
for (const f of fs.readdirSync(imageDir)) {
  const id = f.replace(/\.(json|webp|jpeg)$/, "");
  if (!usedImages.has(id)) {
    fs.unlinkSync(path.join(imageDir, f));
    deletedFiles.push(`image/${f}`);
  }
}
for (const f of fs.readdirSync(audioDir)) {
  const id = f.replace(/\.m4a$/, "");
  if (!usedAudio.has(id)) {
    fs.unlinkSync(path.join(audioDir, f));
    deletedFiles.push(`audio/${f}`);
  }
}

// Registro de audio: solo los referenciados por piezas vivas con archivo.
const aliveAudio = audioRecords.filter(
  (a) => usedAudio.has(a.id) && fs.existsSync(path.join(audioDir, `${a.id}.m4a`))
);
saveAudioRecords(aliveAudio);

console.log(`piezas: ${pieces.length} → ${kept.length} vivas, ${removed.length} podadas`);
for (const p of removed) console.log("  podada:", p.id, "·", p.title ?? "(sin título)", "·", p.createdAt.slice(0, 10));
console.log(`ficheros de upload borrados: ${deletedFiles.length}`);
console.log(`registros de audio: ${audioRecords.length} → ${aliveAudio.length}`);
