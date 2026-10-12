# Diseño — Paisaje Sonoro

Especificación vigente (sincronizada con el código, 2026-10-11). Documento
autónomo: las decisiones técnicas y su contexto se describen en cada sección.

## 0. Qué es

Herramienta web con la que una redacción convierte **imagen + audio** en una
pieza de "paisaje sonoro": la imagen —puntos, trazos, 4 capas de color o una
órbita azimutal— se dibuja y respira con el audio. El periodista la crea con un
asistente de 3 pasos; el lector la consume en la vista publicada `/p/:id`
(imagen dentro de un círculo + título + play).

Stack: **Vite 6 + React 19 + TypeScript strict** (pipeline 100 % navegador) +
**backend Express 4** en Node 18 (subida, validación, loudness con ffmpeg del
sistema). Sin base de datos: JSON en `server/data/`.

## 1. Formato de datos (`src/converter/format.ts`)

Un documento `.paisaje.json` por pieza: `{ format: "paisaje-sonoro", version,
generator, image: { width, height, webp, posterizedJpeg? }, … }`. Unión
discriminada por `version`/`style`; validación estricta con type-guard
(`isPaisajeDocument`) y cadena de migraciones (`validateAndMigrate`). El
backend valida con el MISMO guard (código compartido).

- **v1 · puntillista** (sin `style`): `points` plano `[x, y, r, rgbPacked]·N`;
  `params { step, maxRadius, multiplicador, seed, maxVisibleRatio }`. Versión
  terminal (no migra).
- **v2 · posterized** (paletteIdx): migra a v3 (`MIGRATIONS[2]`: `hueGlobal 0`
  + `layerAlpha` plenas; la v2 no recoloreaba, el color se preserva exacto).
- **v3 · posterized**: `layers[4]` ordenadas por luminancia final (oscura →
  graves): cada capa `{ band, palette, color, path }` con las bandas fijas
  60–200 / 200–1k / 1k–4k / 4k–10k Hz. `params { hueGlobal: −180..180 (0 =
  originales), layerAlpha: [4] en 0..1 (def 1,1,1,1), bw, grayTone: [4],
  minRegion, removeBackground? }`. Los docs viejos con matiz por capa
  (`hueShift[4]`, 2026-09-23) se **normalizan al cargar**: `hueGlobal 0`,
  capas al 100 % y `Layer.color` intacto (look exacto; los hueShift se
  descartan).
- **v3 · lineart**: `primitives.segments` plano `[x, y, angle, len, rgb]·N`
  (longitud %5, ángulo en [0,360), len > 0). `params { step, maxLength,
  strokeWidth, seed, maxVisibleRatio, mode?: 'luz'|'bordes', umbral? (0.05–0.6)
  }` — `mode`/`umbral` opcionales (los docs previos valen 'luz').
- **v3 · azimuthal**: `primitives.frames` = **14 estados** precomputados de
  segmentos (mismo guard que lineart; longitudes variables permitidas entre
  estados); `keyframes[3]` con los 5 parámetros `{ longitudCentral,
  paraleloEstandar, roll, pitch, yaw }`. `params { step, maxLength,
  strokeWidth, umbral, maxVisibleRatio, orbitMode?: 'clamp'|'bounce' }`. Los
  docs azimutales de PUNTOS (pre-AZ-3) se rechazan con mensaje claro (era
  muerta, no migra).

## 2. Conversores (`src/converter/`, registrados en `src/styles/registry.ts`)

Añadir un estilo = registrar entrada + componente, sin tocar el asistente.
Todos normalizan a **900 px de alto** y generan un WebP de referencia (JPEG
fallback si el navegador no codifica WebP; nunca se procesa el WebP).

- **Puntillista**: rejilla + promedio de celda; aceptación probabilística ∝
  oscuridad (`mulberry32(seed)`); radio ∝ oscuridad. `points` v1.
- **Line Art**: gradiente Sobel sobre luminancia; trazo **tangente**
  (`angle = atan2(gy,gx)+90°`), `len = maxLength·(0.3+0.7·oscuridad)`, color de
  celda. Modo **'bordes'** (grabado): tinta negra tangente, sin azar,
  `len = maxLength·(0.4+0.6·m)`, `m ≥ umbral` (campo de bordes compartido con
  el azimutal, en `lineart.ts`).
- **Posterizado 4 capas** (pipeline Krita → JPEG → trazado): resize 900 → snap
  de canales a 8 niveles → histograma **top-6** + **fusión iterativa del par
  más cercano hasta 4** (evita paletas colapsadas en fotos muy oscuras/claras;
  los fusionados se muestran tachados en revisión) → raster exacto → **JPEG
  q92** (artefacto de trabajo: se muestra, se sube y ES la entrada del
  trazado) → re-snap a paleta fija → filtro mayoritario + cierre de agujeros →
  **marching squares a 0.5×** (truco potrace) → Douglas-Peucker ε 0.6 →
  `removeSpikes` convergente (tope 2.5 px) → invariante del trazador: **0
  violaciones y 0 agujas** en las fotos de referencia. **Quitar fondo**
  (`removeBackground`): el color dominante del anillo del borde se excluye de
  la paleta (entra el siguiente candidato) y sus píxeles quedan sin capa
  (−1 → transparentes; el re-snap del JPEG los restaura). **Matiz general**:
  `rotateHue(paleta, hueGlobal)` — perceptible siempre, incluso en capas casi
  negras/blancas. **Transparencia por capa** (`layerAlpha`). B&W con tono de
  gris por capa; Limpieza (`minRegion`) re-traza.
- **Azimutal**: la imagen es un **mapa equirectangular de la esfera completa**;
  la vista es un **disco = hemisferio visible** (`d3.geoAzimuthalEquidistant`,
  `clipAngle(90)`, `invert` por celda — PROHIBIDO rasterizar la deformada).
  Medio: **tinta de borde** negra (Sobel, `len = maxLength·(0.4+0.6·m)`).
  3 keyframes × 5 parámetros → **14 estados** interpolados por camino angular
  corto (wrap ±180°). Editor por pestañas (frames heredan del anterior;
  [Secuencia] anima la interpolación).

## 3. Asistente (`src/demo/Wizard.tsx`)

Rutas: `/` asistente · `/p/:id` vista publicada. Tres pasos con máquina de
estados pura (`wizardState.ts`) y registro de estilos pluggable:

1. **Imagen y estilo**: selector de estilo + editor (lazy). [USAR] sube el
   `.paisaje.json` + WebP (+ JPEG posterizado) con `POST /api/image`.
2. **Audio y reproductor**: subida con progreso real (XMLHttpRequest;
   "Procesando…" indeterminado mientras ffmpeg normaliza); muestra loudness
   antes → después; selector **Amplitud/Espectro** y slider **Velo** sobre el
   player en vivo; [Usar reproductor] confirma.
3. **Resumen**: **título OBLIGATORIO** (1–120, bloquea [TERMINAR]) y **vista
   previa del encuadre**: la pieza tal cual se publicará (play inerte) con
   **arrastre libre** de la imagen detrás del círculo (render estático
   completo; offset en unidades del viewBox; [Recentrar]).

[TERMINAR] → `POST /api/piece { imageId, audioId, mode, veil, title, offsetX,
offsetY }` → `/p/:id`. `buildPaisajeJson` construye el documento según el
estilo (puntillista → v1; el resto → v3 con su rama).

## 4. Backend (`server/`, Express en :8787, mismo origen vía proxy de Vite)

Arranque con verificación de ffmpeg/ffprobe. CORS restrictivo (mismo origen),
estáticos `/uploads`, 404 de API y manejador de errores. Escritura JSON atómica
(tmp + rename).

- `POST /api/image` — multipart `points` + `webp` [+ `posterized`]: valida el
  JSON con el type-guard compartido (400 claro si no valida); guarda
  `uploads/image/{id}.json|.webp[|.jpeg]`.
- `POST /api/audio` — multipart `file` (≤300 MB; mp3/wav/ogg/m4a/flac/aac) →
  **loudnorm EBU R128 a −16 LUFS** (TP −2, LRA 11, dos pasadas: medición +
  aplicación lineal) → AAC 192k; devuelve `{ id, url, originalFormat,
  loudnessBefore, loudnessAfter }`.
- `POST /api/piece` — `{ imageId, audioId, mode, veil, title (obligatorio,
  1–120), offsetX?, offsetY? }` → `{ id }`.
- `GET /api/piece/:id` (404 claro; URLs resueltas + loudness + title + offset)
  · `GET /api/pieces`. Piezas en `server/data/pieces.json`; registro de audio
  en `server/data/audio.json`. Limpieza de eras muertas:
  `scripts/cleanup-storage.ts`.

## 5. Player (`src/player/PaisajePlayer.tsx`)

`<audio>` nativo + controles propios (D1: sin wavesurfer). Grafo WebAudio
`source → gain → analyser → destination` creado solo en el primer gesto (EQ +
compresor en el asistente). **Peak** = pico instantáneo suavizado (α 0.25)
después de normalizar; **normalización adaptativa** (`runningMax·0.999`, piso
anti-ruido 0.08, `drive`); subset visible = `floor(peak^gamma · N · ratio)`
con **gamma 0.7** sobre **permutación sembrada** (`mulberry32(seed)` +
Fisher-Yates) — mismo seed → misma secuencia de revelado. **Espectro**: bandas
logarítmicas **60 Hz–10 kHz** repartidas por `x` (graves izquierda), energía
efectiva interpolada en los bordes de franja (sin líneas divisorias); el
posterizado usa las 4 bandas del documento. **Velo** (0.35): `veiledOpacity`.
Azimutal: **órbita de odómetro** — velocidad `(1 + 1.5·peak^0.7)·13/duration`
estados/s (en silencio completa A→C una vez por tema), fin de recorrido
`clamp` (se detiene en C) o `bounce` (rebote triangular C→A); resync al seek.

Variantes (`variant`):
- `'full'` (editor/asistente): controles completos.
- `'minimal'` (publicada): contenido **dentro de un círculo** (clipPath,
  `r = min(w,h)/2·0.75`) sobre disco blanco `--paisaje-disc` (transparente si
  se anula), **título dentro del cuadro** (abajo-derecha, sobre el play,
  `--paisaje-ink`; descripción opcional bajo el cuadro), play circular +
  contador abajo-derecha, `offset` desplaza el contenido (encuadre F2.5).

`staticPreview` fuerza el render estático completo (vista de encuadre, donde
no hay audio). Reduced-motion: 'static'/'fade'.

## 6. Futuro (decidido, NO implementar aún)

- **Rendimiento móvil** con muchos puntos/trazos: lo evalúa el director de la
  revista en la integración.
- **Integración con el editor** de la revista: la hace el equipo de la
  revista (`src/editor-block/` queda de stub).
- Mover `generatePoints` a **Web Worker** si la generación supera ~200 ms con
  regularidad (hoy avisa por consola).
