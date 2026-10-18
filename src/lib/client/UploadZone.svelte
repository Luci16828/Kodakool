<script lang="ts">
  import { FileUpload } from "melt/builders";
  import "material-symbols/rounded.css";
  import { uploadArticleFile, uploadArticleFolder } from "$lib/client/upload";

  /**
   * The shared upload row (project page + coding-page tree): a Melt FileUpload
   * dropzone for .txt/.md/.pdf files plus a webkitdirectory folder picker —
   * everything lands in `folder`. `compact` is the narrow-sidebar look.
   */
  let { folder, compact = false }: { folder: string; compact?: boolean } = $props();

  let msg = $state("");
  const fileUpload = new FileUpload({
    multiple: true,
    accept: ".txt,.md,.pdf,text/plain,application/pdf",
    onAccept: (f) => void uploadFile(f),
  });
  async function uploadFile(f: File): Promise<void> {
    const r = await uploadArticleFile(folder, f, (m) => (msg = m));
    msg = r.message;
  }
  /** folder picker (webkitdirectory): every .txt/.md/.pdf file inside becomes an article */
  async function uploadFolder(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const messages = await uploadArticleFolder(folder, input);
    msg = messages[messages.length - 1] ?? "";
  }
</script>

<div class="uprow" class:compact>
  <div
    class="upload"
    {...fileUpload.dropzone}
    title={compact ? `upload .txt/.md/.pdf files into ${folder}/` : `upload into ${folder}/ (.txt/.md/.pdf)`}
  >
    <span class="material-symbols-rounded" aria-hidden="true">upload</span>
    {#if compact}
      {fileUpload.isDragging ? `drop → ${folder}/` : `file → ${folder}/`}
    {:else}
      {fileUpload.isDragging ? `drop into ${folder}/` : `upload into ${folder}/ (.txt/.md/.pdf)`}
    {/if}
  </div>
  <label class="upfolder" title="upload a whole folder of .txt/.md/.pdf files into {folder}/">
    <span class="material-symbols-rounded" aria-hidden="true">upload</span>{compact ? "folder" : `folder → ${folder}/`}
    <input type="file" webkitdirectory={true} onchange={(e) => void uploadFolder(e)} />
  </label>
</div>
<input {...fileUpload.input} />
{#if msg}<p class="upmsg" class:compact>{msg}</p>{/if}

<style>
  .uprow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }
  .uprow.compact {
    gap: 0.3rem;
    margin-top: 0.45rem;
    flex-wrap: nowrap;
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
  .compact .upload {
    min-width: 0;
    gap: 0.3rem;
    padding: 0.3rem 0.45rem;
    font-size: 0.65rem;
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
  .compact .upload .material-symbols-rounded {
    font-size: 1rem;
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
  .compact .upfolder {
    flex: 0 0 auto;
    gap: 0.3rem;
    padding: 0.3rem 0.45rem;
    font-size: 0.65rem;
  }
  .upfolder:hover {
    border-color: var(--primary, #6750a4);
    color: var(--primary, #6750a4);
  }
  .upfolder .material-symbols-rounded {
    font-size: 1.1rem;
  }
  .compact .upfolder .material-symbols-rounded {
    font-size: 1rem;
  }
  .upfolder input {
    display: none;
  }
  .upmsg {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);
  }
  .upmsg.compact {
    margin: 0;
    font-size: 0.7rem;
  }
</style>
