import { RemoteApi } from "$lib/remote/api";
import type { RemoteDoc, RemoteDocSummary, RemoteProject } from "$lib/remote/types";
import type { AccountStore } from "$lib/remote/accounts.svelte";
import { LOCAL_ACCOUNT_ID } from "$lib/remote/accounts.svelte";
import type { Instructions } from "$lib/coding/instructions";
import type { CodeEntry } from "$lib/coding/types";
import { onLocalMutated } from "./worker-client";

/**
 * The Local account's data layer — the exact operations the UI used to call on RxDB,
 * now served by the SAME server code running in the Web Worker (REST + Yjs rooms on
 * sqlite-wasm/OPFS). Signatures mirror `coding-db` so the screens keep their shape;
 * the storage engine and the REST routes are the ones the remote accounts use, which
 * is the whole point: local and remote cannot drift apart.
 */

let store: AccountStore | null = null;

/** provided once by +layout.svelte (the AccountStore owner) */
export function setLocalBackend(s: AccountStore | null): void {
  store = s;
}

interface Ctx {
  api: RemoteApi;
  token: string;
}

async function ctx(): Promise<Ctx> {
  if (!store) throw new Error("local backend is not available");
  const acc = store.byId(LOCAL_ACCOUNT_ID);
  if (!acc) throw new Error("local backend is not available");
  const token = await store.ensureLocalToken();
  if (token === "") throw new Error("the local store could not be opened");
  return { api: store.api(acc), token };
}

/* ----- tree listeners (the watch* replacement: mutations notify, no live query) ----- */

type ArticlesCb = (list: RemoteDocSummary[]) => void;
type ProjectsCb = (names: string[]) => void;
const articleListeners = new Set<{ cb: ArticlesCb; project: string | null }>();
const projectListeners = new Set<ProjectsCb>();
const subListeners = new Set<() => void>();

/** pull the current project list + every project's docs and notify the tree */
export async function refreshLocalTree(): Promise<void> {
  const { api, token } = await ctx();
  const projects = await api.projects(token);
  for (const cb of projectListeners) cb(projects.map((p) => p.name));
  for (const l of subListeners) l();
  for (const l of articleListeners) {
    const target = l.project === null ? projects : projects.filter((p) => p.name === l.project);
    const all: RemoteDocSummary[] = [];
    for (const p of target) all.push(...(await api.docs(token, p.id)).map((d) => ({ ...d, project: p.name })));
    l.cb(all);
  }
}

export function watchArticlesLocal(cb: ArticlesCb, project: string | null = null): () => void {
  const l = { cb, project };
  articleListeners.add(l);
  void refreshLocalTree().catch(() => undefined);
  return () => articleListeners.delete(l);
}

export function watchProjectsLocal(cb: ProjectsCb): () => void {
  projectListeners.add(cb);
  void refreshLocalTree().catch(() => undefined);
  return () => projectListeners.delete(cb);
}

/* ----- live cross-tab refresh (the worker's `mutated` broadcast) ----- */

/**
 * The worker broadcasts `{type:"mutated"}` to every connected tab after every
 * successful REST mutation, so a mutation performed in ANOTHER tab (or by a smoke
 * script) lands here too. Bursts are coalesced into one refetch round: a local
 * mutation arrives twice (direct refresh + broadcast echo) and typing in a room
 * materializes repeatedly.
 */
let liveTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleLocalRefresh(): void {
  if (liveTimer !== undefined) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = undefined;
    void refreshLocalTree().catch(() => undefined);
    void refreshLocalCatalogs().catch(() => undefined);
  }, 120);
}
onLocalMutated(scheduleLocalRefresh);

/* ----- projects ----- */

export async function listProjects(): Promise<RemoteProject[]> {
  const { api, token } = await ctx();
  return api.projects(token);
}

/** project names (the tree's + specs' folder-list shape) */
export async function listFolders(): Promise<string[]> {
  return (await listProjects()).map((p) => p.name);
}

/** idempotent: a taken name resolves to the existing project (mirrors createFolder) */
export async function createFolder(name: string): Promise<RemoteProject> {
  const { api, token } = await ctx();
  try {
    const p = await api.createProject(token, name);
    void refreshLocalTree().catch(() => undefined);
    return p;
  } catch (e) {
    // 409 = the project exists: return it (createFolder's idempotency contract)
    const list = await api.projects(token);
    const found = list.find((p) => p.name === name);
    if (found) return found;
    throw e;
  }
}

export async function deleteFolder(name: string): Promise<void> {
  const { api, token } = await ctx();
  const list = await api.projects(token);
  const p = list.find((x) => x.name === name);
  if (!p) return;
  await api.deleteProject(token, p.id);
  void refreshLocalTree().catch(() => undefined);
}

async function projectByName(api: RemoteApi, token: string, name: string): Promise<RemoteProject | null> {
  const list = await api.projects(token);
  return list.find((p) => p.name === name) ?? null;
}

/* ----- documents ----- */

export async function listArticles(project?: string): Promise<RemoteDocSummary[]> {
  const { api, token } = await ctx();
  const projects = await api.projects(token);
  const target = project === undefined ? projects : projects.filter((p) => p.name === project);
  const all: RemoteDocSummary[] = [];
  for (const p of target) all.push(...(await api.docs(token, p.id)).map((d) => ({ ...d, project: p.name })));
  return all;
}

export async function getArticle(id: string): Promise<RemoteDoc | null> {
  const { api, token } = await ctx();
  try {
    const d = await api.doc(token, id);
    // REST summaries carry the project id; the app's contract is the NAME
    const rows = await api.projects(token);
    const name = rows.find((p) => p.id === d.project)?.name;
    return name === undefined ? d : { ...d, project: name };
  } catch {
    return null;
  }
}

/** lookup by (project, name) — the app's addressing key (specs verify through it) */
export async function getArticleByName(project: string, name: string): Promise<RemoteDoc | null> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  if (!p) return null;
  const found = (await api.docs(token, p.id)).find((d) => d.name === name);
  return found ? api.doc(token, found.id) : null;
}

/** create a document with a free "Untitled N" name (mirrors createArticle) */
export async function createArticle(
  project: string,
  kind: "text" | "pdf" = "text",
  folder = "",
): Promise<RemoteDocSummary> {
  const { api, token } = await ctx();
  const p = await createFolder(project);
  const docs = await api.docs(token, p.id);
  const names = new Set(docs.map((d) => d.name));
  let n = 1;
  // legacy contract: new documents are Markdown ("Untitled N.md")
  while (names.has(`Untitled ${n}.md`)) n++;
  const created = await api.createDocKind(token, p.id, `Untitled ${n}.md`, kind, "", folder);
  void refreshLocalTree().catch(() => undefined);
  return created;
}

export async function createArticleNamed(
  project: string,
  name: string,
  text: string,
  folder = "",
  kind: "text" | "pdf" = "text",
): Promise<RemoteDocSummary> {
  const { api, token } = await ctx();
  const p = await createFolder(project);
  const created = await api.createDocKind(token, p.id, name, kind, text, folder);
  void refreshLocalTree().catch(() => undefined);
  return created;
}

export async function renameArticle(id: string, name: string): Promise<void> {
  const { api, token } = await ctx();
  await api.patchDoc(token, id, { name }); // 409 → ApiError "already exists"
  void refreshLocalTree().catch(() => undefined);
}

export async function deleteArticle(id: string): Promise<void> {
  const { api, token } = await ctx();
  await api.deleteDoc(token, id);
  void refreshLocalTree().catch(() => undefined);
}

/** copy text + entries + pdf bytes as `<base> copy [N]` (mirrors duplicateArticle) */
export async function duplicateArticle(id: string): Promise<RemoteDocSummary> {
  const { api, token } = await ctx();
  const doc = await api.doc(token, id);
  const p = (await api.projects(token)).find((x) => x.id === doc.project);
  if (!p) throw new Error("project not found");
  const docs = await api.docs(token, p.id);
  const names = new Set(docs.map((d) => d.name));
  // duplicating a copy strips its suffix: "a copy 2" → base "a" → "a copy 3"
  const base = doc.name.replace(/ copy(?: \d+)?$/, "");
  let name = `${base} copy`;
  let n = 2;
  while (names.has(name)) {
    name = `${base} copy ${n}`;
    n++;
  }
  const created = await api.createDocKind(token, p.id, name, doc.kind === "pdf" ? "pdf" : "text", doc.text, doc.folder);
  if (doc.codes.length > 0) await api.patchDoc(token, created.id, { codes: doc.codes });
  if (doc.kind === "pdf") {
    const bytes = await api.pdfBytes(token, id);
    if (bytes) await api.savePdf(token, created.id, bytes);
  }
  void refreshLocalTree().catch(() => undefined);
  return created;
}

export async function moveArticle(id: string, folder: string): Promise<void> {
  const { api, token } = await ctx();
  await api.patchDoc(token, id, { folder });
  void refreshLocalTree().catch(() => undefined);
}

/** write the full coding-entry list of a document (the example seed uses this) */
export async function setLocalCodes(id: string, codes: CodeEntry[]): Promise<void> {
  const { api, token } = await ctx();
  await api.patchDoc(token, id, { codes });
}

/** snapshot the stored state under a label (the fixtures' version seed) */
export async function addVersion(id: string, label?: string): Promise<void> {
  const { api, token } = await ctx();
  const doc = await api.doc(token, id);
  await api.addVersion(token, id, { text: doc.text, codes: doc.codes, label });
}

/** the stored coding entries of a document */
export async function readCodes(id: string): Promise<CodeEntry[]> {
  const { api, token } = await ctx();
  return (await api.doc(token, id)).codes;
}

export async function moveArticleProject(id: string, project: string): Promise<void> {
  const { api, token } = await ctx();
  await api.patchDoc(token, id, { project });
  void refreshLocalTree().catch(() => undefined);
}

/* ----- subfolders (the project's subs registry) ----- */

export function normalizeSubPath(p: string): string {
  return p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

async function subsOf(api: RemoteApi, token: string, projectId: string): Promise<string[]> {
  const list = await api.projects(token);
  return list.find((p) => p.id === projectId)?.subs ?? [];
}

export async function createSubfolder(project: string, path: string): Promise<void> {
  const { api, token } = await ctx();
  // the registry lives on the project row: materialize a missing project
  const p = (await projectByName(api, token, project)) ?? (await createFolder(project));
  const subs = new Set(await subsOf(api, token, p.id));
  subs.add(normalizeSubPath(path));
  await api.setSubs(
    token,
    p.id,
    [...subs].filter((s) => s !== ""),
  );
  void refreshLocalTree().catch(() => undefined);
}

/** deleting a subfolder moves its documents to the project root (nothing deletes) */
export async function deleteSubfolder(project: string, path: string): Promise<void> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  if (!p) return;
  const sub = normalizeSubPath(path);
  const subs = (await subsOf(api, token, p.id)).filter((s) => s !== sub && !s.startsWith(`${sub}/`));
  await api.setSubs(token, p.id, subs);
  for (const d of await api.docs(token, p.id)) {
    const f = normalizeSubPath(d.folder);
    if (f === sub || f.startsWith(`${sub}/`)) await api.patchDoc(token, d.id, { folder: "" });
  }
  void refreshLocalTree().catch(() => undefined);
}

export async function renameSubfolder(project: string, path: string, next: string): Promise<void> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  if (!p) return;
  const old = normalizeSubPath(path);
  const to = normalizeSubPath(next);
  if (old === to) return;
  const current = await subsOf(api, token, p.id);
  // a subfolder may not be renamed onto an existing path (legacy contract)
  if (current.includes(to)) throw new Error(`"${to}" already exists`);
  const subs = new Set(
    current.map((s) => (s === old ? to : s.startsWith(`${old}/`) ? `${to}/${s.slice(old.length + 1)}` : s)),
  );
  await api.setSubs(token, p.id, [...subs].sort());
  for (const d of await api.docs(token, p.id)) {
    const f = normalizeSubPath(d.folder);
    if (f === old) await api.patchDoc(token, d.id, { folder: to });
    else if (f.startsWith(`${old}/`)) await api.patchDoc(token, d.id, { folder: `${to}/${f.slice(old.length + 1)}` });
  }
  void refreshLocalTree().catch(() => undefined);
}

export async function listSubfolders(project: string): Promise<string[]> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  return p ? subsOf(api, token, p.id) : [];
}

/** reactive subfolder registry (the watchSubfolders replacement) */
export function watchSubfoldersLocal(project: string, cb: (subs: string[]) => void): () => void {
  let alive = true;
  const pull = () => {
    if (alive)
      void listSubfolders(project)
        .then(cb)
        .catch(() => undefined);
  };
  pull();
  subListeners.add(pull);
  return () => {
    alive = false;
    subListeners.delete(pull);
  };
}

/* ----- catalog + whole-store + pdf ----- */

export async function getLocalCatalog(project: string): Promise<Instructions | null> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  return p ? api.catalog(token, p.id) : null;
}

export async function saveLocalCatalog(project: string, data: Instructions): Promise<void> {
  const { api, token } = await ctx();
  // the old store accepted a catalog for a not-yet-created project: materialize it
  const p = await createFolder(project);
  await api.saveCatalog(token, p.id, data);
}

export async function clearLocalCatalog(project: string): Promise<void> {
  const { api, token } = await ctx();
  const p = await projectByName(api, token, project);
  if (p) await api.saveCatalog(token, p.id, null);
}

/* ----- reactive catalog watch (same notify pattern as the tree) ----- */

type CatalogCb = (data: Instructions | null) => void;
const catalogListeners = new Map<string, Set<CatalogCb>>();

async function refreshLocalCatalogs(): Promise<void> {
  for (const [project, set] of [...catalogListeners]) {
    const data = await getLocalCatalog(project);
    if (!set.size) continue;
    for (const cb of [...set]) cb(data);
  }
}

/** reactive catalog for one project (initial value + every store change, any tab) */
export function watchLocalCatalog(project: string, cb: CatalogCb): () => void {
  let set = catalogListeners.get(project);
  if (!set) {
    set = new Set();
    catalogListeners.set(project, set);
  }
  set.add(cb);
  void getLocalCatalog(project)
    .then((d) => {
      if (set.has(cb)) cb(d);
    })
    .catch(() => undefined);
  return () => {
    set.delete(cb);
    if (set.size === 0) catalogListeners.delete(project);
  };
}

export async function exportDatabase(): Promise<unknown> {
  const { api, token } = await ctx();
  return api.exportDb(token);
}

/** the worker server's export blob shape (server/src/app.ts is the source) */
export interface StoreBlob {
  version: number;
  users: { id: string }[];
  projects: { id: string; name: string }[];
  members: { project_id: string; user_id: string }[];
  documents: {
    id: string;
    project_id: string;
    name: string;
    folder?: string;
    codes?: string;
    versions?: string;
  }[];
  catalogs: { project_id: string; data: string }[];
  pdfs: { doc_id: string }[];
  states: { doc_id: string }[];
  meta: { key: string }[];
}

/** narrow a whole-store blob to one project (users/meta ride along: a valid import) */
export function scopeToProject(dump: StoreBlob, name: string): StoreBlob {
  const pids = new Set(dump.projects.filter((p) => p.name === name).map((p) => p.id));
  const docIds = new Set(dump.documents.filter((d) => pids.has(d.project_id)).map((d) => d.id));
  return {
    ...dump,
    projects: dump.projects.filter((p) => pids.has(p.id)),
    members: dump.members.filter((m) => pids.has(m.project_id)),
    documents: dump.documents.filter((d) => pids.has(d.project_id)),
    catalogs: dump.catalogs.filter((c) => pids.has(c.project_id)),
    pdfs: dump.pdfs.filter((p) => docIds.has(p.doc_id)),
    states: dump.states.filter((s) => docIds.has(s.doc_id)),
  };
}

/** a project-scoped export: a valid StoreBlob subset the import merges unchanged */
export async function exportProject(name: string): Promise<StoreBlob> {
  return scopeToProject((await exportDatabase()) as StoreBlob, name);
}

export async function importDatabase(blob: unknown): Promise<void> {
  const { api, token } = await ctx();
  await api.importDb(token, blob);
  await refreshLocalTree();
}

export async function savePdfData(id: string, bytes: Uint8Array): Promise<void> {
  const { api, token } = await ctx();
  await api.savePdf(token, id, bytes);
}

export async function getPdfData(id: string): Promise<Uint8Array | null> {
  const { api, token } = await ctx();
  return api.pdfBytes(token, id);
}

/* ----- uploads live in $lib/client/upload.ts (built on the primitives above) ----- */
