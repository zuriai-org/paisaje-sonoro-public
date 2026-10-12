import { describe, it, expect } from "vitest";
import {
  logBandEdges,
  assignBinsToBands,
  bandEnergies,
  partitionPointsByBand,
  pointBandEnergy,
  veiledOpacity,
  createBandNormalizers,
  resetBandNormalizers,
  normalizeBand,
  MIN_HZ,
  MAX_HZ,
} from "./spectrum";

describe("logBandEdges (bordes logarítmicos)", () => {
  it("devuelve bands+1 bordes dentro del rango [60 Hz, 10 kHz]", () => {
    for (const bands of [2, 3, 6, 12]) {
      const edges = logBandEdges(bands);
      expect(edges).toHaveLength(bands + 1);
      expect(edges[0]).toBeCloseTo(MIN_HZ, 6);
      expect(edges[bands]).toBeCloseTo(MAX_HZ, 6);
      for (const e of edges) {
        expect(e).toBeGreaterThanOrEqual(MIN_HZ - 1e-9);
        expect(e).toBeLessThanOrEqual(MAX_HZ + 1e-9);
      }
    }
  });

  it("es estrictamente monótona creciente", () => {
    const edges = logBandEdges(6);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1]);
    }
  });

  it("espaciado logarítmico: ratio entre bordes consecutivos aprox. constante", () => {
    const edges = logBandEdges(6);
    const r0 = edges[1] / edges[0];
    for (let i = 2; i < edges.length; i++) {
      expect(edges[i] / edges[i - 1]).toBeCloseTo(r0, 6);
    }
    // 6 bandas octavables: ratio ≈ (10000/60)^(1/6) ≈ 2.35
    expect(r0).toBeCloseTo(Math.pow(MAX_HZ / MIN_HZ, 1 / 6), 3);
  });
});

describe("assignBinsToBands", () => {
  it("asigna todos los bins a bandas válidas, de forma monótona", () => {
    const binCount = 1024; // fftSize 2048 → frequencyBinCount
    const map = assignBinsToBands(6, binCount, 48000);
    expect(map).toHaveLength(binCount);
    expect(map[0]).toBe(0); // ~0 Hz → graves
    expect(map[binCount - 1]).toBe(5); // ~23 kHz → agudos
    for (let i = 1; i < binCount; i++) {
      expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]); // monótona
      expect(map[i]).toBeGreaterThanOrEqual(0);
      expect(map[i]).toBeLessThan(6);
    }
  });

  it("acepta bordes EXPLÍCITOS del documento (v2 posterizado: 60–200–1000–4000–10000)", () => {
    const edges = [60, 200, 1000, 4000, 10000];
    const map = assignBinsToBands(4, 1024, 48000, edges);
    const binAt = (hz: number) => Math.floor((hz * 1024) / 24000);
    expect(map[binAt(100)]).toBe(0);   // 60–200
    expect(map[binAt(500)]).toBe(1);   // 200–1000
    expect(map[binAt(2000)]).toBe(2);  // 1000–4000
    expect(map[binAt(8000)]).toBe(3);  // 4000–10000
    // Fuera del rango: clampa a los extremos.
    expect(map[binAt(30)]).toBe(0);
    expect(map[binAt(15000)]).toBe(3);
  });

  it("bordes con longitud incorrecta se ignoran y usa los logarítmicos por defecto", () => {
    const mapDefault = assignBinsToBands(6, 1024, 48000);
    const mapBad = assignBinsToBands(6, 1024, 48000, [60, 10000]); // 2 ≠ 6+1
    expect([...mapBad]).toEqual([...mapDefault]);
  });

  it("los bordes caen donde deben: ~1 kHz en banda media (775–1817 Hz)", () => {
    // 6 bandas log 60–10000: 60, 141, 330, 775, 1817, 4264, 10000
    // → 1 kHz ≈ bin 42 @48k → banda 3
    const map = assignBinsToBands(6, 1024, 48000);
    const bin1k = Math.floor((1000 * 1024) / 24000);
    expect(map[bin1k]).toBe(3);
  });
});

describe("bandEnergies", () => {
  it("energía de banda = promedio de sus bins / 255", () => {
    const binToBand = new Uint8Array([0, 0, 1, 1]);
    const freq = new Uint8Array([255, 255, 0, 0]);
    const e = bandEnergies(freq, binToBand, 2);
    expect(e[0]).toBe(1); // 255/255
    expect(e[1]).toBe(0);
  });
});

describe("partitionPointsByBand (franjas verticales)", () => {
  it("asigna cada punto exactamente una vez (graves izq → agudos der)", () => {
    const bands = 4;
    const width = 400;
    // 8 puntos con x = 0, 50, 100, …, 350 (width 400, 4 franjas de 100 px)
    const points: number[] = [];
    for (let i = 0; i < 8; i++) points.push(i * 50, 0, 3, 0);
    const parts = partitionPointsByBand(points, width, bands);
    const all = parts.flat();
    expect(all.length).toBe(8);
    expect([...all].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Franjas: x 0–99 → banda 0 (2 pts), 100–199 → 1 (2), 200–299 → 2 (2), 300+ → 3 (2)
    expect(parts.map((p) => p.length)).toEqual([2, 2, 2, 2]);
    expect(parts[0]).toEqual([0, 1]);
    expect(parts[3]).toEqual([6, 7]);
  });

  it("clampa x = width a la última banda", () => {
    const points = [400, 0, 3, 0, 399, 0, 3, 0];
    const parts = partitionPointsByBand(points, 400, 4);
    expect(parts[3].sort()).toEqual([0, 1]);
  });

  it("admite bandas vacías sin romperse", () => {
    const points = [0, 0, 3, 0, 10, 0, 3, 0];
    const parts = partitionPointsByBand(points, 1000, 6);
    expect(parts[0]).toEqual([0, 1]);
    expect(parts.slice(1).every((p) => p.length === 0)).toBe(true);
  });
});

describe("pointBandEnergy (interpolación de bordes entre franjas)", () => {
  const bands = 3;
  const width = 600; // franjas de 200 px: [0,200), [200,400), [400,600]
  const energies = [0.2, 0.8, 0.5];
  const transitionPx = 30; // ≈ 1.5 celdas de step = 20

  it("lejos de los bordes devuelve la energía pura de su banda", () => {
    expect(pointBandEnergy(50, width, bands, energies, transitionPx)).toBeCloseTo(0.2);
    expect(pointBandEnergy(300, width, bands, energies, transitionPx)).toBeCloseTo(0.8);
    expect(pointBandEnergy(550, width, bands, energies, transitionPx)).toBeCloseTo(0.5);
  });

  it("en el borde exacto devuelve la media de las dos bandas vecinas", () => {
    expect(pointBandEnergy(200, width, bands, energies, transitionPx)).toBeCloseTo(
      (0.2 + 0.8) / 2
    );
    expect(pointBandEnergy(400, width, bands, energies, transitionPx)).toBeCloseTo(
      (0.8 + 0.5) / 2
    );
  });

  it("interpola de forma suave dentro de la zona de transición", () => {
    // x=190: a 10 px del borde 200 (zona de 30 px) → mezcla parcial suave.
    const near = pointBandEnergy(190, width, bands, energies, transitionPx);
    expect(near).toBeGreaterThan(0.2);
    expect(near).toBeLessThan(0.5);
    // A más distancia del borde, más se acerca a la energía pura de su banda.
    const mid = pointBandEnergy(185, width, bands, energies, transitionPx);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(near);
  });

  it("la energía interpolada nunca sale del rango de las dos bandas vecinas", () => {
    const lo = Math.min(...energies);
    const hi = Math.max(...energies);
    for (let x = 0; x <= width; x += 7) {
      const v = pointBandEnergy(x, width, bands, energies, transitionPx);
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it("los bordes externos no mezclan (clampa a la banda extrema)", () => {
    expect(pointBandEnergy(0, width, bands, energies, transitionPx)).toBeCloseTo(0.2);
    expect(pointBandEnergy(600, width, bands, energies, transitionPx)).toBeCloseTo(0.5);
  });

  it("con transición 0 devuelve siempre la banda pura (sin mezcla)", () => {
    expect(pointBandEnergy(200, width, bands, energies, 0)).toBeCloseTo(0.8);
    expect(pointBandEnergy(400, width, bands, energies, 0)).toBeCloseTo(0.5);
  });
});

describe("veiledOpacity (velo de opacidad por banda/peak)", () => {
  it("veil=0 → siempre maxOpacity, con cualquier energía", () => {
    expect(veiledOpacity(0, 0, 0.7)).toBeCloseTo(0.7);
    expect(veiledOpacity(0.3, 0, 0.7)).toBeCloseTo(0.7);
    expect(veiledOpacity(1, 0, 0.7)).toBeCloseTo(0.7);
  });

  it("veil=1 → opacity = maxOpacity · energía (velo total)", () => {
    expect(veiledOpacity(0, 1, 0.7)).toBeCloseTo(0);
    expect(veiledOpacity(0.5, 1, 0.7)).toBeCloseTo(0.35);
    expect(veiledOpacity(1, 1, 0.7)).toBeCloseTo(0.7);
  });

  it("veil=0.35 → silencio al 65 % y pico al 100 % (de maxOpacity)", () => {
    expect(veiledOpacity(0, 0.35, 1)).toBeCloseTo(0.65);
    expect(veiledOpacity(1, 0.35, 1)).toBeCloseTo(1);
    expect(veiledOpacity(0, 0.35, 0.7)).toBeCloseTo(0.7 * 0.65);
  });

  it("valor intermedio: acotado entre maxOpacity·(1−veil) y maxOpacity", () => {
    for (const e of [0, 0.1, 0.42, 0.77, 1]) {
      const op = veiledOpacity(e, 0.35, 0.7);
      expect(op).toBeGreaterThanOrEqual(0.7 * 0.65 - 1e-9);
      expect(op).toBeLessThanOrEqual(0.7 + 1e-9);
      // Monótona creciente en la energía: más energía → menos velo.
      if (e > 0) {
        expect(op).toBeGreaterThanOrEqual(veiledOpacity(e - 0.1, 0.35, 0.7) - 1e-9);
      }
    }
  });

  it("clampa energía y veil fuera de rango", () => {
    expect(veiledOpacity(1.5, 0.5, 1)).toBeCloseTo(1); // energía > 1 → plena
    expect(veiledOpacity(-0.2, 0.5, 1)).toBeCloseTo(0.5); // energía < 0 → velo de silencio
    expect(veiledOpacity(0.5, 2, 1)).toBeCloseTo(0.5); // veil > 1 → como veil=1
    expect(veiledOpacity(0.5, -1, 1)).toBeCloseTo(1); // veil < 0 → sin velo
  });
});

describe("normalización por banda (misma semántica que la de amplitud)", () => {
  it("el máximo histórico de cada banda escala a 1, con runningMax propio", () => {
    const bn = createBandNormalizers(3);
    // Banda 1 ve energía constante alta; banda 0 silencio
    for (let i = 0; i < 500; i++) {
      bn.smooth[1] = normalizeBand(0.3, bn.states[1]);
      bn.smooth[0] = normalizeBand(0.001, bn.states[0]);
    }
    expect(bn.smooth[1]).toBe(1); // su máximo histórico = 1.0
    expect(bn.smooth[0]).toBeLessThan(0.05); // piso 0.08: no amplifica ruido
    expect(bn.states[1].runningMax).toBeCloseTo(0.3, 2);
    expect(bn.states[0].runningMax).toBeLessThan(0.08);
  });

  it("resetBandNormalizers reinicia runningMax y suavizado de todas las bandas", () => {
    const bn = createBandNormalizers(4);
    for (let i = 0; i < 100; i++) {
      bn.smooth[2] = normalizeBand(0.5, bn.states[2]);
    }
    expect(bn.states[2].runningMax).toBeGreaterThan(0.4);
    resetBandNormalizers(bn);
    expect(bn.states[2].runningMax).toBe(0);
    expect(bn.smooth[2]).toBe(0);
    expect(bn.states).toHaveLength(4);
  });
});
