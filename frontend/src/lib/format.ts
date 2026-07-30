/** Small formatters. Numbers in this app are always shown in the mono face,
 *  so these return plain strings and the caller adds the `num` class. */

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** How much smaller (or larger) a result got, as a signed percentage. */
export function delta(before: number, after: number): string {
  if (before <= 0) return "";
  const pct = ((after - before) / before) * 100;
  const rounded = Math.abs(pct) < 0.5 ? 0 : Math.round(pct);
  if (rounded === 0) return "no change";
  return rounded < 0 ? `${rounded}%` : `+${rounded}%`;
}

/** PDF points to millimetres, for the status bar. 1 pt = 1/72 inch. */
export function mm(points: number): number {
  return Math.round((points / 72) * 25.4);
}

export function inches(points: number): string {
  return (points / 72).toFixed(2);
}

/**
 * Page numbers are padded to the width of the stack, so a 9 page document
 * shows "3" and a 300 page document shows "003". The padding is not
 * decoration: it tells you how big the document is at a glance.
 */
export function pageNo(index: number, total: number): string {
  const width = String(total).length;
  return String(index + 1).padStart(width, "0");
}

/** "1, 3, 4, 5, 9" becomes "1, 3-5, 9". Used wherever a selection is shown. */
export function ranges(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  if (sorted.length === 0) return "none";
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current !== undefined && current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    if (current === undefined) break;
    start = current;
    prev = current;
  }
  return parts.join(", ");
}

/**
 * Parse what someone typed into a page range box: "1-3, 7, 9-" against a
 * 12 page document gives [0,1,2,6,8,9,10,11]. Returns page indexes, not
 * page numbers. Anything out of range is dropped rather than clamped, so a
 * typo shows up as a smaller selection instead of a silently wrong one.
 */
export function parseRanges(input: string, total: number): number[] {
  const out = new Set<number>();
  for (const rawPart of input.split(/[,;]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.toLowerCase() === "all") {
      for (let i = 0; i < total; i++) out.add(i);
      continue;
    }
    const match = /^(\d*)\s*(?:-|–|to)\s*(\d*)$/i.exec(part);
    if (match) {
      const from = match[1] ? parseInt(match[1], 10) : 1;
      const to = match[2] ? parseInt(match[2], 10) : total;
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let n = lo; n <= hi; n++) {
        if (n >= 1 && n <= total) out.add(n - 1);
      }
      continue;
    }
    const single = parseInt(part, 10);
    if (!Number.isNaN(single) && single >= 1 && single <= total) {
      out.add(single - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Strip the extension so exports can be named "lease-signed.pdf". */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "document";
}

/** Keep a file name usable on every platform. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "document";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
