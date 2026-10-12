# CLAUDE.md — Orientación para agentes de código

## Qué es este proyecto
Herramienta web para crear "paisajes sonoros": una imagen se convierte en uno de
cuatro estilos vectoriales (puntillista, line art, posterizado a 4 capas, azimutal)
que se animan en vivo según un audio. Asistente de 3 pasos (imagen → audio →
publicación), backend Express que normaliza el audio a −16 LUFS (ffmpeg) y sirve
los assets.

## Documentación fuente de verdad
- docs/DISENO.md — especificación completa (formato de datos v3, pipeline, decisiones).
- README.md — requisitos y arranque.

## Arquitectura en una línea por pieza
- src/styles/registry.ts — catálogo de estilos (aquí se enchufa uno nuevo).
- src/converter/* — un editor por estilo; todos producen documentos v3 (src/converter/format.ts).
- src/player/PaisajePlayer.tsx — reproductor único; variant 'full' (editor) | 'minimal' (vista publicada).
- src/demo/* — asistente de 3 pasos; wizardState.ts es la máquina de estados (testeada).
- server/* — Express + multer + ffmpeg (loudnorm en dos pasadas → AAC 192k).

## Reglas de oro (no romper sin consultar)
1. Los 284 tests deben quedar en verde, incluido el validador de invariante del
   trazador (trace-invariant). No "mejorar" el trazado sin pasarlo.
2. El formato de datos es JSON v3; cualquier cambio requiere entrada en
   MIGRATIONS (format.ts) y tests asociados.
3. Nuevas dependencias: revisar licencia primero (GPL solo como subproceso en el
   servidor, nunca enlazada en el bundle del navegador).
4. El reproductor se integra en editores ajenos: react/react-dom son
   peerDependencies; estilos solo vía variables CSS --paisaje-*.
5. El procesado de imagen ocurre en el navegador; el servidor solo procesa audio.

## Tareas típicas de integración
- Añadir un estilo nuevo: conversor en src/converter/, registro en registry.ts,
  type-guard + tests.
- Tema visual de la revista: tocar solo variables CSS y player.css/converter.css.
- Incrustar en un editor React: consumir <PaisajePlayer variant="minimal"> y
  replicar el wizard (src/demo/Wizard.tsx) como bloque/panel.
