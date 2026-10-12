/**
 * Envoltorio sobre el ffmpeg/ffprobe del SISTEMA (child_process, sin binarios
 * embebidos). Dos pasadas de loudnorm (EBU R128): medición y aplicación.
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Aborta el arranque si falta ffmpeg o ffprobe en el PATH. */
export function requireFfmpeg(): void {
  const missing = ["ffmpeg", "ffprobe"].filter(
    (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status !== 0
  );
  if (missing.length > 0) {
    console.error(
      `Este backend requiere ffmpeg instalado (apt install ffmpeg). ` +
        `No se encontró: ${missing.join(", ")}.`
    );
    process.exit(1);
  }
}

export interface LoudnormMeasurement {
  measuredI: number | null;
  measuredTP: number | null;
  measuredLRA: number | null;
  measuredThresh: number | null;
  offset: number;
}

interface LoudnormJson {
  input_i?: string;
  input_tp?: string;
  input_lra?: string;
  input_thresh?: string;
  target_offset?: string;
  output_i?: string;
}

/**
 * loudnorm escribe su JSON (print_format=json) en stderr, mezclado con el
 * resto del log. Extrae el ÚLTIMO bloque {...} (la pasada de aplicación
 * imprime el suyo propio).
 */
function extractLoudnormJson(stderr: string): LoudnormJson {
  const matches = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!matches || matches.length === 0) {
    throw new Error("ffmpeg no devolvió el JSON de loudnorm en stderr.");
  }
  return JSON.parse(matches[matches.length - 1]) as LoudnormJson;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null; // "-inf" / "nan" → null
}

/**
 * Pasada 1 (medición): loudnorm en modo análisis sobre salida nula.
 * Devuelve los valores medidos para alimentar la pasada 2.
 */
export async function measureLoudness(input: string): Promise<LoudnormMeasurement> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i", input,
      "-af", "loudnorm=I=-16:TP=-2:LRA=11:print_format=json",
      "-f", "null", "-",
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  const j = extractLoudnormJson(stderr);
  return {
    measuredI: num(j.input_i),
    measuredTP: num(j.input_tp),
    measuredLRA: num(j.input_lra),
    measuredThresh: num(j.input_thresh),
    offset: num(j.target_offset) ?? 0,
  };
}

/**
 * Pasada 2 (aplicación): loudnorm lineal con los valores medidos,
 * codificando AAC 192k en un .m4a. Devuelve el loudness logrado (output_i).
 */
export async function applyLoudness(
  input: string,
  output: string,
  m: LoudnormMeasurement
): Promise<{ loudnessAfter: number | null }> {
  const fmt = (v: number | null, fallback: string) =>
    v === null ? fallback : v.toFixed(2);
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i", input,
      "-af",
      "loudnorm=I=-16:TP=-2:LRA=11:" +
        `measured_I=${fmt(m.measuredI, "-70")}:` +
        `measured_TP=${fmt(m.measuredTP, "-20")}:` +
        `measured_LRA=${fmt(m.measuredLRA, "1")}:` +
        `measured_thresh=${fmt(m.measuredThresh, "-70")}:` +
        `offset=${m.offset.toFixed(2)}:linear=true:` +
        "print_format=json",
      "-c:a", "aac",
      "-b:a", "192k",
      output,
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  // stderr de la pasada 2: su output_i refleja el loudness realmente logrado.
  try {
    const j = extractLoudnormJson(stderr);
    return { loudnessAfter: num(j.output_i) };
  } catch {
    return { loudnessAfter: null };
  }
}
