import { describe, expect, it } from "vitest";
import { PIECE_TITLE_MAX, validatePieceTitle } from "./pieces";

/**
 * Validación del título de la pieza (F1 2026-10-11): POST /api/piece lo
 * exige (1–120 caracteres tras recortar; 400 si vacío/ausente). El validador
 * es puro y exportado para testearlo sin levantar el servidor.
 */
describe("validatePieceTitle", () => {
  it("rechaza lo que no es string", () => {
    expect(validatePieceTitle(undefined)).toBeNull();
    expect(validatePieceTitle(null)).toBeNull();
    expect(validatePieceTitle(123)).toBeNull();
    expect(validatePieceTitle(["t"])).toBeNull();
    expect(validatePieceTitle({ title: "t" })).toBeNull();
  });

  it("rechaza vacío y solo espacios", () => {
    expect(validatePieceTitle("")).toBeNull();
    expect(validatePieceTitle("   ")).toBeNull();
    expect(validatePieceTitle("\n\t ")).toBeNull();
  });

  it("acepta 1–120 caracteres y devuelve el título recortado", () => {
    expect(validatePieceTitle("A")).toBe("A");
    expect(validatePieceTitle("  Retrato sonoro  ")).toBe("Retrato sonoro");
    expect(PIECE_TITLE_MAX).toBe(120);
    expect(validatePieceTitle("x".repeat(120))).toBe("x".repeat(120));
  });

  it("rechaza más de 120 caracteres", () => {
    expect(validatePieceTitle("x".repeat(121))).toBeNull();
    // el recorte va antes de medir: 121 con espacios alrededor sigue > 120
    expect(validatePieceTitle(" " + "x".repeat(121) + " ")).toBeNull();
  });
});
