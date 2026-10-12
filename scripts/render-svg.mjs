/**
 * Render de un SVG a PNG con Chrome headless (evidencia visual del trazado).
 * Uso: node scripts/render-svg.mjs <entrada.svg> <salida.png> [anchoPx]
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const [svgPath, outPath, wStr] = process.argv.slice(2);
if (!svgPath || !outPath) {
  console.error("Uso: node scripts/render-svg.mjs <entrada.svg> <salida.png> [anchoPx]");
  process.exit(1);
}
const width = Number(wStr) || 900;

const svg = fs.readFileSync(svgPath, "utf8");
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "shell",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: Math.round(width * 1.2) });
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
    { waitUntil: "load" }
  );
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`${svgPath} → ${outPath}`);
} finally {
  await browser.close();
}
