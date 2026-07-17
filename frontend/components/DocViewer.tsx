"use client";

import { useEffect, useRef } from "react";
import type { DocumentDetail } from "@/lib/api";

export interface Highlight {
  docId: string;
  page: number;
  start: number;
  end: number;
  /** bump to re-trigger scrolling when the same span is clicked twice */
  nonce: number;
}

export default function DocViewer({
  doc,
  highlight,
}: {
  doc: DocumentDetail | null;
  highlight: Highlight | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight || !doc || highlight.docId !== doc.id) return;
    const el = scrollRef.current?.querySelector("mark.clause-highlight");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight, doc]);

  if (!doc) {
    return (
      <div className="doc-scroll">
        <div className="viewer-drop">
          <h3>No document open</h3>
          <p>
            Pick a sample above, or upload a PDF: a lease, a contract, a terms
            of service, an insurance policy, a manual…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-scroll" ref={scrollRef}>
      {doc.page_texts.map(({ page, text }) => {
        const active =
          highlight && highlight.docId === doc.id && highlight.page === page;
        return (
          <article className="page-card" key={page} id={`page-${page}`}>
            <div className="page-label">
              {doc.name} · Page {page} of {doc.pages}
            </div>
            <div className="page-text">
              {active ? (
                <>
                  {text.slice(0, highlight.start)}
                  <mark className="clause-highlight" key={highlight.nonce}>
                    {text.slice(highlight.start, highlight.end)}
                  </mark>
                  {text.slice(highlight.end)}
                </>
              ) : (
                text
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
