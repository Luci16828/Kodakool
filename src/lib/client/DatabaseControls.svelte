<script lang="ts">
  import "material-symbols/rounded.css";
  import { exportDatabase, importDatabase } from "$lib/client/coding-db";
  import { downloadText } from "$lib/client/download";

  /**
   * Whole-database export/import row (local RxDB snapshot as JSON) — shared by
   * the root start screen and the coding page's tree sidebar.
   * `compact` = the sidebar's small pill variant with an ellipsized message.
   */
  let { compact = false }: { compact?: boolean } = $props();

  let msg = $state("");
  let fileInput: HTMLInputElement | undefined = $state(undefined);

  async function exportDb() {
    msg = "";
    try {
      const dump = await exportDatabase();
      downloadText(
        `kodakool-db-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(dump, null, 2),
        "application/json",
      );
      msg = `exported ${dump.articles.length} documents, ${dump.catalogs.length} catalogs`;
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
      const counts = await importDatabase(JSON.parse(await file.text()));
      msg = `imported ${counts.articles} documents, ${counts.catalogs} catalogs`;
    } catch (err) {
      msg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<button
  type="button"
  class={compact ? "dbbtn" : "pill"}
  title="Export the local database as JSON"
  onclick={() => void exportDb()}
>
  <span class="material-symbols-rounded" aria-hidden="true">file_download</span>Database
</button>
<button
  type="button"
  class={compact ? "dbbtn" : "pill"}
  title="Import a database JSON export"
  onclick={() => fileInput?.click()}
>
  <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>Import DB
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
