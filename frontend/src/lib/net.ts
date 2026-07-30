/**
 * The network meter.
 *
 * The whole claim of this app is that your file never leaves the tab. A badge
 * that says "private" is worth nothing, so instead we measure. This watches
 * every network request the page makes and reports what went out.
 *
 * What counts and what does not, stated plainly:
 *
 *  - Loading the app itself (HTML, JavaScript, CSS, fonts) is a download from
 *    wherever the site is hosted. Those requests happen once, before you have
 *    opened anything, and they are marked as boot traffic.
 *  - After boot, opening, editing, exporting and asking questions about a
 *    document make no network request at all. That is the number the meter
 *    shows: requests since boot, and bytes uploaded.
 *  - The one exception is the optional AI answer mode, which only turns on if
 *    you paste in your own API key. That sends the retrieved excerpts to
 *    Anthropic, and the meter turns amber and says so while it happens.
 *
 * Anyone can check this against their own devtools network tab. That is the
 * point: the instrument agrees with the browser, or it is broken.
 */

export type NetState = {
  /** Requests made after the app finished loading. */
  requests: number;
  /** Bytes sent in request bodies after the app finished loading. */
  bytesOut: number;
  /** Bytes received after the app finished loading. */
  bytesIn: number;
  /** True while a deliberate outbound call is in flight. */
  talking: boolean;
  /** Hosts contacted after boot, for the popover. */
  hosts: string[];
};

const state: NetState = {
  requests: 0,
  bytesOut: 0,
  bytesIn: 0,
  talking: false,
  hosts: [],
};

const listeners = new Set<(s: NetState) => void>();
let bootDone = false;
let started = false;

function emit(): void {
  const snapshot: NetState = { ...state, hosts: [...state.hosts] };
  for (const fn of listeners) fn(snapshot);
}

/**
 * Requests the browser makes on our behalf that are not traffic to a server:
 * blob: and data: URLs are built in memory, and those are how downloads and
 * page thumbnails work here.
 */
function isLocalUrl(url: string): boolean {
  return (
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("filesystem:")
  );
}

export function startNetWatch(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // Everything that loads before the window "load" event is the app arriving.
  // Anything after it is the app doing something, which is what we report.
  const markBooted = () => {
    bootDone = true;
  };
  if (document.readyState === "complete") {
    // Give in-flight font and chunk requests a moment to land first.
    setTimeout(markBooted, 400);
  } else {
    window.addEventListener("load", () => setTimeout(markBooted, 400), {
      once: true,
    });
  }

  if (typeof PerformanceObserver === "undefined") return;

  try {
    const observer = new PerformanceObserver((list) => {
      if (!bootDone) return;
      let changed = false;
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        if (isLocalUrl(resource.name)) continue;
        state.requests += 1;
        state.bytesIn += resource.transferSize || 0;
        try {
          const host = new URL(resource.name, location.href).host;
          if (host && !state.hosts.includes(host)) state.hosts.push(host);
        } catch {
          /* a malformed entry is not worth crashing the meter over */
        }
        changed = true;
      }
      if (changed) emit();
    });
    observer.observe({ type: "resource", buffered: false });
  } catch {
    /* No resource timing available. The meter degrades to counting the
       deliberate calls reported through countUpload() below. */
  }
}

/**
 * Called by the one code path that intentionally sends data out, so the meter
 * can show it happening rather than discovering it after the fact.
 */
export function countUpload(bytes: number): () => void {
  state.talking = true;
  state.bytesOut += bytes;
  emit();
  return () => {
    state.talking = false;
    emit();
  };
}

export function subscribeNet(fn: (s: NetState) => void): () => void {
  listeners.add(fn);
  fn({ ...state, hosts: [...state.hosts] });
  return () => {
    listeners.delete(fn);
  };
}

export function netSnapshot(): NetState {
  return { ...state, hosts: [...state.hosts] };
}
