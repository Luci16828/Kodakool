<script lang="ts">
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import { buildSnapshotGraph, listSnapshots, snapshotLabel } from "$lib/coding/history-graph";
  import type { ArticleVersion } from "$lib/client/coding-db";

  /**
   * The bar's snapshot-history dialog: the `versions (N)` pill, the commit graph
   * (lazily imported — gitgraph stays out of the main chunk), the accessible
   * snapshot list and the text preview. The live document's state stays in the
   * page: `onsnapshot` snapshots the current state, `onrevert` restores a snapshot.
   */
  let {
    count,
    versions,
    head,
    open = $bindable(false),
    onsnapshot,
    onrevert,
  }: {
    count: number;
    versions: ArticleVersion[];
    head: string | null;
    open?: boolean;
    onsnapshot: (label: string) => void;
    onrevert: (v: ArticleVersion) => void;
  } = $props();

  /** snapshot the graph points at (ring + preview) */
  let pickedVersion = $state<string | null>(null);
  /** name typed for the next snapshot */
  let snapName = $state("");
  let HistoryGraphComp = $state<typeof import("$lib/coding/HistoryGraph.svelte").default | null>(null);
  /** snapshot history as a commit graph — pure mapping, the drawing is HistoryGraph.svelte */
  const graph = $derived(buildSnapshotGraph(versions, head));
  const pickedSnapshot = $derived(versions.find((v) => v.id === pickedVersion) ?? null);

  function pick(v: ArticleVersion): void {
    pickedVersion = v.id;
  }
  function snap(): void {
    onsnapshot(snapName);
    snapName = "";
  }

  // the graph library is only needed once the dialog opens: keep it out of the main chunk
  $effect(() => {
    if (open && HistoryGraphComp === null) {
      void import("$lib/coding/HistoryGraph.svelte").then((m) => (HistoryGraphComp = m.default));
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger class="save ghost vbtn" title="snapshot history">
    <span class="material-symbols-rounded" aria-hidden="true">history</span>versions ({count})
  </Dialog.Trigger>
  <Dialog.Overlay class="dlg-overlay" />
  <Dialog.Content class="historydlg" aria-label="snapshot history">
    <Dialog.Close class="dlgclose" aria-label="close snapshot history">
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </Dialog.Close>
    <div class="hsnap">
      <input
        class="vname"
        type="text"
        name="snapshot-name"
        placeholder="name this snapshot"
        maxlength="120"
        bind:value={snapName}
      />
      <button type="button" class="vsnap" onclick={snap}>
        <span class="material-symbols-rounded" aria-hidden="true">add</span>snapshot now
      </button>
    </div>
    {#if HistoryGraphComp !== null && versions.length > 0}
      <HistoryGraphComp {versions} {head} selected={pickedVersion} onpick={pick} />
    {/if}
    <ul class="vlist">
      {#each listSnapshots(versions) as v (v.id)}
        <li class="vrow" class:live={v.id === head} class:picked={v.id === pickedVersion}>
          <button type="button" class="vpick" onclick={() => pick(v)}>
            <span class="vlabel">{snapshotLabel(v)}</span>
            <span class="vbranch">{graph.branchOf.get(v.id) ?? ""}</span>
            <span class="vat">{new Date(v.savedAt).toLocaleString()}</span>
            <span class="vcodes">{v.codes.length} codes</span>
          </button>
          <button type="button" class="vrev" onclick={() => onrevert(v)}>
            <span class="material-symbols-rounded" aria-hidden="true">undo</span>revert
          </button>
        </li>
      {:else}
        <li class="vempty">No versions yet — name the current state and snapshot it.</li>
      {/each}
    </ul>
    {#if pickedSnapshot}
      <pre class="vprev">{pickedSnapshot.text}</pre>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style lang="scss">
  /* snapshot history: commit graph + the accessible list carrying the same actions.
     Dialog.Content is rendered by Bits → :global */
  :global(.historydlg) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 41;
    width: min(52rem, 94vw);
    max-height: 86vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.1rem 1.3rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    color: var(--on-surface, #1c1b1f);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);

    .hsnap {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .vname {
      font: inherit;
      font-size: 0.85rem;
      flex: 1 1 8rem;
      min-width: 0;
      padding: 0.25rem 0.6rem;
      border: 1px solid var(--outline, #888);
      border-radius: 999px;
      background: var(--surface, white);
      color: var(--on-surface);
    }

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

    .vlist {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .vrow {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.78rem;
      border-radius: 6px;

      /* the snapshot the live document continues from, and the previewed one */
      &.live {
        background: color-mix(in srgb, var(--primary, #6750a4) 12%, transparent);
      }

      &.picked {
        outline: 1px solid var(--outline, #888);
      }

      .vpick {
        font: inherit;
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.2rem 0.4rem;
        border: none;
        background: none;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .vlabel {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .vbranch {
        flex: 0 0 auto;
        font-size: 0.68rem;
        padding: 0.02rem 0.4rem;
        border: 1px solid var(--outline, #888);
        border-radius: 999px;
        color: var(--on-surface-variant, #666);
      }

      .vat {
        flex: 0 0 auto;
        color: var(--on-surface-variant, #666);
      }

      .vcodes {
        flex: 0 0 auto;
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
