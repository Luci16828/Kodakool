<script lang="ts">
  import { untrack } from "svelte";
  import type { EditorView } from "@codemirror/view";

  let {
    view,
    marks,
    total,
  }: {
    /** live CodeMirror view — the minimap reads its scroll geometry and scrolls it */
    view: EditorView | undefined;
    /** coded segments in editor offsets (the disjoint coverage segments) */
    marks: { id: string; from: number; to: number; style: string }[];
    /** canonical text length — the fallback scale when no view geometry exists */
    total: number;
  } = $props();

  /** rendered-height geometry of the editor, refreshed on scroll / resize / content change */
  let scrollH = $state(1);
  let clientH = $state(1);
  let top = $state(0);
  /** bump on every measure so the stripes derived re-read the (non-reactive) layout */
  let geomTick = $state(0);

  function measure(): void {
    if (view === undefined) return;
    const dom = view.scrollDOM;
    scrollH = Math.max(1, dom.scrollHeight);
    clientH = Math.max(1, dom.clientHeight);
    top = dom.scrollTop;
    // bump the tick WITHOUT reading it reactively: measure() runs inside an effect,
    // and `geomTick = geomTick + 1` would make that effect read + write the same
    // state → effect_update_depth_exceeded. untrack keeps it a pure write.
    geomTick = untrack(() => geomTick) + 1;
  }

  // (re)attach to the view's scroller whenever the view changes: a scroll listener
  // for the viewport, plus a ResizeObserver on the scroller for window resizes.
  // The observer callback is deferred to the next frame: measure() writes reactive
  // state, and a synchronous write inside a ResizeObserver callback re-triggers the
  // observer ("ResizeObserver loop completed with undelivered notifications").
  // Content-height changes (typing) are covered by the marks/total effect below.
  $effect(() => {
    if (view === undefined) return;
    const dom = view.scrollDOM;
    measure();
    const onScroll = () => (top = dom.scrollTop);
    dom.addEventListener("scroll", onScroll, { passive: true });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => measure());
    });
    ro.observe(dom);
    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  // re-measure when the marks/text change (content height shifts with the text)
  $effect(() => {
    void marks;
    void total;
    measure();
  });

  /** fraction of the document a rendered offset sits at (wrapping-aware via CodeMirror) */
  function fracOf(offset: number): number {
    if (view === undefined) return total > 0 ? offset / total : 0;
    const h = view.contentHeight;
    if (h <= 0) return 0;
    const pos = Math.min(Math.max(offset, 0), view.state.doc.length);
    return view.lineBlockAt(pos).top / h;
  }

  const stripes = $derived.by(() => {
    void geomTick;
    return marks.map((m) => {
      const a = fracOf(m.from);
      const b = fracOf(m.to);
      return {
        // segments are disjoint intervals, so `from` is a unique key; the coverage
        // id is NOT (one entry coded at two separate ranges yields two segments
        // with the same covering-entry set → the same id → duplicate keyed-each key)
        from: m.from,
        top: a * 100,
        height: Math.max((b - a) * 100, 0.6),
        style: m.style,
      };
    });
  });

  const viewTop = $derived(scrollH > 0 ? Math.min((top / scrollH) * 100, 100) : 0);
  const viewH = $derived(scrollH > 0 ? Math.min((clientH / scrollH) * 100, 100) : 100);

  let strip = $state<HTMLDivElement | undefined>(undefined);
  let dragging = false;
  /** pointer offset within the viewport thumb, as a document fraction (kept while dragging) */
  let grab = 0;

  function fracAt(clientY: number): number {
    if (strip === undefined) return 0;
    const r = strip.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  }

  /** scroll the editor so the viewport's top edge lands on document fraction `frac` */
  function scrollToTopFrac(frac: number): void {
    if (view === undefined) return;
    const dom = view.scrollDOM;
    const max = Math.max(0, dom.scrollHeight - dom.clientHeight);
    dom.scrollTop = Math.max(0, Math.min(max, frac * dom.scrollHeight - dom.clientHeight / 2));
    top = dom.scrollTop;
  }

  function onDown(e: PointerEvent): void {
    if (view === undefined || strip === undefined) return;
    const f = fracAt(e.clientY);
    const vt = top / scrollH;
    const vh = clientH / scrollH;
    if (f >= vt && f <= vt + vh) {
      grab = f - vt; // grabbed the thumb: drag from the point inside it
    } else {
      scrollToTopFrac(f); // clicked the track: jump, centering the viewport on the click
      grab = 0.5;
    }
    dragging = true;
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer (test) has no active capture target — the drag still works
    }
    measure();
  }
  function onMove(e: PointerEvent): void {
    if (!dragging) return;
    scrollToTopFrac(fracAt(e.clientY) - grab);
  }
  function onUp(e: PointerEvent): void {
    dragging = false;
    try {
      if (strip !== undefined && strip.hasPointerCapture(e.pointerId)) strip.releasePointerCapture(e.pointerId);
    } catch {
      // ignore: capture was never taken
    }
  }

  /** keyboard scrolling: arrows nudge the viewport, Page keys jump a screen, Home/End jump the ends */
  function onKey(e: KeyboardEvent): void {
    if (view === undefined) return;
    const page = clientH / scrollH; // one viewport, as a document fraction
    const step = page / 8;
    const vt = top / scrollH;
    let frac: number | null = null;
    if (e.key === "ArrowUp") frac = vt - step;
    else if (e.key === "ArrowDown") frac = vt + step;
    else if (e.key === "PageUp") frac = vt - page;
    else if (e.key === "PageDown") frac = vt + page;
    else if (e.key === "Home") frac = 0;
    else if (e.key === "End") frac = 1;
    if (frac === null) return;
    e.preventDefault();
    scrollToTopFrac(frac);
  }
</script>

<div
  class="minimap"
  bind:this={strip}
  role="scrollbar"
  tabindex="0"
  aria-controls="editor"
  aria-label="Document minimap"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(viewTop)}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
  onkeydown={onKey}
>
  {#each stripes as s (s.from)}
    <div class="mstripe" style={`top: ${s.top}%; height: ${s.height}%; ${s.style}`}></div>
  {/each}
  <div class="mview" style={`top: ${viewTop}%; height: ${viewH}%`}></div>
</div>

<style lang="scss">
  /* the whole document as a slim vertical overview: coded segments as hatched bars
     at their true rendered position, plus a viewport thumb you click/drag to scroll */
  .minimap {
    position: relative;
    flex: 0 0 auto;
    width: 64px;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background: var(--surface-variant, #eee);
    overflow: hidden;
    cursor: pointer;
    touch-action: none;
    user-select: none;

    &:focus-visible {
      outline: 2px solid var(--primary, #6750a4);
      outline-offset: 1px;
    }
  }

  /* one coded segment: full-width bar, the same hatch gradient the editor bar uses
     (the segment's --bars / --bars-d custom properties come from the specs) */
  .mstripe {
    position: absolute;
    left: 0;
    right: 0;
    min-height: 2px;
    border-radius: 2px;
    background-image: var(--bars, none);
    background-repeat: repeat;
    background-size: 100% 100%;
    opacity: 0.85;

    :root[data-theme="dark"] & {
      background-image: var(--bars-d, none);
    }
  }

  /* the currently visible region: click it to drag, click the track to jump */
  .mview {
    position: absolute;
    left: 0;
    right: 0;
    border: 1px solid var(--primary, #6750a4);
    background: color-mix(in srgb, var(--primary, #6750a4) 12%, transparent);
    border-radius: 4px;
    pointer-events: none;
  }
</style>
