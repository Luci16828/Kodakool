<script lang="ts">
  import { ScrollArea } from "bits-ui";
  import "material-symbols/rounded.css";
  import { buildCatalogView, type CatalogView } from "$lib/coding/catalog-view";
  import CatalogTree from "$lib/coding/CatalogTree.svelte";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import {
    addChildDevice,
    addBelowDevice,
    findDevice,
    moveDevice,
    removeDeviceById,
    siblingsOf,
    type FrameDevice,
    type Instructions,
  } from "$lib/coding/instructions";
  import { parseCatalogFile } from "$lib/coding/import";
  import type { PaletteOptions } from "$lib/coding/palette";
  import { toQdc } from "$lib/coding/qdc";
  import { clearLocalCatalog, saveLocalCatalog } from "$lib/client/coding-db";
  import { downloadText } from "$lib/client/download";

  /**
   * The coding page's frame-devices sidebar: the catalog tree (arm devices for
   * coding), inline editing (rename / tag / grip reorder / add / delete on a
   * draft), and the JSON/.qdc export + import row. The effective catalog is
   * computed by the page (`buildCatalogView(localCatalog, entryKeys)`); this
   * component owns the edit draft and the local-override persistence.
   */
  let {
    folder,
    localCatalog = $bindable(null),
    catalog,
    entryKeys,
    armed,
    confirm,
    pal,
    options,
    onpick,
    onhover,
    styleFor,
  }: {
    folder: string;
    localCatalog?: Instructions | null;
    catalog: CatalogView[];
    entryKeys: string[];
    armed: string | null;
    confirm: ConfirmAsk;
    pal: number;
    options: PaletteOptions;
    onpick: (id: string) => void;
    onhover: (id: string | null) => void;
    styleFor: (node: CatalogView) => string;
  } = $props();

  let editCat = $state(false);
  let draft = $state<Instructions | null>(null);
  let catMsg = $state("");
  let catBusy = $state(false);
  let catIoMsg = $state("");
  let catImport = $state<HTMLInputElement | undefined>(undefined);

  /** edit-mode tree built from the draft catalog */
  const draftView = $derived(draft === null ? [] : buildCatalogView(draft, entryKeys));

  function draftRename(id: string, name: string): void {
    if (!draft) return;
    const d = findDevice(draft.devices, id);
    if (d) d.name = name;
  }
  function draftTag(id: string, tag: string): void {
    if (!draft) return;
    const d = findDevice(draft.devices, id);
    if (!d) return;
    const t = tag.trim();
    if (t) d.tag = t;
    else delete d.tag;
  }
  /** drop dragId onto targetId: downward moves land after the target, upward before it */
  function draftMove(dragId: string, targetId: string): void {
    if (!draft) return;
    moveDevice(draft.devices, dragId, targetId);
  }
  /** a fresh device for the tree: new UUID, editable placeholder name, kind inherited */
  function newDevice(kind?: FrameDevice["kind"]): FrameDevice {
    return {
      id: crypto.randomUUID(),
      name: "New device",
      kind: kind ?? "device",
      examples: [],
      children: [],
    };
  }
  /** new device under `parentId` (null = top level); fresh UUID, editable name */
  function draftAdd(parentId: string | null): void {
    if (!draft) return;
    const parent = parentId === null ? null : findDevice(draft.devices, parentId);
    if (parent === null && parentId !== null) return;
    addChildDevice(draft.devices, parentId, newDevice(parent?.kind));
  }
  /** new device as the sibling directly BELOW `id` in the draft */
  function draftAddBelow(id: string): void {
    if (!draft) return;
    const above = findDevice(draft.devices, id);
    if (!above) return;
    addBelowDevice(draft.devices, id, newDevice(above.kind));
  }
  /** remove a device from the draft (entries referencing it survive as orphans) */
  function draftDelete(id: string): void {
    if (!draft) return;
    removeDeviceById(draft.devices, id);
  }
  /**
   * Delete a device straight from the stored local catalog (the row context menu
   * in view mode; same orphan rule as draft deletion).
   */
  function removeDevice(id: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const removed = removeDeviceById(copy.devices, id);
    if (!removed) return;
    void persist(copy, `Device "${removed.name}" deleted — its entries stay as orphaned codes`, "delete failed");
  }
  /** write a mutated catalog copy back to the store (view-mode row-menu edits) */
  function persist(copy: Instructions, note: string, failLabel: string): Promise<void> {
    return saveLocalCatalog(folder, copy)
      .then(() => {
        localCatalog = copy;
        catIoMsg = note;
      })
      .catch((e: unknown) => {
        catIoMsg = `${failLabel}: ${e instanceof Error ? e.message : String(e)}`;
      });
  }
  /** view-mode row menu: a child device straight into the stored local catalog */
  function addStoredChild(parentId: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const parent = findDevice(copy.devices, parentId);
    if (!parent) return;
    addChildDevice(copy.devices, parentId, newDevice(parent.kind));
    void persist(copy, `New device added under "${parent.name}"`, "save failed");
  }
  /** view-mode row menu: a sibling device directly below `id` in the stored catalog */
  function addStoredBelow(id: string): void {
    if (localCatalog === null) return;
    const copy = plainClone(localCatalog);
    const above = findDevice(copy.devices, id);
    if (!above) return;
    addBelowDevice(copy.devices, id, newDevice(above.kind));
    void persist(copy, `New device added below "${above.name}"`, "save failed");
  }
  /** shared countdown confirmation for draft + stored deletes (same orphan rule) */
  function confirmDelete(d: FrameDevice, perform: () => void): void {
    const used = entryKeys.filter((k) => k === d.id).length;
    confirm.ask(
      `Delete device "${d.name}"?`,
      used > 0
        ? `${used} code entr${used === 1 ? "y" : "ies"} use this device; they stay in the file as orphaned codes.`
        : "No code entries use this device.",
      perform,
    );
  }
  function askDeleteDevice(id: string): void {
    if (!draft) return;
    const d = findDevice(draft.devices, id);
    if (d) confirmDelete(d, () => draftDelete(id));
  }
  /** view-mode row menu: the same countdown confirmation, applied to the stored catalog */
  function askRemoveDevice(id: string): void {
    if (localCatalog === null) return;
    const d = findDevice(localCatalog.devices, id);
    if (d) confirmDelete(d, () => removeDevice(id));
  }
  /** Proxy-safe deep clone: Svelte 5 props/$state are proxies and structuredClone rejects them. */
  function plainClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
  function startEditCat(): void {
    catMsg = "";
    draft = plainClone(localCatalog);
    editCat = true;
  }
  /** header add buttons: enter edit mode (starting an empty catalog when none exists)
      and add a device — `new category` at top level, `new code` under the armed device */
  function startAdd(parentId: string | null): void {
    if (!editCat) {
      draft = localCatalog === null ? { version: 1, title: folder, devices: [] } : plainClone(localCatalog);
      editCat = true;
    }
    draftAdd(parentId);
  }
  function cancelCat(): void {
    editCat = false;
    draft = null;
    catMsg = "";
  }
  async function saveCat(): Promise<void> {
    if (!draft) return;
    catBusy = true;
    catMsg = "";
    try {
      await saveLocalCatalog(folder, draft);
      localCatalog = plainClone(draft);
      editCat = false;
      draft = null;
    } catch (e) {
      catMsg = e instanceof Error ? e.message : String(e);
    } finally {
      catBusy = false;
    }
  }
  async function resetCat(): Promise<void> {
    await clearLocalCatalog(folder);
    localCatalog = null;
    cancelCat();
  }

  // ----- frame-device catalog export / import (local override only) -----

  function exportCatJson(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(`${folder}-devices.json`, JSON.stringify(instr, null, 2), "application/json");
  }
  function exportCatQdc(): void {
    const instr = localCatalog;
    if (!instr) return;
    downloadText(`${folder}.qdc`, toQdc(instr, { origin: folder, options }), "application/xml");
  }
  async function importCat(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const parsed = parseCatalogFile(file.name, await file.text());
      await saveLocalCatalog(folder, parsed);
      localCatalog = parsed;
      catIoMsg = `imported ${parsed.devices.length} top-level devices`;
    } catch (err) {
      catIoMsg = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<aside class="catalog" data-pal={pal}>
  <ScrollArea.Root class="wsarea" type="hover">
    <ScrollArea.Viewport class="wsview catview">
      <div class="catbody">
        <div class="cathd">
          <div class="cathead">
            <button
              type="button"
              class="cattool addcat"
              title="Add a new code category (top-level device)"
              onclick={() => startAdd(null)}
            >
              <span class="material-symbols-rounded" aria-hidden="true">add</span>New category
            </button>
            <button
              type="button"
              class="cattool addcode"
              title={armed === null
                ? "Add a new code (top-level; arm a device first to nest under it)"
                : "Add a new code under the armed device"}
              onclick={() => startAdd(armed)}
            >
              <span class="material-symbols-rounded" aria-hidden="true">add</span>New code
            </button>
            {#if !editCat && localCatalog !== null}
              <button type="button" class="editcat" aria-label="Edit devices" onclick={startEditCat}>
                <span class="material-symbols-rounded" aria-hidden="true">edit</span>Edit
              </button>
            {/if}
          </div>
          {#if !editCat && localCatalog !== null}
            <div class="cattools">
              <button type="button" class="cattool" onclick={exportCatJson} title="Export frame devices as JSON">
                <span class="material-symbols-rounded" aria-hidden="true">file_download</span>JSON
              </button>
              <button type="button" class="cattool" onclick={exportCatQdc} title="Export frame devices as .qdc (lossy)">
                <span class="material-symbols-rounded" aria-hidden="true">file_download</span>.qdc
              </button>
              <button
                type="button"
                class="cattool"
                onclick={() => catImport?.click()}
                title="Import frame devices from .json or .qdc"
              >
                <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>Import
              </button>
              <input
                type="file"
                accept=".json,.qdc"
                class="catfile"
                bind:this={catImport}
                onchange={(e) => void importCat(e)}
              />
            </div>
          {/if}
          {#if editCat && draft}
            <div class="catbar">
              <button type="button" class="catfinish" onclick={saveCat} disabled={catBusy}>
                {catBusy ? "Saving…" : "Save catalog"}
              </button>
              <button type="button" class="catcancel" onclick={cancelCat}>Cancel</button>
              <button type="button" class="cattool" onclick={() => draftAdd(null)} title="Add a top-level device">
                <span class="material-symbols-rounded" aria-hidden="true">add</span>New device
              </button>
              {#if localCatalog !== null}
                <button type="button" class="catcancel" onclick={resetCat} title="Discard the local catalog"
                  >Remove catalog</button
                >
              {/if}
              {#if catMsg}<span class="msg err">{catMsg}</span>{/if}
            </div>
          {/if}
        </div>
        {#if catIoMsg}<p class="catio">{catIoMsg}</p>{/if}
        {#if editCat && draft}
          <CatalogTree
            catalog={draftView}
            selected={armed}
            {styleFor}
            {onhover}
            editing
            onrename={draftRename}
            ontag={draftTag}
            onmove={draftMove}
            onadd={draftAdd}
            onaddbelow={draftAddBelow}
            ondelete={askDeleteDevice}
          />
        {:else}
          <CatalogTree
            {catalog}
            selected={armed}
            {styleFor}
            {onpick}
            {onhover}
            onadd={addStoredChild}
            onaddbelow={addStoredBelow}
            ondelete={askRemoveDevice}
          />
        {/if}
      </div>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
      <ScrollArea.Thumb class="wsthumb" />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
</aside>

<style lang="scss">
  aside {
    min-height: 0;
  }
  /* frame-devices sidebar: fills the viewport, tree scrolls inside */
  aside.catalog {
    display: flex;
    flex-direction: column;
    height: 100%;

    .cathd {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--surface, white);
      padding: 0.2rem 0;
    }
  }
  .catbody {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
  }

  .editcat {
    font: inherit;
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
    background: var(--surface-variant, #eee);
    border: none;
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    margin-left: 0.4rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .material-symbols-rounded {
      font-size: 0.95rem;
    }

    &:hover {
      filter: brightness(1.1);
    }
  }

  /* devices-codes header row: add buttons left, Edit pushed to the right */
  .cathead {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;

    .editcat {
      margin-left: auto;
    }
  }

  .cattools {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .cattool {
    font: inherit;
    font-size: 0.72rem;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .material-symbols-rounded {
      font-size: 0.9rem;
    }

    &:hover {
      filter: brightness(1.1);
    }
  }
  .catfile {
    display: none;
  }
  .catio {
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    margin: 0.3rem 0 0;
  }

  .catbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.3rem 0 0.1rem;
    flex-wrap: wrap;

    .catfinish {
      font: inherit;
      font-size: 0.8rem;
      padding: 0.2rem 0.8rem;
      border-radius: 999px;
      border: 1px solid var(--primary, #6750a4);
      background: var(--primary, #6750a4);
      color: var(--on-primary, white);
      cursor: pointer;
    }

    .catcancel {
      font: inherit;
      font-size: 0.75rem;
      padding: 0.1rem 0.6rem;
      border-radius: 999px;
      border: 1px solid var(--outline, #888);
      background: var(--surface, white);
      color: var(--on-surface-variant, #666);
      cursor: pointer;
    }
  }

  @media (max-width: 50rem) {
    aside.catalog {
      height: auto;
      overflow: visible;
    }
  }
</style>
