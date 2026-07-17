# Recording the demo GIF

Goal: a short (20-35s) silent GIF that shows the one thing that makes Clause
different, **answers you can verify**, plus the red-flags scan. It lives at
`docs/demo.gif` and is embedded at the top of the README.

## Before you record

- Run both servers (see the README "Running it" section). Have the sample
  **Apartment Lease** open in the left pane.
- **Turn on the LLM if you can.** Set `ANTHROPIC_API_KEY` and restart the
  backend so answers are written in plain English (the header badge should show
  the model, not "no LLM key"). The GIF is much stronger with real answers. If
  you can't, the quote-only mode still demos the citations and the scan.
- Make the browser window smallish (roughly 1280x800) so the GIF file stays
  light. Hide bookmarks/extensions for a clean frame.
- Zoom the page to ~110% so text is readable at GIF size.

## Shot list (do it in this order, slowly)

1. **Start on the lease.** Let the two-pane layout sit for ~1s so it's clear
   what we're looking at.
2. **Ask a question with a real answer.** Click the suggestion
   *"What fees could I be charged?"* (or type *"What's the late fee?"*). Let the
   answer render.
3. **Click a citation chip.** Watch the left pane jump to the page and pulse-
   highlight the exact clause. Pause ~2s on the highlight. **This is the money
   shot, don't rush it.**
4. **Ask something that isn't in the document.** Type *"Can I have a pet
   dragon?"* or *"What's the wifi password?"*. Let the amber "I couldn't find
   that in this document" answer render, that honesty is a selling point.
5. **Run the red-flags scan.** Click the **⚑ Scan for red flags** button. Let
   the flag cards render, then click one flag's citation to highlight that
   clause in the document. Pause on it.
6. Hold the final frame for ~1s, then stop.

## Turning it into a GIF

Record with QuickTime (File > New Screen Recording) or
[Kap](https://getkap.co/) (simpler, exports GIF directly).

If you record a `.mov`, convert with ffmpeg:

```bash
# 12 fps, 1000px wide, palette-optimized for a small, sharp GIF
ffmpeg -i demo.mov -vf "fps=12,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" docs/demo.gif
```

Aim for **under ~8 MB** so it loads fast on GitHub. If it's too big, drop to
`fps=10` or `scale=900`.

## Also worth capturing (optional)

Two or three still PNGs for the README or a portfolio page:
`docs/screenshot-answer.png` (an answer with its citation), and
`docs/screenshot-scan.png` (the red-flags results). Add them under the Demo
section if you want stills as well as the GIF.
