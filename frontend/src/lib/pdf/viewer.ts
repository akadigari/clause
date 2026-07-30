/**
 * The pdf.js side of the app: turning a PDF into pixels and into text.
 *
 * pdf-lib writes PDFs but cannot draw them, and pdf.js draws them but cannot
 * write them. So the two libraries split the job: this file is everything
 * pdf.js does, and lib/pdf/ops/* is everything pdf-lib does.
 *
 * pdf.js is about a megabyte, so it is imported on demand. The bench renders
 * and the drop target works before it has finished loading.
 */

import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";

// Vite turns this into a URL for an emitted asset, which is the setup that
// survives being served from a GitHub Pages subpath. Pointing workerSrc at a
// CDN would work too, and would also mean every page load phoned a third
// party, which is exactly what this app promises not to do.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfjsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfjsModule> | null = null;

/** Load pdf.js once and point it at the bundled worker. */
export function pdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
  }
  return modulePromise;
}

export type { PDFDocumentProxy, PDFPageProxy };

/**
 * Where pdf.js fetches its runtime assets from.
 *
 * These are copied into public/pdfjs by scripts/copy-pdfjs-assets.mjs, so they
 * come from this same site. Every pdf.js tutorial points these at a CDN
 * instead, which would mean opening a document quietly contacted a third
 * party. Without them set at all, pdf.js falls back to guessing and any
 * document using one of the 14 built-in fonts renders with wrong glyphs.
 *
 * BASE_URL keeps this correct whether the site is served from a domain root or
 * from a project subpath.
 */
const ASSETS = {
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
  iccUrl: `${import.meta.env.BASE_URL}pdfjs/iccs/`,
};

/**
 * An open document, plus the handle that shuts it down.
 *
 * `doc.destroy()` does not exist. Tearing a document down means destroying the
 * loading task, which is what aborts its requests and terminates its worker.
 * Dropping the proxy and hoping leaks a worker thread for every file opened,
 * and a long session then runs out of memory for reasons that look unrelated.
 */
export type OpenPdf = {
  doc: PDFDocumentProxy;
  close(): Promise<void>;
};

/**
 * Open a PDF for viewing.
 *
 * pdf.js takes ownership of the array it is given and detaches it when the
 * worker takes over, which silently turns the caller's copy into a zero length
 * array. The failure surfaces much later as "No PDF header found", which looks
 * like a corrupt file rather than a lifetime bug, so this always hands over a
 * fresh copy.
 */
export async function openForViewing(data: Uint8Array): Promise<OpenPdf> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(data),
    // Many real files carry an empty owner password that only marks them as
    // "do not edit". Try to show those rather than refusing.
    password: "",
    // Let the file's own embedded fonts render, but never reach out to the
    // host system to substitute one.
    disableFontFace: false,
    useSystemFonts: false,
    ...ASSETS,
  });
  const doc = await task.promise;
  return {
    doc,
    async close() {
      try {
        await task.destroy();
      } catch {
        /* already torn down */
      }
    },
  };
}

export type RenderHandle = {
  /** Resolves when the page has finished painting. */
  done: Promise<void>;
  cancel(): void;
};

/**
 * Draw a page onto a canvas at a given zoom.
 *
 * The canvas gets sized in device pixels and laid out in CSS pixels, so a
 * page is sharp on a retina screen without every coordinate in the app having
 * to know about devicePixelRatio.
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
  maxPixelRatio = 2,
): RenderHandle {
  const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
  const viewport = page.getViewport({ scale: zoom * ratio });
  const cssViewport = page.getViewport({ scale: zoom });

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  canvas.style.height = `${Math.floor(cssViewport.height)}px`;

  let task: RenderTask | null = null;
  const done = (async () => {
    task = page.render({ canvas, viewport });
    try {
      await task.promise;
    } catch (err) {
      // Flipping pages faster than they paint cancels the previous render.
      // That is the system working, not a failure.
      if (isCancelled(err)) return;
      throw err;
    }
  })();

  return {
    done,
    cancel() {
      task?.cancel();
    },
  };
}

export function isCancelled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "RenderingCancelledException"
  );
}

/** The size a page paints at, in CSS pixels, for a given zoom. */
export function pageViewSize(
  page: PDFPageProxy,
  zoom = 1,
): { width: number; height: number } {
  const viewport = page.getViewport({ scale: zoom });
  return { width: viewport.width, height: viewport.height };
}

/**
 * Render a page into an image.
 *
 * This is the workhorse behind three features that all need the same thing:
 * exporting pages as PNG or JPEG, shrinking a file by flattening it, and
 * redacting text by destroying it. `dpi` is real dots per inch, so 150 means
 * a Letter page comes out 1275 pixels wide.
 */
export async function renderPageToBlob(
  page: PDFPageProxy,
  options: {
    dpi?: number;
    type?: "image/png" | "image/jpeg";
    quality?: number;
    /** Painted under the page. JPEG has no transparency, so it needs one. */
    background?: string;
    /** Drawn on top of the finished page, in canvas pixels. */
    overpaint?: (ctx: CanvasRenderingContext2D, scale: number) => void;
  } = {},
): Promise<Blob> {
  const {
    dpi = 150,
    type = "image/png",
    quality = 0.82,
    background = "#ffffff",
    overpaint,
  } = options;

  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const ctx = canvas.getContext("2d", { alpha: type === "image/png" });
  if (!ctx) throw new Error("This browser would not give us a canvas to draw on.");

  if (type === "image/jpeg" || background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  await page.render({ canvas, viewport }).promise;
  overpaint?.(ctx, scale);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
  // Large canvases hold onto memory until they are collected. Zeroing the size
  // releases the backing store now, which matters when this runs in a loop
  // over a few hundred pages.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("The browser could not turn that page into an image.");
  return blob;
}

/** A single run of text on a page, positioned in view space. */
export type TextPiece = {
  str: string;
  /** Left edge, in points from the left of the page as displayed. */
  x: number;
  /** Top edge, in points from the top of the page as displayed. */
  y: number;
  width: number;
  height: number;
  /** Font size in points, before any horizontal squeeze. */
  fontSize: number;
  /** How much the font is stretched sideways, for the CSS text layer. */
  squeeze: number;
  hasEOL: boolean;
  /**
   * Where this run starts in the string pageText() builds for the same page.
   *
   * Carrying the offset rather than letting the caller re-derive it is the
   * whole reason citations land on the right words. The two functions have to
   * agree on the count exactly, and a caller walking the list itself has no
   * way to see the runs that were dropped for having no text but that still
   * contributed a line break.
   */
  start: number;
  end: number;
};

/**
 * Every run of text on a page with its position.
 *
 * pdf.js hands back a transform matrix per run: [a, b, c, d, e, f]. With a
 * viewport at scale 1 and no rotation, e and f are the baseline origin and
 * the vertical scale is the font size. The baseline sits at the bottom of the
 * text, so the top edge is one font size above it.
 */
export async function pageTextPieces(page: PDFPageProxy): Promise<TextPiece[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces: TextPiece[] = [];
  // Must advance by exactly the same rule pageText() uses, including for runs
  // that carry no text of their own. pdf.js emits empty runs to mark line
  // breaks, and each one still contributes its newline to the page string.
  let offset = 0;

  for (const item of content.items) {
    if (!("str" in item)) continue; // a marked-content boundary, not text
    const start = offset;
    offset += item.str.length + (item.hasEOL ? 1 : 0);

    const transform = item.transform as number[];
    const a = transform[0] ?? 0;
    const b = transform[1] ?? 0;
    const c = transform[2] ?? 0;
    const d = transform[3] ?? 0;
    const e = transform[4] ?? 0;
    const f = transform[5] ?? 0;

    // Push the baseline origin through the viewport so rotation and the
    // page's own box offset are already accounted for.
    const [vx, vy] = viewport.convertToViewportPoint(e, f) as [number, number];
    const fontSize = Math.hypot(b, d) || Math.abs(d) || item.height || 0;
    const stretch = Math.hypot(a, c) || Math.abs(a) || 0;

    // An empty run has nothing to draw and nothing to select, so it is not
    // rendered. Its length was already counted above, which is the part that
    // matters.
    if (!item.str) continue;
    pieces.push({
      str: item.str,
      x: vx,
      y: vy - fontSize,
      width: item.width,
      height: item.height || fontSize,
      fontSize,
      squeeze: fontSize > 0 && stretch > 0 ? stretch / fontSize : 1,
      hasEOL: item.hasEOL,
      start,
      end: start + item.str.length,
    });
  }

  return pieces;
}

/**
 * A page's text as one string, in reading order, with the line breaks the
 * layout implies.
 *
 * The Clause engine indexes this string and cites character ranges inside it,
 * so it has to be built the same way every time. Runs are joined with nothing
 * between them unless pdf.js says a line ended, which keeps words that were
 * split across runs intact.
 */
export async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let out = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out;
}

/**
 * Sample a rendered canvas to catch the case where it came out blank.
 *
 * Browsers have a per-canvas area cap, and iOS also caps the total canvas
 * memory a tab may hold. Going past either can produce a canvas that is
 * silently empty rather than an error. That is merely annoying for a
 * thumbnail, and dangerous for redaction, where an all-white page looks like a
 * successful result. Anything that rasterizes for real must check.
 */
export function looksBlank(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return true;
  const spots: Array<[number, number]> = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
    [0.75, 0.25],
    [0.5, 0.2],
    [0.5, 0.8],
  ];
  for (const [fx, fy] of spots) {
    const x = Math.min(canvas.width - 1, Math.floor(canvas.width * fx));
    const y = Math.min(canvas.height - 1, Math.floor(canvas.height * fy));
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    if (r !== 255 || g !== 255 || b !== 255) return false;
  }
  return true;
}

/** Text for every page, in order. Yields between pages so the tab stays alive. */
export async function allPageText(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    out.push(await pageText(page));
    // Deliberately no page.cleanup() here. pdf.js hands back the same page
    // object to everyone who asks for that page number, so cleaning up a page
    // this loop is finished with also throws away the text and glyphs the
    // viewer is still holding. The whole document is torn down together when
    // it closes, which is where the memory actually goes back.
    onProgress?.(n, doc.numPages);
    if (n % 8 === 0) await yieldToBrowser();
  }
  return out;
}

/**
 * Hand control back to the browser so it can paint and handle input.
 *
 * Anything that loops over pages must call this. Without it a 400 page
 * document locks the tab, and the user cannot even cancel.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
