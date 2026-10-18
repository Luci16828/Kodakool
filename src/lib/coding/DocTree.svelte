<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { Collapsible, ScrollArea, Select } from "bits-ui";
  import "material-symbols/rounded.css";
  import { docIcon, displayName } from "$lib/coding/display";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import { createArticle, createFolder, deleteArticle, type ArticleSummary } from "$lib/client/coding-db";
  import UploadZone from "$lib/client/UploadZone.svelte";

  /**
   * The coding page's document-tree sidebar: the project switcher at the top (a chip for
   * the open project + a dropdown of every OTHER project, ending with the "new project"
   * row), the collapsible project header (the selected upload target), the compact upload
   * row, and one row per document of THIS project (other projects never appear). New
   * documents open their coding page; switching to another project and creating one open
   * that project's page; deleting the open document returns to its project.
   */
  let {
    folder,
    currentName,
    docs,
    projects,
    confirm,
    open = $bindable(true),
  }: {
    folder: string;
    currentName: string;
    docs: ArticleSummary[];
    /** every local project: registered folders + projects that hold documents (sorted) */
    projects: string[];
    confirm: ConfirmAsk;
    open?: boolean;
  } = $props();

  let busy = $state(false);
  /** inline "new project" row of the switcher (opened by the dropdown's last row) */
  let newProj = $state(false);
  let projName = $state("");
  let projErr = $state("");

  /** the dropdown's "new project" row — a sentinel value, never a real project name */
  const NEW_PROJECT = "__new__";
  /**
   * The select's own value. It starts empty (the trigger then shows its placeholder,
   * which is the open project's name) and only ever holds the sentinel between a
   * "new project" pick and the reset in `pickProject` — every real pick navigates away.
   */
  let picked = $state("");

  /** the dropdown offers every OTHER project (the open one is the chip itself) + creation */
  const others = $derived(projects.filter((name) => name !== folder));
  /** select items so the trigger keeps its label while the menu is closed */
  const items = $derived([
    ...others.map((name) => ({ value: name, label: name })),
    { value: NEW_PROJECT, label: "new project" },
  ]);

  function focusFirst(node: HTMLInputElement): void {
    node.focus();
  }

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

  /** the switcher leaves the document: every project has its own page */
  async function switchProject(name: string): Promise<void> {
    if (name === "" || name === folder) return;
    await goto(resolve("/project/[folder]", { folder: name }));
  }
  /** dropdown pick: a project switches, the "new project" row opens the name input */
  function pickProject(name: string): void {
    if (name === NEW_PROJECT) {
      // the sentinel is not a project: restore the chip label and open the name row
      picked = folder;
      newProj = true;
      projName = "";
      projErr = "";
      return;
    }
    void switchProject(name);
  }
  async function newProject(): Promise<void> {
    const name = projName.trim();
    if (!name) return;
    busy = true;
    projErr = "";
    try {
      // createFolder is idempotent: an existing name simply becomes the switch target
      await createFolder(name);
      await goto(resolve("/project/[folder]", { folder: name }));
    } catch (e) {
      projErr = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<aside class="docs" class:closed={!open}>
  <Collapsible.Root class="treeroot" bind:open>
    {#if open}
      <div class="projrow">
        <Select.Root type="single" {items} bind:value={picked} onValueChange={(name: string) => pickProject(name)}>
          <Select.Trigger class="switchbtn" aria-label="switch project" title="switch to another project">
            <span class="material-symbols-rounded switchicon" aria-hidden="true">folder</span>
            <span class="switchcol">
              <span class="switchcap">project</span>
              <Select.Value class="switchname" placeholder={folder} />
            </span>
            <span class="material-symbols-rounded switchmore" aria-hidden="true">unfold_more</span>
          </Select.Trigger>
          <Select.Content class="switchlist" side="bottom" align="start" sideOffset={8}>
            {#each others as name (name)}
              <Select.Item class="switchopt" value={name} label={name}>{name}</Select.Item>
            {/each}
            <Select.Item class="switchopt newopt" value={NEW_PROJECT} label="new project">
              <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>new project
            </Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      {#if newProj}
        <div class="nfrow">
          <input
            type="text"
            class="nfinput"
            placeholder="project name"
            aria-label="new project name"
            spellcheck="false"
            use:focusFirst
            bind:value={projName}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                void newProject();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                newProj = false;
              }
            }}
          />
          <button
            type="button"
            class="nfgo"
            disabled={busy || projName.trim() === ""}
            onclick={() => void newProject()}
          >
            create
          </button>
        </div>
      {/if}
      {#if projErr}<p class="pmsg">{projErr}</p>{/if}
    {/if}
    <div class="docshead">
      <Collapsible.Trigger
        class={`treebtn ${open ? "" : "closed"}`}
        aria-label="toggle document tree"
        title={open ? "collapse document tree" : "expand document tree"}
      >
        <span class="material-symbols-rounded" aria-hidden="true">folder_open</span>
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
  /* ----- project switcher (sidebar top row, account-switcher style) ----- */
  .projrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0.25rem 0 0.55rem;
  }
  :global(.switchbtn) {
    font: inherit;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.55rem;
    text-align: left;
    color: var(--on-surface, #111);
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.14);
    cursor: pointer;

    .switchicon {
      font-size: 1.3rem;
      flex: 0 0 auto;
      color: var(--primary, #6750a4);
    }

    /* caption + project name stacked, like an account chip */
    .switchcol {
      display: flex;
      flex-direction: column;
      gap: 0.05rem;
      flex: 1;
      min-width: 0;
    }

    .switchcap {
      font-size: 0.6rem;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--on-surface-variant, #666);
    }

    .switchmore {
      font-size: 1.2rem;
      flex: 0 0 auto;
      color: var(--on-surface-variant, #666);
    }

    /* Bits sets data-state on the trigger at runtime */
    &:global([data-state="open"]) {
      border-color: var(--primary, #6750a4);
      background: var(--primary-container, #e8def8);
    }
  }
  :global(.switchbtn:hover) {
    border-color: var(--primary, #6750a4);
  }
  /* the current project name: the trigger's only truncating part */
  :global(.switchname) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.95rem;
    font-weight: 700;
  }
  /* inline "new project" row under the switcher */
  .nfrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0 0 0.35rem;
  }
  .nfinput {
    font: inherit;
    font-size: 0.8rem;
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--outline, #888);
    border-radius: 10px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
  }
  .nfgo {
    font: inherit;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--primary, #6750a4);
    border-radius: 10px;
    background: var(--primary, #6750a4);
    color: var(--on-primary, #fff);
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .pmsg {
    margin: -0.2rem 0 0.3rem;
    font-size: 0.72rem;
    color: #b3261e;
  }
  /* the dropdown is portaled by Bits (outside this component) */
  :global(.switchlist) {
    z-index: 60;
    min-width: var(--bits-select-anchor-width);
    max-width: var(--bits-select-content-available-width);
    max-height: 60vh;
    overflow: auto;
    gap: 0.15rem;
    padding: 0.35rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
    font-size: 0.85rem;
  }
  :global(.switchopt) {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border-radius: 8px;
    cursor: pointer;

    /* Bits sets these at runtime (keyboard highlight / selected item) */
    &:global([data-highlighted]) {
      background: var(--surface-variant, #eee);
    }

    &:global([data-selected]) {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
      font-weight: 700;
    }
  }
  /* the dropdown's last row: create a project (separated from the project list) */
  :global(.switchopt.newopt) {
    margin-top: 0.25rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--outline, #ccc);
    border-radius: 0 0 8px 8px;
    color: var(--primary, #6750a4);
    font-weight: 600;

    .material-symbols-rounded {
      font-size: 1.15rem;
    }
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
  /* the toggle is icon-only: the switcher above carries the project name */
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
