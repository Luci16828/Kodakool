<script lang="ts">
  import { Popover } from "bits-ui";
  import "material-symbols/rounded.css";
  import { snapshotLabel } from "$lib/coding/history-graph";
  import type { ArticleVersion } from "$lib/coding/doc";

  /**
   * The bar's snapshot-history popover: the `versions (N)` pill and the commit graph
   * (lazily imported — the drawing stays out of the main chunk). The graph carries the
   * whole interaction: its dots revert, its labels are editable, and its dashed pending
   * node snapshots the live state. The live document's state stays in the page:
   * `onsnapshot` snapshots the current state, `onrevert` restores a snapshot (keeping
   * pending changes as a snapshot first), `onrename` relabels one.
   */
  let {
    count,
    versions,
    head,
    open = $bindable(false),
    onsnapshot,
    onrevert,
    onrename,
  }: {
    count: number;
    versions: ArticleVersion[];
    head: string | null;
    open?: boolean;
    onsnapshot: (label: string) => void;
    onrevert: (v: ArticleVersion) => void;
    onrename: (v: ArticleVersion, label: string) => void;
  } = $props();

  /** snapshot under the dot cursor — the panel's text preview */
  let preview = $state<ArticleVersion | null>(null);
  let HistoryGraphComp = $state<typeof import("$lib/coding/HistoryGraph.svelte").default | null>(null);

  // the graph is only needed once the popover opens: keep it out of the main chunk
  $effect(() => {
    if (open && HistoryGraphComp === null) {
      void import("$lib/coding/HistoryGraph.svelte").then((m) => (HistoryGraphComp = m.default));
    }
  });
</script>

<Popover.Root bind:open>
  <Popover.Trigger class="save ghost vbtn" title="Snapshot history">
    <span class="material-symbols-rounded" aria-hidden="true">history</span>Versions ({count})
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="historypop" role="dialog" aria-label="Snapshot history">
      {#if HistoryGraphComp !== null}
        <HistoryGraphComp {versions} {head} {onsnapshot} {onrevert} {onrename} onpreview={(v) => (preview = v)} />
      {/if}
      {#if versions.length === 0}
        <p class="vempty">No versions yet — name the current state and snapshot it.</p>
      {/if}
      {#if preview !== null}
        <pre class="vprev" aria-label="Preview of {snapshotLabel(preview)}">{preview.text}</pre>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style lang="scss">
  /* the trigger button is rendered by Bits, so it needs :global; the icon span is this
     component's own markup, so it carries this component's scope class. CodingDoc's
     `.bar .save.ghost .material-symbols-rounded` rule can never reach it (the span has
     no CodingDoc scope class) — sizing the glyph here is what actually applies */
  :global(.vbtn) .material-symbols-rounded {
    font-size: 0.9rem;
  }

  /* Popover.Content is rendered by Bits → :global; it renders inside Popover.Portal
     (the bar scrolls sideways, so the panel must not be a layout sibling of the pills) */
  :global(.historypop) {
    z-index: 41;
    width: min(34rem, 92vw);
    max-height: 70vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.7rem 0.9rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 10px;
    color: var(--on-surface, #1c1b1f);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);

    .vempty {
      margin: 0;
      font-size: 0.78rem;
      color: var(--on-surface-variant, #666);
    }

    .vprev {
      margin: 0;
      max-height: 14rem;
      overflow: auto;
      padding: 0.5rem 0.6rem;
      font-size: 0.75rem;
      line-height: 1.45;
      white-space: pre-wrap;
      background: var(--surface-variant, #eee);
      border: 1px solid var(--outline, #888);
      border-radius: 8px;
    }
  }
</style>
