/**
 * Tests del núcleo Azimutal (AZ-3 reescritura 2026-09-26) — modelo
 * mapa-esfera + disco hemisférico: la imagen es un mapa equirectangular de
 * la ESFERA COMPLETA (360°×180°, arriba = polo norte) y la vista es el
 * hemisferio visible de d3.geoAzimuthalEquidistant (exterior transparente).
 * Tinta de bordes negra; muestreo por celda con invert + bilineal.
 *
 * Convención de signos calibrada contra las capturas del usuario (ver
 * entrega/bitácora): longitudCentral+ → contenido al OESTE; paraleloEstandar+
 * → contenido al SUR (+90 = borde inferior del disco); roll+ → rotación en
 * pantalla antihoraria (este→norte); pitch+ → contenido al NORTE; yaw+ →
 * contenido al ESTE.
 */
import { describe, it, expect } from "vitest";
import {
  activateKeyframeTab,
  borderField,
  generateFrames,
  generateStateSegments,
  interpolateKeyframes,
  pixelToSphere,
  sampleField,
  sphereToPixel,
  vistaCasiVacia,
  FRAME_COUNT,
  ZERO_KEYFRAME,
  type AzimuthalKeyframe,
  type AzimuthalParams,
  type AzimuthalSampling,
} from "./azimuthal";
import type { ImageDataLike } from "./core";

function makeImageData(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number]
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Imagen con un punto blanco (borde fuerte) centrado en el pixel (px, py). */
function dotImage(w: number, h: number, px: number, py: number): ImageDataLike {
  return makeImageData(w, h, (x, y) =>
    Math.abs(x - px) <= 4 && Math.abs(y - py) <= 4 ? [255, 255, 255] : [0, 0, 0]
  );
}

function kf(overrides: Partial<AzimuthalKeyframe> = {}): AzimuthalKeyframe {
  return { ...ZERO_KEYFRAME, ...overrides };
}

function sampling(overrides: Partial<AzimuthalSampling> = {}): AzimuthalSampling {
  return { step: 2, maxLength: 10, strokeWidth: 2, umbral: 0.15, ...overrides };
}

/** Centroide de los segmentos emitidos (dónde "aparece" el contenido). */
function centroid(img: ImageDataLike, rotation: AzimuthalKeyframe): [number, number] {
  const segs = generateStateSegments(img, sampling(), rotation);
  let sx = 0;
  let sy = 0;
  const n = segs.length / 5;
  for (let i = 0; i < segs.length; i += 5) {
    sx += segs[i];
    sy += segs[i + 1];
  }
  return [sx / n, sy / n];
}

describe("modelo mapa-esfera (equirectangular completo)", () => {
  it("pixel↔esfera: centro del mapa = (0°, 0°); arriba = polo norte", () => {
    expect(pixelToSphere(100, 50, 200, 100)).toEqual([0, 0]);
    expect(pixelToSphere(100, 0, 200, 100)[1]).toBe(90); // borde superior = polo norte
    expect(pixelToSphere(0, 50, 200, 100)).toEqual([-180, 0]);
    const [x, y] = sphereToPixel(0, 0, 200, 100);
    expect(x).toBeCloseTo(100, 9);
    expect(y).toBeCloseTo(50, 9);
  });

  it("sphereToPixel envuelve la longitud al antimeridiano", () => {
    // λ = 190° equivale a −170° → cerca del borde izquierdo
    const [x] = sphereToPixel(190, 0, 200, 100);
    expect(x).toBeCloseTo(((190 - 360 + 180) / 360) * 200, 6);
  });

  it("disco por defecto: celda central → centro de la imagen", () => {
    const img = dotImage(200, 200, 100, 100); // punto en el centro del mapa
    const [cx, cy] = centroid(img, kf());
    expect(Math.abs(cx - 100)).toBeLessThanOrEqual(4);
    expect(Math.abs(cy - 100)).toBeLessThanOrEqual(4);
  });

  it("disco: celdas fuera del hemisferio omitidas (radio = min(w,h)/2)", () => {
    // Ruido denso → bordes por todas partes; solo cabe el disco.
    const img = makeImageData(200, 200, (x, y) => [
      (x * 31 + y * 17) % 256,
      (x * 7 + y * 3) % 256,
      (x * 11 + y * 23) % 256,
    ]);
    const segs = generateStateSegments(img, sampling(), kf());
    expect(segs.length / 5).toBeGreaterThan(0);
    for (let i = 0; i < segs.length; i += 5) {
      const d = Math.hypot(segs[i] - 100, segs[i + 1] - 100);
      expect(d).toBeLessThanOrEqual(100 + 2); // radio del disco + medio paso
    }
  });
});

describe("signos de los 5 parámetros (capturas del usuario)", () => {
  // Punto de contenido al ESTE del centro del mapa (λ = +30° → px 116.7)
  const img = dotImage(200, 200, 117, 100);
  const base = centroid(img, kf());

  it("base: el punto aparece al ESTE del centro de pantalla", () => {
    expect(base[0]).toBeGreaterThan(104);
    expect(Math.abs(base[1] - 100)).toBeLessThanOrEqual(4);
  });

  it("longitudCentral +50 → el contenido se desplaza hacia el OESTE", () => {
    const [cx] = centroid(img, kf({ longitudCentral: 50 }));
    expect(cx).toBeLessThan(base[0] - 15);
  });

  it("paraleloEstandar +60 → el contenido se desplaza hacia el SUR", () => {
    const [, cy] = centroid(img, kf({ paraleloEstandar: 60 }));
    expect(cy).toBeGreaterThan(base[1] + 15);
  });

  it("paraleloEstandar +90 → el contenido central llega al borde inferior del disco", () => {
    // punto en el CENTRO del mapa: con ps=+90 debe caer en el borde (y ≈ 200)
    const imgCenter = dotImage(200, 200, 100, 100);
    const [, cy] = centroid(imgCenter, kf({ paraleloEstandar: 90 }));
    expect(cy).toBeGreaterThan(185); // junto al borde inferior (radio 100)
  });

  it("roll +90 → rotación en pantalla: el punto del este pasa al norte", () => {
    const [cx, cy] = centroid(img, kf({ roll: 90 }));
    expect(cy).toBeLessThan(base[1] - 10); // sube (norte)
    expect(Math.abs(cx - 100)).toBeLessThanOrEqual(8); // sale del eje horizontal
  });

  it("pitch +30 → el mapa sube: el contenido se desplaza al NORTE", () => {
    const [, cy] = centroid(img, kf({ pitch: 30 }));
    expect(cy).toBeLessThan(base[1] - 10);
  });

  it("yaw +30 → el mapa se desplaza al ESTE (derecha)", () => {
    const [cx] = centroid(img, kf({ yaw: 30 }));
    expect(cx).toBeGreaterThan(base[0] + 10);
  });
});

describe("órbita — 14 estados de segmentos (longitudes variables)", () => {
  const edgeImg = makeImageData(120, 90, (x) => (x <= 60 ? [0, 0, 0] : [255, 255, 255]));

  function params(overrides: Partial<AzimuthalParams> = {}): AzimuthalParams {
    return {
      ...sampling({ step: 10 }),
      maxVisibleRatio: 1,
      keyframes: [kf(), kf({ roll: 90 }), kf()],
      ...overrides,
    };
  }

  it("14 frames, cada uno %5===0, y determinismo (doble corrida idéntica)", () => {
    const a = generateFrames(edgeImg, params());
    expect(a.frames).toHaveLength(FRAME_COUNT);
    for (const f of a.frames) expect(f.length % 5).toBe(0);
    const b = generateFrames(edgeImg, params());
    expect(b.frames).toEqual(a.frames);
    expect(b.keyframes).toEqual(a.keyframes);
  });

  it("la deformación cambia los segmentos entre estados (roll 90° ≠ identidad)", () => {
    const { frames } = generateFrames(edgeImg, params());
    expect(frames[0]).not.toEqual(frames[7]);
  });

  it("los keyframes de salida van de k1 (estado 0) a k3 (estado 13)", () => {
    const k3 = kf({ yaw: 45, pitch: 10, longitudCentral: -30 });
    const { keyframes } = generateFrames(
      edgeImg,
      params({ keyframes: [kf(), kf({ roll: 90 }), k3] })
    );
    expect(keyframes).toHaveLength(FRAME_COUNT);
    expect(keyframes[0]).toEqual(kf());
    const last = keyframes[FRAME_COUNT - 1];
    expect(last.yaw).toBeCloseTo(k3.yaw, 1);
    expect(last.paraleloEstandar).toBeCloseTo(k3.paraleloEstandar, 1);
  });

  it("interpolación por camino corto en los 5 ángulos (wrap)", () => {
    const mid = interpolateKeyframes(kf({ yaw: 170 }), kf({ yaw: -170 }), 0.5);
    expect(mid.yaw).toBe(180);
    const mid2 = interpolateKeyframes(kf({ longitudCentral: -40 }), kf({ longitudCentral: 40 }), 0.5);
    expect(mid2.longitudCentral).toBe(0);
  });
});

describe("editor — herencia de keyframes y aviso de vista casi vacía", () => {
  it("frame 2/3 sin tocar heredan los valores del frame anterior; frame 1 abre en 0", () => {
    let state: {
      keyframes: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe];
      touched: [boolean, boolean, boolean];
    } = {
      keyframes: [kf(), kf(), kf()],
      touched: [false, false, false],
    };
    // editamos frame 1 (longitudCentral = 30)
    state.keyframes[0] = kf({ longitudCentral: 30 });
    state.touched[0] = true;
    // activamos frame 2 por primera vez → hereda frame 1
    state = activateKeyframeTab(state.keyframes, state.touched, 1);
    expect(state.keyframes[1].longitudCentral).toBe(30);
    expect(state.touched[1]).toBe(true);
    // activamos frame 3 → hereda frame 2 (que heredó de 1)
    state.keyframes[1] = { ...state.keyframes[1], roll: 45 };
    state = activateKeyframeTab(state.keyframes, state.touched, 2);
    expect(state.keyframes[2].longitudCentral).toBe(30);
    expect(state.keyframes[2].roll).toBe(45);
  });

  it("una vez tocado, un frame NO vuelve a heredar al reactivarse", () => {
    const k: [AzimuthalKeyframe, AzimuthalKeyframe, AzimuthalKeyframe] = [
      kf({ longitudCentral: 30 }),
      kf({ longitudCentral: 60 }),
      kf(),
    ];
    const t: [boolean, boolean, boolean] = [true, true, false];
    // reactivar frame 2 (ya tocado) no cambia nada
    const r = activateKeyframeTab(k, t, 1);
    expect(r.keyframes[1].longitudCentral).toBe(60);
    expect(r.touched).toEqual(t);
  });

  it("vistaCasiVacia: aviso discreto bajo 20 trazos (no bloqueo)", () => {
    expect(vistaCasiVacia(0)).toBe(true);
    expect(vistaCasiVacia(19)).toBe(true);
    expect(vistaCasiVacia(20)).toBe(false);
    expect(vistaCasiVacia(500)).toBe(false);
  });

  it("imagen plana → 0 trazos → 'vista casi vacía'", () => {
    const img = makeImageData(100, 100, () => [120, 120, 120]);
    const segs = generateStateSegments(img, sampling(), kf());
    expect(segs).toHaveLength(0);
    expect(vistaCasiVacia(segs.length / 5)).toBe(true);
  });

  it("la longitud crece con m (borde fuerte = maxLength)", () => {
    // La vista por defecto mira el CENTRO DEL MAPA (λ=0°,φ=0° → pixel 60,45
    // en un lienzo 120×90): el escalón fuente va ahí. Rampa suave a la
    // derecha (cols 76..80).
    const img = makeImageData(120, 90, (x) => {
      const v =
        x <= 60 ? 0 : x <= 75 ? 255 : x <= 80 ? Math.round(((80 - x) / 4) * 255) : 0;
      return [v, v, v];
    });
    const field = borderField(img);
    const mStrong = sampleField(field, 60.5, 45.5).m;
    expect(mStrong).toBe(1);
    const segs = generateStateSegments(img, sampling({ step: 1, maxLength: 10 }), kf());
    const lenAt = (screenX: number) => {
      for (let i = 0; i < segs.length; i += 5) {
        if (Math.abs(segs[i] - screenX) <= 0.6 && Math.abs(segs[i + 1] - 45.5) <= 0.6) {
          return segs[i + 3];
        }
      }
      return null;
    };
    // El escalón fuente está en el centro del mapa → se dibuja en el centro
    // de la pantalla (con m = 1 → len = maxLength).
    expect(lenAt(60.5)).toBe(10);
    // La rampa fuente (pixel 78 → λ ≈ +54°) se DIBUJA desplazada: pantalla
    // x ≈ 60 + λ·(min/2)/180 ≈ 87. Su len sigue la fórmula con su m fuente.
    const mSoft = sampleField(field, 78.5, 45.5).m;
    expect(mSoft).toBeGreaterThan(0.15);
    expect(mSoft).toBeLessThan(1);
    const softLens: number[] = [];
    for (let x = 86; x <= 90; x += 1) {
      const l = lenAt(x);
      if (l !== null) softLens.push(l);
    }
    expect(softLens.length).toBeGreaterThan(0);
    // La longitud crece con m: el borde blando da trazos MÁS CORTOS que el
    // fuerte (maxLength) y dentro del rango de la fórmula [0.4·L, L). La
    // fórmula exacta se comprueba con el borde fuerte (m = 1 → 10); aquí la
    // distorsión de la proyección desplaza ligeramente el punto fuente.
    for (const l of softLens) {
      expect(l).toBeLessThan(10);
      expect(l).toBeGreaterThanOrEqual(4); // 0.4 · maxLength
    }
    expect(Math.max(...softLens)).toBeLessThan(10);
  });
});
