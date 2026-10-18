<script lang="ts">
  import "material-symbols/rounded.css";
  import { SvelteSet } from "svelte/reactivity";
  import { fade } from "svelte/transition";

  /** stripe row height / how many rows the diagram stacks before it wraps */
  const LANE_H = 14;
  const LANE_CAP = 6;
  const DIAG_H = LANE_CAP * LANE_H + 8;

  let {
    items,
    total,
    lines = 1,
    hover = null,
    onhover = () => {},
    onpick = () => {},
    onjump = () => {},
    ondelete,
  }: {
    /** coded segments in document order, with palette color vars in `style` */
    items: {
      id: string;
      from: number;
      to: number;
      code: string;
      label: string;
      name: string;
      excerpt: string;
      note: string;
      lines: string;
      style: string;
    }[];
    /** canonical text length — the diagram maps ranges onto it proportionally */
    total: number;
    /** text line count — the diagram's page texture */
    lines?: number;
    /** entry id hovered in the list (its diagram stripe lights up) */
    hover?: string | null;
    onhover: (id: string | null) => void;
    /** diagram stripe clicked → the page scrolls the matching row into view */
    onpick: (id: string) => void;
    /** list row clicked → the page opens the Coding tab at that segment */
    onjump: (id: string) => void;
    /** delete the coded segment with this entry id */
    ondelete: (id: string) => void;
  } = $props();

  /**
   * Greedy lane packing: a stripe goes into the first lane whose last stripe
   * ends before it starts, so overlapping segments stack. The lane index wraps
   * at LANE_CAP — a heavily coded document keeps the diagram a fixed height
   * instead of pushing the list out of the panel.
   */
  function lanesOf(): { lane: number; left: number; width: number }[] {
    const ends: number[] = [];
    return items.map((it) => {
      const left = total > 0 ? (it.from / total) * 100 : 0;
      const width = Math.max(total > 0 ? ((it.to - it.from) / total) * 100 : 0, 0.5);
      let lane = ends.findIndex((e) => e <= left);
      if (lane < 0) {
        lane = ends.length;
        ends.push(0);
      }
      ends[lane] = left + width;
      return { lane: lane % LANE_CAP, left, width };
    });
  }

  /** page texture: one faint rule per text line (capped, evenly spread) */
  const texture = $derived.by(() => {
    const rows = Math.max(1, Math.min(lines, 24));
    const gap = (DIAG_H - 8) / rows;
    const line = "color-mix(in srgb, var(--outline, #888) 45%, transparent)";
    return `repeating-linear-gradient(to bottom, ${line} 0 1px, transparent 1px ${gap}px)`;
  });

  /** distinct devices among the segments — the diagram caption */
  const devices = $derived(new SvelteSet(items.map((it) => it.code)).size);
</script>

<div class="analysis">
  {#if items.length === 0}
    <p class="aempty">No coded segments yet — select text in the Coding tab to code it.</p>
  {:else}
    {@const lanes = lanesOf()}
    <p class="acap">
      {items.length} coded segment{items.length === 1 ? "" : "s"} · {devices} device{devices === 1 ? "" : "s"}
      · click a stripe to find its row, a row to open it in the Coding tab
    </p>
    <div
      class="adiag"
      role="img"
      aria-label="Coding diagram: {items.length} coded segments across the document"
      style={`height: ${DIAG_H}px; background-image: ${texture}`}
    >
      {#each items as it, i (it.id)}
        {@const g = lanes[i]}
        <button
          type="button"
          class="astripe {hover === it.id ? 'hot' : ''}"
          transition:fade={{ duration: 160, delay: Math.min(i, 12) * 22 }}
          style={`left: ${g.left}%; width: ${g.width}%; top: ${4 + g.lane * LANE_H}px; ${it.style}`}
          aria-label="Segment {it.label} at line {it.lines}"
          title="{it.name}: {it.excerpt}"
          onmouseenter={() => onhover(it.id)}
          onmouseleave={() => onhover(null)}
          onclick={() => onpick(it.id)}
        ></button>
      {/each}
    </div>
    <ul class="alist">
      {#each items as it, i (it.id)}
        <li
          id={`arow-${it.id}`}
          class="arow {hover === it.id ? 'hot' : ''}"
          transition:fade={{ duration: 160, delay: Math.min(i, 12) * 22 }}
          style={it.style}
          onmouseenter={() => onhover(it.id)}
          onmouseleave={() => onhover(null)}
        >
          <span class="atag">{it.label}</span>
          <button
            type="button"
            class="atext"
            aria-label="Open segment {it.label} at line {it.lines} in the Coding tab"
            title="Open this segment in the Coding tab"
            onclick={() => onjump(it.id)}
          >
            <span class="aexcerpt">{it.excerpt}</span>
            <span class="ameta">
              {it.name} · line {it.lines}
              {#if it.note}· <em>{it.note}</em>{/if}
            </span>
          </button>
          <button
            type="button"
            class="adel"
            aria-label="Delete segment {it.label} at line {it.lines}"
            title="Delete this coded segment"
            onclick={() => ondelete(it.id)}
          >
            <span class="material-symbols-rounded" aria-hidden="true">delete</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style lang="scss">
  .analysis {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .aempty {
    margin: 1rem 0;
    font-size: 0.85rem;
    color: var(--on-surface-variant, #666);
  }

  .acap {
    margin: 0;
    flex: 0 0 auto;
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
  }

  /* position diagram: the whole document as one fixed-height page thumbnail
     (a faint rule per text line) with every coded segment as a stripe at its
     proportional offset; overlapping stripes stack in capped lanes */
  .adiag {
    position: relative;
    flex: 0 0 auto;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background-color: var(--surface-variant, #eee);
    overflow: hidden;
  }
  .astripe {
    position: absolute;
    height: 10px;
    min-width: 4px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    cursor: pointer;
    background: var(--marker, #888);
    opacity: 0.8;
    transition:
      opacity 0.12s ease,
      outline-color 0.12s ease;

    :root[data-theme="dark"] & {
      background: var(--marker-d, #888);
    }

    &:hover,
    &.hot {
      opacity: 1;
      outline: 2px solid var(--primary, #6750a4);
      outline-offset: 1px;
    }
  }

  /* straight list of the coded segments, in document order */
  .alist {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .arow {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background: var(--surface, white);

    &.hot {
      border-color: var(--primary, #6750a4);
    }
  }
  .atag {
    flex: 0 0 auto;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--marker, #888);
    color: var(--on-marker, #fff);

    :root[data-theme="dark"] & {
      background: var(--marker-d, #888);
      color: var(--on-marker-d, #fff);
    }
  }
  /* the row body is a button: it jumps to this segment in the Coding tab */
  .atext {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font: inherit;
    text-align: left;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover .aexcerpt {
      color: var(--primary, #6750a4);
    }
  }
  .aexcerpt {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ameta {
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    em {
      color: var(--on-surface, #1c1b1f);
    }
  }
  .adel {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    padding: 0.2rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--on-surface-variant, #666);
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 1.1rem;
    }

    &:hover {
      color: #b3261e;
      background: color-mix(in srgb, #b3261e 12%, transparent);
    }
  }
</style>
