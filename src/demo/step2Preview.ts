/**
 * Fuente de la vista previa del paso 2 del asistente.
 *
 * INVARIANTE (regresión 2026-09-21): el <PaisajePlayer> de la vista previa
 * se sirve SIEMPRE desde el JSON ya subido al backend (imageId confirmado),
 * nunca desde el documento local del conversor. El player no reacciona a
 * cambios de la prop `points` (solo inicializa su estado en el montaje),
 * pero sí vuelve a fetchear cuando cambia `jsonUrl`. Sourcing por URL:
 *   - la vista previa refleja exactamente lo que se publicará;
 *   - al cambiar la imagen (nuevo imageId), la vista previa se actualiza.
 */
export function step2PreviewJsonUrl(imageId: string | null): string | null {
  return imageId ? `/uploads/image/${imageId}.json` : null;
}
