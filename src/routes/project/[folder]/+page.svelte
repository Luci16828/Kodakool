<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import { FileUpload } from "melt/builders";
  import "material-symbols/rounded.css";
  import ColorPanel from "$lib/coding/ColorPanel.svelte";
  import ConfirmDialog from "$lib/coding/ConfirmDialog.svelte";
  import { docIcon, displayName } from "$lib/coding/display";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import { EXAMPLE_PROJECT } from "$lib/client/examples";
  import {
    createArticle,
    deleteArticle,
    deleteFolder,
    getLocalCatalog,
    watchArticles,
    type ArticleSummary,
  } from "$lib/client/coding-db";
  import { uploadArticleFile, uploadArticleFolder } from "$lib/client/upload";
  import type { Instructions } from "$lib/coding/instructions";

  const { data }: { data: { folder: string } } = $props();
  const prefs = useColors();

  /** every local document; the project's own slice is derived from it */
  let docs = $state<ArticleSummary[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  /** the project's frame-device catalog (drives the .qdc export) */
  let instr = $state<Instructions | null>(null);
  let uploadMsg = $state("");
  /** colors customization popup (Bits Dialog) */
  let colorsOpen = $state(false);
  /** pending destructive action for the shared ConfirmDialog */
  let confirmAction = $state<{ title: string; detail: string; run: () => void } | null>(null);
  let confirmOpen = $state(false);

  /** only this project's documents — other projects stay on the project screen */
  const items = $derived.by(() =>
    docs
      .filter((a) => a.project === data.folder)
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })),
  );
  const stats = $derived.by(() => {
    let codes = 0;
    let versions = 0;
    for (const a of items) {
      codes += a.codes;
      versions += a.versions;
    }
    return { codes, versions };
  });

  onMount(() => {
    const unwatch = watchArticles((list) => {
      docs = list;
      loading = false;
    });
    void getLocalCatalog(data.folder).then((c) => (instr = c));
    return () => unwatch();
  });

  /** open the shared ConfirmDialog for a destructive action */
  function askDelete(title: string, detail: string, run: () => void): void {
    confirmAction = { title, detail, run };
    confirmOpen = true;
  }

  async function newDoc(): Promise<void> {
    busy = true;
    try {
      const a = await createArticle(data.folder);
      await goto(resolve("/text/[folder]/[name]", { folder: a.project, name: a.name }));
    } finally {
      busy = false;
    }
  }

  /** Melt FileUpload dropzone: picked/dropped .txt/.md/.pdf files become articles here */
  const fileUpload = new FileUpload({
    multiple: true,
    accept: ".txt,.md,.pdf,text/plain,application/pdf",
    onAccept: (f) => void uploadFile(f),
  });
  async function uploadFile(f: File): Promise<void> {
    const r = await uploadArticleFile(data.folder, f, (m) => (uploadMsg = m));
    uploadMsg = r.message;
  }
  /** folder picker (webkitdirectory): every text/PDF file inside lands in this project */
  async function uploadFolder(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const messages = await uploadArticleFolder(data.folder, input);
    uploadMsg = messages[messages.length - 1] ?? "";
  }

  function exportQdc(): void {
    if (instr === null) return;
    const url = URL.createObjectURL(
      new Blob([toQdc(instr, { origin: data.folder, options: prefs.options })], { type: "application/xml" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.folder}.qdc`;
    a.click();
    URL.revokeObjectURL(url);
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

<main>
  <Dialog.Root bind:open={colorsOpen}>
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
          askDelete(
            `Delete project ${data.folder}/?`,
            `Deletes the project with its ${items.length} document${items.length === 1 ? "" : "s"}, coding entries and its frame-device catalog.`,
            () => void removeProject(),
          )}
      >
        <span class="material-symbols-rounded" aria-hidden="true">delete</span>delete project
      </button>
    </div>

    <div class="uprow">
      <div class="upload" {...fileUpload.dropzone}>
        <span class="material-symbols-rounded" aria-hidden="true">upload</span>
        {fileUpload.isDragging ? `drop into ${data.folder}/` : `upload into ${data.folder}/ (.txt/.md/.pdf)`}
      </div>
      <label class="upfolder" title="upload a whole folder of .txt/.md/.pdf files into {data.folder}/">
        <span class="material-symbols-rounded" aria-hidden="true">upload</span>folder → {data.folder}/
        <input type="file" webkitdirectory={true} onchange={(e) => void uploadFolder(e)} />
      </label>
    </div>
    <input {...fileUpload.input} />
    {#if uploadMsg}<p class="upmsg">{uploadMsg}</p>{/if}

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
                askDelete(
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

    <ConfirmDialog
      bind:open={confirmOpen}
      title={confirmAction?.title ?? ""}
      detail={confirmAction?.detail ?? ""}
      onconfirm={() => confirmAction?.run()}
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
  .actions {
    margin-top: 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
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
  .uprow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }
  .upload {
    flex: 1;
    min-width: 12rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    border: 1px dashed var(--outline, #888);
    border-radius: 8px;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);
    cursor: pointer;
  }
  .upload:hover {
    border-color: var(--primary, #6750a4);
    color: var(--primary, #6750a4);
  }
  .upload[data-dragging] {
    border-color: var(--primary, #6750a4);
    background: var(--primary-container, #e8def8);
    color: var(--on-primary-container, #21005d);
  }
  .upload .material-symbols-rounded {
    font-size: 1.1rem;
  }
  .upfolder {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);
    cursor: pointer;
  }
  .upfolder:hover {
    border-color: var(--primary, #6750a4);
    color: var(--primary, #6750a4);
  }
  .upfolder .material-symbols-rounded {
    font-size: 1.1rem;
  }
  .upfolder input {
    display: none;
  }
  .upmsg {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);
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
  .fdel {
    font: inherit;
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--on-surface-variant, #888);
  }
  .fdel:hover {
    color: #b3261e;
  }
  .fdel .material-symbols-rounded {
    font-size: 1rem;
  }
  .empty {
    margin-top: 1rem;
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
