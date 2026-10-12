/**
 * Persistencia mínima en JSON para la demo (base de datos de juguete).
 * Dos "tablas": pieces (piezas publicadas) y audio (registro de uploads de
 * audio con su loudness). Lectura tolerante: si el archivo no existe o está
 * corrupto, se devuelve el valor vacío y se reescribe en el próximo guardado.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directorio de este módulo (ESM no tiene __dirname). */
export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AudioRecord {
  id: string;
  url: string;
  originalFormat: string;
  loudnessBefore: number | null;
  loudnessAfter: number | null;
  createdAt: string;
}

export interface Piece {
  id: string;
  imageId: string;
  audioId: string;
  /** Título de la pieza (F1 2026-10-11): obligatorio al crear; las piezas
   *  anteriores a F1 no lo tienen (el GET lo devuelve como null). */
  title?: string;
  mode: "amplitude" | "spectrum";
  veil: number;
  /** F2.5 (2026-10-11): encuadre — desplazamiento [x, y] del contenido dentro
   *  del círculo (unidades del viewBox). Ausente en piezas antiguas = 0,0. */
  offsetX?: number;
  offsetY?: number;
  createdAt: string;
}

const DATA_DIR = path.join(SERVER_DIR, "data");

export function loadJson<T>(name: string, empty: T): T {
  const file = path.join(DATA_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return empty;
  }
}

export function saveJson(name: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // escritura atómica simple
}

export const loadPieces = (): Piece[] => loadJson<Piece[]>("pieces.json", []);
export const savePieces = (pieces: Piece[]): void =>
  saveJson("pieces.json", pieces);

export const loadAudioRecords = (): AudioRecord[] =>
  loadJson<AudioRecord[]>("audio.json", []);
export const saveAudioRecords = (records: AudioRecord[]): void =>
  saveJson("audio.json", records);

/** Crea los directorios de trabajo si no existen. */
export function ensureDirs(): void {
  for (const dir of [
    DATA_DIR,
    path.join(SERVER_DIR, "tmp"),
    path.join(SERVER_DIR, "uploads", "audio"),
    path.join(SERVER_DIR, "uploads", "image"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
