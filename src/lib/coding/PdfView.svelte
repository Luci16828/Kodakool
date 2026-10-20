<script lang="ts">
  /**
   * PDF coding surface (phase 2): renders every PDF page to a canvas and overlays
   * a transparent text layer built from the canonical extracted-text spans
   * (src/lib/coding/pdf.ts), so entry offsets map 1:1 onto page rectangles.
   * Selection is delegated to the canonical text (nearest-offset anchoring +
   * snapWords), not to the browser. Coding marks render as hatched rectangles
   * below the text layer; label chips carry `data-tag-entry` so the CodingDoc
   * popup anchors to them like editor chips.
   */
  import { SvelteSet } from "svelte/reactivity";
  import { base64ToBytes } from "$lib/client/coding-db";
  import { markFill, markGradient } from "$lib/coding/paint";
  import type { PdfSpan } from "$lib/coding/pdf";
  import { elementSpan, sentenceSpan, snapWords } from "$lib/coding/segment";

  interface PdfMark {
    id: string;
    from: number;
    to: number;
    /** catalog ids this mark codes (the sidebar hover fade animates these alphas) */
    devices: string[];
    faded: boolean;
    hot: boolean;
    color: string;
    colorD: string;
    colorHot: string;
    colorHotD: string;
    label: string;
    /** pseudo coverage (selection/preview): rendered like a mark but without a chip */
    tagless: boolean;
    on: string;
    onD: string;
  }

  interface Range {
    from: number;
    to: number;
  }

  let props = $props<{
    /** base64 PDF bytes (RxDB pdfs collection) */
    data: string;
    /** canonical extracted text (entry offsets reference it) */
    text: string;
    marks: PdfMark[];
    armed: boolean;
    smart: boolean;
    /** smart-click preview span (rendered by the parent as pseudo coverage) */
    preview: Range | null;
    /** catalog id under the sidebar cursor (CSS-only fade, see css-var.ts) */
    hoverDevice?: string | null;
    /** catalog ids of the hovered node's subtree (the solid focus overlay) */
    hoverDevices?: string[];
    /** selection/preview fade (the CSS hover rules switch off under it) */
    fadeAll?: boolean;
    onadd: (from: number, to: number) => void;
    onselect: (r: Range | null) => void;
    onpreview: (r: Range | null) => void;
    onhovermark: (id: string | null) => void;
  }>();

  interface PageState {
    page: number;
    w: number;
    h: number;
    spans: PdfSpan[];
  }

  let host = $state<HTMLDivElement | null>(null);
  let pages = $state<PageState[]>([]);
  let scale = $state(1);
  /** rect keys currently inside the PDF viewport (the hover overlay's scope) */
  const visibleRectKeys = new SvelteSet<string>();
  let pdfDoc: {
    numPages: number;
    getPage(n: number): Promise<{
      getViewport(o: { scale: number }): { width: number; height: number };
      render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
        promise: Promise<unknown>;
        cancel(): void;
      };
    }>;
    destroy(): void;
  } | null = null;

  // ----- load + render pipeline -----

  $effect(() => {
    const data = props.data;
    let alive = true;
    void (async () => {
      const unpdf = await import("unpdf");
      const { extractPdfDoc } = await import("$lib/coding/pdf");
      const bytes = base64ToBytes(data);
      // every consumer transfers (detaches) the buffer it is handed → private copies
      const copy = () => {
        const c = new Uint8Array(bytes.length);
        c.set(bytes);
        return c;
      };
      const doc = await unpdf.getDocumentProxy(copy());
      const { spans } = await extractPdfDoc(copy());
      if (!alive) {
        (doc as unknown as { destroy?: () => void }).destroy?.();
        return;
      }
      pdfDoc = doc as unknown as typeof pdfDoc;
      const byPage = new Map<number, PdfSpan[]>();
      for (const s of spans) {
        const arr = byPage.get(s.page) ?? [];
        arr.push(s);
        byPage.set(s.page, arr);
      }
      const out: PageState[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        out.push({ page: i, w: vp.width, h: vp.height, spans: byPage.get(i) ?? [] });
      }
      pages = out;
    })();
    return () => {
      alive = false;
      // unmount / data change: a leaked pdf.js doc survives every pages⇄text
      // toggle otherwise (CodingDoc unmounts PdfView on each switch)
      for (const t of renderTasks.values()) t.cancel();
      renderTasks.clear();
      renderTokens.clear();
      const d = pdfDoc;
      pdfDoc = null;
      if (d) {
        try {
          void Promise.resolve(d.destroy()).catch(() => {});
        } catch {
          // already destroyed / render in flight — cancelled above anyway
        }
      }
      spanMetrics.clear();
    };
  });

  function fit(): void {
    if (!host || pages.length === 0) return;
    const maxW = Math.max(...pages.map((p) => p.w));
    scale = Math.max(0.4, Math.min(1.6, (host.clientWidth - 32) / maxW));
  }

  $effect(() => {
    const el = host;
    if (!el) return;
    // rAF-deferred: fit() writes `scale` ($state), and a synchronous reactive write
    // inside a ResizeObserver callback re-triggers the observer (project rule —
    // same reason as the deferral in Minimap.svelte)
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fit());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });

  // render bookkeeping (canvas nodes, render tasks, tokens) lives OUTSIDE reactive
  // state: writing it into the `pages` $state this effect reads would re-trigger
  // it endlessly (effect_update_depth_exceeded)
  const canvasEls = new Map<number, HTMLCanvasElement>();
  const renderTasks = new Map<number, { cancel(): void }>();
  const renderTokens = new Map<number, number>();

  function renderPage(page: number): void {
    const doc = pdfDoc;
    const canvas = canvasEls.get(page);
    if (!doc || !canvas) return;
    const sc = scale;
    const dpr = window.devicePixelRatio || 1;
    const token = (renderTokens.get(page) ?? 0) + 1;
    renderTokens.set(page, token);
    void (async () => {
      const pg = pages.find((p) => p.page === page);
      const pdfPage = await doc.getPage(page);
      if (!pg || token !== renderTokens.get(page)) return;
      const viewport = pdfPage.getViewport({ scale: sc * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderTasks.get(page)?.cancel();
      const task = pdfPage.render({ canvasContext: ctx, viewport });
      renderTasks.set(page, task);
      try {
        await task.promise;
      } catch {
        // cancelled by a newer render — fine
      }
    })();
  }

  /** attach the page canvas and render it as soon as it is mounted */
  function canvasFor(node: HTMLCanvasElement, page: number): { destroy(): void } {
    canvasEls.set(page, node);
    renderPage(page);
    return {
      destroy: () => {
        canvasEls.delete(page);
        renderTasks.get(page)?.cancel();
        renderTasks.delete(page);
      },
    };
  }

  // ----- text-layer alignment with the rendered canvas glyphs -----
  // The browser lays the transparent text layer out in its own fallback font, so it
  // matches neither the PDF glyph positions nor the PDF baseline. Two corrections:
  // 1. stretch every span with scaleX() so its text occupies exactly the PDF box
  //    width (pdf.js text-layer technique) — caret mapping and marks then follow
  //    the real proportional glyph positions instead of a monospace interpolation;
  // 2. drop the span box by the font's baseline offset (with line-height:1 the
  //    baseline sits ~0.2em above the box bottom) so the DOM baseline lands on the
  //    PDF baseline (span y).
  // Measured char boundaries + box rects live OUTSIDE $state (plain maps); a tick
  // re-triggers the rects derived once they arrive.

  const spanEls = new Map<number, HTMLSpanElement>();
  const spanMetrics = new Map<number, { xs: number[]; bottom: number; h: number }>();
  let layoutTick = $state(0);

  function spanFor(node: HTMLSpanElement, start: number): { destroy(): void } {
    spanEls.set(start, node);
    return { destroy: () => spanEls.delete(start) };
  }

  // distance from line-box bottom to baseline (px) for line-height:1
  const dropCache = new Map<string, number>();
  let measureCtx: CanvasRenderingContext2D | null = null;
  function baselineDrop(fsPx: number): number {
    const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
    const key = `${fam}|${String(Math.round(fsPx))}`;
    const hit = dropCache.get(key);
    if (hit !== undefined) return hit;
    if (!measureCtx) {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      measureCtx = c.getContext("2d");
    }
    let drop = fsPx * 0.1;
    if (measureCtx) {
      measureCtx.font = `${fsPx}px ${fam}`;
      const m = measureCtx.measureText("x");
      const asc = m.fontBoundingBoxAscent || fsPx * 0.8;
      const desc = m.fontBoundingBoxDescent || fsPx * 0.2;
      drop = (fsPx + desc - asc) / 2;
    }
    dropCache.set(key, drop);
    return drop;
  }

  function measureSpans(sc: number): void {
    const pageEls = host ? host.querySelectorAll<HTMLElement>(".pdfpage") : [];
    spanMetrics.clear();
    // batched writes and reads: interleaving a transform write with rect reads
    // forces a synchronous layout per span; four passes flush the layout only at
    // the write→read switches
    interface Pending {
      s: PdfSpan;
      el: HTMLSpanElement;
      tn: Node;
      len: number;
      pageEl: HTMLElement;
      pr: DOMRect;
      natural: number;
    }
    const pend: Pending[] = [];
    pages.forEach((pg, i) => {
      const pageEl = pageEls[i];
      if (!pageEl) return;
      for (const s of pg.spans) {
        const el = spanEls.get(s.start);
        const tn = el?.firstChild;
        if (!el || !tn || tn.nodeType !== Node.TEXT_NODE || s.width <= 0) continue;
        const len = s.end - s.start;
        if (len <= 0) continue;
        // clear any previous stretch before measuring the natural width, otherwise
        // re-measuring after a scale change compounds the old factor into "natural"
        el.style.transform = "";
        pend.push({ s, el, tn, len, pageEl, pr: null as unknown as DOMRect, natural: 0 });
      }
    });
    const r = document.createRange();
    // read pass: page rects + natural widths (no writes in between)
    for (const p of pend) {
      p.pr = p.pageEl.getBoundingClientRect();
      r.selectNodeContents(p.tn);
      p.natural = r.getBoundingClientRect().width;
    }
    // write pass: stretch every span so its text occupies exactly the PDF box width
    // (stretch even tiny/whitespace spans: an unstretched gap span leaves a seam
    // between the marks of its neighbours; 0.5% on a 400px line is already 2px drift)
    for (const p of pend) {
      const target = p.s.width * sc;
      const f = p.natural > 0.01 ? target / p.natural : 1;
      p.el.style.transform = Math.abs(f - 1) > 0.001 ? `scaleX(${f.toFixed(4)})` : "";
    }
    // read pass: char boundary x positions (page-relative PDF units) after the stretch
    for (const p of pend) {
      const xs: number[] = [];
      for (let k = 0; k < p.len; k++) {
        r.setStart(p.tn, k);
        r.setEnd(p.tn, k + 1);
        const cr = r.getBoundingClientRect();
        if (k === 0) xs.push((cr.left - p.pr.left) / sc);
        xs.push((cr.right - p.pr.left) / sc);
      }
      r.selectNodeContents(p.tn);
      const fr = r.getBoundingClientRect();
      spanMetrics.set(p.s.start, {
        xs,
        bottom: (p.pr.bottom - fr.bottom) / sc,
        h: fr.height / sc,
      });
    }
  }

  // measure after the DOM settled (rAF coalesces resize-driven scale changes)
  let measureRaf = 0;
  $effect(() => {
    const sc = scale;
    const pgs = pages;
    if (!host || pgs.length === 0 || sc <= 0) return;
    cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(() => {
      measureSpans(sc);
      layoutTick++;
    });
    return () => cancelAnimationFrame(measureRaf);
  });

  // re-render every page when the fit scale or the loaded pages change
  $effect(() => {
    for (const pg of pages) renderPage(pg.page);
  });

  // fit the pages into the container once they are loaded
  $effect(() => {
    if (pages.length > 0) fit();
  });

  // ----- coverage rectangles (span runs with identical covering marks) -----

  interface Run {
    cov: PdfMark[];
    x0: number;
    x1: number;
    y: number;
    h: number;
    from: number;
    to: number;
  }

  interface Rect {
    key: string;
    page: number;
    geo: string;
    style: string;
    cov: PdfMark[];
    chipBase: string;
    chips: {
      id: string;
      label: string;
      device: string | null;
      hot: boolean;
      on: string;
      onD: string;
      col: string;
      colD: string;
    }[];
  }

  /** x of a text offset inside a span: measured char boundaries once the text
      layer has been stretched+measured, linear interpolation as early fallback */
  function spanX(s: PdfSpan, off: number): number {
    void layoutTick; // recompute when the measured boundaries arrive
    const m = spanMetrics.get(s.start);
    if (m && m.xs.length > 0) {
      const i = Math.min(Math.max(off - s.start, 0), m.xs.length - 1);
      return m.xs[i];
    }
    if (s.end <= s.start || s.width <= 0) return s.x;
    return s.x + (s.width * (off - s.start)) / (s.end - s.start);
  }

  function rectParts(run: Run): { geo: string; vars: string } {
    const cov = run.cov;
    // editor parity: normal/hot fills render opaque, faded coverage stays
    // translucent — the .pdfmarks container's multiply blend makes opaque
    // stripes behave like a real highlighter (dark glyphs stay readable);
    // the fill/gradient math is shared with the editor in paint.ts
    const focus = cov.some((m) => m.faded) && cov.some((m) => !m.faded || m.hot);
    const grad = (dark: boolean): string => markGradient(cov, dark, focus);
    const geo = [
      `left:${run.x0 * scale}px`,
      `bottom:${run.y * scale}px`,
      `width:${(run.x1 - run.x0) * scale}px`,
      `height:${Math.max(run.h, 6) * scale}px`,
    ].join("; ");
    const vars = `--m:${grad(false)}; --m-d:${grad(true)}`;
    return { geo, vars };
  }

  const rects = $derived.by<Rect[]>(() => {
    const out: Rect[] = [];
    // mark indices sorted by `from`: per span the covering set is maintained by a
    // sweep (the old per-span filter over all marks was O(spans × marks) per recompute,
    // and marks change on every drag mousemove)
    const order = props.marks
      .map((_: PdfMark, i: number) => i)
      .sort((a: number, b: number) => props.marks[a].from - props.marks[b].from || a - b);
    for (const pg of pages) {
      let run: (Run & { key: string }) | null = null;
      let active: number[] = []; // mark indices, ascending (cov keeps props.marks order)
      let cursor = 0;
      const flush = () => {
        const r = run;
        if (!r) return;
        const { geo, vars } = rectParts(r);
        const chips = r.cov
          .filter((m: PdfMark) => !m.tagless && m.from >= r.from && m.from < r.to)
          .map((m) => ({
            id: m.id,
            label: m.label,
            device: m.devices[0] ?? null,
            hot: m.hot,
            on: m.on,
            onD: m.onD,
            // solid tag color (editor .cm-tag parity), not the hatch
            col: m.hot ? m.colorHot : m.color,
            colD: m.hot ? m.colorHotD : m.colorD,
          }));
        out.push({
          key: `${pg.page}:${r.from}:${r.to}`,
          page: pg.page,
          geo,
          style: `${geo}; ${vars}`,
          cov: r.cov,
          // chip row anchored just above the mark's top edge (editor tagline parity)
          chipBase: `left:${r.x0 * scale}px; bottom:${(r.y + r.h) * scale + 1}px`,
          chips,
        });
        run = null;
      };
      for (const s of pg.spans) {
        // spans are in ascending start order, so the from-cursor only moves forward
        const add: number[] = [];
        while (cursor < order.length && props.marks[order[cursor]].from < s.end) add.push(order[cursor++]);
        if (add.length > 0) {
          add.sort((a, b) => a - b);
          const merged: number[] = [];
          let a = 0;
          let b = 0;
          while (a < active.length && b < add.length) merged.push(active[a] < add[b] ? active[a++] : add[b++]);
          while (a < active.length) merged.push(active[a++]);
          while (b < add.length) merged.push(add[b++]);
          active = merged;
        }
        if (active.length > 0) active = active.filter((i) => props.marks[i].to > s.start);
        const cov = active.map((i) => props.marks[i]);
        if (cov.length === 0) {
          flush();
          continue;
        }
        // measured line box (baseline-corrected) when available, PDF box as fallback
        const box = spanMetrics.get(s.start);
        const sy = box ? box.bottom : s.y;
        const sh = box ? box.h : s.height;
        // split the span at every covering mark boundary: coverage is constant
        // inside each sub-segment, so a mark codes only its own words — a PDF
        // text item is usually a whole line, and the old whole-span rect made
        // every mark cover the entire line
        const inner = new Set<number>();
        for (const m of cov) {
          const a = Math.max(m.from, s.start);
          const b = Math.min(m.to, s.end);
          if (a > s.start && a < s.end) inner.add(a);
          if (b > s.start && b < s.end) inner.add(b);
        }
        const cuts = [s.start, ...[...inner].sort((a, b) => a - b), s.end];
        for (let i = 0; i < cuts.length - 1; i++) {
          const a = cuts[i];
          const b = cuts[i + 1];
          const segCov = cov.filter((m: PdfMark) => m.from <= a && m.to >= b);
          if (segCov.length === 0) continue;
          const key = segCov
            .map((m: PdfMark) => m.id)
            .sort()
            .join("|");
          const x0 = spanX(s, a);
          const x1 = spanX(s, b);
          if (run && run.key === key && Math.abs(sy - run.y) < 2 && a === run.to && x0 <= run.x1 + 3) {
            run.x1 = Math.max(run.x1, x1);
            run.h = Math.max(run.h, sh);
            run.to = b;
          } else {
            flush();
            run = { key, cov: segCov, x0, x1, y: sy, h: sh, from: a, to: b };
          }
        }
      }
      flush();
    }
    return out;
  });

  // rects grouped by page once: the template used to filter the full rect list
  // per page on every render (O(pages × rects) per marks change)
  const rectsByPage = $derived.by(() => {
    const m = new Map<number, Rect[]>();
    for (const r of rects) {
      const arr = m.get(r.page);
      if (arr) arr.push(r);
      else m.set(r.page, [r]);
    }
    return m;
  });

  // ----- sidebar-hover overlay (viewport only) -----
  function pdfFocusStyle(cov: PdfMark[]): string {
    // the overlay only renders while no selection fade is active, so every
    // hovered mark is visible: focus mode just merges same-color stops
    const grad = (dark: boolean): string => markGradient(cov, dark, true);
    return `--m:${grad(false)}; --m-d:${grad(true)}`;
  }

  const hoverRects = $derived.by(() => {
    const devices = props.hoverDevices ?? [];
    if (devices.length === 0 || props.fadeAll) return [];
    const litIds = new SvelteSet(devices);
    const out: { key: string; page: number; style: string }[] = [];
    for (const r of rects) {
      if (!visibleRectKeys.has(r.key)) continue;
      const lit = r.cov.filter((m) => (!m.tagless && m.devices[0] && litIds.has(m.devices[0])) || m.hot);
      if (lit.length === 0) continue;
      out.push({ key: r.key, page: r.page, style: `${r.geo}; ${pdfFocusStyle(lit)}` });
    }
    return out;
  });

  const hoverByPage = $derived.by(() => {
    const m = new Map<number, { key: string; page: number; style: string }[]>();
    for (const r of hoverRects) {
      const arr = m.get(r.page);
      if (arr) arr.push(r);
      else m.set(r.page, [r]);
    }
    return m;
  });

  function measureVisibleRects(): void {
    if (host === null) return;
    const hr = host.getBoundingClientRect();
    const keys: string[] = [];
    for (const el of host.querySelectorAll<HTMLElement>(".pdfmark[data-key]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= hr.top && r.top <= hr.bottom && r.right >= hr.left && r.left <= hr.right) {
        keys.push(el.dataset.key as string);
      }
    }
    visibleRectKeys.clear();
    for (const k of keys) visibleRectKeys.add(k);
  }

  $effect(() => {
    void rects;
    const root = host;
    if (root === null) return;
    let raf = requestAnimationFrame(measureVisibleRects);
    // coalesce scroll bursts into one measurement per frame (the observer path below
    // is already rAF-deferred; the scroll path ran a full DOM scan per scroll event)
    let scrollRaf = 0;
    const onScroll = () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(measureVisibleRects);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measureVisibleRects);
    });
    ro.observe(root);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(scrollRaf);
      root.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  // ----- selection / caret → canonical text offsets -----

  function offsetOf(node: Node | null, off: number): number | null {
    // only hits inside a text span count; a hit on the container itself must NOT
    // fall through to its first child (that mapped margin clicks to offset 0)
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const start = node.parentElement ? Number(node.parentElement.getAttribute("data-start")) : NaN;
    return Number.isFinite(start) ? start + off : null;
  }

  /** coordinate fallback: map a point to the offset of the NEAREST span box —
      a containing span wins; otherwise the closest one within half a line, so
      drags that start between lines still anchor on real text (margins stay null) */
  function offsetAtPoint(x: number, y: number): number | null {
    const pageEls = host ? host.querySelectorAll<HTMLElement>(".pdfpage") : [];
    for (let i = 0; i < pages.length && i < pageEls.length; i++) {
      const rect = pageEls[i].getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const px = (x - rect.left) / scale;
      const py = (rect.bottom - y) / scale;
      let best: { d: number; off: number } | null = null;
      for (const s of spansOf(i)) {
        const dx = px < s.x ? s.x - px : px > s.x + s.width ? px - (s.x + s.width) : 0;
        const dy = py < s.y ? s.y - py : py > s.y + s.height ? py - (s.y + s.height) : 0;
        const d = dx + dy;
        if (d > 14) continue; // further than half a line: margin, not text
        const off = offsetInSpan(s, Math.min(Math.max(px, s.x), s.x + s.width));
        if (best === null || d < best.d) best = { d, off };
      }
      return best ? best.off : null;
    }
    return null;
  }

  /** offset of a page-space x inside a span: measured char boundaries when the
      text layer has been measured, linear interpolation as fallback */
  function offsetInSpan(s: PdfSpan, px: number): number {
    void layoutTick;
    const m = spanMetrics.get(s.start);
    if (m && m.xs.length > 1) {
      let lo = 0;
      let hi = m.xs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (m.xs[mid] <= px) lo = mid;
        else hi = mid - 1;
      }
      return s.start + lo;
    }
    const t = s.width > 0 ? Math.min(1, Math.max(0, (px - s.x) / s.width)) : 0;
    return s.start + Math.round(t * (s.end - s.start));
  }

  function spansOf(pageIndex: number): PdfSpan[] {
    return pages[pageIndex]?.spans ?? [];
  }

  /** the caret APIs clamp to the nearest text position when the point is outside
      any text (Chromium's caretRangeFromPoint maps margin clicks to offset 0) —
      accept a caret hit only when the click is actually next to that position */
  function caretNear(x: number, y: number, node: Node, off: number): boolean {
    const len = node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : 0;
    const a = off > 0 ? off - 1 : off;
    const b = off < len ? off + 1 : off;
    if (a >= b) return false;
    const r = document.createRange();
    r.setStart(node, a);
    r.setEnd(node, b);
    for (const rect of r.getClientRects()) {
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
    }
    return false;
  }

  function caretOffset(x: number, y: number): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (typeof doc.caretPositionFromPoint === "function") {
      const p = doc.caretPositionFromPoint(x, y);
      const viaCaret = p ? offsetOf(p.offsetNode, p.offset) : null;
      if (viaCaret !== null && p && caretNear(x, y, p.offsetNode, p.offset)) return viaCaret;
    }
    if (typeof doc.caretRangeFromPoint === "function") {
      const r = doc.caretRangeFromPoint(x, y);
      const viaCaret = r ? offsetOf(r.startContainer, r.startOffset) : null;
      if (viaCaret !== null && r && caretNear(x, y, r.startContainer, r.startOffset)) return viaCaret;
    }
    return offsetAtPoint(x, y);
  }

  // cleanup: clear shared selection/preview/hover state when the surface unmounts
  $effect(() => () => {
    props.onselect(null);
    props.onpreview(null);
    props.onhovermark(null);
  });

  $effect(() => {
    if (!props.armed) props.onpreview(null);
  });

  // ----- coding interactions (editor parity) -----
  // Selection is DELEGATED to the canonical text: native browser selection over
  // the absolutely-positioned span layer is unreliable, so a drag anchors on the
  // text nearest the cursor (caretOffset → offsetAtPoint) and snaps both ends
  // with snapWords when smart select is on (raw offsets when off). The selection
  // flows back through onselect and renders as a coverage pseudo-mark, exactly
  // like the editor keeps a live selection.

  let downX = 0;
  let downY = 0;
  let moved = false;
  let anchorOff: number | null = null;
  let liveSel: Range | null = null;

  function smartAt(x: number, y: number): Range | null {
    const pos = caretOffset(x, y);
    if (pos === null) return null;
    // `hard`: extracted PDF lines are discrete layout lines, so every newline is
    // a paragraph boundary — a click codes its own line, not a blob
    return elementSpan(props.text, pos, true) ?? sentenceSpan(props.text, pos, true);
  }

  function onDown(e: MouseEvent): void {
    // right button belongs to the quick select menu: no caret placement, no preview
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
    anchorOff = caretOffset(e.clientX, e.clientY);
    liveSel = null;
    // a fresh press clears the previous selection (editor parity: a click places a caret)
    props.onselect(null);
    // armed smart click: preview the smart span immediately (editor smartSelect parity)
    if (props.armed && props.smart && anchorOff !== null) {
      props.onpreview(elementSpan(props.text, anchorOff, true) ?? sentenceSpan(props.text, anchorOff, true));
    }
  }

  function onMove(e: MouseEvent): void {
    if (e.buttons === 0) return;
    if (!moved && (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3)) moved = true;
    if (!moved) return;
    props.onpreview(null); // drag selection replaces the smart-click preview
    if (anchorOff === null) return;
    const head = caretOffset(e.clientX, e.clientY);
    if (head === null) return; // crossing a margin keeps the last selection
    if (head === anchorOff) {
      // dragged back onto the anchor: collapse to the caret (CodeMirror parity)
      liveSel = null;
      props.onselect(null);
      return;
    }
    const lo = Math.min(anchorOff, head);
    const hi = Math.max(anchorOff, head);
    // smart on: snap both ends to whole words (CodeMirror smartSelect parity);
    // smart off: raw character offsets, exactly like a plain CodeMirror drag
    liveSel = props.smart ? snapWords(props.text, lo, hi) : { from: lo, to: hi };
    props.onselect(liveSel); // live: focus-mode fade + coverage mark feedback
  }

  function onUp(): void {
    let r: Range | null = liveSel;
    if (!moved) r = props.preview ?? (props.smart ? smartAt(downX, downY) : null);
    if (r !== null && r.to > r.from) {
      if (props.armed) props.onadd(r.from, r.to);
      props.onselect(r); // the selection persists after coding, like in the editor
    } else {
      props.onselect(null);
    }
    liveSel = null;
    props.onpreview(null);
  }
</script>

<div
  class="pdfview"
  bind:this={host}
  data-hover-device={props.hoverDevice ?? undefined}
  data-fade={props.fadeAll ? "all" : undefined}
>
  {#each pages as pg (pg.page)}
    <div class="pdfpage" style="width:{pg.w * scale}px; height:{pg.h * scale}px">
      <div class="pdfmarks" aria-hidden="true">
        {#each rectsByPage.get(pg.page) ?? [] as r (r.key)}
          <div class="pdfmark" data-key={r.key} style={r.style}></div>
        {/each}
        {#each hoverByPage.get(pg.page) ?? [] as r (r.key)}
          <div class="pdfmark pdfhover" data-key={r.key} style={r.style}></div>
        {/each}
      </div>
      <div
        class="pdftext"
        role="textbox"
        aria-readonly="true"
        tabindex="0"
        class:armed={props.armed}
        class:smartsel={props.smart}
        onmousedown={onDown}
        onmousemove={onMove}
        onmouseup={onUp}
      >
        {#each pg.spans as s (s.start)}
          <span
            class="pdfspan"
            data-start={s.start}
            use:spanFor={s.start}
            style="left:{s.x * scale}px; bottom:{s.y * scale -
              baselineDrop(Math.max(s.height * scale, 4))}px; width:{Math.max(s.width * scale, 1)}px; height:{Math.max(
              s.height * scale,
              4,
            )}px; font-size:{Math.max(s.height * scale, 4)}px;">{props.text.slice(s.start, s.end)}</span
          >
        {/each}
      </div>
      <div class="pdfchips">
        {#each rectsByPage.get(pg.page) ?? [] as r (r.key)}
          {#if r.chips.length > 0}
            <div class="pdfchipline" style={r.chipBase}>
              {#each r.chips as c (c.id)}
                <span
                  class="pdfchip"
                  class:hot={c.hot}
                  role="presentation"
                  data-tag-entry={c.id}
                  data-device={c.device ?? undefined}
                  style="--tag:{c.col}; --tag-d:{c.colD}; --tag-on:{c.on}; --tag-on-d:{c.onD};"
                  onmouseenter={() => props.onhovermark(c.id)}
                  onmouseleave={() => props.onhovermark(null)}>{c.label}</span
                >
              {/each}
            </div>
          {/if}
        {/each}
      </div>
      <canvas use:canvasFor={pg.page}></canvas>
    </div>
  {/each}
</div>

<style>
  .pdfview {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;
  }

  .pdfpage {
    position: relative;
    background: white;
    box-shadow: 0 1px 8px rgb(0 0 0 / 22%);
    flex: none;
  }

  .pdfpage canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .pdfmarks {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    /* blend on the CONTAINER: .pdfmarks (positioned + z-index) is its own stacking
       context, so a per-mark mix-blend-mode would only blend against the empty
       container, never against the canvas page below — the whole layer multiplies
       onto the page like a highlighter pen */
    mix-blend-mode: multiply;
  }

  .pdfmark {
    position: absolute;
    border-radius: 2px;
    background-image: var(--m, none);
    --surface: white;
  }

  :root[data-theme="dark"] .pdfmark {
    background-image: var(--m-d, none);
  }

  .pdftext {
    position: absolute;
    inset: 0;
    z-index: 2;
    cursor: text;
    /* selection is delegated to the canonical text (snapWords drag) — native
       selection over the positioned span layer is unreliable and ugly */
    user-select: none;
  }

  /* editor parity: smart select on (or armed coding) reads as a crosshair */
  .pdftext.armed,
  .pdftext.smartsel {
    cursor: crosshair;
  }

  .pdfspan {
    position: absolute;
    color: transparent;
    white-space: pre;
    line-height: 1;
    /* the text is stretched to the PDF box width with scaleX (see measureSpans) —
       origin left keeps the stretch anchored at the span's PDF x */
    transform-origin: left bottom;
  }

  .pdfchips {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
    /* NOT inside .pdfmarks — chips must stay unblended solid labels */
  }

  /* one row per mark segment: chips sit side by side above the mark, like the
     editor's .cm-tagline row */
  .pdfchipline {
    position: absolute;
    display: flex;
    gap: 2px;
  }

  .pdfchip {
    pointer-events: auto;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.5;
    padding: 0 5px;
    /* editor .cm-tag parity: solid tag color, rounded top edge */
    border-radius: 3px 3px 0 0;
    background: var(--tag, #888);
    color: var(--tag-on, #111);
  }

  :root[data-theme="dark"] .pdfchip {
    background: var(--tag-d, #666);
    color: var(--tag-on-d, #eee);
  }

  .pdfchip.hot {
    outline: 1px solid var(--outline, #888);
  }
</style>
