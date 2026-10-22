<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { EditorView } from "@codemirror/view";
  import { Compartment, EditorState } from "@codemirror/state";
  import { yCollab } from "y-codemirror.next";
  import { WebsocketProvider } from "y-websocket";
  import * as Y from "yjs";
  import { onMount, tick } from "svelte";
  import { fade } from "svelte/transition";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { Dialog, Toggle } from "bits-ui";
  import { Pane, PaneGroup, PaneResizer } from "paneforge";
  import "material-symbols/rounded.css";
  import { buildPalette, onForFill } from "$lib/coding/palette";
  import { useColors } from "$lib/coding/prefs.svelte";
  import AnalysisPanel from "$lib/coding/AnalysisPanel.svelte";
  import CatalogAside from "$lib/coding/CatalogAside.svelte";
  import ColorsDialog from "$lib/coding/ColorsDialog.svelte";
  import ConfirmHost from "$lib/coding/ConfirmHost.svelte";
  import DocTree from "$lib/coding/DocTree.svelte";
  import DownloadPicker from "$lib/coding/DownloadPicker.svelte";
  import EntryPopup from "$lib/coding/EntryPopup.svelte";
  import { EntryPopupCtl } from "$lib/coding/entry-popup.svelte";
  import HistoryPanel from "$lib/coding/HistoryPanel.svelte";
  import MarkdownHelp from "$lib/coding/MarkdownHelp.svelte";
  import Minimap from "$lib/coding/Minimap.svelte";
  import QuickSelect from "$lib/coding/QuickSelect.svelte";
  import { QuickPrefs } from "$lib/coding/quickselect.svelte";
  import { rankDevices, reconcileSlots } from "$lib/coding/quickselect";
  import { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import { codesKey, entryFromOffsets, entryId, isDuplicateEntry, lineStarts, offsetsSpan } from "$lib/coding/edit";
  import { buildCatalogView, indexCatalog } from "$lib/coding/catalog-view";
  import { analysisRows, hotSetFor, litSegments, splitSegments, type Placed } from "$lib/coding/coverage";
  import { createPainter, PREVIEW_CODE, SEL_CODE } from "$lib/coding/paint";
  import { compareNames, displayName } from "$lib/coding/display";
  import { mdExtensions } from "$lib/coding/code-md";
  import { UUID_RE, type Instructions } from "$lib/coding/instructions";
  import type { CatalogView } from "$lib/coding/catalog-view";
  import type { CodeEntry } from "$lib/coding/types";
  import type { ArticleSummary, ArticleVersion } from "$lib/coding/doc";
  import { watchArticlesLocal, watchLocalCatalog, watchProjectsLocal } from "$lib/local/local-api";
  import { onLocalMutated } from "$lib/local/worker-client";
  import {
    codingMarks,
    smartSelect,
    syncCodingHover,
    syncCodingMarks,
    type CodingMarkSpec,
  } from "$lib/coding/code-mark";
  import { cssVar, hoverFadeCss } from "$lib/coding/css-var";
  import { realtimeBase, useAccounts, LOCAL_ACCOUNT_ID } from "$lib/remote/accounts.svelte";
  import type { AnyAccount } from "$lib/remote/accounts.svelte";
  import { PortProvider } from "$lib/local/port-provider";
  import { useRemote } from "$lib/remote/remote-cache.svelte";
  import type { RemoteApi } from "$lib/remote/api";
  import type { RemoteVersion } from "$lib/remote/types";

  /**
   * THE coding page, for every account (marks, chips, smart select, quick select,
   * minimap, analysis, catalog, versions). The document lives in a Yjs room: text
   * and entries sync live between everyone who has the project open, and the REST
   * API owns the catalog, the snapshot history and the document list. The Local
   * account is the same code path against the in-worker server: its room rides a
   * MessagePort (PortProvider) into the SharedWorker instead of a WebSocket.
   */
  const { data }: { data: { account: string; folder: string; name: string } } = $props();

  type Tab = "preview" | "coding" | "edit" | "analysis";

  const accounts = useAccounts();
  const remote = useRemote();

  /* ----- connection state ----- */
  let loading = $state(true);
  let missing = $state(false);
  let barMsg = $state("");
  let wsStatus = $state("connecting");
  let synced = $state(false);
  let api = $state<RemoteApi | null>(null);
  let token = $state("");
  let projectId = $state("");
  let docId = $state("");
  let peers = $state<{ id: number; name: string; color: string }[]>([]);

  /* ----- Yjs document + provider (created once per mount) ----- */
  let ydoc: Y.Doc | null = null;
  let ytext: Y.Text | null = null;
  let ymap: Y.Map<CodeEntry> | null = null;
  let provider: WebsocketProvider | PortProvider | null = null;
  let seeded = false;

  /* ----- live document state (mirrors of the Yjs doc) ----- */
  let docText = $state("");
  const docStarts = $derived(lineStarts(docText));
  let entries = $state<CodeEntry[]>([]);
  const livePos = new SvelteMap<string, { from: number; to: number }>();
  const key = $derived(docId);

  /* ----- snapshot history (REST, mapped onto the graph's shape) ----- */
  let versions = $state<ArticleVersion[]>([]);
  let headVersion = $state<string | null>(null);
  let versionsOpen = $state(false);

  /* ----- catalog (REST, last-write-wins) ----- */
  let localCatalog = $state<Instructions | null>(null);

  /* ----- local projects (the switcher can jump back to them; worker-backed) ----- */
  let docs = $state<ArticleSummary[]>([]);
  let folders = $state<string[]>([]);
  const projects = $derived.by(() => {
    const set = new Set(folders);
    for (const a of docs) set.add(a.project);
    return [...set].sort(compareNames);
  });

  /* ----- editor + coding UI state (same pipeline as CodingDoc) ----- */
  let mounted = $state(false);
  let parent = $state<HTMLDivElement | undefined>(undefined);
  let view = $state.raw<EditorView | undefined>(undefined);
  let visibleRange = $state({ from: 0, to: 0 });
  let kind = $state<"text" | "pdf">("text");
  const isPdf = $derived(kind === "pdf");
  /** stored PDF bytes + lazily loaded PdfView chunk (unpdf stays out of the main bundle) */
  let pdfBytes = $state<Uint8Array | null>(null);
  // component functions stay UNPROXIED: a $state proxy wraps the function and the
  // mounted component loses its init context (effect_orphan on a cold module graph)
  let PdfViewComp = $state.raw<typeof import("$lib/coding/PdfView.svelte").default | null>(null);
  let dlOpen = $state(false);
  let smart = $state(true);
  let tab = $state<Tab>("coding");
  const mode = $derived(tab === "edit" ? "edit" : "code");
  const tabs = $derived<Tab[]>(isPdf ? ["preview", "coding", "analysis"] : ["coding", "edit", "analysis"]);
  const roComp = new Compartment();
  const langComp = new Compartment();
  const isMd = $derived(/\.(md|markdown)$/i.test(data.name));
  const titleName = $derived(displayName(data.name, kind));
  let armed = $state<string | null>(null);
  let selRange: { from: number; to: number } | null = $state(null);
  let previewRange: { from: number; to: number } | null = $state(null);
  let hoverDevice = $state<string | null>(null);
  let hoverId = $state<string | null>(null);
  let renaming = $state(false);
  let renameDraft = $state("");
  let colorsOpen = $state(false);
  let cursor = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  const confirm = new ConfirmAsk();
  const prefs = useColors();
  const pop = new EntryPopupCtl({
    entries: () => entries,
    key: () => key,
  });

  function setTab(t: Tab): void {
    if (tab === t) return;
    tab = t;
    if (t !== "coding") {
      armed = null;
      pop.close();
    }
  }
  /** Title Case label + glyph of a view tab (the bar's pill and its accessible name) */
  const tabLabel = (t: Tab): string =>
    t === "preview" ? "Preview" : t === "coding" ? "Coding" : t === "edit" ? "Edit" : "Analysis";
  const tabIcon = (t: Tab): string =>
    t === "preview" ? "visibility" : t === "coding" ? "draw" : t === "edit" ? "edit_document" : "pie_chart";

  /** the Edit tab makes the body editable; every other tab keeps it read-only.
      The editor div is never unmounted (CodeMirror owns the DOM inside it), so a
      tab switch only reconfigures readOnly — and re-measures coming back from
      Analysis. For PDFs CodeMirror lives only on the Coding tab (Preview owns
      the document otherwise — CodingDoc parity): open creates it, leaving kills it */
  $effect(() => {
    if (view === undefined) {
      if (isPdf && tab === "coding" && mounted) startEditor();
      return;
    }
    view.dispatch({ effects: roComp.reconfigure(EditorState.readOnly.of(tab !== "edit")) });
    if (tab !== "analysis" && !(isPdf && tab === "preview")) view.requestMeasure();
    if (isPdf && tab !== "coding") {
      view.destroy();
      view = undefined;
    }
  });

  /* ----- catalog / palette / paint pipeline (identical to CodingDoc) ----- */
  const entryKeys = $derived(entries.map((e) => e.device ?? e.code ?? "").filter((k) => k !== ""));
  const catalog = $derived(buildCatalogView(localCatalog, entryKeys));
  const index = $derived(indexCatalog(catalog));
  const displayByDevice = $derived(index.displayByDevice);
  const nameByDevice = $derived(index.nameByDevice);
  const keyToId = $derived(index.keyToId);

  const palettePrefer = new SvelteMap([
    [SEL_CODE, 235],
    [PREVIEW_CODE, 205],
  ]);
  const palette = $derived(
    buildPalette(
      [
        ...new SvelteSet([
          ...index.nodes.map((n) => n.code),
          ...entries.map((e) => displayByDevice.get(e.device ?? e.code ?? "") ?? e.code ?? e.device ?? ""),
          SEL_CODE,
          PREVIEW_CODE,
        ]),
      ],
      { prefer: palettePrefer, ...prefs.options },
    ),
  );
  const paletteTick = $derived.by(() => {
    let t = 0;
    for (const c of palette.values())
      t +=
        c.light.marker.charCodeAt(1) + c.light.on.charCodeAt(1) + c.dark.marker.charCodeAt(1) + c.dark.on.charCodeAt(1);
    return t;
  });

  const armedCode = $derived(armed === null ? "" : (displayByDevice.get(armed) ?? armed));
  const paint = $derived(createPainter({ palette, shortByCode: index.shortByCode, armedCode }));

  const styleFor = (n: CatalogView) => paint.colorVars(n.code);
  const onhover = (id: string | null) => (hoverDevice = id);

  const fadeIds = $derived.by(() => {
    const seen = new SvelteSet<string>();
    const out: string[] = [];
    const add = (id: string): void => {
      const v = cssVar(id);
      if (seen.has(v)) return;
      seen.add(v);
      out.push(id);
    };
    for (const n of index.nodes) add(n.id);
    for (const k of entryKeys) add(k);
    return out;
  });
  const hoverCss = $derived(hoverFadeCss(fadeIds, catalog));
  const fadeAll = $derived(selRange !== null || previewRange !== null);
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
  const EMPTY_SPECS: CodingMarkSpec[] = [];
  const EMPTY_BARS: { id: string; from: number; to: number; style: string }[] = [];
  const EMPTY_IDS: string[] = [];
  /** the same subtree as an array (PdfView's viewport overlay prop) */
  const hoverDevices = $derived(hoverKeys ? [...hoverKeys] : EMPTY_IDS);

  const quickSurface = $derived(
    parent ?? (typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".pdfview")),
  );
  const quick = new QuickPrefs(
    () => data.folder,
    () => key,
  );
  const quickNodes = $derived(index.byId);
  const quickCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>();
    for (const e of entries) {
      const id = keyToId.get(e.device ?? e.code ?? "");
      if (id === undefined) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  });
  const quickRanked = $derived(rankDevices(quickCounts, quick.recent));
  const quickDisplay = $derived(reconcileSlots(quick.slots, quick.pins, quickRanked, quick.count, quickNodes));
  $effect(() => quick.sync(quickDisplay));
  const quickLabel = (id: string) => {
    const code = displayByDevice.get(id) ?? id;
    return index.shortByCode.get(code) ?? code;
  };
  const quickStyle = (id: string) => paint.colorVars(displayByDevice.get(id) ?? id);
  function quickPick(id: string): void {
    if (!UUID_RE.test(id)) return;
    if (tab === "edit") setTab("coding");
    const sel = selRange;
    armed = id;
    pop.close();
    barMsg = "";
    if (sel !== null && sel.to > sel.from) addEntryFromOffsets(sel.from, sel.to, true);
  }
  function quickPinId(id: string): void {
    const at = quickDisplay.indexOf(id);
    const free = quickDisplay.indexOf(null);
    const slot = at >= 0 ? at : free >= 0 ? free : quick.count - 1;
    quick.pin(slot, quick.pins[slot] === id ? null : id);
  }

  const placed = $derived.by<Placed[]>(() => {
    const out: Placed[] = [];
    for (const e of entries) {
      const entryKey = e.device ?? e.code ?? "";
      const r = livePos.get(entryId(key, e));
      if (r === undefined) continue;
      if (r.from >= r.to) continue;
      out.push({
        entry: e,
        id: entryId(key, e),
        code: displayByDevice.get(entryKey) ?? entryKey,
        devices: [keyToId.get(entryKey) ?? entryKey],
        from: r.from,
        to: r.to,
        faded: selRange !== null || previewRange !== null,
      });
    }
    if (selRange !== null && selRange.to > selRange.from)
      out.push({ id: SEL_CODE, code: SEL_CODE, devices: [], from: selRange.from, to: selRange.to, faded: false });
    if (previewRange !== null && previewRange.to > previewRange.from)
      out.push({
        id: PREVIEW_CODE,
        code: PREVIEW_CODE,
        devices: [],
        from: previewRange.from,
        to: previewRange.to,
        faded: false,
      });
    return out;
  });

  let analysisHover = $state<string | null>(null);
  let analysisScroll = $state<string | null>(null);
  const analysis = $derived(analysisRows(entries, key, livePos, docStarts, index, (code) => paint.colorVars(code)));
  $effect(() => {
    const id = analysisScroll;
    if (id === null) return;
    document.getElementById(`arow-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    analysisScroll = null;
  });
  let analysisJump = $state<number | null>(null);
  $effect(() => {
    const off = analysisJump;
    if (off === null) return;
    analysisJump = null;
    requestAnimationFrame(() => {
      if (view === undefined) return;
      view.dispatch({ selection: { anchor: off, head: off }, scrollIntoView: true });
      view.focus();
    });
  });
  function jumpTo(id: string): void {
    const it = analysis.find((x) => x.id === id);
    if (it === undefined) return;
    tab = "coding";
    analysisJump = it.from;
  }

  const segments = $derived(splitSegments(placed));
  const hotEntries = $derived(hotSetFor(segments, hoverId, pop.hoverChip, selRange !== null));

  /** PdfView marks: real entries + selection/preview pseudo coverage — the same
      pipeline as the editor's specs (hatch, focus-mode fade, no chips for pseudo) */
  const pdfMarks = $derived.by(() =>
    placed.map((p) => ({
      id: p.id,
      from: p.from,
      to: p.to,
      devices: p.devices,
      faded: p.faded,
      hot: hotEntries.has(p.id),
      color: paint.fillOf(p.code, false, false),
      colorD: paint.fillOf(p.code, true, false),
      colorHot: paint.fillOf(p.code, false, true),
      colorHotD: paint.fillOf(p.code, true, true),
      label: index.shortByCode.get(p.code) ?? p.code,
      // selection/preview pseudo coverage gets no chip (editor parity: tags are
      // only rendered for real entries)
      tagless: p.entry === undefined,
      on: onForFill(paint.fillOf(p.code, false, false)),
      onD: onForFill(paint.fillOf(p.code, true, false)),
    })),
  );

  const specs = $derived.by<CodingMarkSpec[]>(() => {
    const out: CodingMarkSpec[] = [];
    for (const { id, ids, from, to, cov } of segments) {
      const hotIds = new SvelteSet(ids.filter((x) => hotEntries.has(x)));
      const hot = hotIds.size > 0;
      const focus = cov.some((p) => p.faded) && cov.some((p) => !p.faded || hotIds.has(p.id));
      const style = paint.styleForCov(cov, hotIds, focus);
      out.push({
        id,
        ids,
        devices: [...new SvelteSet(cov.flatMap((p) => p.devices))],
        from,
        to,
        code: [...new SvelteSet(cov.filter((p) => p.entry !== undefined).map((p) => p.code))].sort().join(" · "),
        style,
        tags: cov
          .filter((p) => p.entry !== undefined && p.from === from)
          .map((p) => ({
            ...paint.tagFor(p.code),
            id: p.id,
            device: p.devices[0],
            hot: hotIds.has(p.id),
            faded: p.faded,
            open: pop.hoverChip === p.id,
          })),
        hot,
      });
    }
    return out;
  });

  const litForOverlay = $derived(fadeAll ? [] : litSegments(segments, hoverKeys, hotEntries));
  const hoverSpecs = $derived.by<CodingMarkSpec[]>(() => {
    const lit = litForOverlay;
    if (lit.length === 0) return EMPTY_SPECS;
    const out: CodingMarkSpec[] = [];
    let lo = 0;
    let hi = lit.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lit[mid].to < visibleRange.from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < lit.length && lit[i].from <= visibleRange.to; i++) {
      const { id, ids, from, to, cov, hotIds } = lit[i];
      out.push({
        id,
        ids,
        devices: [...new SvelteSet(cov.flatMap((p) => p.devices))],
        from,
        to,
        code: [...new SvelteSet(cov.filter((p) => p.entry !== undefined).map((p) => p.code))].sort().join(" · "),
        style: paint.styleForCov(lit[i].lit, hotIds, true),
        tags: [],
        hot: hotIds.size > 0,
      });
    }
    return out;
  });

  $effect(() => {
    const css = hoverCss;
    if (css === "") return;
    const el = document.createElement("style");
    el.setAttribute("data-coding-hover", "");
    el.textContent = css;
    document.head.appendChild(el);
    return () => el.remove();
  });

  function measureVisible(): void {
    if (view === undefined) return;
    const blocks = view.viewportLineBlocks;
    if (blocks.length === 0) return;
    visibleRange = { from: blocks[0].from, to: blocks[blocks.length - 1].to };
  }

  $effect(() => {
    if (view === undefined) return;
    measureVisible();
    const dom = view.scrollDOM;
    const onScroll = () => measureVisible();
    dom.addEventListener("scroll", onScroll, { passive: true });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => measureVisible());
    });
    ro.observe(dom);
    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  $effect(() => {
    if (view === undefined) return;
    try {
      syncCodingHover(view, hoverSpecs);
    } catch (e) {
      barMsg = `hover marks: ${String(e)}`;
    }
  });

  const showMinimap = $derived(view !== undefined && (tab === "coding" || tab === "edit"));
  const minimapMarks = $derived(specs.map((s) => ({ id: s.id, from: s.from, to: s.to, style: s.style })));
  const minimapHoverMarks = $derived(
    litForOverlay.length === 0
      ? EMPTY_BARS
      : litForOverlay.map(({ id, from, to, lit, hotIds }) => ({
          id,
          from,
          to,
          style: paint.styleForCov(lit, hotIds, true),
        })),
  );

  const popupEntry = $derived.by(() => {
    const id = pop.popup?.id;
    return id === undefined ? undefined : entries.find((e) => entryId(key, e) === id);
  });
  const popupEntryKey = $derived(popupEntry?.device ?? popupEntry?.code ?? "");
  const popupFullName = $derived(nameByDevice.get(popupEntryKey) ?? popupEntryKey);
  const popupTag = $derived(paint.tagFor(displayByDevice.get(popupEntryKey) ?? popupEntryKey));

  /* ----- Yjs entry writes: every mutation goes through a transact so peers receive it ----- */
  function writeEntry(e: CodeEntry): void {
    const doc = ydoc;
    const map = ymap;
    if (doc === null || map === null) return;
    doc.transact(() => map.set(entryId(key, e), e));
  }

  /**
   * Text edits remap livePos immediately; the STORED entries follow debounced, so
   * REST reads, room peers and reopens see the current line/range/excerpt (the
   * contract CodingDoc's save had). A span whose text vanished removes its entry.
   */
  let recommitTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRecommit(): void {
    if (recommitTimer !== undefined) clearTimeout(recommitTimer);
    recommitTimer = setTimeout(() => {
      recommitTimer = undefined;
      recommitPositions();
    }, 600);
  }
  function recommitPositions(): void {
    const doc = ydoc;
    const map = ymap;
    if (doc === null || map === null) return;
    const s = lineStarts(docText);
    doc.transact(() => {
      for (const e of entries) {
        const id = entryId(key, e);
        const pos = livePos.get(id);
        if (pos === undefined) continue; // not anchored yet — its stored geometry owns it
        if (pos.from >= pos.to) {
          map.delete(id); // the coded text is gone (CodingDoc parity: stale codes drop)
          continue;
        }
        const next: CodeEntry = {
          ...(e.device !== undefined ? { device: e.device } : { code: e.code ?? "" }),
          ...offsetsSpan(s, docText, pos.from, pos.to),
          ...(e.uid !== undefined ? { uid: e.uid } : {}),
          ...(e.note !== undefined ? { note: e.note } : {}),
        };
        if (JSON.stringify(next) !== JSON.stringify(e)) map.set(id, next);
      }
    });
  }
  function deleteEntry(e: CodeEntry): void {
    const doc = ydoc;
    const map = ymap;
    if (doc === null || map === null) return;
    doc.transact(() => map.delete(entryId(key, e)));
  }
  function readEntries(): CodeEntry[] {
    const map = ymap;
    if (map === null) return [];
    const out: CodeEntry[] = [];
    map.forEach((v) => out.push(v));
    return out.sort((a, b) => a.line - b.line || a.range[0] - b.range[0]);
  }

  /** shared entry creation: the editor mouseup + quick select both land here */
  function addEntryFromOffsets(selFrom: number, selTo: number, fromEditor: boolean): void {
    if (armed === null || mode !== "code") return;
    quick.use(keyToId.get(armed) ?? armed);
    const text = docText;
    const s = lineStarts(text);
    let from = selFrom;
    let to = selTo;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (from >= to) return;
    const uid = crypto.randomUUID();
    const entry = entryFromOffsets(key, s, text, from, to, armed, uid);
    if (isDuplicateEntry(entries, entry)) {
      if (fromEditor && view) view.dispatch({ selection: { anchor: to } });
      return;
    }
    livePos.set(entryId(key, entry), { from, to });
    writeEntry(entry);
    if (fromEditor && view) view.dispatch({ selection: { anchor: to } });
  }

  function setPopupNote(value: string): void {
    pop.note = value;
    const e = popupEntry;
    if (e === undefined) return;
    writeEntry({ ...e, note: value });
  }

  const armedLabel = $derived(armed === null ? "" : quickLabel(armed));

  // anchor any entry that has no live geometry yet (room seed, undo bringing back an
  // entry) using its stored line/range against the doc
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
      barMsg = `marks: ${String(e)}`;
    }
  });

  function pick(id: string): void {
    if (!UUID_RE.test(id)) return;
    if (tab === "edit") setTab("coding");
    armed = armed === id ? null : id;
    pop.close();
    barMsg = "";
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

  const liveDocText = () => (view ? view.state.doc.toString() : docText);

  /* ----- snapshot history over the REST API ----- */
  function toVersion(v: RemoteVersion): ArticleVersion {
    return {
      id: v.id,
      parent: v.parent,
      ...(v.label === undefined ? {} : { label: v.label }),
      savedAt: v.time,
      text: v.text,
      codes: v.codes,
    };
  }
  function setVersions(list: RemoteVersion[]): void {
    versions = list.map(toVersion);
    headVersion = versions.at(-1)?.id ?? null;
  }

  async function snapshot(label: string): Promise<void> {
    if (api === null || docId === "") return;
    try {
      setVersions(
        await api.addVersion(token, docId, {
          text: liveDocText(),
          codes: deriveCodes(),
          ...(label === "" ? {} : { label }),
          parent: headVersion,
        }),
      );
      versionsOpen = false;
    } catch (e) {
      barMsg = String(e);
    }
  }

  async function renameVersion(v: ArticleVersion, label: string): Promise<void> {
    if (api === null || docId === "") return;
    try {
      setVersions(await api.setVersionLabel(token, docId, v.id, label));
    } catch (e) {
      barMsg = String(e);
    }
  }

  /** restore a snapshot: the live Yjs doc is replaced in one transaction (peers see it) */
  async function revertTo(v: ArticleVersion): Promise<void> {
    const doc = ydoc;
    const text = ytext;
    const map = ymap;
    if (api === null || doc === null || text === null || map === null || docId === "") return;
    try {
      // keep the current working state as a version first, only when it differs from the head
      const head = versions.find((x) => x.id === headVersion) ?? null;
      const dirty = head === null || head.text !== liveDocText() || codesKey(deriveCodes()) !== codesKey(head.codes);
      if (dirty)
        setVersions(
          await api.addVersion(token, docId, { text: liveDocText(), codes: deriveCodes(), parent: headVersion }),
        );
      headVersion = v.id;
      livePos.clear();
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, v.text);
        map.clear();
        for (const e of v.codes) map.set(entryId(docId, e), e);
      });
      versionsOpen = false;
    } catch (e) {
      barMsg = String(e);
    }
  }

  function removeCode(e: CodeEntry): void {
    livePos.delete(entryId(key, e));
    deleteEntry(e);
    pop.close();
  }

  /* ----- title rename (REST patch, then follow the new URL) ----- */
  function startRename(): void {
    renameDraft = data.name;
    renaming = true;
  }
  async function commitRename(): Promise<void> {
    const name = renameDraft.trim();
    renaming = false;
    if (name === "" || name === data.name || api === null || docId === "") return;
    try {
      await api.patchDoc(token, docId, { name });
      // the local account keeps the legacy /text/<folder>/<name> URL (last-doc,
      // deep links and the Pages check all use it); remotes carry their account id
      await goto(
        data.account === LOCAL_ACCOUNT_ID
          ? resolve("/text/[folder]/[name]", { folder: data.folder, name })
          : resolve("/text/[account]/[folder]/[name]", {
              account: data.account,
              folder: data.folder,
              name,
            }),
      );
    } catch (e) {
      // the server names the clash ("x already exists in this project"); the bar
      // states the project the user is actually standing in
      const m = e instanceof Error ? e.message : String(e);
      barMsg = m.includes("already exists") ? `${m.replace(/ in this project$/, "")} in ${data.folder}/` : m;
    }
  }
  function renameCaret(node: HTMLInputElement): void {
    node.focus();
    const len = node.value.length;
    if (/^Untitled \d+(?:\.md)?$/i.test(node.value)) node.setSelectionRange(0, len);
    else node.setSelectionRange(len, len);
  }

  /* ----- catalog persistence through the server ----- */
  async function saveCatalogServer(_folder: string, instr: Instructions): Promise<void> {
    if (api === null || projectId === "") return;
    await api.saveCatalog(token, projectId, instr);
    localCatalog = instr;
  }
  async function clearCatalogServer(): Promise<void> {
    if (api === null || projectId === "") return;
    await api.saveCatalog(token, projectId, null);
    localCatalog = null;
  }

  /* ----- editor with the Yjs bindings ----- */
  function startEditor(): void {
    if (!parent || ytext === null || provider === null) return;
    view = new EditorView({
      state: EditorState.create({
        // ySync only observes future changes: the editor must start on the Y.Text's
        // current content (the room seed may have landed before the editor mounts)
        doc: ytext.toString(),
        extensions: [
          EditorView.lineWrapping,
          roComp.of(EditorState.readOnly.of(mode === "code")),
          langComp.of(isMd ? mdExtensions() : []),
          // presence: remote cursors/selections + the shared undo stack
          yCollab(ytext, provider.awareness),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet) {
              const r = u.state.selection.main;
              selRange = r.empty ? null : { from: r.from, to: r.to };
            }
            if (u.docChanged) {
              docText = u.state.doc.toString();
              // remote + local edits all flow through CodeMirror transactions:
              // remap every live entry range so marks stay anchored (incl. undo)
              const cs = u.changes;
              livePos.forEach((r, id) => {
                livePos.set(id, { from: cs.mapPos(r.from), to: cs.mapPos(r.to) });
              });
              scheduleRecommit(); // the stored entries follow the remap (debounced)
            }
          }),
          smartSelect({
            enabled: () => smart && tab === "coding",
            armed: () => armed !== null,
            // PDF extracted text: every line is a discrete layout line → hard breaks
            hard: () => isPdf,
            onPreview: (s) => {
              previewRange = s;
            },
          }),
          codingMarks(
            (id) => pop.chipHover(id),
            (id) => {
              void id;
              if (hoverId !== null) hoverId = null;
            },
            (selFrom, selTo) => addEntryFromOffsets(selFrom, selTo, true),
          ),
        ],
      }),
      parent: parent ?? document.body,
    });
    try {
      syncCodingMarks(view, specs);
    } catch (e) {
      barMsg = `marks: ${String(e)}`;
    }
  }

  /* ----- presence (awareness): the people in this room ----- */
  function readPeers(): void {
    const aw = provider?.awareness;
    if (aw === null || aw === undefined) {
      peers = [];
      return;
    }
    const me = aw.clientID;
    const out: { id: number; name: string; color: string }[] = [];
    aw.getStates().forEach((st, id) => {
      if (id === me) return;
      const u = (st as { user?: { name?: string; color?: string } }).user;
      if (u?.name !== undefined) out.push({ id, name: u.name, color: u.color ?? "#888888" });
    });
    peers = out.sort((a, b) => compareNames(a.name, b.name));
  }

  /** a stable color per name (the presence chips) */
  function colorFor(name: string): string {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 65% 45%)`;
  }

  /**
   * Live structural sync for a REMOTE account. The room syncs text + entries over
   * the WebSocket; the server additionally pushes store changes (project/doc/catalog
   * mutations, room materializations) over the SSE feed `GET /api/events`. Every
   * event coalesces into one `cache.refreshAll` round (typing materializes in
   * bursts). EventSource cannot send headers, so the session rides `?token=`.
   * Window focus/visibility refetches too: catch-up after a backgrounded tab.
   * The Local account needs none of this — its worker broadcasts mutations directly.
   */
  let live: (() => void) | null = null;
  function startRemoteLive(acc: AnyAccount, tk: string, pid: string): void {
    live?.();
    live = null;
    const cache = remote?.cache(acc.id);
    const a = accounts?.api(acc);
    if (!cache || !a) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          await cache.refreshAll(a, tk);
          if (pid !== "" && cache.projects.some((p) => p.id === pid)) localCatalog = await cache.getCatalog(a, tk, pid);
        })().catch(() => undefined);
        scheduleVersionsRefresh();
      }, 250);
    };
    const base = acc.kind === "remote" ? acc.serverUrl.replace(/\/+$/, "") : "";
    if (base === "") return;
    const es = new EventSource(`${base}/api/events?token=${encodeURIComponent(tk)}`);
    // the server keeps the stream alive with pings; EventSource auto-reconnects on drops
    es.addEventListener("docs", refetch);
    es.addEventListener("project", refetch);
    es.addEventListener("catalog", refetch);
    es.addEventListener("subs", refetch);
    const onActive = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onActive);
    window.addEventListener("focus", onActive);
    live = () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onActive);
      window.removeEventListener("focus", onActive);
      es.close();
    };
  }

  /**
   * The snapshot list is REST data (the pill shows `versions (N)`): a snapshot
   * taken in ANOTHER tab must move this tab's graph too. A whole-doc fetch per
   * mutation burst would be noise, so the refresh waits for the store to go
   * quiet (typing materializes in bursts; snapshots arrive as single events).
   */
  let versionsTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleVersionsRefresh(): void {
    if (versionsTimer !== undefined) clearTimeout(versionsTimer);
    versionsTimer = setTimeout(() => {
      versionsTimer = undefined;
      if (api === null || token === "" || docId === "") return;
      void (async () => {
        try {
          setVersions((await api.doc(token, docId)).versions);
        } catch {
          /* the doc was deleted under us: the tree watch owns the recovery */
        }
      })();
    }, 2000);
  }

  /* ----- load: account → project → document → room ----- */
  async function load(): Promise<void> {
    loading = true;
    missing = false;
    barMsg = "";
    if (!accounts || !remote) {
      missing = true;
      loading = false;
      return;
    }
    const acc = accounts.byId(data.account);
    if (!acc) {
      missing = true;
      loading = false;
      return;
    }
    let tk: string | null;
    if (acc.kind === "local") {
      tk = (await accounts.ensureLocalToken()) || null;
    } else {
      tk = accounts.tokenOf(acc.id);
      if (tk === null && (await accounts.refresh(acc.id))) tk = accounts.tokenOf(acc.id);
    }
    if (tk === null) {
      missing = true;
      loading = false;
      return;
    }
    const a = accounts.api(acc);
    const cache = remote.cache(acc.id);
    let initialText = "";
    try {
      await cache.refreshProjects(a, tk);
      const proj = cache.projects.find((p) => p.name === data.folder);
      if (!proj) {
        missing = true;
        loading = false;
        return;
      }
      await cache.refreshDocs(a, tk, proj.id);
      const list = cache.docs[proj.id] ?? [];
      const found = list.find((d) => d.name === data.name);
      if (!found) {
        missing = true;
        loading = false;
        return;
      }
      const info = await a.doc(tk, found.id);
      kind = info.kind === "pdf" ? "pdf" : "text";
      if (kind === "pdf") {
        void import("$lib/coding/PdfView.svelte").then((m) => (PdfViewComp = m.default));
        pdfBytes = await a.pdfBytes(tk, info.id);
      }
      api = a;
      token = tk;
      projectId = proj.id;
      docId = info.id;
      setVersions(info.versions);

      const d = new Y.Doc();
      const text = d.getText("text");
      const map = d.getMap<CodeEntry>("entries");
      ydoc = d;
      ytext = text;
      ymap = map;

      // local rooms ride a MessagePort into the in-worker server, remote rooms a WebSocket —
      // same wire protocol, same provider surface, so everything below is shared
      const ws: WebsocketProvider | PortProvider =
        acc.kind === "local"
          ? new PortProvider(d, info.id, tk)
          : new WebsocketProvider(realtimeBase(acc.serverUrl), info.id, d, { params: { token: tk } });
      provider = ws;
      ws.on("status", (s: { status: string }) => (wsStatus = s.status));
      ws.on("sync", (isSynced: boolean) => {
        synced = isSynced;
        // the room is authoritative: seed it from the REST snapshot only when it is empty
        if (isSynced && !seeded) {
          seeded = true;
          if (text.length === 0 && map.size === 0) {
            d.transact(() => {
              if (info.text !== "") text.insert(0, info.text);
              // mint a uid on every REST-seeded entry: entryId is content-derived
              // without one, so the map key (and livePos geometry) would drift the
              // first time a text edit rewrites the entry's range
              for (const e of info.codes) {
                const owned: CodeEntry = e.uid === undefined ? { ...e, uid: crypto.randomUUID() } : e;
                map.set(entryId(info.id, owned), owned);
              }
            });
          }
        }
      });
      const me = acc.kind === "local" ? (accounts.localUser?.name ?? "Local") : (acc.user?.name ?? acc.label);
      ws.awareness?.setLocalStateField("user", { name: me, color: colorFor(me) });
      ws.awareness?.on("change", readPeers);
      readPeers();

      text.observe(() => {
        docText = text.toString();
      });
      map.observe(() => {
        entries = readEntries();
      });
      docText = text.toString();
      entries = readEntries();

      localCatalog = await a.catalog(tk, proj.id);
      initialText = info.text;
      if (acc.kind === "remote") startRemoteLive(acc, tk, proj.id);
    } catch (e) {
      barMsg = String(e);
      missing = true;
    }
    loading = false;
    // a PDF opens on its rendered pages; an empty text document opens on the Edit
    // tab so the text can be pasted/typed first; everything else starts coding
    tab = kind === "pdf" ? "preview" : initialText.trim() === "" ? "edit" : "coding";
    mounted = true;
    // the editor host div only exists once the main markup renders
    await tick();
    // a PDF starts on Preview: its CodeMirror is created by the tab effect
    if (kind !== "pdf") startEditor();
  }

  onMount(() => {
    void load();
    const unsubDocs = watchArticlesLocal((list) => {
      // summaries carry the project NAME (the tree's shape)
      docs = list.map((d): ArticleSummary => ({
        id: d.id,
        project: d.project,
        name: d.name,
        kind: d.kind === "pdf" ? "pdf" : "text",
        folder: d.folder,
        updatedAt: d.updated,
        codes: d.codes,
        versions: 0,
      }));
      // a deep link that opened BEFORE its document existed (cold seed) retries
      // the moment the store reports that document — no more permanent missing screen
      if (missing && docs.some((d) => d.project === data.folder && d.name === data.name)) void load();
    });
    const unsubFolders = watchProjectsLocal((names) => (folders = names));
    // local snapshot list follows snapshots taken in other tabs
    const offVersions = accounts?.byId(data.account)?.kind === "local" ? onLocalMutated(scheduleVersionsRefresh) : null;
    // local catalog follows every store change, from this tab AND the other tabs.
    // Broadcast echoes carry identical content: re-assigning them would re-key the
    // catalog tree mid-animation, so only real changes flow through.
    const isLocal = accounts?.byId(data.account)?.kind === "local";
    const unsubCatalog = isLocal
      ? watchLocalCatalog(data.folder, (d) => {
          const incoming = d === null ? "null" : JSON.stringify(d);
          const current = localCatalog === null ? "null" : JSON.stringify(localCatalog);
          if (incoming !== current) localCatalog = d;
        })
      : null;
    return () => {
      if (recommitTimer !== undefined) clearTimeout(recommitTimer);
      if (versionsTimer !== undefined) clearTimeout(versionsTimer);
      pop.destroy();
      provider?.destroy();
      ydoc?.destroy();
      view?.destroy();
      unsubDocs();
      unsubFolders();
      offVersions?.();
      unsubCatalog?.();
      live?.();
      live = null;
    };
  });

  /** the sidebar shows this project's remote documents (mapped onto the tree's shape) */
  /** the tree/picker document list for the OPEN project. DocTree's contract is
      the project NAME (hrefs, move/delete comparisons), while REST summaries
      carry the project id — normalize it to the open project's name here, and
      ride the local watch (already name-keyed) for the local account */
  const remoteDocs = $derived.by(() => {
    if (accounts?.byId(data.account)?.kind === "local")
      return docs.filter((d) => d.project === data.folder).sort((x, y) => compareNames(x.name, y.name));
    if (!remote || projectId === "") return [];
    return (remote.cache(data.account).docs[projectId] ?? [])
      .map((d): ArticleSummary => ({
        id: d.id,
        project: data.folder,
        name: d.name,
        kind: d.kind === "pdf" ? "pdf" : "text",
        folder: d.folder,
        updatedAt: d.updated,
        codes: d.codes,
        versions: 0,
      }))
      .sort((x, y) => compareNames(x.name, y.name));
  });
  /** the picker's document list: the open project's tree (account-aware above) */
  const pickerDocs = $derived(remoteDocs);
  /** account-aware accessors: `api`/`token` are the open account's REST pair */
  async function pickText(id: string): Promise<string | null> {
    if (api === null) return null;
    try {
      return (await api.doc(token, id)).text;
    } catch {
      return null;
    }
  }
  async function pickPdf(id: string): Promise<Uint8Array | null> {
    if (api === null) return null;
    return api.pdfBytes(token, id);
  }
</script>

<svelte:head>
  <title>{data.name} — coding</title>
</svelte:head>

<svelte:window
  onmousemove={(e) => {
    if (armed !== null) cursor = { x: e.clientX, y: e.clientY };
  }}
  onmousedown={() => {
    dragging = true;
  }}
  onmouseup={() => (dragging = false)}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      armed = null;
      pop.close();
    }
  }}
/>

{#if loading}
  <main class="status">
    <p>Loading remote article…</p>
  </main>
{:else if missing}
  <main class="status">
    <h1>{data.name}</h1>
    <p>This document is not available on that account{barMsg === "" ? "." : `: ${barMsg}`}</p>
    <p>
      <a href={resolve("/")}>← Kodakool</a>
    </p>
  </main>
{:else}
  <main>
    <ColorsDialog bind:open={colorsOpen}>
      <PaneGroup class="workspace" direction="horizontal" autoSaveId={`workspace:${data.folder}`}>
        <Pane minSize={11} maxSize={32} defaultSize={18}>
          <DocTree
            folder={data.folder}
            currentName={data.name}
            docs={remoteDocs}
            allDocs={docs}
            {projects}
            instr={localCatalog}
            {confirm}
            account={data.account}
          />
        </Pane>
        <PaneResizer class="wshandle" />
        <Pane minSize={38} defaultSize={61}>
          <div class="doccol">
            <header>
              {#if renaming}
                <input
                  class="rename"
                  aria-label="Document name"
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
                  <button type="button" class="title" onclick={startRename} title="Rename document">{titleName}</button>
                </h1>
              {/if}
              <div class="bar">
                <div class="tabs" role="tablist" aria-label="Document view">
                  {#each tabs as t (t)}
                    {@const label = tabLabel(t)}
                    <button
                      type="button"
                      role="tab"
                      class={`tabbtn ${tab === t ? "on" : ""}`}
                      aria-selected={tab === t}
                      aria-label={`Show ${label} view`}
                      title={`Show the ${label} view`}
                      onclick={() => setTab(t)}
                    >
                      <span class="material-symbols-rounded" aria-hidden="true">{tabIcon(t)}</span>
                      {label}
                    </button>
                  {/each}
                </div>
                {#if tab === "coding"}
                  <Toggle.Root
                    class={`smart ${smart ? "on" : ""}`}
                    bind:pressed={smart}
                    title="Select by word/quote/sentence instead of raw characters"
                  >
                    <span class="material-symbols-rounded" aria-hidden="true">wand_shine</span>
                    Smart Select
                  </Toggle.Root>
                {:else if tab === "edit" && isMd}
                  <MarkdownHelp />
                {/if}
                <span class="spacer"></span>
                <div class="peers" title="People in this document">
                  {#each peers as p (p.id)}
                    <span class="peer" style={`background: ${p.color}`}>{p.name}</span>
                  {/each}
                  <span class="sync" title="Live sync status">
                    <span class="material-symbols-rounded" aria-hidden="true">
                      {synced ? "cloud_done" : wsStatus === "connecting" ? "sync" : "cloud_off"}
                    </span>
                    {synced ? "live" : wsStatus === "connecting" ? "connecting…" : "offline"}
                  </span>
                </div>
                <DownloadPicker
                  folder={data.folder}
                  docs={pickerDocs}
                  liveId={key}
                  liveText={() => docText}
                  bind:open={dlOpen}
                  getDocText={pickText}
                  getPdfBytes={pickPdf}
                />
                <Dialog.Trigger class="pill">
                  <span class="material-symbols-rounded" aria-hidden="true">palette</span>Colors
                </Dialog.Trigger>
                <HistoryPanel
                  count={versions.length}
                  {versions}
                  head={headVersion}
                  bind:open={versionsOpen}
                  onsnapshot={snapshot}
                  onrevert={revertTo}
                  onrename={renameVersion}
                />
                {#if barMsg}<span class="msg err">{barMsg}</span>{/if}
              </div>
            </header>
            {#if isPdf && tab === "preview"}
              {#if pdfBytes !== null && PdfViewComp !== null}
                <!-- transitions are element-only: the fade wrapper hosts the lazy PdfView -->
                <div class="surfacefade" transition:fade={{ duration: 140 }}>
                  <PdfViewComp
                    bytes={pdfBytes}
                    text={docText}
                    marks={pdfMarks}
                    armed={armed !== null}
                    {smart}
                    preview={previewRange}
                    {hoverDevice}
                    {hoverDevices}
                    {fadeAll}
                    onadd={(from, to) => addEntryFromOffsets(from, to, false)}
                    onselect={(r) => (selRange = r)}
                    onpreview={(r) => (previewRange = r)}
                    onhovermark={(id) => pop.chipHover(id)}
                  />
                </div>
              {:else}
                <div class="pdfmissing" transition:fade={{ duration: 140 }}>
                  no stored PDF for this document — re-upload it to render the pages
                </div>
              {/if}
            {:else if tab === "analysis"}
              <div class="surfacefade" transition:fade={{ duration: 140 }}>
                <AnalysisPanel
                  items={analysis}
                  total={docText.length}
                  lines={docStarts.length}
                  hover={analysisHover}
                  onhover={(id) => (analysisHover = id)}
                  onpick={(id) => (analysisScroll = id)}
                  onjump={jumpTo}
                  ondelete={(id) => {
                    const e = entries.find((x) => entryId(key, x) === id);
                    if (e !== undefined) removeCode(e);
                  }}
                />
              </div>
            {/if}
            <!-- the CodeMirror host is NEVER unmounted (see CodingDoc): Analysis and Preview hide it -->
            <div
              class="editorrow"
              class:hidden={tab === "analysis" || (isPdf && tab === "preview")}
              data-hover-device={hoverDevice ?? undefined}
              data-fade={fadeAll ? "all" : undefined}
            >
              <div
                id="editor"
                class="editor"
                class:hidden={tab === "analysis" || (isPdf && tab === "preview")}
                class:minimapon={showMinimap}
                class:arm={armed !== null}
                class:smartsel={smart}
                style={armed !== null ? paint.markerVars(armedCode) : ""}
                bind:this={parent}
              ></div>
              {#if showMinimap}
                <Minimap {view} marks={minimapMarks} hoverMarks={minimapHoverMarks} total={docText.length} />
              {/if}
            </div>
          </div>
        </Pane>
        <PaneResizer class="wshandle" />
        <Pane minSize={12} maxSize={36} defaultSize={21}>
          <CatalogAside
            folder={data.folder}
            bind:localCatalog
            {catalog}
            {entryKeys}
            {armed}
            {confirm}
            pal={paletteTick}
            options={prefs.options}
            onpick={pick}
            {onhover}
            {styleFor}
            onsave={saveCatalogServer}
            onclear={clearCatalogServer}
          />
        </Pane>
      </PaneGroup>
      <EntryPopup
        ctl={pop}
        entry={popupEntry}
        fullName={popupFullName}
        tag={popupTag}
        onnote={setPopupNote}
        ondelete={() => popupEntry !== undefined && removeCode(popupEntry)}
      />
      {#if armed !== null && !dragging}
        <div class="ctag" style={`left: ${cursor.x + 14}px; top: ${cursor.y + 14}px; ${paint.markerVars(armedCode)}`}>
          {armedLabel}
        </div>
      {/if}
    </ColorsDialog>

    <ConfirmHost {confirm} />

    <QuickSelect
      enabled={tab === "coding" && mounted && !renaming && !colorsOpen && !confirm.open}
      surface={quickSurface}
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
  @use "./coding-page.scss";

  /* presence: the people in this room + the live-sync pill */
  .peers {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex: 0 0 auto;

    .peer {
      font-size: 0.68rem;
      font-weight: 700;
      line-height: 1;
      padding: 0.25rem 0.45rem;
      border-radius: 999px;
      color: #fff;
      white-space: nowrap;
      max-width: 7rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sync {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.72rem;
      color: var(--on-surface-variant, #666);
      white-space: nowrap;

      .material-symbols-rounded {
        font-size: 1rem;
      }
    }
  }
</style>
