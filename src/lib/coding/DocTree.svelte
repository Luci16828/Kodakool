<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { ScrollArea, Select } from "bits-ui";
  import { slide } from "svelte/transition";
  import "material-symbols/rounded.css";
  import { compareNames, docIcon, displayName } from "$lib/coding/display";
  import { openRowMenu } from "$lib/coding/context-menu";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import RowMenu from "$lib/coding/RowMenu.svelte";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import type { Instructions } from "$lib/coding/instructions";
  import { deleteArticle, deleteFolder, type ArticleSummary } from "$lib/client/coding-db";
  import DatabaseControls from "$lib/client/DatabaseControls.svelte";
  import { createProjectDoc, openDoc, openNewDoc } from "$lib/client/open-doc";
  import { downloadArticle, downloadText } from "$lib/client/download";
  import UploadZone from "$lib/client/UploadZone.svelte";

  /**
   * The coding page's document-tree sidebar — the app's whole file explorer (the
   * project dashboard is gone): the project switcher at the top (a chip for the
   * open project + a dropdown of every OTHER project, ending with the "new project"
   * row; picking one opens that project's first document, creating one when it is
   * empty), the collapsible project header (the selected upload target) whose menu
   * offers new document / .qdc export / project deletion, the compact upload row,
   * one row per document of THIS project (other projects never appear), and the
   * database export/import row at the bottom. New documents open their coding page;
   * deleting the open document returns to the root, which reopens the last document.
   *
   * Rows and the project header carry right-click context menus (Bits ContextMenu,
   * anchored at the pointer); the `more_vert` buttons open the same menus for keyboard use.
   */
  let {
    folder,
    currentName,
    docs,
    allDocs,
    projects,
    instr,
    confirm,
  }: {
    folder: string;
    currentName: string;
    docs: ArticleSummary[];
    /** every local document (the switcher opens the target project's first one) */
    allDocs: ArticleSummary[];
    /** every local project: registered folders + projects that hold documents (sorted) */
    projects: string[];
    /** this project's frame-device catalog (drives the .qdc export), null when none */
    instr: Instructions | null;
    confirm: ConfirmAsk;
  } = $props();

  const prefs = useColors();

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
  /** the project header folds its document list: `folder_open` while it is shown */
  let open = $state(true);

  const others = $derived(projects.filter((name) => name !== folder));
  /** select items so the trigger keeps its label while the menu is closed */
  const items = $derived([
    ...others.map((name) => ({ value: name, label: name })),
    { value: NEW_PROJECT, label: "New project" },
  ]);

  function focusFirst(node: HTMLInputElement): void {
    node.focus();
  }

  /** open a document of THIS project */
  async function newDoc(): Promise<void> {
    busy = true;
    try {
      await openNewDoc(folder);
    } finally {
      busy = false;
    }
  }
  function openArticle(a: ArticleSummary): void {
    void openDoc(a.project, a.name);
  }
  async function deleteDoc(a: ArticleSummary): Promise<void> {
    await deleteArticle(a.id);
    // deleting the document we are looking at returns to the root, which reopens the last document
    if (a.project === folder && a.name === currentName) await goto(resolve("/"));
  }
  /** the tree row's context menu: open / download / delete (replaces the old per-row trash) */
  function docMenu(a: ArticleSummary): { label: string; icon: string; danger?: boolean; onSelect: () => void }[] {
    return [
      { label: "Open document", icon: "open_in_new", onSelect: () => openArticle(a) },
      { label: "Download document", icon: "download", onSelect: () => void downloadArticle(a) },
      {
        label: "Delete document",
        icon: "delete",
        danger: true,
        onSelect: () =>
          confirm.ask(
            `Delete "${displayName(a.name, a.kind)}"?`,
            `This removes the document and its ${a.codes} code entr${a.codes === 1 ? "y" : "ies"}.`,
            () => void deleteDoc(a),
          ),
      },
    ];
  }

  /** the switcher opens the target project's FIRST document (creating one when empty) */
  async function switchProject(name: string): Promise<void> {
    if (name === "" || name === folder) return;
    busy = true;
    try {
      const mine = allDocs.filter((a) => a.project === name).sort((x, y) => compareNames(x.name, y.name));
      const first = mine[0];
      if (first) await openDoc(name, first.name);
      else await openNewDoc(name);
    } finally {
      busy = false;
    }
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
      // createProjectDoc: createFolder is idempotent, a taken name simply opens a fresh document
      await createProjectDoc(name);
    } catch (e) {
      projErr = String(e);
      busy = false;
    }
  }

  /** the project header's menu: .qdc export of the local catalog (when it exists) */
  function exportQdc(): void {
    if (instr === null) return;
    downloadText(`${folder}.qdc`, toQdc(instr, { origin: folder, options: prefs.options }), "application/xml");
  }
  async function removeProject(): Promise<void> {
    await deleteFolder(folder);
    // the open project is gone: the root reopens the last surviving document
    await goto(resolve("/"));
  }
</script>

<aside class="docs">
  <div class="projrow">
    <Select.Root type="single" {items} bind:value={picked} onValueChange={(name: string) => pickProject(name)}>
      <Select.Trigger class="switchbtn" aria-label="Switch project" title="Switch to another project">
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
        <Select.Item class="switchopt newopt" value={NEW_PROJECT} label="New project">
          <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>New project
        </Select.Item>
      </Select.Content>
    </Select.Root>
  </div>
  {#if newProj}
    <div class="nfrow">
      <input
        type="text"
        class="nfinput"
        placeholder="Project name"
        aria-label="New project name"
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
      <button type="button" class="nfgo" disabled={busy || projName.trim() === ""} onclick={() => void newProject()}>
        create
      </button>
    </div>
  {/if}
  {#if projErr}<p class="pmsg">{projErr}</p>{/if}
  <div class="docshead">
    <button
      type="button"
      class="newdoc"
      disabled={busy}
      title="New document in {folder}"
      aria-label="New document in {folder}"
      onclick={() => void newDoc()}
    >
      <span class="material-symbols-rounded" aria-hidden="true">note_add</span>
    </button>
  </div>
  <div class="docsbody">
    <ScrollArea.Root class="wsarea" type="hover">
      <ScrollArea.Viewport class="wsview treeview">
        <UploadZone {folder} compact />
        <div class="fgrow">
          <RowMenu
            items={[
              { label: `New document in ${folder}`, icon: "note_add", onSelect: () => void newDoc() },
              ...(instr ? [{ label: "Export .qdc", icon: "file_download", onSelect: () => exportQdc() }] : []),
              {
                label: "Delete project",
                icon: "delete",
                danger: true,
                onSelect: () =>
                  confirm.ask(
                    `Delete project ${folder}/?`,
                    "Deletes the project with all its documents, coding entries and its frame-device catalog.",
                    () => void removeProject(),
                  ),
              },
            ]}
          >
            {#snippet trigger({ props }: { props: Record<string, unknown> })}
              <!-- role=button div (not a <button>): the menu pill nests inside it -->
              <div
                {...props}
                class="fgroup sel"
                role="button"
                tabindex="0"
                aria-pressed="true"
                aria-expanded={open}
                title="Selected upload target — uploads and new documents land in {folder}/ · click folds the document list · right-click for project actions"
                onclick={() => (open = !open)}
                onkeydown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  open = !open;
                }}
              >
                <span class="material-symbols-rounded" aria-hidden="true">{open ? "folder_open" : "folder"}</span
                >{folder}/
                <span class="fcodes">{docs.length}</span>
                <button
                  type="button"
                  class="menubtn"
                  title="Project actions"
                  aria-label="Project menu"
                  onclick={(e) => {
                    e.stopPropagation();
                    openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget);
                  }}
                >
                  <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                </button>
              </div>
            {/snippet}
          </RowMenu>
        </div>
        {#if open}
          <ul class="doclist" transition:slide={{ duration: 180 }}>
            {#each docs as a (a.id)}
              <li class:current={a.name === currentName}>
                <RowMenu items={docMenu(a)}>
                  {#snippet trigger({ props }: { props: Record<string, unknown> })}
                    <div class="row" {...props}>
                      <a href={resolve("/text/[folder]/[name]", { folder: a.project, name: a.name })}>
                        <span class="material-symbols-rounded docicon" aria-hidden="true">{docIcon(a)}</span>
                        {displayName(a.name, a.kind)}
                      </a>
                      <span class="fcodes">{a.codes}</span>
                      <button
                        type="button"
                        class="menubtn"
                        title="Document actions"
                        aria-label={`Menu for ${displayName(a.name, a.kind)}`}
                        onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
                      >
                        <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                      </button>
                    </div>
                  {/snippet}
                </RowMenu>
              </li>
            {/each}
          </ul>
        {/if}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
        <ScrollArea.Thumb class="wsthumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  </div>
  <div class="dbrow">
    <DatabaseControls compact />
  </div>
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
  .docsbody {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
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

    .menubtn {
      margin-left: 0.15rem;
    }
  }
  /* folder header row: the group button IS the row (it carries the context menu) */
  .fgrow {
    display: flex;
    align-items: center;
    gap: 0.2rem;

    :global(.ctxmenu) {
      min-width: 13rem;
    }

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

    /* the Bits trigger wraps the row's own content (right-click opens its menu) */
    :global(.row) {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 0.4rem;
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
  /* database export/import row (sidebar bottom — the dashboard is gone) */
  .dbrow {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--outline, #ccc);
  }

  @media (max-width: 50rem) {
    .docs {
      height: auto;
    }

    .docsbody {
      max-height: 60vh;
    }
  }
</style>
