# paisaje-sonoro

Herramienta web con la que una redacción convierte **una imagen y un audio** en una pieza de paisaje sonoro: la imagen —puntos, trazos de grabado, 4 capas de color o una órbita azimutal— se dibuja y respira con el audio, y el lector la reproduce en una vista publicada (`/p/:id`).

## Requisitos

- **Node 18+**
- **ffmpeg** instalado en el sistema (`apt install ffmpeg`) — el backend lo usa para normalizar el loudness del audio a −16 LUFS.

## Arranque

```bash
npm install
npm run server   # backend en http://localhost:8787 (requiere ffmpeg)
npm run dev      # frontend en http://localhost:5173
```

Abrir http://localhost:5173 y seguir el asistente (imagen y estilo → audio y reproductor → resumen con título y encuadre); al terminar se publica en `/p/:id`.

## Arquitectura

- **Asistente** (`src/demo`): wizard de 3 pasos con máquina de estados pura y registro de estilos pluggable; la vista publicada `/p/:id` consume la pieza por API.
- **Conversores** (`src/converter`): cuatro estilos —puntillista, line art, posterizado 4 capas, azimutal—; todo el pipeline corre en el navegador y produce un `.paisaje.json` validado por un type-guard compartido con el backend.
- **Player** (`src/player`): reproductor audio-reactivo (WebAudio analyser; modos amplitud/espectro, velo, permutación sembrada de revelado; órbita azimutal). Variante `'full'` para el editor y `'minimal'` para la vista publicada (círculo + título + encuadre).
- **Backend** (`server/`): Express 4 + multer + ffmpeg (loudnorm EBU R128 a −16 LUFS, AAC 192k); valida los documentos con el mismo type-guard del frontend; storage en JSON (`server/data/`) y ficheros (`server/uploads/`). Mantenimiento: `npx tsx scripts/cleanup-storage.ts` (poda de piezas huérfanas/eras muertas — destructivo, hacer backup antes).

## Licencias de las dependencias

Runtime: React y React DOM (MIT), react-router-dom (MIT), d3-geo (ISC), express (MIT), multer (MIT), nanoid (MIT).
Toolchain (dev): Vite, Vitest, tsx, jsdom, @testing-library/react (MIT), puppeteer-core (Apache-2.0), TypeScript y @types/* (Apache-2.0 / MIT).
