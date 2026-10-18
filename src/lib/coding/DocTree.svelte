<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { Collapsible, ScrollArea } from "bits-ui";
  import "material-symbols/rounded.css";
  import { docIcon, displayName } from "$lib/coding/display";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import { createArticle, deleteArticle, type ArticleSummary } from "$lib/client/coding-db";
  import UploadZone from "$lib/client/UploadZone.svelte";

  /**
   * The coding page's document-tree sidebar: the collapsible project header (the
   * selected upload target), the compact upload row, and one row per document of
   * THIS project (other projects never appear). New documents open their coding
   * page; deleting the open document returns to its project.
   */
  let {
    folder,
    currentName,
    docs,
    confirm,
    open = $bindable(true),
  }: {
    folder: string;
    currentName: string;
    docs: ArticleSummary[];
    confirm: ConfirmAsk;
    open?: boolean;
  } = $props();

  let busy = $state(false);

  async function newDoc(): Promise<void> {
    busy = true;
    try {
      const a = await createArticle(folder);
      await goto(resolve("/text/[folder]/[name]", { folder: a.project, name: a.name }));
    } finally {
      busy = false;
    }
  }
  async function deleteDoc(a: ArticleSummary): Promise<void> {
    await deleteArticle(a.id);
    // deleting the document we are looking at returns to its project
    if (a.project === folder && a.name === currentName) await goto(resolve("/project/[folder]", { folder: a.project }));
  }
</script>

<aside class="docs" class:closed={!open}>
  <Collapsible.Root class="treeroot" bind:open>
    <div class="docshead">
      <Collapsible.Trigger
        class={`treebtn ${open ? "" : "closed"}`}
        aria-label="toggle document tree"
        title={open ? "collapse document tree" : "expand document tree"}
      >
        <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
        {#if open}{folder}{/if}
      </Collapsible.Trigger>
      {#if open}
        <button
          type="button"
          class="newdoc"
          disabled={busy}
          title="new document in {folder}"
          aria-label="new document in {folder}"
          onclick={() => void newDoc()}
        >
          <span class="material-symbols-rounded" aria-hidden="true">note_add</span>
        </button>
      {/if}
    </div>
    <Collapsible.Content class="docsbody">
      <ScrollArea.Root class="wsarea" type="hover">
        <ScrollArea.Viewport class="wsview treeview">
          <UploadZone {folder} compact />
          <div class="fgrow">
            <button
              type="button"
              class="fgroup sel"
              aria-pressed="true"
              title="selected upload target — uploads and new documents land in {folder}/"
            >
              <span class="material-symbols-rounded" aria-hidden="true">folder</span>{folder}/
              <span class="fcodes">{docs.length}</span></button
            >
          </div>
          <ul>
            {#each docs as a (a.id)}
              <li class:current={a.name === currentName}>
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
                    confirm.ask(
                      `Delete "${displayName(a.name, a.kind)}"?`,
                      `This removes the document and its ${a.codes} code entr${a.codes === 1 ? "y" : "ies"}.`,
                      () => void deleteDoc(a),
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

<style lang="scss">
  /* document tree sidebar (collapsible, left of the editor) */
  aside {
    min-height: 0;
  }
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
  :global(.docsbody[data-ending-style]) {
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

  @media (max-width: 50rem) {
    .docs {
      height: auto;
    }

    :global(.docsbody) {
      max-height: 60vh;
    }
  }
</style>
