import { describe, it, expect } from "vitest";
import { hasJpegSignature } from "./jpeg";

/**
 * Validación del JPEG posterizado en POST /api/image (campo "posterized"):
 * se exige mime image/jpeg EN LA RUTA y aquí se verifica la firma de bytes
 * (descarta bytes que no son JPEG aunque vengan con ese mime).
 */

// Cabecera mínima de un JPEG real: SOI (FFD8) + marcador de segmento (FFxx).
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe("hasJpegSignature", () => {
  it("acepta bytes con firma JPEG (FF D8 FF …)", () => {
    expect(hasJpegSignature(JPEG_HEAD)).toBe(true);
    expect(hasJpegSignature(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    // Otro marcador de segmento tras el SOI (p. ej. Exif FF E1).
    expect(hasJpegSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe(true);
  });

  it("rechaza otras firmas aunque el mime diga image/jpeg", () => {
    // PNG: 89 50 4E 47
    expect(hasJpegSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false);
    // GIF: 47 49 46
    expect(hasJpegSignature(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBe(false);
    // WebP: RIFF….
    expect(hasJpegSignature(Buffer.from("RIFF....WEBP", "ascii"))).toBe(false);
    // Texto plano renombrado.
    expect(hasJpegSignature(Buffer.from("{\"format\":\"paisaje", "utf8"))).toBe(false);
  });

  it("rechaza buffers demasiado cortos para tener firma", () => {
    expect(hasJpegSignature(Buffer.from([]))).toBe(false);
    expect(hasJpegSignature(Buffer.from([0xff, 0xd8]))).toBe(false);
  });
});
