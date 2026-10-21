<script lang="ts">
  import { Popover } from "bits-ui";
  import "material-symbols/rounded.css";
  import { SvelteSet } from "svelte/reactivity";
  import { displayName } from "$lib/coding/display";
  import type { ArticleSummary } from "$lib/coding/doc";
  import { downloadBlob, downloadText } from "$lib/client/download";

  /**
   * The bar's download picker: checkboxes over this project's documents,
   * PDFs download their original bytes, texts as .md/.txt. `liveText` supplies
   * the open document's editor body (incl. unsaved edits). The picker touches no
   * store itself: `getDocText`/`getPdfBytes` are the parent's account-aware accessors.
   */
  let {
    folder,
    docs,
    liveId,
    liveText,
    getDocText,
    getPdfBytes,
    open = $bindable(false),
  }: {
    folder: string;
    docs: ArticleSummary[];
    liveId: string;
    liveText: () => string;
    /** stored text of a document, null when gone */
    getDocText: (id: string) => Promise<string | null>;
    /** original PDF bytes of a document, null when gone */
    getPdfBytes: (id: string) => Promise<Uint8Array | null>;
    open?: boolean;
  } = $props();

  /** article ids picked in the picker */
  const sel = new SvelteSet<string>();

  function toggle(id: string): void {
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
  }
  /** "select all" / "select none" */
  function toggleAll(): void {
    const all = sel.size === docs.length && docs.length > 0;
    sel.clear();
    if (!all) for (const a of docs) sel.add(a.id);
  }
  /** download every picked document (the open document uses its live editor body) */
  async function downloadSelected(): Promise<void> {
    for (const a of docs) {
      if (!sel.has(a.id)) continue;
      if (a.kind === "pdf") {
        const bytes = await getPdfBytes(a.id);
        if (bytes !== null) {
          // .slice() gives a fresh ArrayBuffer-backed view (BlobPart requires it)
          downloadBlob(displayName(a.name, "pdf"), new Blob([bytes.slice()], { type: "application/pdf" }));
          continue;
        }
      }
      const text = a.id === liveId ? liveText() : ((await getDocText(a.id)) ?? "");
      if (text === "") continue;
      const filename = displayName(a.name, a.kind);
      downloadText(filename, text, /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain");
    }
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger class="pill" aria-label="Download files" title="Download project files">
    <span class="material-symbols-rounded" aria-hidden="true">download</span>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="downloads" role="dialog" aria-label="Download files">
      <div class="dlhead">
        <span>download from {folder}/</span>
        <button type="button" class="dlsel" onclick={toggleAll}>
          {sel.size === docs.length && docs.length > 0 ? "Select none" : "Select all"}
        </button>
      </div>
      <ul>
        {#each docs as a (a.id)}
          <li>
            <label>
              <input type="checkbox" checked={sel.has(a.id)} onchange={() => toggle(a.id)} />
              {displayName(a.name, a.kind)}
            </label>
          </li>
        {/each}
      </ul>
      <button type="button" class="dldl" disabled={sel.size === 0} onclick={() => void downloadSelected()}>
        <span class="material-symbols-rounded" aria-hidden="true">download</span>
        download {sel.size > 0 ? sel.size : ""}
      </button>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style lang="scss">
  /* Popover.Content is rendered by Bits → :global */
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
</style>
