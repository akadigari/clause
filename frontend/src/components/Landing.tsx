/**
 * The empty bench.
 *
 * It is the same surface the tool uses once a file is open, with the same crop
 * marks, so opening a document feels like putting something down rather than
 * navigating to a different page.
 */

import { useCallback, useState } from "react";

import leaseUrl from "../assets/lease.pdf?url";
import termsUrl from "../assets/terms.pdf?url";

type Props = {
  onOpen: (file: File) => void;
  onOpenBytes: (name: string, bytes: Uint8Array) => void;
  onProblem: (message: string) => void;
};

const CAPABILITIES: Array<[string, string]> = [
  ["Pages", "Turn, reorder, delete, duplicate"],
  ["Merge", "Any number of files into one"],
  ["Split", "Cut anywhere, or one file per page"],
  ["Sign", "Draw it once, drop it anywhere"],
  ["Redact", "Takes the words out, not just covers them"],
  ["Shrink", "Flatten scans, with the real numbers"],
  ["Convert", "Pages to images, images to pages"],
  ["Read", "Ask a question, get the exact clause"],
];

const SAMPLES: Array<{ label: string; url: string; name: string }> = [
  { label: "An apartment lease", url: leaseUrl, name: "sample-apartment-lease.pdf" },
  { label: "Terms of service", url: termsUrl, name: "sample-terms-of-service.pdf" },
];

export default function Landing({ onOpen, onOpenBytes, onProblem }: Props) {
  const [over, setOver] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const takeFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) onOpen(file);
    },
    [onOpen],
  );

  const loadSample = useCallback(
    async (sample: (typeof SAMPLES)[number]) => {
      setLoading(sample.name);
      try {
        const response = await fetch(sample.url);
        const buffer = await response.arrayBuffer();
        onOpenBytes(sample.name, new Uint8Array(buffer));
      } catch {
        onProblem("That sample would not load. Your own file will still work.");
      } finally {
        setLoading(null);
      }
    },
    [onOpenBytes, onProblem],
  );

  return (
    <div className="landing">
      <div className="landing-inner">
        <p className="eyebrow">
          <span className="rule" />
          PDF workbench
          <span className="rule" />
        </p>

        <h1 className="thesis">
          Your PDF never <span className="lit">leaves this tab.</span>
        </h1>

        <p className="sub">
          Merge, split, turn, sign, redact and read documents. Every tool is
          free, nothing comes out watermarked, and there is no account. The
          counter in the corner is how you check the first part.
        </p>

        <label
          className={`dropzone ${over ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            takeFiles(e.dataTransfer.files);
          }}
        >
          <span className="crop tl" />
          <span className="crop tr" />
          <span className="crop bl" />
          <span className="crop br" />
          <div className="big">Drop a PDF here</div>
          <div className="small">or click to choose one</div>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => takeFiles(e.target.files)}
            aria-label="Choose a PDF to open"
          />
        </label>

        <div className="samples">
          <span className="lead">Nothing to hand?</span>
          {SAMPLES.map((sample) => (
            <button
              key={sample.name}
              type="button"
              className="sample-chip"
              disabled={loading !== null}
              onClick={() => void loadSample(sample)}
            >
              {loading === sample.name ? "Opening..." : sample.label}
            </button>
          ))}
        </div>

        <div className="capabilities">
          <span className="label">What is on the bench</span>
          <div className="cap-grid">
            {CAPABILITIES.map(([name, what]) => (
              <div className="cap" key={name}>
                <b>{name}</b>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="footnote">
          What it will not do: read scanned pages that have no text in them,
          remove a password, or sign anything cryptographically. Those need
          either a server or a certificate, and a tool that pretended otherwise
          would be doing the same thing the subscription sites do. Everything
          above works offline, and keeps working if this site ever disappears.
        </p>
      </div>
    </div>
  );
}
