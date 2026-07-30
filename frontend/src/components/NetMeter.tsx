/**
 * The network meter.
 *
 * Every PDF site says it respects your privacy. Most of them upload your file
 * to a server to do the work, then delete it later and ask you to take their
 * word for it. This one does the work in the tab, and rather than claiming
 * that, it counts.
 *
 * The number here is requests made after the app finished loading. Opening a
 * file, editing it, and saving it should never move it. If it ever does, this
 * says so, and anyone can check it against their own devtools.
 */

import { useEffect, useRef, useState } from "react";

import { subscribeNet, type NetState } from "../lib/net";
import { bytes as fmtBytes } from "../lib/format";
import { IconShield } from "./Icons";

export default function NetMeter() {
  const [net, setNet] = useState<NetState>({
    requests: 0,
    bytesOut: 0,
    bytesIn: 0,
    talking: false,
    hosts: [],
  });
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeNet(setNet), []);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // What matters is whether anything went OUT. Fetching a bundled sample
  // document from this same site is a download, and saying "0 sent" while a
  // download happened is still exactly true.
  const quiet = net.bytesOut === 0 && !net.talking;

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        className={`meter ${net.talking ? "talking" : quiet ? "quiet" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          quiet
            ? "Network: nothing has been sent. Open for details."
            : `Network: ${net.requests} requests since load. Open for details.`
        }
      >
        <span className="dot" />
        {net.talking ? (
          <span>sending</span>
        ) : quiet ? (
          <>
            <span>0 sent</span>
            <span className="bytes">{fmtBytes(0)}</span>
          </>
        ) : (
          <>
            <span className="num">{net.requests}</span>
            <span className="bytes">{fmtBytes(net.bytesOut)}</span>
          </>
        )}
      </button>

      {open && (
        <div className="meter-pop" role="dialog" aria-label="Network activity">
          <h4>
            <IconShield size={15} /> Where your file goes
          </h4>
          {quiet ? (
            <p>
              Nowhere. Since this page finished loading it has sent{" "}
              <strong>no bytes to anyone</strong>. Your document was read by the
              browser and has stayed in this tab.
              {net.requests > 0 && (
                <>
                  {" "}
                  It has made{" "}
                  <strong className="num">{net.requests}</strong>{" "}
                  {net.requests === 1 ? "request" : "requests"} back to this same
                  site, which is how a bundled sample document gets loaded.
                </>
              )}
            </p>
          ) : (
            <p>
              Since loading, this page has made <strong>{net.requests}</strong>{" "}
              {net.requests === 1 ? "request" : "requests"} and sent{" "}
              <strong>{fmtBytes(net.bytesOut)}</strong>
              {net.hosts.length > 0 ? ` to ${net.hosts.join(", ")}` : ""}.
            </p>
          )}
          <p>
            Loading the app itself is a download from wherever it is hosted, and
            that happens before you open anything. It is not counted here.
          </p>
          <p>
            Do not take this from a counter that this app wrote. Open devtools,
            go to the Network tab, and edit a document: nothing appears. Or turn
            off your wifi and keep working.
          </p>
        </div>
      )}
    </div>
  );
}
