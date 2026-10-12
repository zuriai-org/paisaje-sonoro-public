// @vitest-environment jsdom
/**
 * Tests del chrome del reproductor (P3 2026-09-24): la prop `variant`.
 *
 * - 'minimal' (vista publicada /p/:id): NO hay barra de progreso, tiempo,
 *   volumen ni mute — solo la imagen animada + botón circular play/pausa
 *   accesible (esquina inferior izquierda del stage).
 * - 'full' (default, asistente paso 2): controles completos intactos.
 *
 * El componente se monta con la prop `points` (sin fetch) y con los stubs
 * mínimos que jsdom no trae: matchMedia, AudioContext y play/pause del
 * <audio> (simulados con sus eventos, que es como el componente sincroniza
 * el estado `playing`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PaisajePlayer, { MINIMAL_CIRCLE_SCALE } from "./PaisajePlayer";

// Dos puntos v1 planos [x, y, r, rgbPacked] — solo importa que el SVG monte.
const POINTS: number[] = [
  10, 10, 5, (200 << 16) | (30 << 8) | 30,
  40, 40, 5, (30 << 16) | (160 << 8) | 60,
];

beforeAll(() => {
  // matchMedia (prefers-reduced-motion): jsdom no lo implementa.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  // AudioContext mínimo: ensureGraph() se llama en el gesto de play.
  const node = { connect: () => {}, disconnect: () => {} };
  class FakeAudioContext {
    state = "running";
    sampleRate = 48000;
    destination = {};
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createMediaElementSource() {
      return { ...node };
    }
    createGain() {
      return { gain: { value: 1 }, ...node };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        ...node,
        getByteTimeDomainData: () => {},
        getByteFrequencyData: () => {},
      };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

  // play/pause: jsdom no los implementa. El componente sincroniza `playing`
  // con los eventos onPlay/onPause del <audio> y decide la rama por la
  // propiedad `paused`, así que simulamos ambas cosas.
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, get: () => false });
    this.dispatchEvent(new Event("play", { bubbles: true }));
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, get: () => true });
    this.dispatchEvent(new Event("pause", { bubbles: true }));
  };
});

afterEach(() => cleanup());

describe("PaisajePlayer · variant='minimal' (vista publicada)", () => {
  it("no renderiza progreso, tiempo, volumen ni mute (queryByRole negativo)", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />
    );
    expect(screen.queryByRole("slider", { name: "Progreso" })).toBeNull();
    expect(screen.queryByRole("slider", { name: "Volumen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Silenciar" })).toBeNull();
    expect(container.querySelector(".paisaje-controls")).toBeNull();
    expect(container.querySelector(".paisaje-time")).toBeNull();
    // la imagen animada sigue ahí
    expect(container.querySelector("svg.paisaje-svg")).not.toBeNull();
  });

  it("solo hay UN botón: el play circular, con aria-label y estado anunciado", () => {
    render(<PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    const btn = buttons[0];
    expect(btn.getAttribute("aria-label")).toBe("Reproducir paisaje sonoro");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.className).toBe("paisaje-play-minimal");
  });

  it("el botón alterna play/pause (estado y aria)", () => {
    render(<PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />);
    const btn = screen.getByRole("button", { name: "Reproducir paisaje sonoro" });

    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Pausar" }).getAttribute("aria-pressed")).toBe(
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(
      screen.getByRole("button", { name: "Reproducir paisaje sonoro" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("chrome en la esquina inferior DERECHA: botón dentro del contenedor y CSS correcto", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />
    );
    const chrome = container.querySelector(".paisaje-minimal-chrome");
    expect(chrome).not.toBeNull();
    expect(chrome?.querySelector("button.paisaje-play-minimal")).not.toBeNull();
    // jsdom no hace layout: la posición se fija en el stylesheet.
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "player.css"),
      "utf8"
    );
    const chromeCss = css.match(/\.paisaje-minimal-chrome\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(chromeCss).toContain("right: 16px");
    expect(chromeCss).toContain("bottom: 16px");
    expect(chromeCss).not.toContain("left:");
    const btnCss = css.match(/\.paisaje-play-minimal\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(btnCss).toContain("border: 3.5px solid");
  });

  it("contador m:ss debajo del círculo: duración en pausa, cuenta regresiva sonando", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />
    );
    const audio = container.querySelector("audio") as HTMLAudioElement;
    const timer = screen.getByRole("timer");
    // va después del botón dentro del chrome (debajo del círculo, centrado)
    const chrome = container.querySelector(".paisaje-minimal-chrome") as HTMLElement;
    expect(chrome.children[0].tagName).toBe("BUTTON");
    expect(chrome.children[1]).toBe(timer);
    // sin metadata aún → 0:00
    expect(timer.textContent).toMatch(/^\d+:\d{2}$/);
    expect(timer.textContent).toBe("0:00");
    // metadata (duración 30) → en pausa muestra la duración total
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 30 });
    fireEvent(audio, new Event("loadedmetadata", { bubbles: true }));
    expect(timer.textContent).toBe("0:30");
    // play → cuenta regresiva del tiempo restante (actualización por segundo)
    fireEvent.click(screen.getByRole("button", { name: "Reproducir paisaje sonoro" }));
    expect(timer.textContent).toBe("0:30"); // currentTime 0: restan 30
    Object.defineProperty(audio, "currentTime", { configurable: true, get: () => 10 });
    fireEvent(audio, new Event("timeupdate", { bubbles: true }));
    expect(timer.textContent).toBe("0:20");
    // pausa → vuelve a mostrar la duración total
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(timer.textContent).toBe("0:30");
  });
});

describe("PaisajePlayer · variant='full' (default — regresión)", () => {
  it("sin la prop renderiza los controles completos como siempre", () => {
    render(<PaisajePlayer points={POINTS} audioUrl="audio.mp3" />);
    // getByRole lanza si no existe: estas llamadas YA son la aserción;
    // el toBe/not.toBeNull deja el valor explícito.
    expect(screen.getByRole("slider", { name: "Progreso" })).not.toBeNull();
    expect(screen.getByRole("slider", { name: "Volumen" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reproducir" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Silenciar" })).not.toBeNull();
  });

  it("variant='full' explícita = idéntica a la default", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="full" />
    );
    expect(screen.getByRole("slider", { name: "Progreso" })).not.toBeNull();
    expect(container.querySelector(".paisaje-play-minimal")).toBeNull();
  });
});


// ─────────────────────────────────────────────────────────────────────────
// F1 (2026-10-11): presentación en círculo + título debajo (SOLO 'minimal')
// ─────────────────────────────────────────────────────────────────────────

/** El círculo de la clipPath: es el único <circle> cuyo padre es clipPath
 *  (la comparación en minúsculas es robusta al caso del tagName SVG). */
function clipCircle(svg: SVGSVGElement) {
  return [...svg.querySelectorAll("circle")].find(
    (c) => c.parentElement?.tagName.toLowerCase() === "clippath"
  );
}

describe("PaisajePlayer · círculo y título (F1, variant='minimal')", () => {
  // points prop → viewBox fallback 1000×1000 → r = min/2 · 0.75 (25 % menor).
  const R = (1000 / 2) * MINIMAL_CIRCLE_SCALE;

  it("recorta el contenido con una clipPath circular centrada (r = min(w,h)/2 · 0.75)", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />
    );
    const svg = container.querySelector("svg.paisaje-svg") as SVGSVGElement;
    expect(MINIMAL_CIRCLE_SCALE).toBe(0.75);
    const c = clipCircle(svg);
    expect(c).not.toBeUndefined();
    expect(c!.getAttribute("cx")).toBe("500");
    expect(c!.getAttribute("cy")).toBe("500");
    expect(c!.getAttribute("r")).toBe(String(R));
    // el contenido animado va DENTRO de un <g> que usa ese clip.
    const g = svg.querySelector("g[clip-path]");
    expect(g).not.toBeNull();
    expect(g!.getAttribute("clip-path")).toBe(`url(#${c!.parentElement!.id})`);
  });

  it("dibuja el disco de fondo DETRÁS del contenido, con fill --paisaje-disc", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="minimal" />
    );
    const svg = container.querySelector("svg.paisaje-svg") as SVGSVGElement;
    const disc = svg.querySelector("circle.paisaje-disc");
    expect(disc).not.toBeNull();
    expect(disc!.getAttribute("cx")).toBe("500");
    expect(disc!.getAttribute("r")).toBe(String(R));
    // el disco aparece ANTES que el grupo con clip → queda detrás del contenido.
    const kids = [...svg.children];
    expect(kids.indexOf(disc!)).toBeLessThan(kids.indexOf(svg.querySelector("g[clip-path]")!));
    // el fill lo da la variable de tema (blanca por defecto, anulable).
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "player.css"),
      "utf8"
    );
    const discCss = css.match(/\.paisaje-disc\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(discCss).toContain("var(--paisaje-disc");
  });

  it("título DENTRO del cuadro (abajo-derecha, sobre el play); descripción bajo el stage", () => {
    const { container } = render(
      <PaisajePlayer
        points={POINTS}
        audioUrl="audio.mp3"
        variant="minimal"
        title="Retrato sonoro"
        description="Prueba F1"
      />
    );
    // el título es hijo del STAGE (dentro del cuadro), no del exterior.
    const stage = container.querySelector(".paisaje-player-stage")!;
    const title = stage.querySelector("h2.paisaje-minimal-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Retrato sonoro");
    expect(screen.queryByRole("heading", { level: 2, name: "Retrato sonoro" })).not.toBeNull();
    // sin header encima (ese era el defecto reportado).
    expect(container.querySelector(".paisaje-player-header")).toBeNull();
    // la descripción opcional sigue bajo el cuadro, en cuerpo menor.
    const caption = container.querySelector(".paisaje-minimal-caption");
    expect(caption).not.toBeNull();
    expect(caption!.querySelector("p.paisaje-minimal-desc")!.textContent).toBe("Prueba F1");
    const parentKids = [...stage.parentElement!.children];
    expect(parentKids.indexOf(caption!)).toBeGreaterThan(parentKids.indexOf(stage));
    // la posición inferior-derecha vive en el stylesheet (jsdom no hace layout).
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "player.css"),
      "utf8"
    );
    const titleCss = css.match(/\.paisaje-minimal-title\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(titleCss).toContain("position: absolute");
    expect(titleCss).toContain("right: 16px");
    expect(titleCss).toContain("--paisaje-ink");
  });

  it("variant='full': sin círculo, sin disco, sin título en el stage (todo como antes)", () => {
    const { container } = render(
      <PaisajePlayer points={POINTS} audioUrl="audio.mp3" variant="full" title="Solo arriba" />
    );
    const svg = container.querySelector("svg.paisaje-svg") as SVGSVGElement;
    expect(clipCircle(svg)).toBeUndefined();
    expect(svg.querySelector("g[clip-path]")).toBeNull();
    expect(svg.querySelector("circle.paisaje-disc")).toBeNull();
    expect(container.querySelector(".paisaje-minimal-caption")).toBeNull();
    // el título NO se cuela dentro del stage; sigue en el header de siempre.
    const stage = container.querySelector(".paisaje-player-stage")!;
    expect(stage.querySelector("h2.paisaje-minimal-title")).toBeNull();
    const header = container.querySelector(".paisaje-player-header");
    expect(header).not.toBeNull();
    expect(header!.querySelector("h2")!.textContent).toBe("Solo arriba");
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Estilo 'lineart' (LA-2): <line> por segmento + efecto dibujo (dash)
// ─────────────────────────────────────────────────────────────────────────

/** Documento v3 lineart servido por el fetch mockeado: 30 trazos horizontales
 * rojos (x creciente) — suficientes N para que el subset por peak sea > 0
 * aunque el peak suavizado no llegue a 1 (crece de forma asintótica). */
function lineartFetchMock() {
  const segments: number[] = [];
  for (let i = 0; i < 30; i++) {
    segments.push(10 + i, 10, 0, 8, (255 << 16) | (20 << 8) | 30);
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        format: "paisaje-sonoro",
        version: 3,
        style: "lineart",
        generator: { name: "test", version: "0" },
        image: { width: 640, height: 100, webp: "f.webp" },
        params: { step: 4, maxLength: 10, strokeWidth: 2, seed: 7, maxVisibleRatio: 1 },
        primitives: { segments },
      }),
    })) as unknown as typeof fetch
  );
}

describe("PaisajePlayer · estilo 'lineart' (LA-2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("<line> por segmento: extremos desde (x,y,angle,len), stroke, ancho y dash", async () => {
    lineartFetchMock();
    const { container } = render(
      <PaisajePlayer jsonUrl="/uploads/x.json" audioUrl="audio.mp3" />
    );
    // En reposo (peak 0) el subset visible está vacío: ningún trazo.
    expect(container.querySelectorAll("line")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    // Con el audio sonando el subset crece y aparecen los <line>.
    await waitFor(
      () => {
        expect(container.querySelectorAll("line").length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 }
    );

    const lines = [...container.querySelectorAll("line")];
    for (const ln of lines) {
      const x1 = Number(ln.getAttribute("x1"));
      const y1 = Number(ln.getAttribute("y1"));
      const x2 = Number(ln.getAttribute("x2"));
      const y2 = Number(ln.getAttribute("y2"));
      // Extremos coherentes con el segmento del documento (angle 0, len 8,
      // centro en (10+i, 10)): x1+x2 = 20+2i y Δx = 8, Δy = 0.
      const i = Math.round((x1 + x2 - 20) / 2);
      expect(x1).toBeCloseTo(10 + i + 4, 5);
      expect(x2).toBeCloseTo(10 + i - 4, 5);
      expect(y1).toBe(10);
      expect(y2).toBe(10);
      // Estilo del trazo: color desempaquetado, ancho del params, linecap round.
      expect(ln.getAttribute("stroke")).toBe("rgb(255,20,30)");
      expect(ln.getAttribute("stroke-width")).toBe("2");
      expect(ln.getAttribute("stroke-linecap")).toBe("round");
      expect(ln.getAttribute("fill")).toBe("none");
      // Efecto dibujo: dasharray = len y offset = len·(1 − peak) ∈ [0, len].
      expect(Number(ln.getAttribute("stroke-dasharray"))).toBe(8);
      const off = Number(ln.getAttribute("stroke-dashoffset"));
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(8);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Estilo 'azimuthal' (AZ-2): secuencia por progreso + vaivén, r=0 omitidos
// ─────────────────────────────────────────────────────────────────────────

/** Doc v3 azimuthal (AZ-3, líneas de borde) mockeado: 14 frames de 4
 * segmentos negros. Tres horizontales distintivos por frame (x = 100 + f·10,
 * angle 0, len 8 → x1 = x+4; ys 50/70/90) y uno vertical en x = f (len 6). */
function azimuthalFetchMock() {
  const frames = Array.from({ length: 14 }, (_, f) => [
    100 + f * 10, 50, 0, 8, 0,
    100 + f * 10, 70, 0, 8, 0,
    100 + f * 10, 90, 0, 8, 0,
    f, 200, 90, 6, 0,
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        format: "paisaje-sonoro",
        version: 3,
        style: "azimuthal",
        generator: { name: "test", version: "0" },
        image: { width: 640, height: 400, webp: "f.webp" },
        params: { step: 4, maxLength: 10, strokeWidth: 2, umbral: 0.15, maxVisibleRatio: 1 },
        keyframes: [
          { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 0 },
          { longitudCentral: 30, paraleloEstandar: 0, roll: 45, pitch: 0, yaw: 0 },
          { longitudCentral: 0, paraleloEstandar: 0, roll: 0, pitch: 0, yaw: 45 },
        ],
        primitives: { frames },
      }),
    })) as unknown as typeof fetch
  );
}

describe("PaisajePlayer · estilo 'azimuthal' (AZ-3, líneas de borde)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renderiza UN frame de <line> (pos = progreso + sway) y cambia con el seek", async () => {
    azimuthalFetchMock();
    const { container } = render(
      <PaisajePlayer jsonUrl="/uploads/az.json" audioUrl="audio.mp3" />
    );
    const audio = container.querySelector("audio") as HTMLAudioElement;

    // Sin audio no hay subset visible: ninguna línea.
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 26 });
    fireEvent(audio, new Event("loadedmetadata", { bubbles: true }));
    expect(container.querySelectorAll("line")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    await waitFor(
      () => {
        expect(container.querySelectorAll("line").length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 }
    );

    // El subset va creciendo; todos los <line> negros, con dash dibujo.
    await waitFor(
      () => {
        expect(container.querySelectorAll("line").length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 }
    );
    let lines = [...container.querySelectorAll("line")];
    for (const ln of lines) {
      expect(ln.getAttribute("stroke")).toBe("rgb(0,0,0)");
      expect(ln.getAttribute("stroke-width")).toBe("2");
      expect(ln.getAttribute("stroke-linecap")).toBe("round");
      expect(Number(ln.getAttribute("stroke-dasharray"))).toBeGreaterThan(0);
    }

    // Seek a currentTime 20/26 → posBase = 10 (+ sway ≤ 0.5) → frame 10:
    // aparecen el vertical (x1 = 10) y los horizontales (x1 = 204).
    Object.defineProperty(audio, "currentTime", { configurable: true, get: () => 20 });
    fireEvent(audio, new Event("timeupdate", { bubbles: true }));
    await waitFor(
      () => {
        const xs = [...container.querySelectorAll("line")].map((ln) =>
          Number(ln.getAttribute("x1"))
        );
        expect(xs).toContain(10);
        expect(xs).toContain(204);
      },
      { timeout: 3000 }
    );
    lines = [...container.querySelectorAll("line")];
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// F2 (2026-10-11): posterizado + transparencia por capa (fill-opacity)
// ─────────────────────────────────────────────────────────────────────────

/** Doc v3 posterizado (2 capas con paths reales) con layerAlpha [0.5, 1, 1, 1]. */
function posterizedFetchMock() {
  const BANDS = [
    [60, 200],
    [200, 1000],
    [1000, 4000],
    [4000, 10000],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        format: "paisaje-sonoro",
        version: 3,
        style: "posterized",
        generator: { name: "test", version: "0" },
        image: { width: 100, height: 100, webp: "f.webp" },
        params: {
          hueGlobal: 0,
          layerAlpha: [0.5, 1, 1, 1],
          bw: false,
          grayTone: [0, 85, 170, 255],
          minRegion: 12,
          removeBackground: false,
        },
        layers: [0, 1, 2, 3].map((i) => ({
          band: BANDS[i],
          palette: [i * 60, i * 60, i * 60],
          color: [i * 60, i * 60, i * 60],
          path: `M${i * 10},0 L${i * 10 + 8},0 L${i * 10 + 8},8 L${i * 10},8 Z`,
        })),
      }),
    })) as unknown as typeof fetch
  );
}

describe("PaisajePlayer · posterizado + transparencia por capa (F2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cada capa renderiza fill-opacity = layerAlpha, multiplicando la opacidad del grupo (modo)", async () => {
    posterizedFetchMock();
    const { container } = render(
      <PaisajePlayer jsonUrl="/uploads/p.json" audioUrl="audio.mp3" />
    );
    const audio = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 30 });
    fireEvent(audio, new Event("loadedmetadata", { bubbles: true }));

    // fill-opacity = layerAlpha CONSTANTE (0.5 / 1 / 1 / 1); la opacidad del
    // MODO la lleva el grupo (amplitud): 0 en reposo → nada se ve aunque el
    // atributo de la capa sea 0.5.
    await waitFor(() => expect(container.querySelectorAll("path")).toHaveLength(4));
    const group = () => {
      // el <g> hijo del <g transform> del modo amplitud lleva opacity
      const g = container.querySelector("svg.paisaje-svg > g g[opacity]");
      return g ? parseFloat(g.getAttribute("opacity") ?? "-1") : -1;
    };
    expect(group()).toBe(0);
    const fosAtRest = [...container.querySelectorAll("path")].map((p) =>
      parseFloat(p.getAttribute("fill-opacity") ?? "-1")
    );
    expect(fosAtRest).toEqual([0.5, 1, 1, 1]);

    // Al sonar: el grupo sube con el peak y el fill-opacity de la capa 0 es
    // la MITAD que el de la capa 1 (misma opacidad de modo, alpha 0.5 vs 1).
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    await waitFor(
      () => {
        expect(group()).toBeGreaterThan(0);
        const fos = [...container.querySelectorAll("path")].map((p) =>
          parseFloat(p.getAttribute("fill-opacity") ?? "-1")
        );
        expect(fos[0]).toBe(0.5);
        expect(fos[1]).toBe(1);
      },
      { timeout: 3000 }
    );
  });
});
