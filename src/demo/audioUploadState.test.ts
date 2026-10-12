import { describe, it, expect } from "vitest";
import {
  initialAudioUploadState,
  startAudioUpload,
  setAudioUploadProgress,
  audioUploadComplete,
  audioUploadSucceed,
  audioUploadFail,
  isAudioUploadLocked,
} from "./audioUploadState";

describe("audioUploadState — transición idle → uploading → processing → ready", () => {
  it("startAudioUpload pasa de idle a uploading con progreso 0", () => {
    const s = startAudioUpload(initialAudioUploadState());
    expect(s.phase).toBe("uploading");
    expect(s.progress).toBe(0);
    expect(s.error).toBeNull();
    expect(isAudioUploadLocked(s)).toBe(true);
  });

  it("setAudioUploadProgress actualiza el porcentaje real solo en uploading", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = setAudioUploadProgress(s, 42);
    expect(s.progress).toBe(42);
    const proc = audioUploadComplete(s);
    expect(setAudioUploadProgress(proc, 80)).toBe(proc); // no-op fuera de uploading
  });

  it("el progreso se clampa a [0, 100]", () => {
    let s = startAudioUpload(initialAudioUploadState());
    expect(setAudioUploadProgress(s, -5).progress).toBe(0);
    expect(setAudioUploadProgress(s, 250).progress).toBe(100);
  });

  it("uploadComplete → processing (barra indeterminada, bloqueo activo)", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = audioUploadComplete(s);
    expect(s.phase).toBe("processing");
    expect(isAudioUploadLocked(s)).toBe(true);
  });

  it("succeed solo desde processing → ready y desbloqueo", () => {
    let s = startAudioUpload(initialAudioUploadState());
    expect(audioUploadSucceed(s)).toBe(s); // no-op: aún no se ha subido
    s = audioUploadComplete(s);
    s = audioUploadSucceed(s);
    expect(s.phase).toBe("ready");
    expect(isAudioUploadLocked(s)).toBe(false);
  });
});

describe("audioUploadState — error conserva el audio anterior", () => {
  it("fallo en uploading → error con mensaje, sin cambiar nada más", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = setAudioUploadProgress(s, 60);
    s = audioUploadFail(s, "Error de red");
    expect(s.phase).toBe("error");
    expect(s.error).toBe("Error de red");
    expect(isAudioUploadLocked(s)).toBe(false); // el audio anterior queda usable
  });

  it("fallo en processing → error (el audio anterior sigue intacto)", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = audioUploadComplete(s);
    s = audioUploadFail(s, "ffmpeg falló");
    expect(s.phase).toBe("error");
    expect(s.error).toBe("ffmpeg falló");
  });

  it("desde error se puede reintentar (→ uploading limpio)", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = audioUploadFail(s, "Error de red");
    s = startAudioUpload(s);
    expect(s.phase).toBe("uploading");
    expect(s.error).toBeNull();
  });

  it("reemplazar un audio ready vuelve a uploading (y bloquea)", () => {
    let s = startAudioUpload(initialAudioUploadState());
    s = audioUploadComplete(s);
    s = audioUploadSucceed(s);
    s = startAudioUpload(s);
    expect(s.phase).toBe("uploading");
    expect(isAudioUploadLocked(s)).toBe(true);
  });
});

describe("audioUploadState — inmutabilidad", () => {
  it("las transiciones no mutan el estado anterior", () => {
    const s0 = initialAudioUploadState();
    const s1 = startAudioUpload(s0);
    const s2 = setAudioUploadProgress(s1, 50);
    expect(s0.phase).toBe("idle");
    expect(s1.progress).toBe(0);
    expect(s2.progress).toBe(50);
  });
});
