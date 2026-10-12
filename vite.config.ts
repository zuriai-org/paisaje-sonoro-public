import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Proxy del backend de demo (server/, puerto 8787): el frontend habla en
  // mismo origen, sin CORS abierto.
  server: {
    proxy: {
      // changeOrigin: false → se preserva el Host original (:5173), de modo
      // que el backend (CORS de mismo origen) ve Origin y Host coincidentes.
      "/api": { target: "http://localhost:8787", changeOrigin: false },
      "/uploads": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"],
  },
});
