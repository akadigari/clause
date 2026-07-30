/**
 * Copy pdf.js runtime assets into public/ so they are served from this site.
 *
 * pdf.js does not bundle these. It fetches them at runtime, and only when a
 * document actually needs one:
 *
 *   standard_fonts  the 14 fonts every PDF is allowed to reference without
 *                   embedding. Without these, any document using Helvetica or
 *                   Times renders with the wrong glyph shapes, and pdf.js logs
 *                   a warning for every text run.
 *   cmaps           character maps for CJK documents.
 *   wasm            decoders for JBIG2 and JPEG 2000 images, which show up in
 *                   scanned documents.
 *
 * The alternative is pointing pdf.js at a CDN, which is what most tutorials do.
 * That would mean opening a document quietly fetched files from a third party,
 * which is the one thing this app promises never to happen. So they are copied
 * here and served from the same origin as everything else.
 *
 * Runs before dev and before build. The copies are gitignored: they are build
 * output, not source.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

const DIRS = ["standard_fonts", "cmaps", "wasm", "iccs"];

if (!existsSync(from)) {
  console.error("[clause] pdfjs-dist is not installed. Run npm install first.");
  process.exit(1);
}

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });

for (const dir of DIRS) {
  const source = join(from, dir);
  if (!existsSync(source)) {
    console.warn(`[clause] pdfjs-dist has no ${dir}/, skipping it`);
    continue;
  }
  await cp(source, join(to, dir), { recursive: true });
}

console.log(`[clause] copied pdf.js assets into public/pdfjs (${DIRS.join(", ")})`);
