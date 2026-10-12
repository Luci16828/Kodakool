<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import ColorPanel from "$lib/coding/ColorPanel.svelte";
  import ConfirmDialog from "$lib/coding/ConfirmDialog.svelte";
  import { EXAMPLE_PROJECT } from "$lib/client/examples";
  import {
    createArticle,
    createFolder,
    deleteFolder,
    exportDatabase,
    importDatabase,
    listLocalCatalogs,
    watchArticles,
    watchFolders,
    type ArticleSummary,
  } from "$lib/client/coding-db";
  import type { Instructions } from "$lib/coding/instructions";

  const prefs = useColors();

  let articles = $state<ArticleSummary[]>([]);
  let folders = $state<string[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let errMsg = $state("");
  /** local frame-device catalogs (drive display + .qdc export) */
  const localCats = new SvelteMap<string, Instructions>();
  /** colors customization popup (Bits Dialog) */
  let colorsOpen = $state(false);
  /** inline "new project" name input */
  let newProj = $state(false);
  let projName = $state("");
  /** project marked for deletion (ConfirmDialog target) */
  let deleteProj = $state<string | null>(null);
  let confirmOpen = $state(false);

  onMount(() => {
    const unwatchA = watchArticles((list) => {
      articles = list;
      loading = false;
    });
    const unwatchF = watchFolders((names) => (folders = names));
    void listLocalCatalogs().then((m) => {
      for (const [folder, instr] of m) localCats.set(folder, instr);
    });
    return () => {
      unwatchA();
      unwatchF();
    };
  });

  let totals = $derived.by(() => {
    let codes = 0;
    let versions = 0;
    for (const a of articles) {
      codes += a.codes;
      versions += a.versions;
    }
    return { projects: projects.length, documents: articles.length, codes, versions };
  });

  /** every project: folders + any project that currently holds documents */
  let projects = $derived.by(() => {
    const set = new Set(folders);
    for (const a of articles) set.add(a.project);
    return [...set].sort((x, y) => x.localeCompare(y));
  });

  let byProject = $derived.by(() => {
    const groups = new Map<string, ArticleSummary[]>();
    for (const a of [...articles].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))) {
      const group = groups.get(a.project);
      if (group) group.push(a);
      else groups.set(a.project, [a]);
    }
    return groups;
  });

  function statsOf(items: ArticleSummary[]): { codes: number; versions: number } {
    let codes = 0;
    let versions = 0;
    for (const a of items) {
      codes += a.codes;
      versions += a.versions;
    }
    return { codes, versions };
  }

  function exportQdc(folder: string, instr: Instructions) {
    const url = URL.createObjectURL(new Blob([toQdc(instr, { options: prefs.options })], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${folder}.qdc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function newProject() {
    const name = projName.trim();
    if (!name) return;
    busy = true;
    errMsg = "";
    try {
      await createFolder(name);
      newProj = false;
      projName = "";
    } catch (e) {
      errMsg = String(e);
    } finally {
      busy = false;
    }
  }

  async function newArticle(project: string) {
    busy = true;
    errMsg = "";
    try {
      const article = await createArticle(project);
      await goto(resolve("/text/[folder]/[name]", { folder: article.project, name: article.name }));
    } catch (e) {
      errMsg = String(e);
    } finally {
      busy = false;
    }
  }

  async function removeProject(name: string) {
    await deleteFolder(name);
  }

  // ----- whole-database export / import (local RxDB snapshot as JSON) -----

  let dbMsg = $state("");
  let dbInput = $state<HTMLInputElement | undefined>(undefined);

  async function exportDb() {
    dbMsg = "";
    try {
      const dump = await exportDatabase();
      const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `kodakool-db-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      dbMsg = `exported ${dump.articles.length} documents, ${dump.catalogs.length} catalogs`;
    } catch (e) {
      dbMsg = `export failed: ${String(e)}`;
    }
  }

  async function importDb(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    dbMsg = "";
    try {
      const counts = await importDatabase(JSON.parse(await file.text()));
      dbMsg = `imported ${counts.articles} documents, ${counts.catalogs} catalogs`;
    } catch (err) {
      dbMsg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<svelte:head>
  <title>Projects — Kodakool</title>
</svelte:head>

<main>
  <Dialog.Root bind:open={colorsOpen}>
    <h1>Kodakool</h1>
    <p class="sub">Projects, documents, coding entries and frame devices live entirely in this browser.</p>
    <p class="nav">
      <Dialog.Trigger class="pill">
        <span class="material-symbols-rounded" aria-hidden="true">palette</span>colors
      </Dialog.Trigger>
      <button type="button" class="pill" onclick={() => void exportDb()} title="export the local database as JSON">
        <span class="material-symbols-rounded" aria-hidden="true">file_download</span>database
      </button>
      <button type="button" class="pill" onclick={() => dbInput?.click()} title="import a database JSON export">
        <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>import db
      </button>
      <input
        type="file"
        accept=".json,application/json"
        class="dbfile"
        bind:this={dbInput}
        onchange={(e) => void importDb(e)}
      />
    </p>
    {#if dbMsg}<p class="dbmsg">{dbMsg}</p>{/if}
    <p class="summary">
      <span class="chip">{totals.projects} projects</span>
      <span class="chip">{totals.documents} documents</span>
      <span class="chip">{totals.codes} codes</span>
      <span class="chip versions">{totals.versions} versions</span>
    </p>

    <div class="actions">
      <button type="button" class="go" onclick={() => (newProj = !newProj)} disabled={busy}>
        <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>new project
      </button>
      {#if newProj}
        <span class="nfrow">
          <input
            type="text"
            class="nfinput"
            placeholder="project name"
            aria-label="new project name"
            bind:value={projName}
            onkeydown={(e) => e.key === "Enter" && void newProject()}
          />
          <button type="button" class="go" onclick={() => void newProject()} disabled={busy || projName.trim() === ""}>
            create
          </button>
        </span>
      {/if}
      {#if errMsg}<span class="msg err">{errMsg}</span>{/if}
    </div>

    {#if loading}
      <p class="empty">Loading projects…</p>
    {:else}
      {#each projects as project (project)}
        {@const items = byProject.get(project) ?? []}
        {@const instr = localCats.get(project)}
        {@const stats = statsOf(items)}
        <section class="card">
          <h2>
            {project}
            {#if project === EXAMPLE_PROJECT}
              <span class="chip ex">example</span>
            {/if}
            <span class="chip">{items.length} documents</span>
            <span class="chip">{stats.codes} codes</span>
            {#if stats.versions}
              <span class="chip versions">{stats.versions} versions</span>
            {/if}
          </h2>
          <div class="prow">
            <button type="button" class="go" onclick={() => void newArticle(project)} disabled={busy}>
              <span class="material-symbols-rounded" aria-hidden="true">note_add</span>new document in {project}
            </button>
            {#if instr}
              <button type="button" class="export" onclick={() => exportQdc(project, instr)}>
                <span class="material-symbols-rounded" aria-hidden="true">file_download</span>export .qdc
              </button>
            {/if}
            <button
              type="button"
              class="delproj"
              aria-label="delete project {project}"
              onclick={() => {
                deleteProj = project;
                confirmOpen = true;
              }}
            >
              <span class="material-symbols-rounded" aria-hidden="true">delete</span>delete project
            </button>
          </div>
          {#if items.length}
            <ul>
              {#each items as a (a.id)}
                <li>
                  <a href={resolve("/text/[folder]/[name]", { folder: a.project, name: a.name })}>
                    <span class="name">{a.name}</span>
                  </a>
                  <span class="codes">{a.codes}</span>
                  {#if a.versions}
                    <span class="chip versions">{a.versions} v</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="empty">Empty project — add a document to start coding.</p>
          {/if}
        </section>
      {:else}
        <p class="empty">No projects yet — create one to start coding.</p>
      {/each}
    {/if}

    <ConfirmDialog
      bind:open={confirmOpen}
      title={deleteProj === null ? "" : `Delete project ${deleteProj}/?`}
      detail="Deletes the project with all its documents, coding entries and its frame-device catalog."
      onconfirm={() => {
        if (deleteProj !== null) void removeProject(deleteProj);
        deleteProj = null;
      }}
    />

    <Dialog.Overlay class="dlg-overlay" />
    <Dialog.Content class="colorsdlg" aria-label="colors">
      <Dialog.Close class="dlgclose" aria-label="close colors">
        <span class="material-symbols-rounded" aria-hidden="true">close</span>
      </Dialog.Close>
      <ColorPanel />
    </Dialog.Content>
  </Dialog.Root>
</main>

<style>
  main {
    max-width: 44rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  h1 {
    font-size: 1.4rem;
    margin-bottom: 0.15rem;
  }
  .sub {
    margin: 0 0 0.8rem;
    font-size: 0.85rem;
    color: var(--on-surface-variant);
  }
  .summary {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .nfrow {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .nfinput {
    font: inherit;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
  }
  .go {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.9rem;
    border-radius: 99px;
    border: 1px solid var(--primary, #6750a4);
    background: var(--primary, #6750a4);
    color: white;
    cursor: pointer;
  }
  .go .material-symbols-rounded {
    font-size: 1.1rem;
  }
  .go:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .msg {
    color: #0a6b2d;
  }
  .msg.err {
    color: #b3261e;
  }
  .card {
    margin-top: 1.25rem;
    padding: 0.75rem 0.9rem 0.9rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
  }
  li:hover {
    background: var(--surface-variant);
  }
  li a {
    text-decoration: none;
    color: inherit;
    flex: 1;
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .name {
    font-weight: 600;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
    color: var(--on-surface-variant);
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .prow {
    margin-top: 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .export {
    font: inherit;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--on-surface-variant);
    background: var(--surface-variant);
    border: none;
    border-radius: 99px;
    padding: 0.1rem 0.6rem;
    cursor: pointer;
  }
  .export .material-symbols-rounded {
    font-size: 1rem;
  }
  .export:hover {
    filter: brightness(1.1);
  }
  .delproj {
    font: inherit;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: #b3261e;
    background: none;
    border: 1px solid #b3261e;
    border-radius: 99px;
    padding: 0.1rem 0.6rem;
    cursor: pointer;
  }
  .delproj .material-symbols-rounded {
    font-size: 1rem;
  }
  .delproj:hover {
    background: #b3261e;
    color: white;
  }
  .dbfile {
    display: none;
  }
  .dbmsg {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant);
  }
  .codes {
    color: var(--on-surface-variant);
    font-variant-numeric: tabular-nums;
    min-width: 2rem;
    text-align: right;
  }
  .empty {
    margin-top: 0.75rem;
    color: var(--on-surface-variant);
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 99px;
    background: var(--surface-variant);
    color: var(--on-surface-variant);
  }
  .chip.versions {
    background: var(--primary-container);
    color: var(--on-primary-container);
  }
  .chip.ex {
    background: var(--primary);
    color: var(--on-primary);
  }
</style>
