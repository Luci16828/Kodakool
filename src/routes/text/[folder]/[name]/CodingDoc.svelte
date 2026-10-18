<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { EditorView, keymap } from "@codemirror/view";
  import { Compartment, EditorState } from "@codemirror/state";
  import { history, historyKeymap } from "@codemirror/commands";
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { FileUpload } from "melt/builders";
  import { Collapsible, Dialog, Popover, RadioGroup, ScrollArea, Toggle } from "bits-ui";
  import { Pane, PaneGroup, PaneResizer } from "paneforge";
  import "material-symbols/rounded.css";
  import { buildPalette, onForFill, type CodeColor } from "$lib/coding/palette";
  import { useColors } from "$lib/coding/prefs.svelte";
  import CatalogTree from "$lib/coding/CatalogTree.svelte";
  import ColorPanel from "$lib/coding/ColorPanel.svelte";
  import ConfirmDialog from "$lib/coding/ConfirmDialog.svelte";
  import { entryFromOffsets, entryId, lineStarts, offsetsSpan } from "$lib/coding/edit";
  import { buildCatalogView } from "$lib/coding/catalog-view";
  import { rankDevices, reconcileSlots } from "$lib/coding/quickselect";
  import { QuickPrefs } from "$lib/coding/quickselect.svelte";
  import QuickSelect from "$lib/coding/QuickSelect.svelte";
  import { docIcon, displayName } from "$lib/coding/display";
  import { parseCatalogFile } from "$lib/coding/import";
  import { mdExtensions } from "$lib/coding/code-md";
  import { toQdc } from "$lib/coding/qdc";
  import type { FrameDevice, Instructions } from "$lib/coding/instructions";
  import type { CatalogView } from "$lib/coding/catalog-view";
  import type { CodeEntry } from "$lib/coding/types";
  import {
    addVersion,
    base64ToBytes,
    clearLocalCatalog,
    createArticle,
    deleteArticle,
    getArticle,
    getArticleById,
    getLocalCatalog,
    getPdfData,
    removeEntry,
    renameArticle,
    saveArticle,
    saveLocalCatalog,
    watchArticle,
    watchArticles,
    type ArticleData,
    type ArticleSummary,
    type ArticleVersion,
  } from "$lib/client/coding-db";
  import { uploadArticleFile, uploadArticleFolder } from "$lib/client/upload";
  import { codingMarks, smartSelect, syncCodingMarks, type CodingMarkSpec } from "$lib/coding/code-mark";

  const { data }: { data: { folder: string; name: string } } = $props();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** editor is live once the initial local article has been handed to CodeMirror */
  let mounted = $state(false);
  /** live editor body (kept in sync from the CodeMirror doc) + its line starts */
  let docText = $state("");
  const docStarts = $derived(lineStarts(docText));
  /**
   * Authoritative mark geometry in editor coordinates: entryId → {from,to}.
   * Seeded from stored line/range on load, then mapped through every doc change
   * (including undo/redo) so marks stay anchored while the text is edited.
   * At save these are re-derived back into line/range/excerpt of the current text.
   */
  const livePos = new SvelteMap<string, { from: number; to: number }>();

  /** an unsaved change (text edit or entry edit) is queued; debounced autosave flushes it */
  let pending = $state(false);
  let committing = false;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleCommit(delay = 700): void {
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      void doCommit();
    }, delay);
  }

  function seedPositions(): void {
    for (const e of entries) {
      const id = entryId(key, e);
      if (livePos.has(id)) continue;
      const from = docStarts[e.line - 1] + e.range[0];
      const to = docStarts[(e.endLine ?? e.line) - 1] + e.range[1];
      if (Number.isFinite(from) && Number.isFinite(to) && from < to) livePos.set(id, { from, to });
    }
  }

  let parent = $state<HTMLDivElement | undefined>(undefined);
  let view = $state.raw<EditorView | undefined>(undefined);
  let unsubscribe: (() => void) | undefined;

  let loading = $state(true);
  let missing = $state(false);
  let initialLoaded = $state(false);
  let initial = $state<{ article: ArticleData; entries: CodeEntry[] } | null>(null);
  let article = $state<ArticleData | null>(null);
  /** PDF-derived document: extracted text is the source of truth, strictly read-only */
  const isPdf = $derived(article?.kind === "pdf");
  /** stored PDF bytes + lazily loaded PdfView component (unpdf stays out of the main bundle) */
  let pdfDoc = $state<{ data: string; pages: number } | null>(null);
  /** PDF surface: rendered pages (default) or the extracted text in the editor */
  let pdfMode = $state<"doc" | "text">("doc");
  let PdfViewComp = $state<typeof import("$lib/coding/PdfView.svelte").default | null>(null);
  let entries = $state<CodeEntry[]>([]);
  let versionCount = $state(0);
  const key = $derived(article?.id ?? "");
  let armed = $state<string | null>(null);
  let saving = $state(false);
  let smart = $state(true);
  /** coding (read-only body, arming + entry edits) vs edit (body editable) */
  let mode = $state<"code" | "edit">("code");
  const roComp = new Compartment();
  const langComp = new Compartment();
  /** .md documents (extension kept in the name) get markdown + frontmatter highlighting */
  const isMd = $derived(/\.(md|markdown)$/i.test(data.name));

  /** title keeps the raw name until the article (and with it the kind) is known */
  const titleName = $derived(article ? displayName(data.name, article.kind ?? "text") : data.name);
  function setMode(m: "code" | "edit"): void {
    if (mode === m || (m === "edit" && isPdf)) return;
    mode = m;
    if (m === "edit") {
      armed = null;
      popup = null;
    }
    if (view) view.dispatch({ effects: roComp.reconfigure(EditorState.readOnly.of(m === "code")) });
  }
  /** the app-wide color source (shared via context; the sliders below write to it) */
  const prefs = useColors();
  /** entry whose detail popup is open (hover) + its anchored viewport position */
  let popup = $state<{ id: string; x: number; y: number } | null>(null);
  let popupNote = $state("");
  /** pointer is over the popup itself (keeps it open across the chip→popup gap) */
  let overPopup = false;
  /** current editor selection (rendered as just another mark) */
  let selRange: { from: number; to: number } | null = $state(null);
  /** span a smart click would select right now (hover preview mark) */
  let previewRange: { from: number; to: number } | null = $state(null);
  let saveMsg = $state("");
  let editMsg = $state("");
  let msgTimer: ReturnType<typeof setTimeout> | undefined;
  /** transient success note in the bar (errors live in editMsg) */
  function flashSaveMsg(msg: string): void {
    saveMsg = msg;
    if (msgTimer !== undefined) clearTimeout(msgTimer);
    if (msg !== "") msgTimer = setTimeout(() => (saveMsg = ""), 2500);
  }
  /** catalog id under the sidebar cursor (fades unrelated marks) */
  let hoverDevice = $state<string | null>(null);
  /** segment id under the editor cursor (heats its narrowest entry) */
  let hoverId = $state<string | null>(null);
  /** entry id under a hovered label chip (heats the entry everywhere) */
  let hoverChip = $state<string | null>(null);
  /** inline rename of the document title */
  let renaming = $state(false);
  let renameDraft = $state("");
  /** caret placement for the rename input: end of the name, full select on default names */
  function renameCaret(node: HTMLInputElement): void {
    node.focus();
    const len = node.value.length;
    if (/^Untitled \d+(?:\.md)?$/i.test(node.value)) node.setSelectionRange(0, len);
    else node.setSelectionRange(len, len);
  }
  /** versions popover open (Bits Popover) */
  let versionsOpen = $state(false);
  /** download picker + markdown cheatsheet popovers (Bits Popover) */
  let dlOpen = $state(false);
  let mdOpen = $state(false);
  /** article ids picked in the download picker */
  const dlSel = new SvelteSet<string>();
  /** local frame-device catalog for this folder + edit draft */
  let localCatalog = $state<Instructions | null>(null);
  let editCat = $state(false);
  let draft = $state<Instructions | null>(null);
  let catMsg = $state("");
  let catBusy = $state(false);
  /** colors customization popup (Bits Dialog) */
  let colorsOpen = $state(false);
  /** right-side document tree sidebar (Bits Collapsible) */
  let treeOpen = $state(true);
  /** right-side frame-devices sidebar (Bits Collapsible) */
  let catOpen = $state(true);
  /** resizable workspace panes (PaneForge): sizes are % of the workspace width */
  const WS_TREE = { def: 16, min: 10, max: 32, collapsed: 3.5 };
  const WS_DOC = { def: 63, min: 38 };
  const WS_CAT = { def: 21, min: 12, max: 36, collapsed: 3.5 };
  /** pane instances: the collapse pills drive them, dragging a pane reports back */
  let treePane: ReturnType<typeof Pane> | null = $state(null);
  let catPane: ReturnType<typeof Pane> | null = $state(null);

  /** the collapse pills resize the panes; dragging a pane down to its collapsed
      size collapses the sidebar, and the Collapsible state follows it back */
  $effect(() => {
    const pane = treePane;
    if (pane === null) return;
    if (treeOpen) pane.expand();
    else pane.collapse();
  });
  $effect(() => {
    const pane = catPane;
    if (pane === null) return;
    if (catOpen) pane.expand();
    else pane.collapse();
  });
  /** all local documents; the sidebar shows only this project's slice */
  let docs = $state<ArticleSummary[]>([]);
  let docsBusy = $state(false);
  /** shared delete confirmation: pending action + open flag (ConfirmDialog) */
  let confirmAction = $state<{ title: string; detail: string; run: () => void } | null>(null);
  let confirmOpen = $state(false);

  /** documents of THIS project only — other projects stay on the project screen */
  const myDocs = $derived.by(() =>
    docs
      .filter((a) => a.project === data.folder)
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })),
  );

  async function newDoc(project: string): Promise<void> {
    docsBusy = true;
    try {
      const a = await createArticle(project);
      await goto(resolve("/text/[folder]/[name]", { folder: a.project, name: a.name }));
    } finally {
      docsBusy = false;
    }
  }

  /** open the shared ConfirmDialog for a destructive action */
  function askDelete(title: string, detail: string, run: () => void): void {
    confirmAction = { title, detail, run };
    confirmOpen = true;
  }
  async function doDeleteDoc(a: ArticleSummary): Promise<void> {
    await deleteArticle(a.id);
    // deleting the document we are looking at returns to its project
    if (a.project === data.folder && a.name === data.name)
      await goto(resolve("/project/[folder]", { folder: a.project }));
  }

  /** Melt FileUpload dropzone: picked/dropped .txt/.md/.pdf files become local articles */
  let uploadMsg = $state("");
  const fileUpload = new FileUpload({
    multiple: true,
    accept: ".txt,.md,.pdf,text/plain,application/pdf",
    onAccept: (f) => void uploadFile(f),
  });
  async function uploadFile(f: File): Promise<void> {
    const r = await uploadArticleFile(data.folder, f, (m) => (uploadMsg = m));
    uploadMsg = r.message;
  }
  /** folder picker (webkitdirectory): every .txt/.md/.pdf file inside becomes an article */
  async function uploadFolder(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const messages = await uploadArticleFolder(data.folder, input);
    uploadMsg = messages[messages.length - 1] ?? "";
  }

  const entryKeys = $derived(entries.map((e) => e.device ?? e.code ?? "").filter((k) => k !== ""));
  /** effective catalog: the local RxDB copy (seeded, imported, or edited) */
  const catalog = $derived(buildCatalogView(localCatalog, entryKeys));

  function flatten(nodes: CatalogView[], out: CatalogView[] = []) {
    for (const n of nodes) {
      out.push(n);
      flatten(n.children, out);
    }
    return out;
  }
  const nodes = $derived(flatten(catalog));
  const displayByDevice = $derived(new SvelteMap(nodes.map((n) => [n.id, n.code])));
  const nameByDevice = $derived(new SvelteMap(nodes.map((n) => [n.id, n.name])));

  const SEL_CODE = "__selection";
  const PREVIEW_CODE = "__preview";
  // selection/preview bars keep a blue-ish identity (prefer) but are now part of the
  // palette, so the chroma/tone sliders re-tint them like every other mark.
  const palettePrefer = new SvelteMap([
    [SEL_CODE, 235],
    [PREVIEW_CODE, 205],
  ]);
  const palette = $derived(
    buildPalette(
      [
        ...new SvelteSet([
          ...nodes.map((n) => n.code),
          ...entries.map((e) => displayByDevice.get(e.device ?? e.code ?? "") ?? e.code ?? e.device ?? ""),
          SEL_CODE,
          PREVIEW_CODE,
        ]),
      ],
      { prefer: palettePrefer, ...prefs.options },
    ),
  );
  const colorOf = (code: string) => palette.get(code)?.light.marker ?? "#888888";

  // Fingerprint of the palette colors. The sidebar's styleFor is a callback, so
  // +page never reads `palette` for that subtree and slider moves would otherwise
  // leave the tree rows stale; the sidebar element reads this to re-style on change.
  const paletteTick = $derived.by(() => {
    let t = 0;
    for (const c of palette.values())
      t +=
        c.light.marker.charCodeAt(1) + c.light.on.charCodeAt(1) + c.dark.marker.charCodeAt(1) + c.dark.on.charCodeAt(1);
    return t;
  });

  // short slugs (LTE etc.) from the catalog, keyed by display code
  const shortByCode = $derived.by(() => {
    const map = new SvelteMap<string, string>();
    const walk = (ns: CatalogView[]): void => {
      for (const n of ns) {
        if (n.slug) map.set(n.code, n.slug.short);
        walk(n.children);
      }
    };
    walk(catalog);
    return map;
  });

  // selection & smart-preview are coverage pseudo-codes (rendered through the
  // same segments/hatch pipeline as real entries, so overlaps hatch).
  // SEL_CODE / PREVIEW_CODE are declared above the palette (it colors them).

  // article parity: repeating stripes separated by surface gaps (hatch())
  function hatch(stops: string[]): string {
    const w = 4;
    const p = w + 2;
    const total = stops.length * p;
    const stopsStr = stops
      .flatMap((col, k) => [
        `${col} ${k * p}px ${k * p + w}px`,
        `var(--surface, white) ${k * p + w}px ${(k + 1) * p}px`,
      ])
      .concat(`${stops[0]} ${total}px ${total}px`)
      .join(", ");
    return `repeating-linear-gradient(45deg, ${stopsStr})`;
  }

  /** fill (or fillHover) of a code color for the given scheme/interaction state */
  const pickFill = (c: CodeColor, dark: boolean, hover: boolean): string => {
    const s = dark ? c.dark : c.light;
    return hover ? s.fillHover : s.fill;
  };

  const fillOf = (code: string, dark: boolean, hover: boolean): string => {
    // selection & preview take the armed frame device's color when one is armed,
    // otherwise their own palette entry (so the chroma/tone sliders re-tint them too)
    if (code === SEL_CODE || code === PREVIEW_CODE) {
      const c = (armed === null ? undefined : palette.get(displayByDevice.get(armed) ?? armed)) ?? palette.get(code);
      if (c !== undefined) return pickFill(c, dark, hover);
      return code === SEL_CODE ? (dark ? "#7f97e6" : "#4a7ad4") : dark ? "#93a4d6" : "#829fcf";
    }
    const c = palette.get(code);
    return c === undefined ? "#888888" : pickFill(c, dark, hover);
  };

  function colorVars(code: string): string {
    const c = palette.get(code);
    if (!c) return "";
    return [
      `--fill: ${c.light.fill}`,
      `--fill-d: ${c.dark.fill}`,
      `--marker: ${c.light.marker}`,
      `--marker-d: ${c.dark.marker}`,
      `--on-marker: ${c.light.on}`,
      `--on-marker-d: ${c.dark.on}`,
    ].join("; ");
  }

  // catalog id for an entry's device/code/alias key
  const keyToId = $derived.by(() => {
    const map = new SvelteMap<string, string>();
    const walk = (ns: CatalogView[]): void => {
      for (const n of ns) {
        map.set(n.id, n.id);
        map.set(n.code, n.id);
        for (const a of n.alias ?? []) map.set(a, n.id);
        walk(n.children);
      }
    };
    walk(catalog);
    return map;
  });

  // ----- quick select menu (hold the right mouse button) -----
  /** slot preferences of this project + pins of this document (localStorage) */
  const quick = new QuickPrefs(
    () => data.folder,
    () => key,
  );
  const quickNodes = $derived(new SvelteMap(flatten(catalog).map((n) => [n.id, n])));
  /** entries per catalog node id (the "top used" part of the ranking) */
  const quickCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>();
    for (const e of entries) {
      const id = keyToId.get(e.device ?? e.code ?? "");
      if (id === undefined) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  });
  // recency comes from QuickPrefs: RxDB hands out code docs in primary-key order,
  // so the entries array cannot say which code was coded last
  const quickRanked = $derived(rankDevices(quickCounts, quick.recent));
  /** the slots the menu shows: stable positions, pinned ones past the top gate */
  const quickDisplay = $derived(reconcileSlots(quick.slots, quick.pins, quickRanked, quick.count, quickNodes));
  // remember what the menu showed: the next reconciliation starts from these slots,
  // so an ejected item never shifts its neighbours (the write is guarded by equality)
  $effect(() => quick.sync(quickDisplay));
  const quickLabel = (id: string) => {
    const code = displayByDevice.get(id) ?? id;
    return shortByCode.get(code) ?? code;
  };
  const quickStyle = (id: string) => colorVars(displayByDevice.get(id) ?? id);
  /** release over a tag: arm that device, and code the live selection when there is one */
  function quickPick(id: string): void {
    if (!UUID_RE.test(id)) return;
    if (mode === "edit") setMode("code");
    const sel = selRange;
    armed = id;
    popup = null;
    saveMsg = "";
    editMsg = "";
    if (sel !== null && sel.to > sel.from) addEntryFromOffsets(sel.from, sel.to, true);
    else flashSaveMsg(`armed ${quickLabel(id)}`);
  }

  /** left click on a cascade tag: pin it into its slot, else the first free one */
  function quickPinId(id: string): void {
    const at = quickDisplay.indexOf(id);
    const free = quickDisplay.indexOf(null);
    const slot = at >= 0 ? at : free >= 0 ? free : quick.count - 1;
    quick.pin(slot, quick.pins[slot] === id ? null : id);
  }

  // ids of the hovered catalog node and its whole subtree (null = no filter)
  const hoverKeys = $derived.by(() => {
    if (hoverDevice === null) return null;
    const find = (ns: CatalogView[]): CatalogView | null => {
      for (const n of ns) {
        if (n.id === hoverDevice) return n;
        const f = find(n.children);
        if (f) return f;
      }
      return null;
    };
    const node = find(catalog);
    if (!node) return null;
    const ids = new SvelteSet<string>();
    const collect = (n: CatalogView): void => {
      ids.add(n.id);
      for (const c of n.children) collect(c);
    };
    collect(node);
    return ids;
  });

  interface Placed {
    entry?: CodeEntry;
    id: string;
    code: string;
    from: number;
    to: number;
    faded: boolean;
  }

  const placed = $derived.by<Placed[]>(() => {
    const out: Placed[] = [];
    for (const e of entries) {
      const entryKey = e.device ?? e.code ?? "";
      const r = livePos.get(entryId(key, e));
      if (r === undefined) continue;
      const from = r.from;
      const to = r.to;
      if (from >= to) continue;
      out.push({
        entry: e,
        id: entryId(key, e),
        code: displayByDevice.get(entryKey) ?? entryKey,
        from,
        to,
        faded:
          selRange !== null ||
          previewRange !== null ||
          (hoverKeys !== null && !hoverKeys.has(keyToId.get(entryKey) ?? entryKey)),
      });
    }
    // selection & preview are coverage pseudo-entries: they split segments and
    // cover the faded real marks instead of sitting as a separate overlay
    if (selRange !== null && selRange.to > selRange.from)
      out.push({ id: SEL_CODE, code: SEL_CODE, from: selRange.from, to: selRange.to, faded: false });
    if (previewRange !== null && previewRange.to > previewRange.from)
      out.push({ id: PREVIEW_CODE, code: PREVIEW_CODE, from: previewRange.from, to: previewRange.to, faded: false });
    return out;
  });

  const tagFor = (code: string) => {
    const c = palette.get(code);
    return {
      label: shortByCode.get(code) ?? code,
      marker: c?.light.marker ?? "#888888",
      markerD: c?.dark.marker ?? "#888888",
      on: c?.light.on ?? "#ffffff",
      onD: c?.dark.on ?? "#ffffff",
    };
  };

  // article parity: entry size metric (lines dominate chars) for the narrowest
  // entry of a hovered segment; pseudo coverage (selection/preview) is ignored
  const spanOf = (p: Placed): number => {
    if (!p.entry) return Number.POSITIVE_INFINITY;
    return ((p.entry.endLine ?? p.entry.line) - p.entry.line) * 1_000_000 + (p.to - p.from);
  };
  const narrowest = (cov: Placed[]): Placed | undefined =>
    cov
      .filter((p) => p.entry !== undefined)
      .reduce<Placed | undefined>((a, b) => (a === undefined || spanOf(b) < spanOf(a) ? b : a), undefined);
  // split overlapping entries into disjoint segments (article token parity):
  // maximal intervals with identical coverage, independent of any hover state
  const segments = $derived.by(() => {
    const points = [...new SvelteSet(placed.flatMap((p) => [p.from, p.to]))].sort((a, b) => a - b);
    const out: { id: string; ids: string[]; from: number; to: number; cov: Placed[] }[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      const cov = placed.filter((p) => p.from <= from && to <= p.to);
      if (cov.length === 0) continue;
      const ids = cov.map((p) => p.id);
      out.push({ id: [...ids].sort().join("|"), ids, from, to, cov });
    }
    return out;
  });

  // single hover model (article hotSetFor parity): hovering a segment marks its
  // narrowest entry hot, hovering a chip marks that entry hot, and the entry is
  // then hot in EVERY segment and chip it covers — bars and chips both render
  // off this one set, so all hover sources go through the same code path
  const hotEntries = $derived.by(() => {
    const s = new SvelteSet<string>();
    // a live selection takes over the emphasis: no hover highlight while it lasts
    if (selRange !== null) return s;
    const seg = hoverId === null ? undefined : segments.find((x) => x.id === hoverId);
    if (seg !== undefined) {
      const n = narrowest(seg.cov);
      if (n !== undefined) s.add(n.id);
    }
    if (hoverChip !== null) s.add(hoverChip);
    return s;
  });

  /** PdfView marks: real entries + selection/preview pseudo coverage — the same
      pipeline as the editor's specs (hatch, focus-mode fade, no chips for pseudo) */
  const pdfMarks = $derived.by(() =>
    placed.map((p) => ({
      id: p.id,
      from: p.from,
      to: p.to,
      faded: p.faded,
      hot: hotEntries.has(p.id),
      color: fillOf(p.code, false, false),
      colorD: fillOf(p.code, true, false),
      colorHot: fillOf(p.code, false, true),
      colorHotD: fillOf(p.code, true, true),
      label: shortByCode.get(p.code) ?? p.code,
      // selection/preview pseudo coverage gets no chip (editor parity: tags are
      // only rendered for real entries)
      tagless: p.entry === undefined,
      on: onForFill(fillOf(p.code, false, false)),
      onD: onForFill(fillOf(p.code, true, false)),
    })),
  );

  const specs = $derived.by<CodingMarkSpec[]>(() => {
    const out: CodingMarkSpec[] = [];
    for (const { id, ids, from, to, cov } of segments) {
      const hotIds = new SvelteSet(ids.filter((x) => hotEntries.has(x)));
      const hot = hotIds.size > 0;
      const mix = (col: string, faded: boolean) => (faded ? `color-mix(in srgb, ${col} 32%, transparent)` : col);
      const itemFill = (p: Placed, dark: boolean, hotFor: boolean) =>
        hotFor ? fillOf(p.code, dark, true) : mix(fillOf(p.code, dark, false), p.faded);
      const grad = (dark: boolean, hotVariant: boolean): string => {
        // focus mode (selection/preview/hover): highlighted markers fully cover
        // the faded ones below them — no hatching against faded coverage; same
        // color highlights merge into one solid fill
        const focus = cov.some((p) => p.faded) && cov.some((p) => !p.faded || hotIds.has(p.id));
        const vis = focus ? cov.filter((p) => !p.faded || hotIds.has(p.id)) : cov;
        const stops = vis.map((p) => itemFill(p, dark, hotVariant && hotIds.has(p.id)));
        const uniq = focus ? [...new Set(stops)] : stops;
        return uniq.length === 1 ? `linear-gradient(${uniq[0]}, ${uniq[0]})` : hatch(uniq);
      };
      // dominant code for the bar text: the first visible (non-faded) coverage
      const dom = cov.find((p) => !p.faded || hotIds.has(p.id)) ?? cov[0];
      const style = [
        `--bars:${grad(false, false)}`,
        `--bars-d:${grad(true, false)}`,
        `--bars-hot:${grad(false, true)}`,
        `--bars-hot-d:${grad(true, true)}`,
        // text on the bar: contrast against the dominant code's fill (per scheme/variant)
        `--on-bars:${onForFill(fillOf(dom.code, false, false))}`,
        `--on-bars-d:${onForFill(fillOf(dom.code, true, false))}`,
        `--on-bars-hot:${onForFill(fillOf(dom.code, false, true))}`,
        `--on-bars-hot-d:${onForFill(fillOf(dom.code, true, true))}`,
      ].join("; ");
      out.push({
        id,
        ids,
        from,
        to,
        code: [...new SvelteSet(cov.filter((p) => p.entry !== undefined).map((p) => p.code))].sort().join(" · "),
        style,
        // one label per entry, only above the segment where it starts
        tags: cov
          .filter((p) => p.entry !== undefined && p.from === from)
          .map((p) => ({
            ...tagFor(p.code),
            id: p.id,
            hot: hotIds.has(p.id),
            faded: p.faded,
            open: hoverChip === p.id,
          })),
        hot,
      });
    }
    return out;
  });
  /** edit-mode tree built from the draft catalog */
  const draftView = $derived(draft === null ? [] : buildCatalogView(draft, entryKeys));

  function draftFind(ns: FrameDevice[], id: string): FrameDevice | null {
    for (const n of ns) {
      if (n.id === id) return n;
      const f = draftFind(n.children, id);
      if (f) return f;
    }
    return null;
  }
  function draftSiblings(ns: FrameDevice[], id: string): FrameDevice[] | null {
    if (ns.some((d) => d.id === id)) return ns;
    for (const n of ns) {
      const f = draftSiblings(n.children, id);
      if (f) return f;
    }
    return null;
  }
  function draftRename(id: string, name: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (d) d.name = name;
  }
  function draftTag(id: string, tag: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (!d) return;
    const t = tag.trim();
    if (t) d.tag = t;
    else delete d.tag;
  }
  /** drop dragId onto targetId: downward moves land after the target, upward before it */
  function draftMove(dragId: string, targetId: string): void {
    if (!draft || dragId === targetId) return;
    const list = draftSiblings(draft.devices, dragId);
    if (!list || !list.some((d) => d.id === targetId)) return;
    const from = list.findIndex((d) => d.id === dragId);
    const to = list.findIndex((d) => d.id === targetId);
    const [moved] = list.splice(from, 1);
    const at = list.findIndex((d) => d.id === targetId);
    list.splice(from <= to ? at + 1 : at, 0, moved);
  }
  /** new device under `parentId` (null = top level); fresh UUID, editable name */
  function draftAdd(parentId: string | null): void {
    if (!draft) return;
    const parent = parentId === null ? null : draftFind(draft.devices, parentId);
    const dev: FrameDevice = {
      id: crypto.randomUUID(),
      name: "New device",
      kind: parent?.kind ?? "device",
      examples: [],
      children: [],
    };
    if (parent) parent.children.push(dev);
    else draft.devices.push(dev);
  }
  /** remove a device from the draft (entries referencing it survive as orphans) */
  function draftDelete(id: string): void {
    if (!draft) return;
    const list = draftSiblings(draft.devices, id);
    if (!list) return;
    const i = list.findIndex((d) => d.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  function askDeleteDevice(id: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (!d) return;
    const used = entries.filter((e) => e.device === id).length;
    askDelete(
      `Delete device "${d.name}"?`,
      used > 0
        ? `${used} code entr${used === 1 ? "y" : "ies"} use this device; they stay in the file as orphaned codes.`
        : "No code entries use this device.",
      () => draftDelete(id),
    );
  }
  /** Proxy-safe deep clone: Svelte 5 props/$state are proxies and structuredClone rejects them. */
  function plainClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
  function startEditCat(): void {
    catMsg = "";
    draft = plainClone(localCatalog);
    editCat = true;
  }
  /** header add buttons: enter edit mode (starting an empty catalog when none exists)
      and add a device — `new category` at top level, `new code` under the armed device */
  function startAdd(parentId: string | null): void {
    if (!editCat) {
      draft = localCatalog === null ? { version: 1, title: data.folder, devices: [] } : plainClone(localCatalog);
      editCat = true;
    }
    draftAdd(parentId);
  }
  function cancelCat(): void {
    editCat = false;
    draft = null;
    catMsg = "";
  }
  async function saveCat(): Promise<void> {
    if (!draft) return;
    catBusy = true;
    catMsg = "";
    try {
      await saveLocalCatalog(data.folder, draft);
      localCatalog = plainClone(draft);
      editCat = false;
      draft = null;
    } catch (e) {
      catMsg = e instanceof Error ? e.message : String(e);
    } finally {
      catBusy = false;
    }
  }
  async function resetCat(): Promise<void> {
    await clearLocalCatalog(data.folder);
    localCatalog = null;
    cancelCat();
  }

  /** Blob download helper shared by document + catalog exports. */
  function downloadText(filename: string, text: string, mime: string): void {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** download picker: toggle one document of this project */
  function toggleDl(id: string): void {
    if (dlSel.has(id)) dlSel.delete(id);
    else dlSel.add(id);
  }
  /** "select all" / "select none" for the picker */
  function toggleDlAll(): void {
    const all = dlSel.size === myDocs.length && myDocs.length > 0;
    dlSel.clear();
    if (!all) for (const a of myDocs) dlSel.add(a.id);
  }
  /** download every picked document: PDFs as their original bytes, texts as .md/.txt
      (the open document uses its live editor body, incl. unsaved edits) */
  async function downloadSelected(): Promise<void> {
    for (const a of myDocs) {
      if (!dlSel.has(a.id)) continue;
      if (a.kind === "pdf") {
        const pdf = await getPdfData(a.id);
        if (pdf !== null) {
          // .slice() gives a fresh ArrayBuffer-backed view (BlobPart requires it)
          const blob = new Blob([base64ToBytes(pdf.data).slice()], { type: "application/pdf" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = displayName(a.name, "pdf");
          link.click();
          URL.revokeObjectURL(url);
          continue;
        }
      }
      const text =
        a.id === key ? (view ? view.state.doc.toString() : docText) : ((await getArticleById(a.id))?.text ?? "");
      if (text === "") continue;
      const filename = displayName(a.name, a.kind);
      downloadText(filename, text, /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain");
    }
    dlOpen = false;
  }

  // ----- frame-device catalog export / import (local override only) -----

  let catImport = $state<HTMLInputElement | undefined>(undefined);
  let catIoMsg = $state("");

  function exportCatJson(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(`${data.folder}-devices.json`, JSON.stringify(instr, null, 2), "application/json");
  }
  function exportCatQdc(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(
      `${data.folder}.qdc`,
      toQdc(instr, { origin: data.folder, options: prefs.options }),
      "application/xml",
    );
  }
  async function importCat(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const parsed = parseCatalogFile(file.name, await file.text());
      await saveLocalCatalog(data.folder, parsed);
      localCatalog = parsed;
      catIoMsg = `imported ${parsed.devices.length} top-level devices`;
    } catch (err) {
      catIoMsg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const popupEntry = $derived.by(() => {
    const id = popup?.id;
    return id === undefined ? undefined : entries.find((e) => entryId(key, e) === id);
  });

  /** (re)anchor the popup to the chip for `id`, resetting the note draft on a new tag */
  function showPopup(id: string) {
    // works for editor chips (.cm-tag) and PDF view chips alike
    const el = document.querySelector(`[data-tag-entry="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - 272));
    if (popup === null || popup.id !== id) {
      const e = entries.find((x) => entryId(key, x) === id);
      popupNote = e?.note ?? "";
    }
    // anchor the popup ABOVE the chip: y is its distance from the viewport bottom
    popup = { id, x, y: window.innerHeight - r.top };
  }

  /** chip hover: (re)anchor the popup; leaving a chip closes it after a short grace period
      (bridges the chip→popup gap so the popup can actually be entered and used — the
      popup sits directly above the chip, so crossing the gap takes far under 100ms) */
  const POPUP_GRACE_MS = 100;
  let popupTimer: ReturnType<typeof setTimeout> | null = null;
  function chipHover(id: string | null): void {
    if (id !== hoverChip) hoverChip = id;
    if (id === null) {
      if (!overPopup && popupTimer === null) {
        popupTimer = setTimeout(() => {
          popupTimer = null;
          if (!overPopup && hoverChip === null) popup = null;
        }, POPUP_GRACE_MS);
      }
    } else {
      if (popupTimer !== null) {
        clearTimeout(popupTimer);
        popupTimer = null;
      }
      showPopup(id);
    }
  }
  onDestroy(() => {
    if (popupTimer !== null) clearTimeout(popupTimer);
  });

  /** shared entry creation: editor mouseup and PdfView selection both land here */
  function addEntryFromOffsets(selFrom: number, selTo: number, fromEditor: boolean): void {
    if (armed === null || mode !== "code") return;
    // the ranking's recency signal: this device was just used on this document
    quick.use(keyToId.get(armed) ?? armed);
    const text = docText;
    const s = lineStarts(text);
    // trim whitespace at both ends: a multi-line drag otherwise codes
    // the trailing spaces / leading indents of each line, rendering as
    // floating bars over whitespace
    let from = selFrom;
    let to = selTo;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (from >= to) return;
    const uid = crypto.randomUUID();
    const entry = entryFromOffsets(key, s, text, from, to, armed, uid);
    // coding the same span with the same device twice is redundant: dedupe by
    // content — the uid keeps an entry's identity across text edits, but a
    // fresh uid per click would let the same span be coded over and over
    const dup = entries.some(
      (e) =>
        (e.device ?? e.code) === (entry.device ?? entry.code) &&
        e.line === entry.line &&
        (e.endLine ?? e.line) === (entry.endLine ?? entry.line) &&
        e.range[0] === entry.range[0] &&
        e.range[1] === entry.range[1],
    );
    if (dup) {
      if (fromEditor && view) view.dispatch({ selection: { anchor: to } });
      return;
    }
    livePos.set(entryId(key, entry), { from, to });
    entries = [...entries, entry];
    pending = true;
    scheduleCommit();
    if (fromEditor && view) view.dispatch({ selection: { anchor: to } });
  }

  function setPopupNote(value: string) {
    popupNote = value;
    const e = popupEntry;
    if (e === undefined) return;
    const id = entryId(key, e);
    entries = entries.map((x) => (entryId(key, x) === id ? { ...x, note: value } : x));
    pending = true;
    scheduleCommit();
  }
  /* the cursor tag + the bar hint show the short tag, not the numeric code */
  /** palette key of the armed device (numeric display code) */
  const armedCode = $derived(armed === null ? "" : (displayByDevice.get(armed) ?? armed));
  /** what the cursor tag shows: the short tag, not the numeric code */
  const armedLabel = $derived(armed === null ? "" : quickLabel(armed));

  // cursor-following ctag while armed (article parity)
  let cursor = $state({ x: 0, y: 0 });
  let dragging = $state(false);

  function markerVars(code: string): string {
    const c = palette.get(code);
    if (!c) return "";
    return [
      `--marker:${c.light.marker}`,
      `--marker-d:${c.dark.marker}`,
      `--on-marker:${c.light.on}`,
      `--on-marker-d:${c.dark.on}`,
    ].join("; ");
  }

  // anchor any entry that has no live geometry yet (initial load, server import,
  // undo bringing back an entry) using its stored line/range against the doc.
  // runs before the sync effect so specs see fresh geometry in the same pass.
  $effect(() => {
    if (!mounted) return;
    for (const e of entries) {
      const id = entryId(key, e);
      if (livePos.has(id)) continue;
      const from = docStarts[e.line - 1] + e.range[0];
      const to = docStarts[(e.endLine ?? e.line) - 1] + e.range[1];
      if (Number.isFinite(from) && Number.isFinite(to) && from < to) livePos.set(id, { from, to });
    }
  });

  $effect(() => {
    if (!view) return;
    try {
      syncCodingMarks(view, specs);
    } catch (e) {
      editMsg = `marks: ${String(e)}`;
    }
  });

  function pick(id: string) {
    if (!UUID_RE.test(id)) return;
    if (mode === "edit") setMode("code"); // any coding action auto-exits edit mode
    armed = armed === id ? null : id;
    popup = null;
    saveMsg = "";
    editMsg = "";
  }

  /** project the current live geometry back onto the doc as line/range/excerpt codes */
  function deriveCodes(): CodeEntry[] {
    const text = view ? view.state.doc.toString() : docText;
    const s = lineStarts(text);
    const out: CodeEntry[] = [];
    for (const e of entries) {
      const r = livePos.get(entryId(key, e));
      if (r === undefined || r.from >= r.to) continue;
      const e2: CodeEntry = { ...offsetsSpan(s, text, r.from, r.to) };
      if (e.uid !== undefined) e2.uid = e.uid;
      if (e.device !== undefined) e2.device = e.device;
      else if (e.code !== undefined) e2.code = e.code;
      if (e.note !== undefined) e2.note = e.note;
      out.push(e2);
    }
    return out;
  }

  /** persist the current doc + re-derived codes into the local database */
  async function flushCommit(): Promise<boolean> {
    // PDF docs have no CodeMirror view: commit against the extracted docText
    if (key === "" || committing || (!view && !mounted)) return false;
    committing = true;
    try {
      await saveArticle(key, view ? view.state.doc.toString() : docText, deriveCodes());
      pending = false;
      return true;
    } catch (e) {
      editMsg = String(e);
      return false;
    } finally {
      committing = false;
      if (pending) scheduleCommit(0);
    }
  }

  async function doCommit(): Promise<void> {
    await flushCommit();
  }

  async function save() {
    if (key === "" || (!view && !mounted)) return;
    saving = true;
    if (commitTimer !== undefined) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    await flushCommit();
    saving = false;
  }

  async function snapshot() {
    if (key === "" || (!view && !mounted)) return;
    await flushCommit();
    try {
      // the live article subscription already reports the new `versions.length`,
      // so counting up here would double-count when its change event lands first
      await addVersion(key);
      flashSaveMsg("version saved");
    } catch (e) {
      editMsg = String(e);
    }
  }

  function removeCode(e: CodeEntry) {
    const id = entryId(key, e);
    entries = entries.filter((x) => entryId(key, x) !== id);
    livePos.delete(id);
    pending = true;
    scheduleCommit();
    void removeEntry(key, e).catch((err: unknown) => (editMsg = String(err)));
    popup = null;
  }

  function startRename(): void {
    renameDraft = data.name;
    renaming = true;
  }
  async function commitRename(): Promise<void> {
    const name = renameDraft.trim();
    renaming = false;
    if (name === "" || name === data.name || key === "") return;
    if (await getArticle(data.folder, name)) {
      editMsg = `"${name}" already exists in ${data.folder}/`;
      return;
    }
    try {
      await renameArticle(key, name);
    } catch (e) {
      // schema validation (e.g. a name over the 200-char limit) must surface in the UI
      editMsg = String(e);
      return;
    }
    await goto(resolve("/text/[folder]/[name]", { folder: data.folder, name }));
  }

  /** restore a version snapshot; the current state is kept as a new version first */
  async function revertTo(v: ArticleVersion): Promise<void> {
    if (key === "") return;
    if (commitTimer !== undefined) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    await flushCommit();
    await addVersion(key);
    livePos.clear();
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v.text } });
    // PDF docs have no CodeMirror view: the extracted docText is the body
    else docText = v.text;
    entries = v.codes.map((e) => ({ ...e }));
    seedPositions();
    pending = true;
    scheduleCommit(0);
    versionsOpen = false;
    flashSaveMsg("reverted");
  }

  function startEditor(): void {
    if (!parent || view) return;
    view = new EditorView({
      state: EditorState.create({
        doc: docText,
        extensions: [
          EditorView.lineWrapping,
          // coding mode keeps the body read-only; edit mode reconfigures this
          roComp.of(EditorState.readOnly.of(mode === "code")),
          // .md documents: markdown syntax + YAML frontmatter token colors
          langComp.of(isMd ? mdExtensions() : []),
          // session-only undo/redo; durable history lives in article versions
          history(),
          keymap.of(historyKeymap),
          // selection is folded into specs as a mark; mirror CM's main range,
          // and remap every live entry range through doc edits (incl. undo/redo)
          EditorView.updateListener.of((u) => {
            if (u.selectionSet) {
              const r = u.state.selection.main;
              selRange = r.empty ? null : { from: r.from, to: r.to };
            }
            if (u.docChanged) {
              docText = u.state.doc.toString();
              const cs = u.changes;
              livePos.forEach((r, id) => {
                livePos.set(id, { from: cs.mapPos(r.from), to: cs.mapPos(r.to) });
              });
              pending = true;
              scheduleCommit();
            }
          }),
          // listed before codingMarks: its click-selection dispatch updates the
          // selection before the mouseup-add handler reads it
          smartSelect({
            enabled: () => smart && mode === "code",
            armed: () => armed !== null,
            // PDF extracted text: every line is a discrete layout line → hard breaks
            hard: () => isPdf,
            onPreview: (s) => {
              previewRange = s;
            },
          }),
          codingMarks(
            // hovering a chip (re)anchors its popup; leaving it closes the popup
            // unless the pointer moved into the popup itself
            (id) => chipHover(id),
            // marker hover is intentionally off (only tag/chip hover drives the
            // dimming) — kept as a no-op listener so the chip callbacks stay paired
            (id) => {
              void id;
              if (hoverId !== null) hoverId = null;
            },
            // add on mouse release only: during a drag CM dispatches a selection
            // transaction per mousemove, so updateListener would fire per-pixel
            (selFrom, selTo) => addEntryFromOffsets(selFrom, selTo, true),
          ),
        ],
      }),
      parent: parent ?? document.body,
    });

    try {
      syncCodingMarks(view, specs);
    } catch (e) {
      editMsg = `marks: ${String(e)}`;
    }
  }

  $effect(() => {
    // one-shot: seedPositions() reads `entries`, so without the initialLoaded gate
    // a later entries emission would re-run this effect and wipe the live state
    if (view || loading || missing || !initial || initialLoaded) return;
    const isPdfDoc = initial.article.kind === "pdf";
    // the editor div only exists for text docs; PDF docs load the PdfView chunk instead
    if (!isPdfDoc && !parent) return;
    // an empty document starts in edit mode so the text can be pasted/typed first
    mode = isPdfDoc ? "code" : initial.article.text.trim() === "" ? "edit" : "code";
    article = initial.article;
    entries = initial.entries;
    versionCount = initial.article.versions.length;
    docText = initial.article.text;
    initialLoaded = true;
    seedPositions();
    if (isPdfDoc) {
      void import("$lib/coding/PdfView.svelte").then((m) => (PdfViewComp = m.default));
      void getPdfData(initial.article.id).then((d) => (pdfDoc = d));
    } else {
      startEditor();
    }
    mounted = true;
  });

  // PDF surface toggle: "doc" = PdfView (canvas + overlay marks), "text" = the
  // extracted canonical text in the read-only editor — both code the same offsets
  $effect(() => {
    if (!mounted || !isPdf) return;
    if (pdfMode === "text") {
      if (view === undefined) startEditor();
    } else if (view !== undefined) {
      void flushCommit();
      selRange = null;
      previewRange = null;
      view.destroy();
      view = undefined;
    }
  });

  onMount(() => {
    void getLocalCatalog(data.folder).then((c) => {
      localCatalog = c;
    });
    const unsubDocs = watchArticles((list) => (docs = list));
    unsubscribe = watchArticle(data.folder, data.name, (a, es) => {
      if (a === null) {
        if (!initialLoaded) {
          missing = true;
          loading = false;
        }
        return;
      }
      if (!initialLoaded) {
        initial = { article: a, entries: es };
        loading = false;
        return;
      }
      article = a;
      versionCount = a.versions.length;
      if (!pending) {
        entries = es;
        seedPositions();
      }
    });

    return () => {
      if (msgTimer !== undefined) clearTimeout(msgTimer);
      // a document switch remounts this component (keyed +page.svelte): flush queued edits first
      if (commitTimer !== undefined) {
        clearTimeout(commitTimer);
        commitTimer = undefined;
      }
      if (pending) void flushCommit();
      unsubDocs();
      unsubscribe?.();
      view?.destroy();
    };
  });
</script>

<svelte:head>
  <title>{data.name} — coding</title>
</svelte:head>

<svelte:window
  onmousemove={(e) => {
    if (armed !== null) cursor = { x: e.clientX, y: e.clientY };
  }}
  onmousedown={(e) => {
    dragging = true;
    // Bits debounces its outside-interaction check (~10ms); a target that unmounts itself
    // on click (e.g. the edit pill switching modes) then fails its containment check, so
    // close the versions popover here too — mousedown fires before any click handler.
    if (versionsOpen && !(e.target as HTMLElement).closest(".vbtn, .versions")) versionsOpen = false;
  }}
  onmouseup={() => (dragging = false)}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      armed = null;
      popup = null;
      versionsOpen = false;
    }
  }}
/>

{#if loading}
  <main class="status">
    <p>Loading local article…</p>
  </main>
{:else if missing}
  <main class="status">
    <h1>{data.name}</h1>
    <p>This article does not exist in local storage.</p>
    <p>
      <a href={resolve("/project/[folder]", { folder: data.folder })}>← {data.folder}/</a>
      ·
      <a href={resolve("/")}>projects</a>
    </p>
  </main>
{:else}
  <main>
    <Dialog.Root bind:open={colorsOpen}>
      <PaneGroup class="workspace" direction="horizontal" autoSaveId={`workspace:${data.folder}`}>
        <Pane
          bind:this={treePane}
          collapsible
          collapsedSize={WS_TREE.collapsed}
          minSize={WS_TREE.min}
          maxSize={WS_TREE.max}
          defaultSize={WS_TREE.def}
          onCollapse={() => (treeOpen = false)}
          onExpand={() => (treeOpen = true)}
        >
          <aside class="docs" class:closed={!treeOpen}>
            <Collapsible.Root class="treeroot" bind:open={treeOpen}>
              <div class="docshead">
                <Collapsible.Trigger
                  class={`treebtn ${treeOpen ? "" : "closed"}`}
                  aria-label="toggle document tree"
                  title={treeOpen ? "collapse document tree" : "expand document tree"}
                >
                  <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
                  {#if treeOpen}{data.folder}{/if}
                </Collapsible.Trigger>
                {#if treeOpen}
                  <button
                    type="button"
                    class="newdoc"
                    disabled={docsBusy}
                    title="new document in {data.folder}"
                    aria-label="new document in {data.folder}"
                    onclick={() => void newDoc(data.folder)}
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">note_add</span>
                  </button>
                {/if}
              </div>
              <Collapsible.Content class="docsbody">
                <ScrollArea.Root class="wsarea" type="hover">
                  <ScrollArea.Viewport class="wsview treeview">
                    <div class="uprow">
                      <div
                        class="upload"
                        {...fileUpload.dropzone}
                        title="upload .txt/.md/.pdf files into {data.folder}/"
                      >
                        <span class="material-symbols-rounded" aria-hidden="true">upload</span>
                        {fileUpload.isDragging ? `drop → ${data.folder}/` : `file → ${data.folder}/`}
                      </div>
                      <label class="upfolder" title="upload a whole folder of .txt/.md/.pdf files into {data.folder}/">
                        <span class="material-symbols-rounded" aria-hidden="true">upload</span>folder
                        <input type="file" webkitdirectory={true} onchange={(e) => void uploadFolder(e)} />
                      </label>
                    </div>
                    <input {...fileUpload.input} />
                    {#if uploadMsg}<span class="upmsg">{uploadMsg}</span>{/if}
                    <div class="fgrow">
                      <button
                        type="button"
                        class="fgroup sel"
                        aria-pressed="true"
                        title="selected upload target — uploads and new documents land in {data.folder}/"
                      >
                        <span class="material-symbols-rounded" aria-hidden="true">folder</span>{data.folder}/
                        <span class="fcodes">{myDocs.length}</span></button
                      >
                    </div>
                    <ul>
                      {#each myDocs as a (a.id)}
                        <li class:current={a.name === data.name}>
                          <a href={resolve("/text/[folder]/[name]", { folder: a.project, name: a.name })}>
                            <span class="material-symbols-rounded docicon" aria-hidden="true">{docIcon(a)}</span>
                            {displayName(a.name, a.kind)}
                          </a>
                          <span class="fcodes">{a.codes}</span>
                          <button
                            type="button"
                            class="fdel"
                            title="delete document"
                            aria-label={`delete ${displayName(a.name, a.kind)}`}
                            onclick={() =>
                              askDelete(
                                `Delete "${displayName(a.name, a.kind)}"?`,
                                `This removes the document and its ${a.codes} code entr${a.codes === 1 ? "y" : "ies"}.`,
                                () => void doDeleteDoc(a),
                              )}
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">delete</span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  </ScrollArea.Viewport>
                  <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
                    <ScrollArea.Thumb class="wsthumb" />
                  </ScrollArea.Scrollbar>
                </ScrollArea.Root>
              </Collapsible.Content>
            </Collapsible.Root>
          </aside>
        </Pane>
        <PaneResizer class={`wshandle ${treeOpen ? "" : "dim"}`} />
        <Pane minSize={WS_DOC.min} defaultSize={WS_DOC.def}>
          <div class="doccol">
            <header>
              {#if renaming}
                <input
                  class="rename"
                  aria-label="document name"
                  bind:value={renameDraft}
                  spellcheck="false"
                  use:renameCaret
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      void commitRename();
                    } else if (e.key === "Escape") {
                      e.stopPropagation();
                      renaming = false;
                    }
                  }}
                  onblur={() => (renaming = false)}
                />
              {:else}
                <h1>
                  <button type="button" class="title" onclick={startRename} title="rename document">{titleName}</button>
                </h1>
              {/if}
              <div class="bar">
                <a
                  class="pill back"
                  href={resolve("/project/[folder]", { folder: data.folder })}
                  aria-label="back to project {data.folder}"
                  title="back to {data.folder}/"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">arrow_back</span>{data.folder}
                </a>
                {#if mode === "code"}
                  {#if !isPdf}
                    <button type="button" class="modebtn" aria-label="edit text" onclick={() => setMode("edit")}>
                      <span class="material-symbols-rounded" aria-hidden="true">edit_document</span>edit
                    </button>
                  {/if}
                  <Toggle.Root
                    class={`smart ${smart ? "on" : ""}`}
                    bind:pressed={smart}
                    title="select by word/quote/sentence instead of raw characters"
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">wand_shine</span>
                    Smart Select
                  </Toggle.Root>
                {:else}
                  <button
                    type="button"
                    class="modebtn finish"
                    aria-label="finish editing"
                    onclick={() => setMode("code")}
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">done</span>finish
                  </button>
                  <span class="hint">editing mode</span>
                  {#if isMd}
                    <Popover.Root bind:open={mdOpen}>
                      <Popover.Trigger class="pill mdhelp" title="markdown syntax cheatsheet">
                        <span class="material-symbols-rounded" aria-hidden="true">format_size</span>Markdown
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content class="cheatsheet" role="dialog" aria-label="markdown cheatsheet">
                          <h3>Markdown cheatsheet</h3>
                          <p class="cheatnote">
                            This syntax only matters when the file is later converted to HTML or PDF (e.g. with pandoc)
                            — plain reading ignores the markers.
                          </p>
                          <dl>
                            <dt>YAML header — meta data at the very top</dt>
                            <dd>
                              <pre>---
title: My document
author: Me
date: 2026-02-01
tags: coding, example
---</pre>
                              Not shown as text: the converter reads it as document meta data (title, author, date on the
                              HTML/PDF title).
                            </dd>
                            <dt>Headers</dt>
                            <dd>
                              <pre># Header 1
## Header 2
### Header 3
#### Header 4
##### Header 5
###### Header 6</pre>
                              →<code>&lt;h1&gt;</code>…<code>&lt;h6&gt;</code>: big bold title down to a small heading.
                            </dd>
                            <dt>Text</dt>
                            <dd>
                              <pre>*italic*  _italic_
**strong**  __strong__
***italic & strong***  ___i&s___
~~strikethrough~~</pre>
                              →<em>italic</em>, <strong>bold</strong>, both, <del>strikethrough</del>.
                            </dd>
                            <dt>Links</dt>
                            <dd>
                              <pre>&lt;https://my_link.com&gt;
[MyLinkname](https://my_link.com)</pre>
                              → clickable link, bare URL or with your own label.
                            </dd>
                            <dt>Lists</dt>
                            <dd>
                              <pre>* Item 1
  * Subitem 1
    * Subsubitem 1

1. Item 1
2. Item 2
3. Item 21

- [x] item done
- [ ] item todo</pre>
                              → bulleted list (indent = nesting), numbered list (number items in order), task list → ☑ / ☐.
                            </dd>
                          </dl>
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  {/if}
                {/if}
                <span class="spacer"></span>
                {#if isPdf}
                  <RadioGroup.Root class="viewtoggle" bind:value={pdfMode} aria-label="PDF view">
                    <RadioGroup.Item
                      class={`seg ${pdfMode === "doc" ? "on" : ""}`}
                      value="doc"
                      title="rendered PDF pages"
                    >
                      <span class="material-symbols-rounded" aria-hidden="true">newsmode</span>Full
                    </RadioGroup.Item>
                    <RadioGroup.Item
                      class={`seg ${pdfMode === "text" ? "on" : ""}`}
                      value="text"
                      title="extracted text (the coded canonical text)"
                    >
                      <span class="material-symbols-rounded" aria-hidden="true">convert_to_text</span>Plain Text
                    </RadioGroup.Item>
                  </RadioGroup.Root>
                {/if}
                <Popover.Root bind:open={dlOpen}>
                  <Popover.Trigger class="pill" aria-label="download files" title="download project files">
                    <span class="material-symbols-rounded" aria-hidden="true">download</span>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content class="downloads" role="dialog" aria-label="download files">
                      <div class="dlhead">
                        <span>download from {data.folder}/</span>
                        <button type="button" class="dlsel" onclick={toggleDlAll}>
                          {dlSel.size === myDocs.length && myDocs.length > 0 ? "select none" : "select all"}
                        </button>
                      </div>
                      <ul>
                        {#each myDocs as a (a.id)}
                          <li>
                            <label>
                              <input type="checkbox" checked={dlSel.has(a.id)} onchange={() => toggleDl(a.id)} />
                              {displayName(a.name, a.kind)}
                            </label>
                          </li>
                        {/each}
                      </ul>
                      <button
                        type="button"
                        class="dldl"
                        disabled={dlSel.size === 0}
                        onclick={() => void downloadSelected()}
                      >
                        <span class="material-symbols-rounded" aria-hidden="true">download</span>
                        download {dlSel.size > 0 ? dlSel.size : ""}
                      </button>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
                <Dialog.Trigger class="pill">
                  <span class="material-symbols-rounded" aria-hidden="true">palette</span>colors
                </Dialog.Trigger>
                <Popover.Root bind:open={versionsOpen}>
                  <Popover.Trigger class="save ghost vbtn" title="version history">
                    <span class="material-symbols-rounded" aria-hidden="true">history</span>versions ({versionCount})
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content class="versions" role="dialog" aria-label="versions">
                      <button type="button" class="vsnap" onclick={snapshot}>
                        <span class="material-symbols-rounded" aria-hidden="true">add</span>snapshot now
                      </button>
                      {#each [...(article?.versions ?? [])].reverse() as v, i (i)}
                        <div class="vrow">
                          <span class="vat">{new Date(v.savedAt).toLocaleString()}</span>
                          <span class="vcodes">{v.codes.length} codes</span>
                          <button type="button" class="vrev" onclick={() => revertTo(v)}>
                            <span class="material-symbols-rounded" aria-hidden="true">undo</span>revert
                          </button>
                        </div>
                      {:else}
                        <p class="vempty">No versions yet — snapshot the current state.</p>
                      {/each}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
                {#if pending}
                  <button type="button" class="save" onclick={save} disabled={saving}>
                    {saving ? "saving…" : "save"}
                  </button>
                {:else}
                  <span class="msg saved">saved</span>
                {/if}
                {#if saveMsg}<span class="msg">{saveMsg}</span>{/if}
                {#if editMsg}<span class="msg err">{editMsg}</span>{/if}
              </div>
            </header>
            {#if isPdf && pdfMode === "doc"}
              {#if pdfDoc !== null && PdfViewComp !== null}
                <PdfViewComp
                  data={pdfDoc.data}
                  text={docText}
                  marks={pdfMarks}
                  armed={armed !== null}
                  {smart}
                  preview={previewRange}
                  onadd={(from, to) => addEntryFromOffsets(from, to, false)}
                  onselect={(r) => (selRange = r)}
                  onpreview={(r) => (previewRange = r)}
                  onhovermark={chipHover}
                />
              {:else}
                <div class="pdfmissing">no stored PDF for this document — re-upload it to render the pages</div>
              {/if}
            {:else}
              <div
                class="editor"
                class:arm={armed !== null}
                class:smartsel={smart}
                style={armed !== null ? markerVars(armedCode) : ""}
                bind:this={parent}
              ></div>
            {/if}
          </div>
        </Pane>
        <PaneResizer class={`wshandle ${catOpen ? "" : "dim"}`} />
        <Pane
          bind:this={catPane}
          collapsible
          collapsedSize={WS_CAT.collapsed}
          minSize={WS_CAT.min}
          maxSize={WS_CAT.max}
          defaultSize={WS_CAT.def}
          onCollapse={() => (catOpen = false)}
          onExpand={() => (catOpen = true)}
        >
          <aside class="catalog" class:closed={!catOpen} data-pal={paletteTick}>
            <ScrollArea.Root class="wsarea" type="hover">
              <ScrollArea.Viewport class="wsview catview">
                <Collapsible.Root class="catroot" bind:open={catOpen}>
                  <Collapsible.Trigger class="catbtn" aria-label="toggle devices codes">
                    <span class="material-symbols-rounded" aria-hidden="true">account_tree</span>
                    {#if catOpen}Devices codes{/if}
                  </Collapsible.Trigger>
                  <Collapsible.Content class="catbody">
                    <div class="cathd">
                      <div class="cathead">
                        <button
                          type="button"
                          class="cattool addcat"
                          title="add a new code category (top-level device)"
                          onclick={() => startAdd(null)}
                        >
                          <span class="material-symbols-rounded" aria-hidden="true">add</span>new category
                        </button>
                        <button
                          type="button"
                          class="cattool addcode"
                          title={armed === null
                            ? "add a new code (top-level; arm a device first to nest under it)"
                            : "add a new code under the armed device"}
                          onclick={() => startAdd(armed)}
                        >
                          <span class="material-symbols-rounded" aria-hidden="true">add</span>new code
                        </button>
                        {#if !editCat && localCatalog !== null}
                          <button type="button" class="editcat" aria-label="edit devices" onclick={startEditCat}>
                            <span class="material-symbols-rounded" aria-hidden="true">edit</span>Edit
                          </button>
                        {/if}
                      </div>
                      {#if !editCat && localCatalog !== null}
                        <div class="cattools">
                          <button
                            type="button"
                            class="cattool"
                            onclick={exportCatJson}
                            title="export frame devices as JSON"
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">file_download</span>json
                          </button>
                          <button
                            type="button"
                            class="cattool"
                            onclick={exportCatQdc}
                            title="export frame devices as .qdc (lossy)"
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">file_download</span>.qdc
                          </button>
                          <button
                            type="button"
                            class="cattool"
                            onclick={() => catImport?.click()}
                            title="import frame devices from .json or .qdc"
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>import
                          </button>
                          <input
                            type="file"
                            accept=".json,.qdc"
                            class="catfile"
                            bind:this={catImport}
                            onchange={(e) => void importCat(e)}
                          />
                        </div>
                      {/if}
                      {#if editCat && draft}
                        <div class="catbar">
                          <button type="button" class="catfinish" onclick={saveCat} disabled={catBusy}>
                            {catBusy ? "saving…" : "save catalog"}
                          </button>
                          <button type="button" class="catcancel" onclick={cancelCat}>cancel</button>
                          <button
                            type="button"
                            class="cattool"
                            onclick={() => draftAdd(null)}
                            title="add a top-level device"
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">add</span>new device
                          </button>
                          {#if localCatalog !== null}
                            <button type="button" class="catcancel" onclick={resetCat} title="discard the local catalog"
                              >remove catalog</button
                            >
                          {/if}
                          {#if catMsg}<span class="msg err">{catMsg}</span>{/if}
                        </div>
                      {/if}
                    </div>
                    {#if catIoMsg}<p class="catio">{catIoMsg}</p>{/if}
                    {#if editCat && draft}
                      <CatalogTree
                        catalog={draftView}
                        selected={armed}
                        styleFor={(n) => colorVars(n.code)}
                        onhover={(id) => (hoverDevice = id)}
                        editing
                        onrename={draftRename}
                        ontag={draftTag}
                        onmove={draftMove}
                        onadd={draftAdd}
                        ondelete={askDeleteDevice}
                      />
                    {:else}
                      <CatalogTree
                        {catalog}
                        selected={armed}
                        styleFor={(n) => colorVars(n.code)}
                        onpick={pick}
                        onhover={(id) => (hoverDevice = id)}
                      />
                    {/if}
                  </Collapsible.Content>
                </Collapsible.Root>
              </ScrollArea.Viewport>
              <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
                <ScrollArea.Thumb class="wsthumb" />
              </ScrollArea.Scrollbar>
            </ScrollArea.Root>
          </aside>
        </Pane>
      </PaneGroup>

      <Dialog.Overlay class="dlg-overlay" />
      <Dialog.Content class="colorsdlg" aria-label="colors">
        <Dialog.Close class="dlgclose" aria-label="close colors">
          <span class="material-symbols-rounded" aria-hidden="true">close</span>
        </Dialog.Close>
        <ColorPanel />
      </Dialog.Content>

      {#if popup !== null && popupEntry !== undefined}
        {@const popupEntryKey = popupEntry.device ?? popupEntry.code ?? ""}
        {@const fullName = nameByDevice.get(popupEntryKey) ?? popupEntryKey}
        {@const t = tagFor(displayByDevice.get(popupEntryKey) ?? popupEntryKey)}
        <div
          class="tpopup"
          style={`left: ${popup.x}px; bottom: ${popup.y}px; --tag:${t.marker}; --tag-d:${t.markerD}; --tag-on:${t.on}; --tag-on-d:${t.onD}`}
          role="dialog"
          tabindex={-1}
          aria-label="code entry"
          onmouseenter={() => {
            overPopup = true;
            if (popupTimer !== null) {
              clearTimeout(popupTimer);
              popupTimer = null;
            }
          }}
          onmouseleave={() => {
            overPopup = false;
            // leaving the popup re-arms the grace close (re-entering cancels it)
            chipHover(null);
          }}
        >
          <span class="tname">{fullName}</span>
          <textarea
            class="tnote"
            rows={2}
            placeholder="note"
            value={popupNote}
            oninput={(e) => setPopupNote(e.currentTarget.value)}></textarea>
          <button type="button" class="del" onclick={() => popupEntry !== undefined && removeCode(popupEntry)}>
            delete
          </button>
        </div>
      {/if}
      {#if armed !== null && !dragging}
        <div class="ctag" style={`left: ${cursor.x + 14}px; top: ${cursor.y + 14}px; ${markerVars(armedCode)}`}>
          {armedLabel}
        </div>
      {/if}
    </Dialog.Root>

    <ConfirmDialog
      bind:open={confirmOpen}
      title={confirmAction?.title ?? ""}
      detail={confirmAction?.detail ?? ""}
      onconfirm={() => confirmAction?.run()}
    />

    <QuickSelect
      enabled={mode === "code" && mounted && !renaming && !colorsOpen && !confirmOpen}
      tree={catalog}
      nodeById={quickNodes}
      display={quickDisplay}
      pins={quick.pins}
      labelOf={quickLabel}
      nameOf={(id) => nameByDevice.get(id) ?? id}
      styleFor={quickStyle}
      onpick={quickPick}
      oncancel={() => (armed = null)}
      onpinid={quickPinId}
      onpin={(i, id) => quick.pin(i, id)}
    />
  </main>
{/if}

<style lang="scss">
  main {
    max-width: 90cm;
    margin: 0 auto;
    padding: 1rem 2rem;
    font-family: var(--font-sans, system-ui, sans-serif);
    /* full-viewport app layout: side panels fill the viewport, bar sits above the editor */
    height: 100vh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  h1 {
    margin: 0;
    font-size: 1.3rem;
  }

  /* PDF pages/text radio group: one pill shell, two segments, active filled */
  :global(.viewtoggle) {
    display: inline-flex;
    flex: 0 0 auto; // never shrink — the segments would overflow the shrunk shell
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    overflow: hidden;
    background: var(--surface, white);
  }
  :global(.viewtoggle .seg) {
    font: inherit;
    font-size: 0.8rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
    color: var(--on-surface-variant, #666);
    padding: 0.15rem 0.7rem;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  :global(.viewtoggle .seg + .seg) {
    border-left: 1px solid var(--outline, #888);
  }
  :global(.viewtoggle .seg .material-symbols-rounded) {
    font-size: 1rem;
  }
  :global(.viewtoggle .seg:hover) {
    color: var(--primary, #6750a4);
  }
  :global(.viewtoggle .seg.on) {
    color: var(--on-primary-container, #21005d);
    background: var(--primary-container, #e9ddff);
  }

  .rename {
    font: inherit;
    font-size: 1.3rem;
    font-weight: 700;
    margin: 0 0 0.45rem; /* keep the focus border clear of the bar's finish button */
    width: min(100%, 26rem);
    padding: 0.1rem 0.4rem;
    background: var(--surface, white);
    color: var(--on-surface);
    border: 1px solid var(--primary, #6750a4);
    border-radius: 6px;
  }

  .title {
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    cursor: pointer;

    &:hover {
      text-decoration: underline dotted;
    }
  }

  /* resizable workspace: PaneForge lays the panes out as a flex row and writes its
     own inline display/width/height styles, so the overrides here need !important.
     The group renders its own element → :global (scoped CSS cannot match it) */
  :global(.workspace) {
    gap: 0.75rem;
    flex: 1;
    min-height: 0;
    height: auto !important;
  }

  /* the panes render their own divs: they carry the column layout the asides expect */
  :global([data-pane]) {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* drag handle between two panes: a fixed-width hit area (so thickening never shifts
     the layout) with a 1px line centered in it; the line thickens + takes the primary
     color under the pointer, while dragged, and on keyboard focus */
  :global(.wshandle) {
    position: relative;
    flex: 0 0 9px;
    align-self: stretch;
    padding: 0;
    border: none;
    background: transparent;
    touch-action: none;

    &::before {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: 50%;
      width: 1px;
      margin-left: -0.5px;
      border-radius: 999px;
      background: var(--outline, #888);
      opacity: 0.5;
      transition:
        width 0.14s ease,
        margin-left 0.14s ease,
        opacity 0.14s ease,
        background 0.14s ease;
    }

    /* a collapsed sidebar's rail: faint, but it stays draggable — dragging it back
       out expands the pane and the Collapsible state follows via onExpand */
    &.dim::before {
      opacity: 0.22;
    }

    &:hover::before,
    &:focus-visible::before,
    &[data-active]::before {
      width: 5px;
      margin-left: -2.5px;
      opacity: 1;
      background: var(--primary, #6750a4);
    }
  }

  /* center column: title + bar sit directly above the editor */
  .doccol {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    min-height: 0;
  }

  aside {
    min-height: 0;
  }

  /* frame-devices sidebar: fills the viewport, tree scrolls inside */
  aside.catalog {
    display: flex;
    flex-direction: column;
    height: 100%;

    .cathd {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--surface, white);
      padding: 0.2rem 0;
    }
  }
  /* Bits Collapsible.Root wrapper carries the aside's flex column (like .treeroot) */
  :global(.catroot) {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
  }
  :global(.catbtn) {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    background: var(--surface-variant, #eee);
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  :global(.catbtn:hover) {
    color: var(--primary, #6750a4);
    border-color: var(--primary, #6750a4);
  }
  :global(.catbody) {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
    transition: opacity 0.18s ease;
  }
  /* Bits keeps closed content mounted with [hidden] — restore the UA's display:none */
  :global(.catbody[hidden]) {
    display: none;
  }

  /* document tree sidebar (collapsible, left of the editor) */
  .docs {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    height: 100%;
  }
  /* Bits Collapsible.Root renders a wrapper div — it carries the column layout */
  :global(.treeroot) {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
  }
  :global(.treebtn) {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    background: var(--surface-variant, #eee);
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  :global(.treebtn:hover) {
    color: var(--primary, #6750a4);
    border-color: var(--primary, #6750a4);
  }
  /* collapsed: the icon fills the narrow column and sits centered in it */
  :global(.treebtn.closed) {
    width: 100%;
    justify-content: center;
  }
  :global(.docsbody) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    transition: opacity 0.18s ease;
  }
  /* Bits keeps closed content mounted with [hidden] — restore the UA's display:none
     (our display:flex would otherwise override it and keep the tree in the a11y tree) */
  :global(.docsbody[hidden]) {
    display: none;
  }
  /* Bits tags the animating surfaces with data-starting/ending-style; presence waits
     for these transitions to finish before hiding the content (collapse fade) */
  :global(.docsbody[data-starting-style]),
  :global(.docsbody[data-ending-style]),
  :global(.catbody[data-starting-style]),
  :global(.catbody[data-ending-style]) {
    opacity: 0;
  }
  .docshead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .newdoc {
    font: inherit;
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--on-surface-variant, #666);

    .material-symbols-rounded {
      font-size: 1.1rem;
    }

    &:hover {
      color: var(--primary, #6750a4);
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .fgroup {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--on-surface-variant, #666);
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    margin: 0.5rem 0 0;
    padding: 0.1rem 0.3rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;

    &:hover {
      color: var(--primary, #6750a4);
    }

    /* the project header is the selected upload target — marked like a picked document */
    &.sel {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
      border-radius: 6px;
    }

    .material-symbols-rounded {
      font-size: 1.05rem;
    }
  }
  /* folder header row: group button + delete button */
  .fgrow {
    display: flex;
    align-items: center;
    gap: 0.2rem;

    .fgroup {
      flex: 1;
      min-width: 0;
    }
  }
  .fdel {
    font: inherit;
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--on-surface-variant, #888);

    &:hover {
      color: #b3261e;
    }

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  .uprow {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.45rem;
  }
  .upload {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.45rem;
    border: 1px dashed var(--outline, #888);
    border-radius: 8px;
    font-size: 0.65rem;
    color: var(--on-surface-variant, #666);
    cursor: pointer;

    &:hover {
      border-color: var(--primary, #6750a4);
      color: var(--primary, #6750a4);
    }

    &[data-dragging] {
      border-color: var(--primary, #6750a4);
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
    }

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  .upmsg {
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
  }
  .upfolder {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    /* same box metrics as the .upload dropzone so the pair reads as siblings */
    padding: 0.3rem 0.45rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    font-size: 0.65rem;
    color: var(--on-surface-variant, #666);
    cursor: pointer;

    &:hover {
      border-color: var(--primary, #6750a4);
      color: var(--primary, #6750a4);
    }

    .material-symbols-rounded {
      font-size: 1rem;
    }

    input {
      display: none;
    }
  }
  .docs ul {
    list-style: none;
    margin: 0.1rem 0 0;
    padding: 0 0 0 0.5rem;
    border-left: 1px solid var(--outline, #ccc);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .docs li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;

    &:hover {
      background: var(--surface-variant, #eee);
    }

    &.current {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
    }

    a {
      flex: 1;
      font-size: 0.85rem;
      text-decoration: none;
      color: inherit;
    }

    .docicon {
      font-size: 1.1rem;
      vertical-align: -0.25em;
      color: var(--on-surface-variant, #666);
    }
  }
  .fcodes {
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    font-variant-numeric: tabular-nums;
  }

  /* colors customization popup (Melt Dialog) */
  @media (max-width: 50rem) {
    /* stacked: back to normal page flow + scrolling */
    main {
      height: auto;
      display: block;
      overflow: visible;
    }

    :global(.workspace) {
      /* stacked: the panes become plain full-width blocks and the rails go away */
      display: block !important;
      height: auto !important;

      :global([data-pane]) {
        flex: none !important;
        width: 100%;
        overflow: visible !important;
      }

      :global(.wshandle) {
        display: none;
      }
    }

    .editor {
      height: 70vh;
    }

    aside.catalog {
      height: auto;
      overflow: visible;
    }

    .docs {
      height: auto;
    }

    :global(.docsbody) {
      max-height: 60vh;
    }
  }

  /* Bits ScrollArea (tree + catalog panes): the Root fills its flex parent, the
     Viewport is the scroller (Bits sets its overflow inline), and Bits' own content
     wrapper carries the column layout while staying tall enough to fill the pane */
  :global(.wsarea) {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  :global(.wsview) {
    /* the app has no global border-box reset: without this the 10px gutter would add
       to the viewport's width and the rail would sit on top of the rows */
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    /* gutter for the overlay rail: the content ends before it, so the rail never
       sits on top of the rows it scrolls */
    padding-right: 10px;
  }
  :global(.wsview > [data-scroll-area-content]) {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    min-width: 0;
  }
  :global(.treeview > [data-scroll-area-content]) {
    gap: 0.15rem;
  }
  :global(.catview > [data-scroll-area-content]) {
    gap: 0.4rem;
  }
  /* hover-fade scrollbar in the theme's colors (Bits fades it via data-state) */
  :global(.wsbar) {
    width: 8px;
    /* Bits pins the rail at right:0 of the Root: nudge it off the pane edge */
    margin-right: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-variant, #ddd) 55%, transparent);
    transition: opacity 0.18s ease;

    &[data-state="hidden"] {
      opacity: 0;
    }

    &[data-state="visible"] {
      opacity: 1;
    }
  }
  :global(.wsthumb) {
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary, #6750a4) 55%, transparent);
  }

  /* the editor keeps CodeMirror's own scroller (sticky gutters, decorations and
     scrollIntoView all anchor to it) — themed to match the panes above */
  :global(.cm-scroller) {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--primary, #6750a4) 45%, transparent) transparent;
  }
  :global(.cm-scroller::-webkit-scrollbar) {
    width: 10px;
    height: 10px;
  }
  :global(.cm-scroller::-webkit-scrollbar-thumb) {
    border: 2px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary, #6750a4) 45%, transparent);
    background-clip: content-box;
  }
  :global(.cm-scroller::-webkit-scrollbar-track) {
    background: transparent;
  }

  .bar {
    display: flex;
    align-items: center;
    /* the bar never wraps: fixed pills keep their size, the flexible parts shrink */
    flex-wrap: nowrap;
    /* narrow window: the pills overflow sideways instead of being clipped away,
       so every control stays reachable (a hidden overflow also let floating-ui
       scroll the bar out from under an open popover) */
    overflow-x: auto;
    scrollbar-width: none;
    gap: 0.75rem;
    min-height: 1.6rem;
    font-size: 0.8rem;
    margin-bottom: 0.5rem;

    > * {
      flex: 0 0 auto;
      /* nowrap bar: a shrinking pill must never break its own label */
      white-space: nowrap;
    }

    /* back to the project this document belongs to */
    .back {
      text-decoration: none;
    }

    .hint {
      font-style: italic;
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .msg {
      color: #0a6b2d;

      /* the dark green is unreadable on the dark surface — use a light green there */
      :root[data-theme="dark"] & {
        color: #86d9a0;
      }

      &.saved {
        opacity: 0.6;
      }

      &.err {
        color: #b3261e;
      }
    }

    .spacer {
      flex: 1 1 0;
      min-width: 0;
    }

    .modebtn {
      font: inherit;
      font-size: 0.8rem;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.1rem 0.6rem;
      border-radius: 999px;
      border: 1px solid var(--outline, #888);
      background: var(--surface, white);
      color: var(--on-surface-variant, #666);
      cursor: pointer;

      .material-symbols-rounded {
        font-size: 1rem;
      }

      &.finish {
        background: var(--primary, #6750a4);
        border-color: var(--primary, #6750a4);
        color: var(--on-primary, white);
        font-size: 0.9rem;
        font-weight: 600;
        padding: 0.25rem 1rem;
      }
    }
  }

  :global(.versions) {
    z-index: 20;
    min-width: 17rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);

    .vsnap {
      font: inherit;
      font-size: 0.8rem;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      border: 1px solid var(--outline, #888);
      background: var(--surface-variant, #eee);
      color: var(--on-surface);
      cursor: pointer;

      .material-symbols-rounded {
        font-size: 1rem;
      }
    }

    .vrow {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.78rem;

      .vat {
        flex: 1;
        color: var(--on-surface-variant, #666);
      }

      .vcodes {
        color: var(--on-surface-variant, #666);
        font-variant-numeric: tabular-nums;
      }

      .vrev {
        font: inherit;
        font-size: 0.75rem;
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        padding: 0.05rem 0.55rem;
        border-radius: 999px;
        border: 1px solid var(--outline, #888);
        background: var(--surface, white);
        color: var(--on-surface);
        cursor: pointer;

        .material-symbols-rounded {
          font-size: 0.95rem;
        }
      }
    }

    .vempty {
      margin: 0;
      font-size: 0.78rem;
      color: var(--on-surface-variant, #666);
    }
  }

  .editcat {
    font: inherit;
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
    background: var(--surface-variant, #eee);
    border: none;
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    margin-left: 0.4rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .material-symbols-rounded {
      font-size: 0.95rem;
    }

    &:hover {
      filter: brightness(1.1);
    }
  }

  /* devices-codes header row: add buttons left, Edit pushed to the right */
  .cathead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;

    .editcat {
      margin-left: auto;
    }
  }

  /* download picker: pick this project's documents, select all, download */
  :global(.downloads) {
    z-index: 20;
    min-width: 15rem;
    max-height: 60vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
    font-size: 0.8rem;

    .dlhead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      font-weight: 600;
    }

    .dlsel {
      font: inherit;
      font-size: 0.72rem;
      padding: 0.05rem 0.55rem;
      border-radius: 999px;
      border: 1px solid var(--outline, #888);
      background: var(--surface, white);
      color: var(--on-surface-variant, #666);
      cursor: pointer;
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }

    label {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
      padding: 0.1rem 0.2rem;
      border-radius: 4px;

      &:hover {
        background: var(--surface-variant, #eee);
      }
    }

    .dldl {
      font: inherit;
      font-size: 0.8rem;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.15rem 0.7rem;
      border-radius: 999px;
      border: 1px solid var(--primary, #6750a4);
      background: var(--primary, #6750a4);
      color: var(--on-primary, white);
      cursor: pointer;
      align-self: flex-start;

      &:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .material-symbols-rounded {
        font-size: 1rem;
      }
    }
  }

  /* markdown cheatsheet popover (edit mode of .md documents) */
  :global(.cheatsheet) {
    z-index: 20;
    width: min(30rem, 90vw);
    max-height: 70vh;
    overflow: auto;
    padding: 0.7rem 0.9rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
    font-size: 0.78rem;

    h3 {
      margin: 0 0 0.3rem;
      font-size: 0.9rem;
    }

    .cheatnote {
      margin: 0 0 0.5rem;
      font-style: italic;
      color: var(--on-surface-variant, #666);
    }

    dl {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    dt {
      font-weight: 700;
      color: var(--primary, #6750a4);
    }

    dd {
      margin: 0.15rem 0 0;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    pre {
      margin: 0;
      padding: 0.35rem 0.5rem;
      background: var(--surface-variant, #eee);
      border-radius: 6px;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      line-height: 1.45;
      overflow-x: auto;
    }

    code {
      font-family: var(--font-mono, monospace);
      font-size: 0.95em;
    }
  }

  .cattools {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .cattool {
    font: inherit;
    font-size: 0.72rem;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .material-symbols-rounded {
      font-size: 0.9rem;
    }

    &:hover {
      filter: brightness(1.1);
    }
  }
  .catfile {
    display: none;
  }
  .catio {
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    margin: 0.3rem 0 0;
  }

  .catbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.3rem 0 0.1rem;
    flex-wrap: wrap;

    .catfinish {
      font: inherit;
      font-size: 0.8rem;
      padding: 0.2rem 0.8rem;
      border-radius: 999px;
      border: 1px solid var(--primary, #6750a4);
      background: var(--primary, #6750a4);
      color: var(--on-primary, white);
      cursor: pointer;
    }

    .catcancel {
      font: inherit;
      font-size: 0.75rem;
      padding: 0.1rem 0.6rem;
      border-radius: 999px;
      border: 1px solid var(--outline, #888);
      background: var(--surface, white);
      color: var(--on-surface-variant, #666);
      cursor: pointer;
    }
  }

  .tag {
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--marker, #666);
    color: white;
  }

  .editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;

    /* CodeMirror must fill the box so .cm-scroller scrolls internally —
       otherwise the growing document pushes the whole page into scrolling */
    :global(.cm-editor) {
      height: 100%;
    }
  }

  :global(.cm-editor.cm-focused) {
    outline: none;
  }

  /* CodeMirror draws the caret as a border on .cm-cursor — the default dark caret
     is invisible on the dark surface, so follow the theme (white caret in dark mode) */
  :global(.cm-editor .cm-cursor) {
    border-left-color: var(--on-surface, #1c1b1f);
  }
  :root[data-theme="dark"] :global(.cm-editor .cm-cursor) {
    border-left-color: #ffffff;
  }

  /* armed keeps the normal text cursor (the floating ctag already signals arming);
     only smart select changes the cursor, to a crosshair, where it would be text */
  .editor.smartsel :global(.cm-content) {
    cursor: crosshair;
  }

  /* selection is drawn by our own .cm-underline mark (see specs) instead of the
     drawSelection layer: hide the native highlight */
  :global(.cm-editor ::selection) {
    background: transparent;
  }

  /* save pill + versions popover trigger (Bits Popover.Trigger renders the button) */
  :global(.bar .save) {
    font: inherit;
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    white-space: nowrap;
    gap: 0.3rem;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  :global(.bar .save.ghost) {
    border-style: dashed;
    opacity: 0.8;
  }

  :global(.smart) {
    cursor: pointer;
    user-select: none;
    flex: 0 0 auto;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    padding: 0.15rem 0.7rem;
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  :global(.smart.on) {
    background: var(--primary-container, #e8def8);
    border-color: var(--primary, #6750a4);
    color: var(--on-primary-container, #21005d);
  }

  /* cursor-following tag while armed (article .ctag parity) */
  .ctag {
    position: fixed;
    z-index: 10;
    pointer-events: none;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 3px;
    background: var(--marker, #666);
    color: var(--on-marker, white);
    white-space: nowrap;
  }

  :root[data-theme="dark"] .ctag {
    background: var(--marker-d, #aaa);
    color: var(--on-marker-d, black);
  }

  :global(.cm-content) {
    font-family: var(--font-serif, Georgia, serif);
    line-height: 2.55;
    padding: 1.35rem 0 0.5rem;
  }

  /* highlight bar hugging the text (article .coded parity); base and hover
     gradients are both precomputed, the hot class swaps in --bars-hot. No abs
     ::after: it misplaces itself on fragmented (wrapped, multi-line) marks */
  :global(.cm-underline) {
    border-radius: 2px;
    background-image: var(--bars, none);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 100% 1.2em;
    color: var(--on-bars, inherit);
  }

  :global(.cm-underline.cm-hot) {
    background-image: var(--bars-hot, var(--bars, none));
    color: var(--on-bars-hot, var(--on-bars, inherit));
  }

  :global(:root[data-theme="dark"] .cm-underline) {
    background-image: var(--bars-d, none);
    color: var(--on-bars-d, inherit);
  }

  :global(:root[data-theme="dark"] .cm-underline.cm-hot) {
    background-image: var(--bars-hot-d, var(--bars-d, none));
    color: var(--on-bars-hot-d, var(--on-bars-d, inherit));
  }

  /* YAML frontmatter block tint (.md documents, see code-md.ts) */
  :global(.cm-frontmatter) {
    background: color-mix(in srgb, var(--outline, #888) 16%, transparent);
    border-radius: 3px;
  }

  /* markdown + frontmatter token styles (.md documents, see code-md.ts) */
  :global(.cm-header-1) {
    font-weight: 700;
    font-size: 1.35em;
  }
  :global(.cm-header-2) {
    font-weight: 700;
    font-size: 1.2em;
  }
  :global(.cm-header-3) {
    font-weight: 700;
    font-size: 1.1em;
  }
  :global(.cm-header-4),
  :global(.cm-header-5),
  :global(.cm-header-6) {
    font-weight: 700;
  }
  :global(.cm-strong) {
    font-weight: 700;
  }
  :global(.cm-em) {
    font-style: italic;
  }
  :global(.cm-link) {
    color: var(--primary, #6750a4);
    text-decoration: underline;
  }
  :global(.cm-url) {
    color: var(--primary, #6750a4);
  }
  :global(.cm-code) {
    font-family: var(--font-mono, monospace);
    background: color-mix(in srgb, var(--outline, #888) 14%, transparent);
    border-radius: 3px;
  }
  :global(.cm-quote) {
    color: var(--on-surface-variant, #666);
    font-style: italic;
  }
  :global(.cm-list) {
    color: var(--primary, #6750a4);
    font-weight: 700;
  }
  :global(.cm-hr),
  :global(.cm-processing) {
    color: var(--outline, #888);
  }
  :global(.cm-property) {
    color: #0080cc;
  }
  :global(.cm-string) {
    color: #b11;
  }
  :global(.cm-number) {
    color: #164;
  }
  :global(.cm-bool) {
    color: #708;
  }
  :root[data-theme="dark"] :global(.cm-property) {
    color: #7fc4ff;
  }
  :root[data-theme="dark"] :global(.cm-string) {
    color: #ff9c9c;
  }
  :root[data-theme="dark"] :global(.cm-number) {
    color: #9fd0ff;
  }
  :root[data-theme="dark"] :global(.cm-bool) {
    color: #d8b4fe;
  }

  /* code label chips floating above the segment start (article .cid parity),
     rendered by the zero-width inline widget */
  :global(.cm-tagline) {
    position: relative;
    display: inline-block;
    width: 0;
    height: 0;
  }

  /* line-height 2.55 with the 1.2em bar centered puts the bar top ~0.9em above
     the baseline, where the chip row anchors */
  :global(.cm-tagrow) {
    position: absolute;
    bottom: 0.9em;
    left: 0;
    z-index: 2;
    display: inline-flex;
    gap: 3px;
    white-space: nowrap;
  }

  :global(.cm-tag) {
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.5;
    padding: 1px 3px;
    border-radius: 3px 3px 0 0;
    background: var(--tag, #888);
    color: var(--tag-on, #fff);
    cursor: pointer;
  }

  :global(:root[data-theme="dark"] .cm-tag) {
    background: var(--tag-d, #888);
    color: var(--tag-on-d, #fff);
  }

  /* when a selection dims unrelated marks, the tags fade their color too
     (color-mix toward transparent, never text opacity) */
  :global(.cm-tag.cm-tag-faded) {
    background: color-mix(in srgb, var(--tag, #888) 16%, transparent);
    color: color-mix(in srgb, var(--tag, #888) 72%, transparent);
  }

  :global(:root[data-theme="dark"] .cm-tag.cm-tag-faded) {
    background: color-mix(in srgb, var(--tag-d, #888) 20%, transparent);
    color: color-mix(in srgb, var(--tag-d, #888) 78%, transparent);
  }

  /* the chip whose popup is open (above it) drops its top corners so the popup
     (bottom corners square, same color) reads as one connected card */
  :global(.cm-tag.cm-tag-open) {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  /* article .id:hover/.hot parity */
  :global(.cm-tag:hover),
  :global(.cm-tag-hot) {
    filter: brightness(1.2);
  }

  :global(:root[data-theme="dark"] .cm-tag:hover),
  :global(:root[data-theme="dark"] .cm-tag-hot) {
    filter: brightness(1.35);
  }

  /* entry detail popup: fixed card anchored above its tag, sharing the tag color
     (bottom corners square + borderless bottom so it joins the chip below) */
  .tpopup {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 16rem;
    max-width: 22rem;
    padding: 0.5rem 0.6rem 0.6rem;
    background: var(--tag, #888);
    color: var(--tag-on, #fff);
    border: 1px solid var(--tag, #888);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    box-shadow: 0 -6px 18px rgb(0 0 0 / 0.18);

    .tname {
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--tag-on, #fff);
    }

    .tnote {
      font: inherit;
      font-size: 0.82rem;
      padding: 0.3rem 0.4rem;
      background: var(--surface, #fff);
      border: 1px solid var(--tag-on, #ccc);
      border-radius: 6px;
      resize: vertical;
    }

    .del {
      align-self: flex-start;
      font: inherit;
      font-size: 0.8rem;
      color: var(--tag-on, #fff);
      border: 1px solid var(--tag-on, #ffffff66);
      border-radius: 999px;
      background: transparent;
      padding: 0.1rem 0.6rem;
      cursor: pointer;
    }
  }

  .status {
    max-width: 40rem;
    margin: 6rem auto;
    padding: 0 2rem;
    text-align: center;
    color: var(--on-surface-variant);
  }

  :global(:root[data-theme="dark"] .tpopup) {
    background: var(--tag-d, #888);
    color: var(--tag-on-d, #fff);
    border-color: var(--tag-d, #888);
  }
</style>
