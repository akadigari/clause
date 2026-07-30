import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Relative base so the same build works from a GitHub Pages subpath
// (akadigari.github.io/clause/), from a custom domain root, and from
// a file:// copy someone downloaded to use offline.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    // pdf.js and pdf-lib are both large. Splitting them keeps the first paint
    // small: the bench renders before either library has finished loading.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/pdfjs-dist")) return "pdfjs";
          if (id.includes("node_modules/pdf-lib") || id.includes("@pdf-lib/fontkit")) {
            return "pdflib";
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
