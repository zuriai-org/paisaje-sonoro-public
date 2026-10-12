/**
 * Validación mínima de un JPEG real: firma de bytes (SOI + marcador JFIF/Exif
 * u otro marcador de segmento). Se exige ADEMÁS el mime image/jpeg en la
 * ruta; esto solo descarta bytes que no son un JPEG aunque vengan con ese
 * mime (p. ej. un PNG o un script renombrado).
 */
export function hasJpegSignature(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
