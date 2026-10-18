<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import { openRowMenu } from "$lib/coding/context-menu";
  import ColorsDialog from "$lib/coding/ColorsDialog.svelte";
  import ConfirmHost from "$lib/coding/ConfirmHost.svelte";
  import { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import RowMenu from "$lib/coding/RowMenu.svelte";
  import { EXAMPLE_PROJECT } from "$lib/client/examples";
  import { downloadText } from "$lib/client/download";
  import {
    createFolder,
    deleteFolder,
    exportDatabase,
    importDatabase,
    listLocalCatalogs,
    statsOf,
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
  const confirm = new ConfirmAsk();

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
    const { codes, versions } = statsOf(articles);
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

  function exportQdc(folder: string, instr: Instructions) {
    downloadText(`${folder}.qdc`, toQdc(instr, { options: prefs.options }), "application/xml");
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

  async function removeProject(name: string) {
    await deleteFolder(name);
  }

  /** the project card's context menu (replaces the old `delete project` button) */
  function cardMenu(
    project: string,
    items: ArticleSummary[],
    instr: Instructions | undefined,
  ): { label: string; icon: string; danger?: boolean; onSelect: () => void }[] {
    return [
      {
        label: "Open project",
        icon: "folder_open",
        onSelect: () => void goto(resolve("/project/[folder]", { folder: project })),
      },
      ...(instr
        ? [
            {
              label: "Export .qdc",
              icon: "file_download",
              onSelect: () => exportQdc(project, instr),
            },
          ]
        : []),
      {
        label: "Delete project",
        icon: "delete",
        danger: true,
        onSelect: () =>
          confirm.ask(
            `Delete project ${project}/?`,
            "Deletes the project with all its documents, coding entries and its frame-device catalog.",
            () => void removeProject(project),
          ),
      },
    ];
  }

  // ----- whole-database export / import (local RxDB snapshot as JSON) -----

  let dbMsg = $state("");
  let dbInput = $state<HTMLInputElement | undefined>(undefined);

  async function exportDb() {
    dbMsg = "";
    try {
      const dump = await exportDatabase();
      downloadText(
        `kodakool-db-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(dump, null, 2),
        "application/json",
      );
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

<main class="page">
  <ColorsDialog bind:open={colorsOpen}>
    <h1>Kodakool</h1>
    <p class="sub">Projects, documents, coding entries and frame devices live entirely in this browser.</p>
    <p class="nav">
      <Dialog.Trigger class="pill">
        <span class="material-symbols-rounded" aria-hidden="true">palette</span>Colors
      </Dialog.Trigger>
      <button type="button" class="pill" onclick={() => void exportDb()} title="Export the local database as JSON">
        <span class="material-symbols-rounded" aria-hidden="true">file_download</span>Database
      </button>
      <button type="button" class="pill" onclick={() => dbInput?.click()} title="Import a database JSON export">
        <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>Import DB
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
        <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>New project
      </button>
      {#if newProj}
        <span class="nfrow">
          <input
            type="text"
            class="nfinput"
            placeholder="Project name"
            aria-label="New project name"
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
        <RowMenu items={cardMenu(project, items, instr)}>
          {#snippet trigger({ props }: { props: Record<string, unknown> })}
            <section class="card" {...props}>
              <h2>
                <a class="open" href={resolve("/project/[folder]", { folder: project })}>
                  {project}
                  <span class="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                </a>
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
                {#if instr}
                  <button type="button" class="export" onclick={() => exportQdc(project, instr)}>
                    <span class="material-symbols-rounded" aria-hidden="true">file_download</span>Export .qdc
                  </button>
                {/if}
                <button
                  type="button"
                  class="menubtn"
                  title="Project actions"
                  aria-label={`Menu for project ${project}`}
                  onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
                >
                  <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                </button>
              </div>
              {#if items.length === 0}
                <p class="empty">Empty project — open it to add a document.</p>
              {/if}
            </section>
          {/snippet}
        </RowMenu>
      {:else}
        <p class="empty">No projects yet — create one to start coding.</p>
      {/each}
    {/if}

    <ConfirmHost {confirm} />
  </ColorsDialog>
</main>

<style>
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
  .msg {
    color: #0a6b2d;
  }
  .msg.err {
    color: #b3261e;
  }
  .card {
    position: relative;
    margin-top: 1.25rem;
    padding: 0.75rem 0.9rem 0.9rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
  }
  /* the whole card is the link into the project: the title link's overlay
     covers the card, the action row sits above it so its buttons stay reachable */
  .card .open {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    color: inherit;
    text-decoration: none;
  }
  .card .open .material-symbols-rounded {
    font-size: 1.1rem;
    color: var(--on-surface-variant, #666);
  }
  .card .open:hover {
    color: var(--primary, #6750a4);
  }
  .card .open:hover .material-symbols-rounded {
    color: var(--primary, #6750a4);
  }
  .card .open::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 12px;
  }
  .card:hover {
    border-color: var(--primary, #6750a4);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
    position: relative;
    z-index: 1;
    margin-top: 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dbfile {
    display: none;
  }
  .dbmsg {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant);
  }
  .empty {
    margin-top: 0.75rem;
    color: var(--on-surface-variant);
  }
</style>
