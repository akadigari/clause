/**
 * Getting a finished file out of the tab.
 *
 * Two ways exist. `showSaveFilePicker` opens the real system save dialog, so
 * the file goes where the user chose with the name they chose. Browsers that
 * do not have it fall back to a link click, which drops the file in the
 * downloads folder. The picker is tried first because being asked where to put
 * something is the behaviour people expect from a tool that edits their files.
 *
 * Both paths are entirely local. A download is the browser writing to disk,
 * not a transfer, so nothing here touches the network.
 */

import { safeName } from "./format";

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable(): Promise<{
      write(data: BufferSource | Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
};

const KINDS: Record<string, { description: string; extension: string }> = {
  "application/pdf": { description: "PDF document", extension: ".pdf" },
  "application/zip": { description: "Zip archive", extension: ".zip" },
  "image/png": { description: "PNG image", extension: ".png" },
  "image/jpeg": { description: "JPEG image", extension: ".jpg" },
  "text/plain": { description: "Text file", extension: ".txt" },
};

/**
 * Save a blob, asking where if the browser allows it.
 *
 * Returns false when the user cancelled the dialog, so a caller can stay quiet
 * instead of announcing a save that did not happen.
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<boolean> {
  const name = safeName(fileName);
  const picker = (window as PickerWindow).showSaveFilePicker;

  if (picker) {
    const kind = KINDS[blob.type] ?? { description: "File", extension: "" };
    try {
      const handle = await picker({
        suggestedName: name,
        types: [
          {
            description: kind.description,
            accept: { [blob.type || "application/octet-stream"]: [kind.extension] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      // A cancelled dialog throws AbortError, which is not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return false;
      // Anything else means the picker is unavailable in this context, such as
      // inside a sandboxed frame. Fall through to the link.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export function savePdfBytes(bytes: Uint8Array, fileName: string): Promise<boolean> {
  const copy = new Uint8Array(bytes);
  return saveBlob(new Blob([copy.buffer as ArrayBuffer], { type: "application/pdf" }), fileName);
}

export function saveText(text: string, fileName: string): Promise<boolean> {
  return saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), fileName);
}
