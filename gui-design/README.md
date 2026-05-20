# 发票助手 · GUI Design Preview

Static HTML/CSS/JS design preview for the `Mail-Fapiao-Helper` CLI. No build required.

## Preview

From the repo root:

```bash
cd gui-design && python3 -m http.server 5173
```

Then open <http://localhost:5173/> in a browser. The landing page links into all six screens.

Alternatively, just double-click `gui-design/index.html` to open it directly in the browser; the relative paths to `styles/` and `scripts/` work either way.

## Files

```
gui-design/
  index.html                 — landing card, links to all screens
  styles/main.css            — design system (paper-ledger aesthetic)
  scripts/shell.js           — shared sidebar nav injector
  pages/
    dashboard.html           — 01 Run Console (trigger fetch, live console, run history)
    inbox.html               — 02 Inbox Ledger (INDEX.csv view, filters, grouping by month)
    library.html             — 03 Invoice Library (filed invoices with OCR fields)
    pending.html             — 04 Manual Queue (failures grouped by reason)
    config.html              — 05 Configuration (config.json editor with section index)
    settings.html            — 06 About & Build (roadmap, principles, build info)
```

## Design notes

- **Aesthetic** — editorial ledger / accountant's paper journal. Cream paper background with horizontal ruled lines (subtle, baked into the body bg), deep ink-black text, vermilion (朱砂) as the single hot accent, sage celadon for "successful" states, amber for "pending", indigo for the persistent left nav.
- **Typography** — Noto Serif SC for display headings (paper-ledger feel), IBM Plex Mono for all numeric / tabular / metadata columns, Noto Sans SC for body, Fraunces italic for English secondary labels.
- **Spatial system** — 56px content padding, hairline 1px rules, occasional 2px structural rules; tables ("ledgers") use 10px monospace uppercase headers with 0.22em tracking for a stamped/printed feel.
- **Decorative motif** — the red square "chop" (印章) appears as brand mark, large action affordance, status indicator, and decorative seal — a single visual signature that ties the system together.
- **Microinteractions** — page-load stagger (60/120/180ms), hard-shadow button press (2px → 3px → 1px), animated progress bar + pulsing dot on the run console, rotating dashed-stamp transform on chops.

This is design-only. The existing CLI is unmodified.
