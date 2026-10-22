<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { ScrollArea, Select } from "bits-ui";
  import { SvelteSet } from "svelte/reactivity";
  import { slide } from "svelte/transition";
  import "material-symbols/rounded.css";
  import { compareNames, docIcon, displayName } from "$lib/coding/display";
  import { openRowMenu } from "$lib/coding/context-menu";
  import { toQdc } from "$lib/coding/qdc";
  import { useColors } from "$lib/coding/prefs.svelte";
  import RowMenu from "$lib/coding/RowMenu.svelte";
  import { buildTree, flattenRows, type TreeRow } from "$lib/coding/tree";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import type { Instructions } from "$lib/coding/instructions";
  import {
    createSubfolder,
    deleteArticle,
    deleteFolder,
    deleteSubfolder,
    duplicateArticle,
    moveArticle,
    moveArticleProject,
    renameArticle,
    renameSubfolder,
    watchSubfoldersLocal,
  } from "$lib/local/local-api";
  import type { ArticleSummary } from "$lib/coding/doc";
  import DatabaseControls from "$lib/client/DatabaseControls.svelte";
  import { createProjectDoc, openDoc, openNewDoc, openRemoteDoc } from "$lib/client/open-doc";
  import { downloadArticle, downloadText } from "$lib/client/download";
  import { uploadArticleFile, uploadArticleFolder } from "$lib/client/upload";
  import UploadZone from "$lib/client/UploadZone.svelte";
  import AccountPanel from "$lib/coding/AccountPanel.svelte";
  import { LOCAL_ACCOUNT_ID, useAccounts, type RemoteAccount } from "$lib/remote/accounts.svelte";
  import { useRemote } from "$lib/remote/remote-cache.svelte";
  import type { RemoteApi } from "$lib/remote/api";
  import type { RemoteCache } from "$lib/remote/remote-cache.svelte";

  /**
   * The coding page's document-tree sidebar — the app's whole file explorer (the
   * project dashboard is gone): the project switcher at the top (a chip for the
   * open project + a dropdown of every OTHER project, ending with the "new project"
   * row; picking one opens that project's first document, creating one when it is
   * empty), the collapsible project header (the selected upload target) whose menu
   * offers new document / new folder / upload file / upload folder / .qdc export /
   * project deletion, the compact upload row, the nested subfolder tree (folders
   * fold, docs live in folders or at the project root) and the database
   * export/import row below the project switcher.
   *
   * Document rows carry the full file menu: open / download / rename (inline) /
   * duplicate / move (into a subfolder, to the root, or to another project) /
   * delete. Subfolder rows carry: new document / new folder (nested) / upload file
   * / upload folder (into that subfolder) / rename (inline) / delete (contained
   * documents move to the project root). New documents open their coding page;
   * deleting the open document returns to the root, which reopens the last document.
   *
   * Rows and the project header carry right-click context menus (Bits ContextMenu,
   * anchored at the pointer); the `more_vert` buttons open the same menus for keyboard use.
   */
  let {
    folder,
    currentName,
    docs,
    allDocs,
    projects,
    instr,
    confirm,
    account = LOCAL_ACCOUNT_ID,
  }: {
    folder: string;
    currentName: string;
    docs: ArticleSummary[];
    /** every local document (the switcher opens the target project's first one) */
    allDocs: ArticleSummary[];
    /** every local project: registered folders + projects that hold documents (sorted) */
    projects: string[];
    /** this project's frame-device catalog (drives the .qdc export), null when none */
    instr: Instructions | null;
    confirm: ConfirmAsk;
    /** the account whose projects this sidebar shows: LOCAL_ACCOUNT_ID (default) or an account id */
    account?: string;
  } = $props();

  const prefs = useColors();
  const accounts = useAccounts();
  const remote = useRemote();
  const isLocal = $derived(account === LOCAL_ACCOUNT_ID);

  let busy = $state(false);
  /** inline "new project" row of the switcher (opened by the dropdown's last row) */
  let newProj = $state(false);
  let projName = $state("");
  let projErr = $state("");

  /** the dropdown's "new project" row — a sentinel value, never a real project name */
  const NEW_PROJECT = "__new__";
  /**
   * The select's own value. It starts empty (the trigger then shows its placeholder,
   * which is the open project's name) and only ever holds the sentinel between a
   * "new project" pick and the reset in `pickProject` — every real pick navigates away.
   */
  let picked = $state("");

  /** the dropdown offers every OTHER project (the open one is the chip itself) + creation */
  /** the project header folds its document list: `folder_open` while it is shown */
  let open = $state(true);

  /** selected upload target: a subfolder path inside this project ("" = project root) */
  let target = $state("");
  /** registered subfolder paths of THIS project (live) */
  let subs = $state<string[]>([]);
  /** folded subfolders (everything not listed here is open) */
  const closed = new SvelteSet<string>();
  /** inline "new folder" input: the parent path it creates under (null = closed) */
  let newSubAt = $state<string | null>(null);
  let subName = $state("");
  /** inline rename: the document id / subfolder path being renamed + its input value */
  let renamingId = $state<string | null>(null);
  let renameName = $state("");
  let renamingSub = $state<string | null>(null);
  let subRenameName = $state("");
  /** rename/move collision feedback (name already taken) */
  let treeErr = $state("");
  /**
   * Hidden file/folder pickers driven by the context menus' upload items:
   * the menu sets `menuSub` (the target subfolder) and clicks the input,
   * the change handler uploads into it. `menuMsg` reports the last result.
   */
  let menuFile: HTMLInputElement | undefined = $state();
  let menuDir: HTMLInputElement | undefined = $state();
  let menuSub = $state("");
  let menuMsg = $state("");
  function pickFiles(path: string): void {
    menuSub = path;
    menuFile?.click();
  }
  function pickFolder(path: string): void {
    menuSub = path;
    menuDir?.click();
  }
  async function menuFilesChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    menuMsg = "";
    for (const f of files) {
      const r = await uploadArticleFile(folder, f, (m) => (menuMsg = m), menuSub);
      if (r.message !== "") menuMsg = r.message;
    }
  }
  async function menuDirChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const messages = await uploadArticleFolder(folder, input, menuSub);
    menuMsg = messages[messages.length - 1] ?? "";
  }

  const others = $derived(projects.filter((name) => name !== folder));
  /** every cached remote project (all accounts), the open one excluded */
  const remoteProjects = $derived.by(() => {
    if (!accounts || !remote) return [];
    const out: { accId: string; accLabel: string; name: string }[] = [];
    for (const a of accounts.accounts) {
      const c = remote.cache(a.id);
      for (const p of c.projects) {
        if (a.id === account && p.name === folder) continue;
        out.push({ accId: a.id, accLabel: a.label, name: p.name });
      }
    }
    return out;
  });
  /** select items so the trigger keeps its label while the menu is closed */
  const items = $derived([
    ...others.map((name) => ({ value: `local:${name}`, label: name })),
    ...remoteProjects.map((p) => ({ value: `remote:${p.accId}::${p.name}`, label: `${p.name} · ${p.accLabel}` })),
    { value: NEW_PROJECT, label: "New project" },
  ]);

  /** remote documents of the open project, mapped onto the tree's summary shape */
  const remoteDocs = $derived.by(() => {
    if (isLocal || !remote) return [];
    const c = remote.cache(account);
    const proj = c.projects.find((p) => p.name === folder);
    if (!proj) return [];
    return (c.docs[proj.id] ?? [])
      .map((d): ArticleSummary => ({
        id: d.id,
        project: d.project,
        name: d.name,
        kind: d.kind === "pdf" ? "pdf" : "text",
        folder: d.folder,
        updatedAt: d.updated,
        codes: d.codes,
        versions: 0,
      }))
      .sort((x, y) => compareNames(x.name, y.name));
  });
  /** the tree renders local documents or the open remote project's documents */
  const treeDocs = $derived(isLocal ? docs : remoteDocs);
  const tree = $derived(buildTree(treeDocs, isLocal ? subs : []));
  const rows = $derived(flattenRows(tree, new Set(isLocal ? subs.filter((p) => !closed.has(p)) : [])));
  /** documents at the project root render after the folder rows */
  const rootDocs = $derived(treeDocs.filter((a) => a.folder === ""));

  /** every subfolder path, parents first (for "Move to" menus) */
  const subPaths = $derived([...subs].sort((a, b) => a.split("/").length - b.split("/").length || compareNames(a, b)));

  function focusFirst(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  /** open a document of THIS project */
  async function newDoc(): Promise<void> {
    busy = true;
    try {
      await openNewDoc(folder, target);
    } finally {
      busy = false;
    }
  }
  /** api + live token + cache for the open remote account (null when not signed in) */
  function remoteCtx(): { api: RemoteApi; token: string; cache: RemoteCache } | null {
    if (!accounts || !remote) return null;
    const acc = accounts.accounts.find((a) => a.id === account);
    if (!acc) return null;
    const token = accounts.tokenOf(account);
    if (token === null) return null;
    return { api: accounts.api(acc), token, cache: remote.cache(account) };
  }
  function openArticle(a: ArticleSummary): void {
    if (isLocal) void openDoc(a.project, a.name);
    else void openRemoteDoc(account, a.project, a.name);
  }
  async function downloadDoc(a: ArticleSummary): Promise<void> {
    if (isLocal) {
      await downloadArticle(a);
      return;
    }
    const ctx = remoteCtx();
    if (ctx === null) return;
    // remote documents are text (the server stores extracted text only)
    downloadText(a.name, (await ctx.api.doc(ctx.token, a.id)).text, a.kind);
  }
  async function deleteDoc(a: ArticleSummary): Promise<void> {
    if (isLocal) await deleteArticle(a.id);
    else {
      const ctx = remoteCtx();
      if (ctx === null) return;
      await ctx.api.deleteDoc(ctx.token, a.id);
      await ctx.cache.refreshDocs(ctx.api, ctx.token, a.project);
    }
    // deleting the document we are looking at returns to the root, which reopens the last document
    if (a.project === folder && a.name === currentName) await goto(resolve("/"));
  }
  async function duplicateDoc(a: ArticleSummary): Promise<void> {
    busy = true;
    try {
      await duplicateArticle(a.id);
    } finally {
      busy = false;
    }
  }
  function startRename(a: ArticleSummary): void {
    renamingSub = null;
    renamingId = a.id;
    renameName = a.name;
    treeErr = "";
  }
  async function commitRename(a: ArticleSummary): Promise<void> {
    const name = renameName.trim();
    renamingId = null;
    if (!name || name === a.name) return;
    try {
      if (isLocal) await renameArticle(a.id, name);
      else {
        const ctx = remoteCtx();
        if (ctx === null) return;
        await ctx.api.patchDoc(ctx.token, a.id, { name });
        await ctx.cache.refreshDocs(ctx.api, ctx.token, a.project);
      }
      treeErr = "";
      if (a.project === folder && a.name === currentName) {
        if (isLocal) await goto(resolve("/text/[folder]/[name]", { folder, name }));
        else await openRemoteDoc(account, folder, name);
      }
    } catch (e) {
      treeErr = String(e);
    }
  }
  async function moveTo(a: ArticleSummary, path: string): Promise<void> {
    await moveArticle(a.id, path);
  }
  async function moveToProject(a: ArticleSummary, project: string): Promise<void> {
    treeErr = "";
    try {
      await moveArticleProject(a.id, project);
      // the open document moved: follow it into the target project
      if (a.project === folder && a.name === currentName)
        await goto(resolve("/text/[folder]/[name]", { folder: project, name: a.name }));
    } catch (e) {
      treeErr = String(e);
    }
  }
  /** the tree row's context menu: the full file menu (right-click opens it, the pill is the keyboard way in) */
  function docMenu(
    a: ArticleSummary,
  ): { label: string; icon: string; danger?: boolean; sep?: boolean; onSelect: () => void }[] {
    if (!isLocal) {
      // remote documents: open / download / rename / delete (no local moves, no duplicate)
      return [
        { label: "Open document", icon: "open_in_new", onSelect: () => openArticle(a) },
        { label: "Download document", icon: "download", onSelect: () => void downloadDoc(a) },
        { label: "Rename document", icon: "edit", onSelect: () => startRename(a) },
        {
          label: "Delete document",
          icon: "delete",
          danger: true,
          sep: true,
          onSelect: () =>
            confirm.ask(
              `Delete "${displayName(a.name, a.kind)}"?`,
              "This removes the document and its entries on the server.",
              () => void deleteDoc(a),
            ),
        },
      ];
    }
    const moves: { label: string; icon: string; onSelect: () => void }[] = [
      ...(a.folder !== ""
        ? [{ label: "Move to project root", icon: "drive_file_move", onSelect: () => void moveTo(a, "") }]
        : []),
      ...subPaths.map((p) => ({ label: `Move to ${p}`, icon: "drive_file_move", onSelect: () => void moveTo(a, p) })),
      ...others.map((p) => ({
        label: `Move to project ${p}`,
        icon: "folder",
        onSelect: () => void moveToProject(a, p),
      })),
    ];
    return [
      { label: "Open document", icon: "open_in_new", onSelect: () => openArticle(a) },
      { label: "Download document", icon: "download", onSelect: () => void downloadArticle(a) },
      { label: "Rename document", icon: "edit", onSelect: () => startRename(a) },
      { label: "Duplicate document", icon: "content_copy", onSelect: () => void duplicateDoc(a) },
      // the move group and the delete row each get their own section
      ...moves.map((m, i) => ({ ...m, sep: i === 0 })),
      {
        label: "Delete document",
        icon: "delete",
        danger: true,
        sep: true,
        onSelect: () =>
          confirm.ask(
            `Delete "${displayName(a.name, a.kind)}"?`,
            `This removes the document and its ${a.codes} code entr${a.codes === 1 ? "y" : "ies"}.`,
            () => void deleteDoc(a),
          ),
      },
    ];
  }

  /* ----- subfolders ----- */
  function startNewSub(parent: string): void {
    newSubAt = parent;
    subName = "";
    treeErr = "";
  }
  async function commitNewSub(parent: string): Promise<void> {
    const name = subName.trim();
    newSubAt = null;
    if (!name) return;
    const path = parent === "" ? name : `${parent}/${name}`;
    await createSubfolder(folder, path);
    closed.delete(path); // a new folder starts open
  }
  function startRenameSub(path: string): void {
    renamingId = null;
    renamingSub = path;
    subRenameName = path.split("/").pop() ?? path;
    treeErr = "";
  }
  async function commitRenameSub(path: string): Promise<void> {
    const name = subRenameName.trim();
    renamingSub = null;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!name || name === path.split("/").pop()) return;
    try {
      await renameSubfolder(folder, path, parent === "" ? name : `${parent}/${name}`);
      treeErr = "";
      if (target === path) target = parent === "" ? name : `${parent}/${name}`;
    } catch (e) {
      treeErr = String(e);
    }
  }
  /** click on a subfolder row: select it as the upload target + fold/unfold the group */
  function toggleSub(path: string): void {
    target = target === path ? "" : path;
    if (closed.has(path)) closed.delete(path);
    else closed.add(path);
  }

  function subMenu(
    path: string,
    name: string,
  ): { label: string; icon: string; danger?: boolean; sep?: boolean; onSelect: () => void }[] {
    return [
      {
        label: `New document in ${name}`,
        icon: "note_add",
        onSelect: () => {
          target = path;
          void newDoc();
        },
      },
      { label: "New folder", icon: "create_new_folder", onSelect: () => startNewSub(path) },
      { label: "Upload File", icon: "upload_file", onSelect: () => pickFiles(path) },
      { label: "Upload Folder", icon: "drive_folder_upload", onSelect: () => pickFolder(path) },
      { label: "Rename folder", icon: "edit", onSelect: () => startRenameSub(path) },
      {
        label: "Delete folder",
        icon: "delete",
        danger: true,
        sep: true,
        onSelect: () =>
          confirm.ask(
            `Delete folder ${path}/?`,
            "Every document inside moves to the project root; nothing is deleted.",
            () => void deleteSubfolder(folder, path),
          ),
      },
    ];
  }

  /** the switcher opens the target project's FIRST document (creating one when empty) */
  async function switchProject(name: string): Promise<void> {
    if (name === "" || name === folder) return;
    busy = true;
    try {
      const mine = allDocs.filter((a) => a.project === name).sort((x, y) => compareNames(x.name, y.name));
      const first = mine[0];
      if (first) await openDoc(name, first.name);
      else await openNewDoc(name);
    } finally {
      busy = false;
    }
  }
  /** the switcher opens a REMOTE project's first document (creating one when empty) */
  async function switchRemoteProject(accId: string, name: string): Promise<void> {
    if (!accounts || !remote) return;
    const acc = accounts.accounts.find((a) => a.id === accId);
    if (!acc) return;
    busy = true;
    treeErr = "";
    try {
      let token = accounts.tokenOf(accId);
      if (token === null && (await accounts.refresh(accId))) token = accounts.tokenOf(accId);
      if (token === null) {
        treeErr = `${acc.label}: not connected`;
        return;
      }
      const api = accounts.api(acc);
      const cache = remote.cache(accId);
      await cache.refreshProjects(api, token);
      const proj = cache.projects.find((p) => p.name === name);
      if (!proj) return;
      await cache.refreshDocs(api, token, proj.id);
      const first = [...(cache.docs[proj.id] ?? [])].sort((x, y) => compareNames(x.name, y.name))[0];
      const doc = first ?? (await api.createDoc(token, proj.id, "Untitled"));
      await openRemoteDoc(accId, name, doc.name);
    } catch (e) {
      treeErr = String(e);
    } finally {
      busy = false;
    }
  }
  /** dropdown pick: a project switches, the "new project" row opens the name input */
  function pickProject(value: string): void {
    if (value === NEW_PROJECT) {
      // the sentinel is not a project: restore the chip label and open the name row
      picked = folder;
      newProj = true;
      projName = "";
      projErr = "";
      return;
    }
    if (value.startsWith("remote:")) {
      const rest = value.slice("remote:".length);
      const sep = rest.indexOf("::");
      void switchRemoteProject(rest.slice(0, sep), rest.slice(sep + 2));
      return;
    }
    void switchProject(value.slice("local:".length));
  }
  async function newProject(): Promise<void> {
    const name = projName.trim();
    if (!name) return;
    busy = true;
    projErr = "";
    try {
      // createProjectDoc: createFolder is idempotent, a taken name simply opens a fresh document
      await createProjectDoc(name);
    } catch (e) {
      projErr = String(e);
      busy = false;
    }
  }

  /** the project header's menu: .qdc export of the local catalog (when it exists) */
  function exportQdc(): void {
    if (instr === null) return;
    downloadText(`${folder}.qdc`, toQdc(instr, { origin: folder, options: prefs.options }), "application/xml");
  }
  async function removeProject(): Promise<void> {
    await deleteFolder(folder);
    // the open project is gone: the root reopens the last surviving document
    await goto(resolve("/"));
  }

  $effect(() => {
    if (!isLocal) return; // remote projects have no local subfolder registry
    return watchSubfoldersLocal(folder, (paths: string[]) => (subs = paths));
  });
</script>

<aside class="docs">
  <div class="projrow">
    <Select.Root type="single" {items} bind:value={picked} onValueChange={(name: string) => pickProject(name)}>
      <Select.Trigger class="switchbtn" aria-label="Switch project" title="Switch to another project">
        <span class="material-symbols-rounded switchicon" aria-hidden="true">folder</span>
        <span class="switchcol">
          <span class="switchcap">project</span>
          <Select.Value class="switchname" placeholder={folder} />
        </span>
        <span class="material-symbols-rounded switchmore" aria-hidden="true">unfold_more</span>
      </Select.Trigger>
      <Select.Content class="switchlist" side="bottom" align="start" sideOffset={8}>
        {#each items as it (it.value)}
          {#if it.value === NEW_PROJECT}
            <Select.Item class="switchopt newopt" value={NEW_PROJECT} label="New project">
              <span class="material-symbols-rounded" aria-hidden="true">create_new_folder</span>New project
            </Select.Item>
          {:else}
            <Select.Item class="switchopt" value={it.value} label={it.label}>{it.label}</Select.Item>
          {/if}
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  {#if newProj}
    <div class="nfrow">
      <input
        type="text"
        class="nfinput"
        placeholder="Project name"
        aria-label="New project name"
        spellcheck="false"
        use:focusFirst
        bind:value={projName}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            void newProject();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            newProj = false;
          }
        }}
      />
      <button type="button" class="nfgo" disabled={busy || projName.trim() === ""} onclick={() => void newProject()}>
        create
      </button>
    </div>
  {/if}
  {#if projErr}<p class="pmsg">{projErr}</p>{/if}
  {#if isLocal}
    <div class="dbrow">
      <DatabaseControls compact project={folder} />
    </div>
  {/if}
  {#if isLocal}
    <div class="docshead">
      <button
        type="button"
        class="newdoc"
        disabled={busy}
        title="New document in {target === '' ? folder : `${folder}/${target}`}"
        aria-label="New document in {target === '' ? folder : `${folder}/${target}`}"
        onclick={() => void newDoc()}
      >
        <span class="material-symbols-rounded" aria-hidden="true">note_add</span>
      </button>
    </div>
  {/if}
  <div class="docsbody">
    <ScrollArea.Root class="wsarea" type="hover">
      <ScrollArea.Viewport class="wsview treeview">
        {#if isLocal}
          <UploadZone {folder} sub={target} compact />
          <!-- context-menu upload pickers: the menu items click these, the change handlers upload into menuSub -->
          <input
            class="menufile"
            type="file"
            multiple
            accept=".txt,.md,.pdf,text/plain,application/pdf"
            bind:this={menuFile}
            onchange={(e) => void menuFilesChange(e)}
          />
          <input
            class="menufile"
            type="file"
            webkitdirectory={true}
            bind:this={menuDir}
            onchange={(e) => void menuDirChange(e)}
          />
          {#if menuMsg}
            <p class="menumsg">{menuMsg}</p>
          {/if}
        {/if}
        <div class="fgrow">
          {#snippet header(props: Record<string, unknown>)}
            <!-- role=button div (not a <button>): the menu pill nests inside it -->
            <div
              {...props}
              class="fgroup sel"
              role="button"
              tabindex="0"
              aria-pressed="true"
              aria-expanded={open}
              title={isLocal
                ? `Selected upload target — uploads and new documents land in ${target === "" ? `${folder}/` : `${folder}/${target}/`} · click folds the document list · right-click for project actions`
                : "Click folds the document list"}
              onclick={() => (open = !open)}
              onkeydown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                open = !open;
              }}
            >
              <span class="material-symbols-rounded" aria-hidden="true">{open ? "folder_open" : "folder"}</span
              >{target === "" ? `${folder}/` : `${folder}/${target}/`}
              <span class="fcodes">{treeDocs.length}</span>
              {#if isLocal}
                <button
                  type="button"
                  class="menubtn"
                  title="Project actions"
                  aria-label="Project menu"
                  onclick={(e) => {
                    e.stopPropagation();
                    openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget);
                  }}
                >
                  <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                </button>
              {/if}
            </div>
          {/snippet}
          {#if isLocal}
            <RowMenu
              items={[
                { label: `New document in ${folder}`, icon: "note_add", onSelect: () => void newDoc() },
                { label: "New folder", icon: "create_new_folder", onSelect: () => startNewSub("") },
                { label: "Upload File", icon: "upload_file", onSelect: () => pickFiles(target) },
                { label: "Upload Folder", icon: "drive_folder_upload", onSelect: () => pickFolder(target) },
                ...(instr
                  ? [{ label: "Export .qdc", icon: "file_download", sep: true, onSelect: () => exportQdc() }]
                  : []),
                {
                  label: "Delete project",
                  icon: "delete",
                  danger: true,
                  sep: true,
                  onSelect: () =>
                    confirm.ask(
                      `Delete project ${folder}/?`,
                      "Deletes the project with all its documents, coding entries and its frame-device catalog.",
                      () => void removeProject(),
                    ),
                },
              ]}
            >
              {#snippet trigger({ props }: { props: Record<string, unknown> })}
                {@render header(props)}
              {/snippet}
            </RowMenu>
          {:else}
            {@render header({})}
          {/if}
        </div>
        {#if newSubAt === ""}
          <div class="nfrow subnew">
            <input
              type="text"
              class="nfinput"
              placeholder="Folder name"
              aria-label="New folder name"
              spellcheck="false"
              use:focusFirst
              bind:value={subName}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  void commitNewSub("");
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  newSubAt = null;
                }
              }}
            />
            <button type="button" class="nfgo" disabled={subName.trim() === ""} onclick={() => void commitNewSub("")}>
              create
            </button>
          </div>
        {/if}
        {#if treeErr}<p class="pmsg">{treeErr}</p>{/if}
        {#if open}
          <ul class="doclist" transition:slide={{ duration: 180 }}>
            {#each rows as row (`${row.kind}:${row.kind === "folder" ? row.path : row.doc.id}`)}
              {#if row.kind === "folder"}
                <li class="subrow" style:padding-left={`${0.5 + row.depth * 0.9}rem`}>
                  {#if renamingSub === row.path}
                    <input
                      type="text"
                      class="rname"
                      aria-label="Rename folder"
                      spellcheck="false"
                      use:focusFirst
                      bind:value={subRenameName}
                      onkeydown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          void commitRenameSub(row.path);
                        } else if (e.key === "Escape") {
                          e.stopPropagation();
                          renamingSub = null;
                        }
                      }}
                      onblur={() => void commitRenameSub(row.path)}
                    />
                  {:else}
                    <RowMenu items={subMenu(row.path, row.name)}>
                      {#snippet trigger({ props }: { props: Record<string, unknown> })}
                        <!-- role=button div: click selects the upload target + folds the group -->
                        <div
                          {...props}
                          class="subhead"
                          role="button"
                          tabindex="0"
                          aria-pressed={target === row.path}
                          aria-expanded={!closed.has(row.path)}
                          title="Upload target · click selects this folder for uploads and new documents · right-click for folder actions"
                          onclick={() => toggleSub(row.path)}
                          onkeydown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            target = target === row.path ? "" : row.path;
                          }}
                        >
                          <span class="material-symbols-rounded" aria-hidden="true">
                            {closed.has(row.path) ? "folder" : "folder_open"}
                          </span>{row.name}/
                          <span class="fcodes">{row.count}</span>
                          <button
                            type="button"
                            class="menubtn"
                            title="Folder actions"
                            aria-label={`Menu for folder ${row.path}`}
                            onclick={(e) => {
                              e.stopPropagation();
                              openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget);
                            }}
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                          </button>
                        </div>
                      {/snippet}
                    </RowMenu>
                  {/if}
                  {#if newSubAt === row.path}
                    <div class="nfrow subnew" style:padding-left="1rem">
                      <input
                        type="text"
                        class="nfinput"
                        placeholder="Folder name"
                        aria-label="New folder name"
                        spellcheck="false"
                        use:focusFirst
                        bind:value={subName}
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            void commitNewSub(row.path);
                          } else if (e.key === "Escape") {
                            e.stopPropagation();
                            newSubAt = null;
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="nfgo"
                        disabled={subName.trim() === ""}
                        onclick={() => void commitNewSub(row.path)}
                      >
                        create
                      </button>
                    </div>
                  {/if}
                </li>
              {:else}
                <li class:current={row.doc.name === currentName} style:padding-left={`${0.5 + row.depth * 0.9}rem`}>
                  {#if renamingId === row.doc.id}
                    <input
                      type="text"
                      class="rname"
                      aria-label="Rename document"
                      spellcheck="false"
                      use:focusFirst
                      bind:value={renameName}
                      onkeydown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          void commitRename(row.doc);
                        } else if (e.key === "Escape") {
                          e.stopPropagation();
                          renamingId = null;
                        }
                      }}
                      onblur={() => void commitRename(row.doc)}
                    />
                  {:else}
                    <RowMenu items={docMenu(row.doc)}>
                      {#snippet trigger({ props }: { props: Record<string, unknown> })}
                        <div class="row" {...props}>
                          <a href={resolve("/text/[folder]/[name]", { folder: row.doc.project, name: row.doc.name })}>
                            <span class="material-symbols-rounded docicon" aria-hidden="true">{docIcon(row.doc)}</span>
                            {displayName(row.doc.name, row.doc.kind)}
                          </a>
                          <span class="fcodes">{row.doc.codes}</span>
                          <button
                            type="button"
                            class="menubtn"
                            title="Document actions"
                            aria-label={`Menu for ${displayName(row.doc.name, row.doc.kind)}`}
                            onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
                          >
                            <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                          </button>
                        </div>
                      {/snippet}
                    </RowMenu>
                  {/if}
                </li>
              {/if}
            {/each}
            {#each rootDocs as a (a.id)}
              <li class:current={a.name === currentName}>
                {#if renamingId === a.id}
                  <input
                    type="text"
                    class="rname"
                    aria-label="Rename document"
                    spellcheck="false"
                    use:focusFirst
                    bind:value={renameName}
                    onkeydown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        void commitRename(a);
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        renamingId = null;
                      }
                    }}
                    onblur={() => void commitRename(a)}
                  />
                {:else}
                  <RowMenu items={docMenu(a)}>
                    {#snippet trigger({ props }: { props: Record<string, unknown> })}
                      <div class="row" {...props}>
                        <a href={resolve("/text/[folder]/[name]", { folder: a.project, name: a.name })}>
                          <span class="material-symbols-rounded docicon" aria-hidden="true">{docIcon(a)}</span>
                          {displayName(a.name, a.kind)}
                        </a>
                        <span class="fcodes">{a.codes}</span>
                        <button
                          type="button"
                          class="menubtn"
                          title="Document actions"
                          aria-label={`Menu for ${displayName(a.name, a.kind)}`}
                          onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
                        >
                          <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
                        </button>
                      </div>
                    {/snippet}
                  </RowMenu>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar class="wsbar" orientation="vertical">
        <ScrollArea.Thumb class="wsthumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  </div>
  <AccountPanel {confirm} current={account} />
</aside>

<style lang="scss">
  /* document tree sidebar (collapsible, left of the editor) */
  aside {
    min-height: 0;
  }
  .docs {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    height: 100%;
  }
  /* ----- project switcher (sidebar top row, account-switcher style) ----- */
  .projrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0.25rem 0 0.55rem;
  }
  :global(.switchbtn) {
    font: inherit;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.55rem;
    text-align: left;
    color: var(--on-surface, #111);
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.14);
    cursor: pointer;

    .switchicon {
      font-size: 1.3rem;
      flex: 0 0 auto;
      color: var(--primary, #6750a4);
    }

    /* caption + project name stacked, like an account chip */
    .switchcol {
      display: flex;
      flex-direction: column;
      gap: 0.05rem;
      flex: 1;
      min-width: 0;
    }

    .switchcap {
      font-size: 0.6rem;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--on-surface-variant, #666);
    }

    .switchmore {
      font-size: 1.2rem;
      flex: 0 0 auto;
      color: var(--on-surface-variant, #666);
    }

    /* Bits sets data-state on the trigger at runtime */
    &:global([data-state="open"]) {
      border-color: var(--primary, #6750a4);
      background: var(--primary-container, #e8def8);
    }
  }
  :global(.switchbtn:hover) {
    border-color: var(--primary, #6750a4);
  }
  /* the current project name: the trigger's only truncating part */
  :global(.switchname) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.95rem;
    font-weight: 700;
  }
  /* inline "new project" / "new folder" row under the switcher */
  .nfrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0 0 0.35rem;
  }
  .nfinput {
    font: inherit;
    font-size: 0.8rem;
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--outline, #888);
    border-radius: 10px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
  }
  .nfgo {
    font: inherit;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--primary, #6750a4);
    border-radius: 10px;
    background: var(--primary, #6750a4);
    color: var(--on-primary, #fff);
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .pmsg {
    margin: -0.2rem 0 0.3rem;
    font-size: 0.72rem;
    color: #b3261e;
  }
  /* the dropdown is portaled by Bits (outside this component) */
  :global(.switchlist) {
    z-index: 60;
    min-width: var(--bits-select-anchor-width);
    max-width: var(--bits-select-content-available-width);
    max-height: 60vh;
    overflow: auto;
    gap: 0.15rem;
    padding: 0.35rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
    font-size: 0.85rem;
  }
  :global(.switchopt) {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border-radius: 8px;
    cursor: pointer;

    /* Bits sets these at runtime (keyboard highlight / selected item) */
    &:global([data-highlighted]) {
      background: var(--surface-variant, #eee);
    }

    &:global([data-selected]) {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
      font-weight: 700;
    }
  }
  /* the dropdown's last row: create a project (separated from the project list) */
  :global(.switchopt.newopt) {
    margin-top: 0.25rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--outline, #ccc);
    border-radius: 0 0 8px 8px;
    color: var(--primary, #6750a4);
    font-weight: 600;

    .material-symbols-rounded {
      font-size: 1.15rem;
    }
  }
  .docsbody {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .docshead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .newdoc {
    font: inherit;
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--on-surface-variant, #666);

    .material-symbols-rounded {
      font-size: 1.1rem;
    }

    &:hover {
      color: var(--primary, #6750a4);
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .fgroup {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--on-surface-variant, #666);
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    margin: 0.5rem 0 0;
    padding: 0.1rem 0.3rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;

    &:hover {
      color: var(--primary, #6750a4);
    }

    /* the project header is the selected upload target — marked like a picked document */
    &.sel {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
      border-radius: 6px;
    }

    .material-symbols-rounded {
      font-size: 1.05rem;
    }

    /* the count + menu ride the row's right edge, like in the document rows */
    .fcodes {
      margin-left: auto;
    }

    .menubtn {
      margin-left: 0.4rem;
    }
  }
  /* folder header row: the group button IS the row (it carries the context menu) */
  .fgrow {
    display: flex;
    align-items: center;
    gap: 0.2rem;

    :global(.ctxmenu) {
      min-width: 13rem;
    }

    .fgroup {
      flex: 1;
      min-width: 0;
    }
  }
  .docs ul {
    list-style: none;
    margin: 0.1rem 0 0;
    padding: 0 0 0 0.5rem;
    border-left: 1px solid var(--outline, #ccc);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .docs li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;

    &:hover {
      background: var(--surface-variant, #eee);
    }

    &.current {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
    }

    /* the Bits trigger wraps the row's own content (right-click opens its menu) */
    :global(.row) {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    a {
      flex: 1;
      font-size: 0.85rem;
      text-decoration: none;
      color: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .docicon {
      font-size: 1.1rem;
      vertical-align: -0.25em;
      color: var(--on-surface-variant, #666);
    }
  }
  /* ----- subfolder rows (nested groups inside the project) ----- */
  .subrow {
    flex-wrap: wrap;

    .subhead {
      font: inherit;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--on-surface-variant, #666);
      display: flex;
      align-items: center;
      gap: 0.15rem;
      flex: 1;
      min-width: 0;
      padding: 0.1rem 0.3rem;
      border: none;
      background: none;
      cursor: pointer;
      text-align: left;

      &:hover {
        color: var(--primary, #6750a4);
      }

      /* the picked subfolder is the upload target — marked like the project header */
      &:global([aria-pressed="true"]) {
        background: var(--primary-container, #e8def8);
        color: var(--on-primary-container, #21005d);
        border-radius: 6px;
      }

      .material-symbols-rounded {
        font-size: 1.05rem;
        flex: 0 0 auto;
      }

      .fcodes {
        margin-left: auto;
      }

      .menubtn {
        margin-left: 0.4rem;
      }
    }

    .subnew {
      flex: 1 1 100%;
      margin: 0.2rem 0 0;
    }
  }
  /* inline rename input (documents + folders) */
  .rname {
    font: inherit;
    font-size: 0.85rem;
    flex: 1;
    min-width: 0;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--primary, #6750a4);
    border-radius: 6px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
  }
  .fcodes {
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
    font-variant-numeric: tabular-nums;
    min-width: 1.6rem;
    text-align: right;
    margin-right: 0.2rem;
  }
  /* database export/import row (below the project switcher — the dashboard is gone) */
  .dbrow {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  /* context-menu upload pickers (opened programmatically by the menu items) */
  .menufile {
    display: none;
  }
  .menumsg {
    margin: 0.2rem 0 0;
    font-size: 0.7rem;
    color: var(--on-surface-variant, #666);
  }

  @media (max-width: 50rem) {
    .docs {
      height: auto;
    }

    .docsbody {
      max-height: 60vh;
    }
  }
</style>
