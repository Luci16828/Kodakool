<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import ColorsDialog from "$lib/coding/ColorsDialog.svelte";
  import ConfirmHost from "$lib/coding/ConfirmHost.svelte";
  import { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import { docIcon, displayName } from "$lib/coding/display";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import { EXAMPLE_PROJECT } from "$lib/client/examples";
  import { downloadText } from "$lib/client/download";
  import UploadZone from "$lib/client/UploadZone.svelte";
  import {
    createArticle,
    deleteArticle,
    deleteFolder,
    getLocalCatalog,
    statsOf,
    watchArticles,
    type ArticleSummary,
  } from "$lib/client/coding-db";
  import type { Instructions } from "$lib/coding/instructions";

  const { data }: { data: { folder: string } } = $props();
  const prefs = useColors();

  /** every local document; the project's own slice is derived from it */
  let docs = $state<ArticleSummary[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  /** the project's frame-device catalog (drives the .qdc export) */
  let instr = $state<Instructions | null>(null);
  /** colors customization popup (Bits Dialog) */
  let colorsOpen = $state(false);
  /** pending destructive action for the shared ConfirmDialog */
  const confirm = new ConfirmAsk();

  /** only this project's documents — other projects stay on the project screen */
  const items = $derived.by(() =>
    docs
      .filter((a) => a.project === data.folder)
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })),
  );
  const stats = $derived(statsOf(items));

  onMount(() => {
    const unwatch = watchArticles((list) => {
      docs = list;
      loading = false;
    });
    void getLocalCatalog(data.folder).then((c) => (instr = c));
    return () => unwatch();
  });

  async function newDoc(): Promise<void> {
    busy = true;
    try {
      const a = await createArticle(data.folder);
      await goto(resolve("/text/[folder]/[name]", { folder: a.project, name: a.name }));
    } finally {
      busy = false;
    }
  }

  function exportQdc(): void {
    if (instr === null) return;
    downloadText(
      `${data.folder}.qdc`,
      toQdc(instr, { origin: data.folder, options: prefs.options }),
      "application/xml",
    );
  }

  async function removeDoc(a: ArticleSummary): Promise<void> {
    await deleteArticle(a.id);
  }
  async function removeProject(): Promise<void> {
    await deleteFolder(data.folder);
    await goto(resolve("/"));
  }
</script>

<svelte:head>
  <title>{data.folder} — Kodakool</title>
</svelte:head>

<main class="page">
  <ColorsDialog bind:open={colorsOpen}>
    <p class="crumb">
      <a class="pill" href={resolve("/")}>
        <span class="material-symbols-rounded" aria-hidden="true">arrow_back</span>projects
      </a>
      <Dialog.Trigger class="pill">
        <span class="material-symbols-rounded" aria-hidden="true">palette</span>colors
      </Dialog.Trigger>
    </p>
    <h1>
      {data.folder}
      {#if data.folder === EXAMPLE_PROJECT}
        <span class="chip ex">example</span>
      {/if}
    </h1>
    <p class="summary">
      <span class="chip">{items.length} documents</span>
      <span class="chip">{stats.codes} codes</span>
      {#if stats.versions}
        <span class="chip versions">{stats.versions} versions</span>
      {/if}
    </p>

    <div class="actions">
      <button type="button" class="go" onclick={() => void newDoc()} disabled={busy}>
        <span class="material-symbols-rounded" aria-hidden="true">note_add</span>new document
      </button>
      {#if instr !== null}
        <button type="button" class="export" onclick={exportQdc} title="export the frame devices of this project">
          <span class="material-symbols-rounded" aria-hidden="true">file_download</span>export .qdc
        </button>
      {/if}
      <button
        type="button"
        class="delproj"
        aria-label="delete project {data.folder}"
        onclick={() =>
          confirm.ask(
            `Delete project ${data.folder}/?`,
            `Deletes the project with its ${items.length} document${items.length === 1 ? "" : "s"}, coding entries and its frame-device catalog.`,
            () => void removeProject(),
          )}
      >
        <span class="material-symbols-rounded" aria-hidden="true">delete</span>delete project
      </button>
    </div>

    <UploadZone folder={data.folder} />

    {#if loading}
      <p class="empty">Loading project…</p>
    {:else if items.length > 0}
      <ul class="docs">
        {#each items as a (a.id)}
          <li>
            <a href={resolve("/text/[folder]/[name]", { folder: a.project, name: a.name })}>
              <span class="material-symbols-rounded docicon" aria-hidden="true">{docIcon(a)}</span>
              <span class="name">{displayName(a.name, a.kind)}</span>
            </a>
            <span class="codes">{a.codes}</span>
            {#if a.versions}
              <span class="chip versions">{a.versions} v</span>
            {/if}
            <button
              type="button"
              class="fdel"
              title="delete document"
              aria-label={`delete ${displayName(a.name, a.kind)}`}
              onclick={() =>
                confirm.ask(
                  `Delete "${displayName(a.name, a.kind)}"?`,
                  `This removes the document and its ${a.codes} code entr${a.codes === 1 ? "y" : "ies"}.`,
                  () => void removeDoc(a),
                )}
            >
              <span class="material-symbols-rounded" aria-hidden="true">delete</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">Empty project — add a document to start coding.</p>
    {/if}

    <ConfirmHost {confirm} />
  </ColorsDialog>
</main>

<style>
  .crumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.8rem;
  }
  .crumb a {
    text-decoration: none;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0 0 0.5rem;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .summary {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0;
  }
  .docs {
    list-style: none;
    padding: 0;
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .docs li {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
  }
  .docs li:hover {
    background: var(--surface-variant);
  }
  .docs a {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    text-decoration: none;
    color: inherit;
  }
  .docs a:hover .name {
    text-decoration: underline;
  }
  .docicon {
    font-size: 1.1rem;
    color: var(--on-surface-variant, #666);
  }
  .name {
    font-weight: 600;
  }
  .codes {
    color: var(--on-surface-variant);
    font-variant-numeric: tabular-nums;
    min-width: 2rem;
    text-align: right;
  }
  .empty {
    margin-top: 1rem;
    color: var(--on-surface-variant);
  }
</style>
