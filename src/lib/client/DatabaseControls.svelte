<script lang="ts">
  import "material-symbols/rounded.css";
  import { exportDatabase, importDatabase, scopeToProject, type StoreBlob } from "$lib/local/local-api";
  import { downloadText } from "$lib/client/download";

  /**
   * Export/import row (the local worker store as a JSON snapshot) — shared by the root
   * start screen and the coding page's tree sidebar. With a `project` prop it exports
   * THAT project only (documents + entries + PDF bytes + catalog + subfolders);
   * without one it exports the whole store. Import merges by id, so a project blob
   * lands alongside the existing data. `compact` = the sidebar's small pill variant.
   */
  let { compact = false, project = "" }: { compact?: boolean; project?: string } = $props();

  let msg = $state("");
  let fileInput: HTMLInputElement | undefined = $state(undefined);

  /** union by id, imported rows win — the merge-import contract the app always had */
  function mergeBlobs(current: StoreBlob, incoming: StoreBlob): StoreBlob {
    const byId = <T extends { id?: string; project_id?: string; doc_id?: string; key?: string }>(
      a: T[],
      b: T[],
      key: (x: T) => string,
    ): T[] => {
      const map = new Map<string, T>();
      for (const x of a) map.set(key(x), x);
      for (const x of b) map.set(key(x), x);
      return [...map.values()];
    };
    return {
      version: 1,
      users: byId(current.users, incoming.users, (x) => x.id),
      projects: byId(current.projects, incoming.projects, (x) => x.id),
      members: byId(current.members, incoming.members, (x) => `${x.project_id}/${x.user_id ?? ""}`),
      documents: byId(current.documents, incoming.documents, (x) => x.id),
      catalogs: byId(current.catalogs, incoming.catalogs, (x) => x.project_id),
      pdfs: byId(current.pdfs, incoming.pdfs, (x) => x.doc_id),
      states: byId(current.states, incoming.states, (x) => x.doc_id),
      meta: byId(current.meta, incoming.meta, (x) => x.key),
    };
  }

  async function exportDb() {
    msg = "";
    try {
      const dump = (await exportDatabase()) as StoreBlob;
      const scoped = project === "" ? dump : scopeToProject(dump, project);
      downloadText(
        `kodakool-${project || "db"}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(scoped, null, 2),
        "application/json",
      );
      msg = project
        ? `exported project ${project}: ${scoped.documents.length} documents, ${scoped.catalogs.length} catalogs`
        : `exported ${scoped.documents.length} documents, ${scoped.catalogs.length} catalogs`;
    } catch (e) {
      msg = `export failed: ${String(e)}`;
    }
  }

  async function importDb(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    msg = "";
    try {
      const incoming = JSON.parse(await file.text()) as StoreBlob;
      // shape-validate BEFORE merging: mergeBlobs iterates every array of the
      // incoming blob, so a foreign file must fail with a readable message
      if (
        incoming === null ||
        typeof incoming !== "object" ||
        !Array.isArray(incoming.projects) ||
        !Array.isArray(incoming.documents) ||
        !Array.isArray(incoming.users)
      )
        throw new Error("not a luci-bachelor database export");
      const merged = mergeBlobs((await exportDatabase()) as StoreBlob, incoming);
      await importDatabase(merged);
      msg = `imported ${incoming.documents.length} documents, ${incoming.catalogs.length} catalogs`;
    } catch (err) {
      msg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<button
  type="button"
  class={compact ? "dbbtn" : "pill"}
  title={project ? `Export the ${project} project as JSON` : "Export the local database as JSON"}
  onclick={() => void exportDb()}
>
  <span class="material-symbols-rounded" aria-hidden="true">file_download</span>Export
</button>
<button
  type="button"
  class={compact ? "dbbtn" : "pill"}
  title={project ? "Import a project JSON export" : "Import a database JSON export"}
  onclick={() => fileInput?.click()}
>
  <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>Import
</button>
<input
  type="file"
  accept=".json,application/json"
  class="dbfile"
  bind:this={fileInput}
  onchange={(e) => void importDb(e)}
/>
{#if msg}<p class="dbmsg" class:compact title={compact ? msg : undefined}>{msg}</p>{/if}

<style lang="scss">
  .dbbtn {
    font: inherit;
    font-size: 0.7rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 0.95rem;
    }

    &:hover {
      color: var(--primary, #6750a4);
      border-color: var(--primary, #6750a4);
    }
  }
  .dbfile {
    display: none;
  }
  .dbmsg {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);

    &.compact {
      margin: 0;
      font-size: 0.65rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
