<script lang="ts">
  import { Collapsible, ScrollArea } from "bits-ui";
  import "material-symbols/rounded.css";
  import { buildCatalogView, type CatalogView } from "$lib/coding/catalog-view";
  import CatalogTree from "$lib/coding/CatalogTree.svelte";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import type { FrameDevice, Instructions } from "$lib/coding/instructions";
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
    open = $bindable(true),
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
    open?: boolean;
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

  function draftFind(ns: FrameDevice[], id: string): FrameDevice | null {
    for (const n of ns) {
      if (n.id === id) return n;
      const f = draftFind(n.children, id);
      if (f) return f;
    }
    return null;
  }
  function draftSiblings(ns: FrameDevice[], id: string): FrameDevice[] | null {
    if (ns.some((d) => d.id === id)) return ns;
    for (const n of ns) {
      const f = draftSiblings(n.children, id);
      if (f) return f;
    }
    return null;
  }
  function draftRename(id: string, name: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (d) d.name = name;
  }
  function draftTag(id: string, tag: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (!d) return;
    const t = tag.trim();
    if (t) d.tag = t;
    else delete d.tag;
  }
  /** drop dragId onto targetId: downward moves land after the target, upward before it */
  function draftMove(dragId: string, targetId: string): void {
    if (!draft || dragId === targetId) return;
    const list = draftSiblings(draft.devices, dragId);
    if (!list || !list.some((d) => d.id === targetId)) return;
    const from = list.findIndex((d) => d.id === dragId);
    const to = list.findIndex((d) => d.id === targetId);
    const [moved] = list.splice(from, 1);
    const at = list.findIndex((d) => d.id === targetId);
    list.splice(from <= to ? at + 1 : at, 0, moved);
  }
  /** new device under `parentId` (null = top level); fresh UUID, editable name */
  function draftAdd(parentId: string | null): void {
    if (!draft) return;
    const parent = parentId === null ? null : draftFind(draft.devices, parentId);
    const dev: FrameDevice = {
      id: crypto.randomUUID(),
      name: "New device",
      kind: parent?.kind ?? "device",
      examples: [],
      children: [],
    };
    if (parent) parent.children.push(dev);
    else draft.devices.push(dev);
  }
  /** remove a device from the draft (entries referencing it survive as orphans) */
  function draftDelete(id: string): void {
    if (!draft) return;
    const list = draftSiblings(draft.devices, id);
    if (!list) return;
    const i = list.findIndex((d) => d.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  function askDeleteDevice(id: string): void {
    if (!draft) return;
    const d = draftFind(draft.devices, id);
    if (!d) return;
    const used = entryKeys.filter((k) => k === id).length;
    confirm.ask(
      `Delete device "${d.name}"?`,
      used > 0
        ? `${used} code entr${used === 1 ? "y" : "ies"} use this device; they stay in the file as orphaned codes.`
        : "No code entries use this device.",
      () => draftDelete(id),
    );
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

<aside class="catalog" class:closed={!open} data-pal={pal}>
  <ScrollArea.Root class="wsarea" type="hover">
    <ScrollArea.Viewport class="wsview catview">
      <Collapsible.Root class="catroot" bind:open>
        <Collapsible.Trigger class="catbtn" aria-label="toggle devices codes">
          <span class="material-symbols-rounded" aria-hidden="true">account_tree</span>
          {#if open}Devices codes{/if}
        </Collapsible.Trigger>
        <Collapsible.Content class="catbody">
          <div class="cathd">
            <div class="cathead">
              <button
                type="button"
                class="cattool addcat"
                title="add a new code category (top-level device)"
                onclick={() => startAdd(null)}
              >
                <span class="material-symbols-rounded" aria-hidden="true">add</span>new category
              </button>
              <button
                type="button"
                class="cattool addcode"
                title={armed === null
                  ? "add a new code (top-level; arm a device first to nest under it)"
                  : "add a new code under the armed device"}
                onclick={() => startAdd(armed)}
              >
                <span class="material-symbols-rounded" aria-hidden="true">add</span>new code
              </button>
              {#if !editCat && localCatalog !== null}
                <button type="button" class="editcat" aria-label="edit devices" onclick={startEditCat}>
                  <span class="material-symbols-rounded" aria-hidden="true">edit</span>Edit
                </button>
              {/if}
            </div>
            {#if !editCat && localCatalog !== null}
              <div class="cattools">
                <button type="button" class="cattool" onclick={exportCatJson} title="export frame devices as JSON">
                  <span class="material-symbols-rounded" aria-hidden="true">file_download</span>json
                </button>
                <button
                  type="button"
                  class="cattool"
                  onclick={exportCatQdc}
                  title="export frame devices as .qdc (lossy)"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">file_download</span>.qdc
                </button>
                <button
                  type="button"
                  class="cattool"
                  onclick={() => catImport?.click()}
                  title="import frame devices from .json or .qdc"
                >
                  <span class="material-symbols-rounded" aria-hidden="true">file_upload</span>import
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
                  {catBusy ? "saving…" : "save catalog"}
                </button>
                <button type="button" class="catcancel" onclick={cancelCat}>cancel</button>
                <button type="button" class="cattool" onclick={() => draftAdd(null)} title="add a top-level device">
                  <span class="material-symbols-rounded" aria-hidden="true">add</span>new device
                </button>
                {#if localCatalog !== null}
                  <button type="button" class="catcancel" onclick={resetCat} title="discard the local catalog"
                    >remove catalog</button
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
              ondelete={askDeleteDevice}
            />
          {:else}
            <CatalogTree {catalog} selected={armed} {styleFor} {onpick} {onhover} />
          {/if}
        </Collapsible.Content>
      </Collapsible.Root>
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
  /* Bits Collapsible.Root wrapper carries the aside's flex column (like .treeroot) */
  :global(.catroot) {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
  }
  :global(.catbtn) {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    background: var(--surface-variant, #eee);
    border: 1px solid var(--outline, #888);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 1rem;
    }
  }
  :global(.catbtn:hover) {
    color: var(--primary, #6750a4);
    border-color: var(--primary, #6750a4);
  }
  :global(.catbody) {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1;
    min-height: 0;
    transition: opacity 0.18s ease;
  }
  /* Bits keeps closed content mounted with [hidden] — restore the UA's display:none */
  :global(.catbody[hidden]) {
    display: none;
  }
  /* Bits tags the animating surfaces with data-starting/ending-style; presence waits
     for these transitions to finish before hiding the content (collapse fade) */
  :global(.catbody[data-starting-style]),
  :global(.catbody[data-ending-style]) {
    opacity: 0;
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
