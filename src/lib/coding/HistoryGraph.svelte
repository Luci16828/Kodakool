<script lang="ts">
  import "material-symbols/rounded.css";
  import { buildPalette } from "$lib/coding/palette";
  import { useColors } from "$lib/coding/prefs.svelte";
  import { useTheme } from "$lib/coding/theme.svelte";
  import { buildSnapshotGraph, listSnapshots, snapshotLabel } from "$lib/coding/history-graph";
  import type { ArticleVersion } from "$lib/client/coding-db";

  /**
   * Snapshot history drawn as a git-style commit graph in plain HTML + SVG:
   * newest snapshot at the top, one column per lineage, connector lines drawn as
   * SVG elbows, and the live working state as a dashed **pending** node above the
   * snapshot it continues from.
   *
   * Every control is real DOM (the graph IS the accessible path — no list beside it):
   * a commit dot reverts to that snapshot, its label is an editable input, and the
   * pending node shows the live time with a + dot that snapshots the state under it.
   */
  let {
    versions,
    head = null,
    onsnapshot,
    onrevert,
    onrename,
    onpreview,
  }: {
    /** the article's snapshots, in stored order */
    versions: ArticleVersion[];
    /** snapshot the live document continues from */
    head?: string | null;
    /** snapshot the live state with this label (pending node) */
    onsnapshot: (label: string) => void;
    /** restore a snapshot (the dot click is the revert) */
    onrevert: (v: ArticleVersion) => void;
    /** relabel a snapshot */
    onrename: (v: ArticleVersion, label: string) => void;
    /** snapshot under the dot cursor (the panel's text preview) */
    onpreview?: (v: ArticleVersion | null) => void;
  } = $props();

  const ROW_H = 40;
  const COL_W = 22;
  const PAD = 8;
  const DOT = 14;
  /** the pending node carries a + glyph, so it reads a size larger than a commit dot */
  const PDOT = 20;

  const prefs = useColors();
  const theme = useTheme();

  /** lineage colors reuse the app's contrast-checked marker palette, so they re-tint with it */
  const BRANCH_KEYS = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10"];
  const lineColors = $derived.by(() => {
    const tokens = prefs.tokens[theme.theme];
    const palette = buildPalette(BRANCH_KEYS, prefs.options);
    return BRANCH_KEYS.map((k) => palette.get(k)?.[theme.theme].marker ?? tokens.primary);
  });

  /** snapshots newest-first: row 0 is the pending node, so snapshots start at row 1 */
  const rows = $derived(listSnapshots(versions));
  const graph = $derived(buildSnapshotGraph(versions, head));

  /** branch line -> column index, in creation order (the column order the graph draws) */
  const colOf = $derived.by(() => {
    const m = new Map<string, number>();
    for (const op of graph.ops) if (!m.has(op.branch)) m.set(op.branch, m.size);
    return m;
  });

  /** snapshot id -> drawing position */
  const posOf = $derived.by(() => {
    const m = new Map<string, { row: number; col: number }>();
    rows.forEach((v, i) => m.set(v.id, { row: i + 1, col: colOf.get(graph.branchOf.get(v.id) ?? "") ?? 0 }));
    return m;
  });

  const headPos = $derived(head !== null ? (posOf.get(head) ?? null) : null);
  /**
   * The live working state hangs off the head snapshot. When the head already has a
   * successor (the document was reverted back onto an older node), the live state is a
   * NEW branch off it — drawn in its own column, exactly where the next snapshot lands.
   */
  const headForked = $derived(head !== null && versions.some((v) => v.parent === head));
  const maxCol = $derived(colOf.size > 0 ? Math.max(...colOf.values()) : 0);
  const pending = $derived({ row: 0, col: headPos === null ? 0 : headForked ? maxCol + 1 : headPos.col });

  const gutter = $derived((Math.max(maxCol, pending.col) + 1) * COL_W + PAD * 2);
  const height = $derived((rows.length + 1) * ROW_H);

  const x = (col: number) => PAD + col * COL_W + COL_W / 2;
  const y = (row: number) => row * ROW_H + ROW_H / 2;
  const colorOf = (col: number) => lineColors[col % lineColors.length];

  /** connector lines: parent -> child elbows + the dashed link to the pending node */
  const links = $derived.by(() => {
    const out: { d: string; color: string; dashed: boolean }[] = [];
    for (const v of rows) {
      const c = posOf.get(v.id);
      const p = v.parent !== null ? posOf.get(v.parent) : undefined;
      if (c === undefined || p === undefined) continue;
      // peel off just ABOVE the parent: a fork spanning several rows must not run
      // down the parent's column past the newer commits on its way to the elbow
      const mid = y(p.row) - ROW_H / 2;
      out.push({
        d: `M ${x(c.col)} ${y(c.row)} V ${mid} H ${x(p.col)} V ${y(p.row)}`,
        color: colorOf(c.col),
        dashed: false,
      });
    }
    if (headPos !== null) {
      const px = x(pending.col);
      const hx = x(headPos.col);
      const mid = y(headPos.row) - ROW_H / 2;
      out.push({
        d:
          px === hx
            ? `M ${px} ${y(pending.row)} V ${y(headPos.row)}`
            : `M ${px} ${y(pending.row)} V ${mid} H ${hx} V ${y(headPos.row)}`,
        color: "var(--primary, #6750a4)",
        dashed: true,
      });
    }
    return out;
  });

  /** live clock shown on the pending node (seconds ticking); its string is the snapshot label */
  let now = $state("");
  $effect(() => {
    const tick = () => (now = new Date().toLocaleTimeString());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });

  /** the + dot snapshots the live state, named with the time it shows */
  function snap(): void {
    onsnapshot(now);
  }

  function rename(v: ArticleVersion, el: HTMLInputElement): void {
    const label = el.value.trim();
    if (label === (v.label ?? "")) return;
    onrename(v, label);
  }
</script>

<div class="histgraph" style={`height: ${height}px; --gutter: ${gutter}px; --row: ${ROW_H}px; --dot: ${DOT}px`}>
  <svg class="glines" width={gutter} {height} aria-hidden="true">
    {#each links as l (l.d)}
      <path
        d={l.d}
        stroke={l.color}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray={l.dashed ? "4 5" : undefined}
      />
    {/each}
  </svg>

  <div class="crow pending" style={`top: ${y(pending.row)}px`}>
    <button
      type="button"
      class="cdot pdot"
      style={`left: ${x(pending.col) - PDOT / 2}px`}
      aria-label="snapshot current state"
      title="snapshot the current working state"
      onclick={snap}
    >
      <span class="material-symbols-rounded" aria-hidden="true">add</span>
    </button>
    <span class="cnow">{now}</span>
    <span class="ccur">(current)</span>
  </div>

  {#each rows as v (v.id)}
    {@const p = posOf.get(v.id) ?? { row: 0, col: 0 }}
    <div class="crow" style={`top: ${y(p.row)}px`}>
      <button
        type="button"
        class="cdot"
        class:head={v.id === head}
        style={`left: ${x(p.col) - DOT / 2}px; --dot-color: ${colorOf(p.col)}`}
        aria-label={`revert to ${snapshotLabel(v)}`}
        title="revert to this snapshot"
        onclick={() => onrevert(v)}
        onpointerenter={() => onpreview?.(v)}
        onpointerleave={() => onpreview?.(null)}
        onfocus={() => onpreview?.(v)}
        onblur={() => onpreview?.(null)}
      ></button>
      <input
        class="clabel"
        type="text"
        value={v.label ?? ""}
        placeholder={new Date(v.savedAt).toLocaleString()}
        aria-label="snapshot name"
        maxlength="120"
        onchange={(e) => rename(v, e.currentTarget)}
      />
    </div>
  {/each}
</div>

<style lang="scss">
  .histgraph {
    position: relative;
    min-width: 20rem;

    /* connector lines sit behind the dots and never intercept clicks */
    .glines {
      position: absolute;
      left: 0;
      top: 0;
      pointer-events: none;
    }

    /* one row per node, vertically centered on its graph position */
    .crow {
      position: absolute;
      left: 0;
      right: 0;
      height: var(--row);
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding-left: var(--gutter);
      padding-right: 0.2rem;
    }

    .cdot {
      position: absolute;
      top: calc((var(--row) - var(--dot)) / 2);
      width: var(--dot);
      height: var(--dot);
      padding: 0;
      border: 2px solid var(--dot-color, var(--primary, #6750a4));
      border-radius: 50%;
      background: var(--surface, white);
      cursor: pointer;

      /* the snapshot the live document continues from */
      &.head {
        background: var(--primary, #6750a4);
        border-color: var(--primary, #6750a4);
      }

      /* the live working state: a dashed outline, not a stored commit — carries the + */
      &.pdot {
        border-style: dashed;
        width: 20px;
        height: 20px;
        top: calc((var(--row) - 20px) / 2);
        display: inline-flex;
        align-items: center;
        justify-content: center;

        .material-symbols-rounded {
          font-size: 0.85rem;
          line-height: 1;
          color: var(--primary, #6750a4);
        }
      }
    }

    /* the pending row's live clock: seconds ticking, bold, with its (current) tag */
    .cnow,
    .ccur {
      font-weight: 700;
      font-size: 0.8rem;
      color: var(--on-surface, #1c1b1f);
    }

    .ccur {
      font-size: 0.7rem;
      color: var(--on-surface-variant, #666);
    }

    /* labels look like plain text until hovered/focused — every commit is editable */
    .clabel {
      font: inherit;
      font-size: 0.8rem;
      flex: 1 1 auto;
      min-width: 0;
      padding: 0.15rem 0.5rem;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--on-surface, #1c1b1f);

      &:hover,
      &:focus {
        border-color: var(--outline, #888);
        background: var(--surface, white);
      }
    }
  }
</style>
