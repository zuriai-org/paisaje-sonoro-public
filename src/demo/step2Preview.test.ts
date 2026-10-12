import { describe, it, expect } from "vitest";
import { step2PreviewJsonUrl } from "./step2Preview";

describe("step2PreviewJsonUrl (regresión: vista previa reactiva al imageId)", () => {
  it("sin imageId no hay vista previa (null)", () => {
    expect(step2PreviewJsonUrl(null)).toBeNull();
  });

  it("con imageId apunta al JSON subido al backend", () => {
    expect(step2PreviewJsonUrl("abc123")).toBe("/uploads/image/abc123.json");
  });

  it("cambiar de imageId cambia la URL (el player refetchea por jsonUrl)", () => {
    const a = step2PreviewJsonUrl("imagen-A");
    const b = step2PreviewJsonUrl("imagen-B");
    expect(a).not.toBe(b);
    expect(b).toBe("/uploads/image/imagen-B.json");
  });
});
