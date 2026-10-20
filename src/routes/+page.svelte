<script lang="ts">
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import ColorsDialog from "$lib/coding/ColorsDialog.svelte";
  import { compareDocs, compareNames } from "$lib/coding/display";
  import { EXAMPLE_PROJECT, seedExampleProject } from "$lib/client/examples";
  import { getArticle, listArticles, listFolders } from "$lib/client/coding-db";
  import DatabaseControls from "$lib/client/DatabaseControls.svelte";
  import { lastDoc } from "$lib/client/last-doc";
  import { createProjectDoc, openDoc, openNewDoc } from "$lib/client/open-doc";

  /**
   * The app's entry point. The coding page is the app's single screen (its sidebar
   * is the project switcher + file explorer), so `/` resolves to a document: the
   * last one the user worked on (when it still exists), else the first document.
   * With an empty database this minimal start screen stays visible: create a
   * project, create a document in an existing project, import a database export.
   */
  let colorsOpen = $state(false);
  let busy = $state(false);
  let errMsg = $state("");
  /** every project: registered folders + projects that hold documents (sorted) */
  let projects = $state<string[]>([]);
  let resolving = $state(true);
  let newProj = $state(false);
  let projName = $state("");

  onMount(() => {
    void (async () => {
      // this page's onMount runs BEFORE the layout's, so the layout's fire-and-forget
      // seed may not have started yet: seedExampleProject() is once-per-profile and
      // coalesces an in-flight run, so awaiting it covers both orders
      await seedExampleProject();
      const arts = await listArticles();
      const set = new Set(await listFolders());
      for (const a of arts) set.add(a.project);
      projects = [...set].sort(compareNames);

      const last = lastDoc();
      if (last && (await getArticle(last.folder, last.name))) {
        await openDoc(last.folder, last.name);
        return;
      }
      const first = [...arts].sort(compareDocs)[0];
      if (first) await openDoc(first.project, first.name);
      resolving = false;
    })();
  });

  async function newProject() {
    const name = projName.trim();
    if (!name) return;
    busy = true;
    errMsg = "";
    try {
      // createProjectDoc: createFolder is idempotent, a taken name just opens a fresh document
      await createProjectDoc(name);
    } catch (e) {
      errMsg = String(e);
      busy = false;
    }
  }

  async function newDoc(project: string) {
    busy = true;
    errMsg = "";
    try {
      await openNewDoc(project);
    } catch (e) {
      errMsg = String(e);
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Kodakool</title>
</svelte:head>

<main class="page">
  {#if resolving}
    <p class="empty">Loading…</p>
  {:else}
    <ColorsDialog bind:open={colorsOpen}>
      <h1>Kodakool</h1>
      <p class="sub">
        Projects, documents, coding entries and frame devices live entirely in this browser. The sidebar of every
        document is the file explorer.
      </p>
      <p class="nav">
        <Dialog.Trigger class="pill">
          <span class="material-symbols-rounded" aria-hidden="true">palette</span>Colors
        </Dialog.Trigger>
        <DatabaseControls />
      </p>

      <div class="actions">
        <button type="button" class="go" onclick={() => (newProj = !newProj)} disabled={busy}>
          <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>New project
        </button>
        {#if projects.length > 0}
          <button type="button" class="go" onclick={() => void newDoc(projects[0])} disabled={busy}>
            <span class="material-symbols-rounded" aria-hidden="true">note_add</span>New document in
            {projects[0]}{#if projects[0] === EXAMPLE_PROJECT}
              (example){/if}
          </button>
        {/if}
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
            <button
              type="button"
              class="go"
              onclick={() => void newProject()}
              disabled={busy || projName.trim() === ""}
            >
              create
            </button>
          </span>
        {/if}
        {#if errMsg}<span class="msg err">{errMsg}</span>{/if}
      </div>

      <p class="empty">Nothing open yet — create a project to start coding.</p>
    </ColorsDialog>
  {/if}
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
  .nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
  .empty {
    margin-top: 0.75rem;
    color: var(--on-surface-variant);
  }
</style>
