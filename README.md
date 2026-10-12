# Kodakool

**Local-first qualitative coding for text analysis** — a browser app for coding newspaper
corpora (and any other text) with frame devices, notes and version history. Everything lives
in your browser's [RxDB](https://rxdb.info) (Dexie/IndexedDB): documents, coding entries,
frame-device catalogs and version snapshots. No account, no server-side data.

The app ships with a bundled **example project** (`example/`): a real newspaper article
(_Junge Freiheit_ 22) with 132 verified coding entries and its full frame-device catalog,
seeded automatically on first visit.

## Features

- **Projects screen** — create projects, add documents, see per-project document/code/version
  stats, export a project's catalog as `.qdc`, delete projects behind a timed confirm dialog.
- **Coding editor** — CodeMirror 6 with every coded range hatched in its device color, label
  chips, hover popups with notes, markdown highlighting, full undo.
- **Smart select** — one click selects a sentence / quote / paragraph (word-snapped), tuned for
  extracted PDF lines.
- **PDF support** — drop a PDF, its text is extracted client-side (unpdf) and rendered as a
  canvas + text layer with the same coding marks; selection is delegated to the canonical text.
- **Frame-device catalogs** — per-project device trees (numeric codes derived from tree
  position, short tags auto-generated), editable inline (rename, tag, reorder, add, delete),
  import/export as `.json` or QDA-XML `.qdc`.
- **Versions** — snapshot a document with its entries, restore any snapshot.
- **Color system** — Material-You-style palette (chroma/tone sliders), per-device marker
  colors, light/dark theme; one control re-tints the whole app.
- **Database export/import** — the entire local database as a single JSON file.

## Getting started

The repo uses a Nix flake devShell (nodejs_22 + pnpm + Playwright browsers) via direnv:

```sh
direnv allow        # enter the devShell (NixOS)
pnpm install
pnpm dev            # http://localhost:5173
```

Without Nix, any Node ≥ 22 + pnpm works the same.

## Commands

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `pnpm dev`             | dev server                                            |
| `pnpm build`           | production build (`@sveltejs/adapter-node`)           |
| `pnpm preview`         | serve the build with `node build`                     |
| `pnpm check`           | `svelte-kit sync` + `svelte-check` (must stay clean)  |
| `pnpm test`            | all vitest projects (client = browser, server = node) |
| `pnpm lint` / `format` | prettier                                              |

Single test file: `pnpm test:unit --run src/tests/dashboard.svelte.spec.ts`.
The client suite runs headless Chromium by default; in the devShell
`direnv exec . env BROWSER=firefox pnpm test --project=client` runs it in Firefox.

## Architecture

- **SvelteKit 2 + Svelte 5** (runes forced on; all config lives in `vite.config.ts`, there is
  no `svelte.config.js`).
- **Local-first store** — `src/lib/client/coding-db.ts`: RxDB collections `articles`, `codes`,
  `catalogs`, `pdfs`, `folders`; live queries drive every screen. Nothing is sent to a server.
- **Example project** — `src/lib/assets/examples/` (source text, coding entries, catalog,
  QDC codebook) seeded once per browser profile by `src/lib/client/examples.ts`.
- **Coding page** `/text/<folder>/<name>` — `CodingDoc.svelte` (editor + marks + catalog
  sidebar) with `PdfView.svelte` for PDF documents; `src/lib/coding/` holds the shared coding
  logic (entry verification, excerpt ellipsis, smart-select segmentation, palette, QDC I/O).
- **UI components** — [bits-ui](https://bits-ui.com) 2.x primary, Melt UI only for the catalog
  tree + file uploads; icons from `material-symbols`.
- The SvelteKit server only serves the app (`adapter-node`); it owns no data.

## Tests

Vitest splits into two projects: `server` (node, pure logic) and `client`
(`src/tests/*.svelte.spec.ts`, headless browser via Playwright — browsers come from the Nix
devShell). UI specs drive the real pages against a fresh RxDB per test.

## License / provenance

Started as a bachelor-project tool (`luci-bachelor`); history on the `history`-era remote,
development continues at `github.com:Luci16828/Kodakool`.
