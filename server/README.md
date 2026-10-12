# Backend de demo — paisaje-sonoro

Node 18 + Express 4 + multer, en TypeScript ejecutado con **tsx** (dev dependency).
Normaliza audio a EBU R128 con el **ffmpeg del sistema** (vía `child_process`,
sin binarios embebidos ni ffmpeg-static).

## Requisito: ffmpeg

El arranque aborta si no están en el PATH:

```bash
sudo apt install ffmpeg     # ffmpeg + ffprobe
ffmpeg -version             # comprobación
```

## Arranque

```bash
npm install        # una vez (instala express, multer, nanoid, tsx, …)
npm run server     # tsx watch server/index.ts  → http://localhost:8787
```

Puerto por defecto **8787**; se cambia con `PORT=9999 npm run server`.

En desarrollo del frontend (`npm run dev`, Vite :5173) las rutas `/api` y
`/uploads` ya van proxyadas a este servidor (ver `vite.config.ts`), así que
no hace falta CORS abierto: el backend solo acepta mismo origen.

## Endpoints (resumen)

| Método | Ruta | Campos multipart / body JSON | Devuelve |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ ok: true }` |
| `POST` | `/api/audio` | multipart, campo **`file`** (máx. 300 MB; mp3/wav/ogg/m4a/flac/aac) | `{ id, url, originalFormat, loudnessBefore, loudnessAfter, createdAt }` |
| `POST` | `/api/image` | multipart, dos campos: **`points`** (`.paisaje.json`) y **`webp`** (`.webp`) | `{ id, jsonUrl, webpUrl }` |
| `POST` | `/api/piece` | JSON body: `{ imageId, audioId, mode: "amplitude"\|"spectrum", veil: number }` | `{ id }` |
| `GET` | `/api/piece/:id` | — | pieza con `audio.url`, `audio.loudnessBefore/After`, `image.jsonUrl`, `image.webpUrl` (404 si no existe) |
| `GET` | `/api/pieces` | — | array de piezas con URLs resueltas |
| `GET` | `/uploads/audio/{id}.m4a` | — | audio normalizado (estático) |
| `GET` | `/uploads/image/{id}.json` / `{id}.webp` | — | puntos / referencia visual (estático) |

### Ejemplos curl

```bash
# 1. Subir audio (normalización EBU R128 a .m4a)
curl -F "file=@/ruta/pieza.mp3" http://localhost:8787/api/audio

# 2. Subir imagen (JSON de puntos validado + WebP)
curl -F "points=@/ruta/foto.paisaje.json" -F "webp=@/ruta/foto.webp" \
     http://localhost:8787/api/image

# 3. Crear pieza que los enlaza
curl -X POST -H "Content-Type: application/json" \
     -d '{"imageId":"IMG_ID","audioId":"AUD_ID","mode":"spectrum","veil":0.35}' \
     http://localhost:8787/api/piece

# 4. Recuperarla y listar el índice
curl http://localhost:8787/api/piece/PIECE_ID
curl http://localhost:8787/api/pieces
```

Detalle por endpoint:

### `POST /api/audio`
Multipart con un campo `file` (máx. **300 MB**).
Formatos aceptados: `mp3 wav ogg m4a flac aac`.

Pipeline (`server/ffmpeg.ts`):
1. **Medición**: `ffmpeg -i input -af loudnorm=I=-16:TP=-2:LRA=11:print_format=json -f null -`
2. **Aplicación**: `ffmpeg -i input -af loudnorm=…:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=…:linear=true -c:a aac -b:a 192k` → `server/uploads/audio/{id}.m4a`

Responde `200`:
```json
{
  "id": "V1StGXR8_Z",
  "url": "/uploads/audio/V1StGXR8_Z.m4a",
  "originalFormat": "wav",
  "loudnessBefore": -27.1,
  "loudnessAfter": -16.0
}
```

### `POST /api/image`
Multipart con **dos** campos: `points` (`.paisaje.json`) y `webp` (`.webp`).
El JSON se valida con el mismo type-guard del frontend
(`isPaisajeDocument`, de `src/converter/format.ts`, código compartido).
Si no valida → `400` con mensaje descriptivo.

Responde `200`: `{ "id": "…", "jsonUrl": "/uploads/image/{id}.json", "webpUrl": "/uploads/image/{id}.webp" }`

### Piezas — `server/data/pieces.json` como "base de datos" de la demo

- `POST /api/piece` — body `{ imageId, audioId, mode: "amplitude"|"spectrum", veil: number }`
  → crea la pieza y responde `{ "id": "…" }` (id corto).
- `GET /api/piece/:id` → pieza con URLs resueltas (audio con loudness
  antes/después, imagen con jsonUrl/webpUrl). `404` si no existe.
- `GET /api/pieces` → listado completo con URLs resueltas (índice simple).

### `GET /uploads/*`
Estáticos: `express.static` sobre `server/uploads/` (`/uploads/audio/{id}.m4a`,
`/uploads/image/{id}.json`, `/uploads/image/{id}.webp`).

## Datos

| Ruta | Contenido |
|---|---|
| `server/uploads/audio/` | `.m4a` normalizados (persistente) |
| `server/uploads/image/` | `.json` + `.webp` por imagen (persistente) |
| `server/data/pieces.json` | piezas publicadas |
| `server/data/audio.json` | registro de uploads de audio (incl. loudness) |
| `server/tmp/` | archivos temporales de multer (se limpian tras cada request) |
