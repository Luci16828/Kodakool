import { entryId } from "$lib/coding/edit";
import { instructionsSchema, uniqueIds, type Instructions } from "$lib/coding/instructions";
import type { CodeEntry } from "$lib/coding/types";

/**
 * Local-first store. The browser RxDB/Dexie database is the single source of
 * truth: articles (documents, with their own text + version history) and their
 * coding entries both live here. A remote/replication layer can be attached to
 * this database later; nothing in the app reads documents from the server.
 */

export const DEFAULT_PROJECT = "default";

export interface ArticleVersion {
  savedAt: number;
  label?: string;
  text: string;
  codes: CodeEntry[];
}

/** "pdf" articles carry extracted PDF text and are always read-only */
export type ArticleKind = "text" | "pdf";

export interface ArticleData {
  id: string;
  project: string;
  name: string;
  text: string;
  kind?: ArticleKind;
  createdAt: number;
  updatedAt: number;
  versions: ArticleVersion[];
}

export interface ArticleSummary {
  id: string;
  project: string;
  name: string;
  kind: ArticleKind;
  updatedAt: number;
  codes: number;
  versions: number;
}

const CODE_SCHEMA = {
  title: "codes",
  description: "one document per coding entry",
  version: 0,
  type: "object",
  primaryKey: "id",
  properties: {
    id: { type: "string", maxLength: 500 },
    articleId: { type: "string", maxLength: 100 },
    uid: { type: "string", maxLength: 100 },
    device: { type: "string", maxLength: 100 },
    code: { type: "string", maxLength: 100 },
    line: { type: "number" },
    endLine: { type: "number" },
    range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    excerpt: { type: "string" },
    note: { type: "string" },
  },
  required: ["id", "articleId", "line", "range", "excerpt"],
  indexes: ["articleId"],
} as const;

const VERSION_SCHEMA = {
  type: "object",
  properties: {
    savedAt: { type: "number" },
    label: { type: "string" },
    text: { type: "string" },
    codes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          endLine: { type: "number" },
          range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          excerpt: { type: "string" },
          device: { type: "string" },
          code: { type: "string" },
          uid: { type: "string" },
          note: { type: "string" },
        },
        required: ["line", "range", "excerpt"],
      },
    },
  },
  required: ["savedAt", "text", "codes"],
} as const;

const CATALOG_SCHEMA = {
  title: "catalogs",
  description: "locally edited frame-device catalog per folder (overrides the server catalog for display)",
  version: 0,
  type: "object",
  primaryKey: "folder",
  properties: {
    folder: { type: "string", maxLength: 200 },
    data: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: ["folder", "data", "updatedAt"],
} as const;

const PDF_SCHEMA = {
  title: "pdfs",
  description: "original PDF bytes (base64) for a kind=pdf article, rendered by the PDF view",
  version: 0,
  type: "object",
  primaryKey: "id",
  properties: {
    id: { type: "string", maxLength: 100 },
    data: { type: "string" },
    pages: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "data", "pages", "updatedAt"],
} as const;

const FOLDER_SCHEMA = {
  title: "folders",
  description: "locally created document folders (may be empty — articles only carry their project name)",
  version: 0,
  type: "object",
  primaryKey: "name",
  properties: {
    name: { type: "string", maxLength: 200 },
    createdAt: { type: "number" },
  },
  required: ["name", "createdAt"],
} as const;

const ARTICLE_SCHEMA = {
  title: "articles",
  description: "one document per article (local-first, carries its own text + history)",
  version: 1,
  type: "object",
  primaryKey: "id",
  properties: {
    id: { type: "string", maxLength: 100 },
    project: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 200 },
    text: { type: "string" },
    kind: { type: "string", enum: ["text", "pdf"] },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    versions: { type: "array", items: VERSION_SCHEMA },
  },
  required: ["id", "project", "name", "text", "createdAt", "updatedAt"],
  indexes: ["project"],
} as const;

interface RxDocument<T> {
  patch(patch: Record<string, unknown>): Promise<unknown>;
  remove(): Promise<unknown>;
  toJSON(): T;
}

type RxDoc<T> = RxDocument<T> & T;

interface Unsubscribable {
  unsubscribe(): void;
}

interface LiveQuery<T> {
  exec(): Promise<RxDoc<T>[]>;
  readonly $: { subscribe(next: (docs: RxDoc<T>[]) => void): Unsubscribable };
}

interface Collection<T> {
  insert(doc: T): Promise<unknown>;
  bulkInsert(docs: T[]): Promise<unknown>;
  bulkUpsert(docs: T[]): Promise<unknown>;
  findOne(id: string): { exec(): Promise<RxDoc<T> | null> };
  find(query?: { selector: Record<string, unknown> }): LiveQuery<T>;
}

interface CodeDocData extends Record<string, unknown> {
  id: string;
  articleId: string;
  uid?: string;
  device?: string;
  code?: string;
  line: number;
  endLine?: number;
  range: [number, number];
  excerpt: string;
  note?: string;
}

interface CatalogDocData {
  folder: string;
  data: string;
  updatedAt: number;
}

export interface PdfDocData extends Record<string, unknown> {
  /** article id this PDF belongs to (1:1) */
  id: string;
  /** raw PDF bytes as base64 */
  data: string;
  pages: number;
  updatedAt: number;
}

export interface FolderDocData extends Record<string, unknown> {
  name: string;
  createdAt: number;
}

interface Db {
  articles: Collection<ArticleData>;
  codes: Collection<CodeDocData>;
  catalogs: Collection<CatalogDocData>;
  pdfs: Collection<PdfDocData>;
  folders: Collection<FolderDocData>;
}

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const { createRxDatabase, addRxPlugin } = await import("rxdb");
    const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
    // required since the articles schema was bumped to version 1 (kind field)
    const { RxDBMigrationSchemaPlugin } = await import("rxdb/plugins/migration-schema");
    addRxPlugin(RxDBMigrationSchemaPlugin);
    const db = await createRxDatabase({ name: "luci-coding", storage: getRxStorageDexie() });
    await db.addCollections({
      articles: {
        schema: structuredClone(ARTICLE_SCHEMA),
        // v0 → v1 added the kind field: pre-existing articles are plain text
        migrationStrategies: { 1: (oldDoc) => ({ ...oldDoc, kind: "text" as const }) },
      },
      codes: { schema: structuredClone(CODE_SCHEMA) },
      catalogs: { schema: structuredClone(CATALOG_SCHEMA) },
      pdfs: { schema: structuredClone(PDF_SCHEMA) },
      folders: { schema: structuredClone(FOLDER_SCHEMA) },
    });
    return db as unknown as Db;
  })();
  return dbPromise;
}

function toCodeDoc(articleId: string, entry: CodeEntry): CodeDocData {
  const doc: CodeDocData = {
    id: entryId(articleId, entry),
    articleId,
    line: entry.line,
    range: entry.range,
    excerpt: entry.excerpt,
  };
  if (entry.uid !== undefined) doc.uid = entry.uid;
  if (entry.device !== undefined) doc.device = entry.device;
  if (entry.code !== undefined) doc.code = entry.code;
  if (entry.endLine !== undefined) doc.endLine = entry.endLine;
  if (entry.note !== undefined) doc.note = entry.note;
  return doc;
}

function toEntry(doc: RxDoc<CodeDocData> | CodeDocData): CodeEntry {
  const entry: CodeEntry = { line: doc.line, range: doc.range, excerpt: doc.excerpt };
  if (doc.uid !== undefined) entry.uid = doc.uid;
  if (doc.device !== undefined) entry.device = doc.device;
  if (doc.code !== undefined) entry.code = doc.code;
  if (doc.endLine !== undefined) entry.endLine = doc.endLine;
  if (doc.note !== undefined) entry.note = doc.note;
  return entry;
}

// ----- articles -----

/** Next free `Untitled N` base name inside a project (max existing N + 1). */
export async function nextUntitledName(project: string): Promise<string> {
  const { articles } = await getDb();
  const docs = await articles.find({ selector: { project } }).exec();
  let max = 0;
  for (const d of docs) {
    const m = /^Untitled (\d+)$/.exec(d.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (docs.some((d) => d.name === `Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export async function createArticle(
  project: string = DEFAULT_PROJECT,
  kind: ArticleKind = "text",
): Promise<ArticleSummary> {
  const { articles } = await getDb();
  const cleanProject = (project || DEFAULT_PROJECT).trim() || DEFAULT_PROJECT;
  const id = crypto.randomUUID();
  const now = Date.now();
  const article: ArticleData = {
    id,
    project: cleanProject,
    name: await nextUntitledName(cleanProject),
    text: "",
    kind,
    createdAt: now,
    updatedAt: now,
    versions: [],
  };
  await articles.insert(article);
  return { id, project: cleanProject, name: article.name, kind, updatedAt: now, codes: 0, versions: 0 };
}

export async function getArticle(project: string, name: string): Promise<ArticleData | null> {
  const { articles } = await getDb();
  const docs = await articles.find({ selector: { project, name } }).exec();
  return docs[0]?.toJSON() ?? null;
}

export async function getArticleById(id: string): Promise<ArticleData | null> {
  const { articles } = await getDb();
  return (await articles.findOne(id).exec())?.toJSON() ?? null;
}

export async function listArticles(): Promise<ArticleSummary[]> {
  const { articles, codes } = await getDb();
  const docs = await articles.find().exec();
  const codeDocs = await codes.find().exec();
  const counts = new Map<string, number>();
  for (const c of codeDocs) counts.set(c.articleId, (counts.get(c.articleId) ?? 0) + 1);
  return docs.map((d) => toSummary(d.toJSON(), counts.get(d.id) ?? 0)).sort(compareSummary);
}

function toSummary(a: ArticleData, codes: number): ArticleSummary {
  return {
    id: a.id,
    project: a.project,
    name: a.name,
    kind: a.kind ?? "text",
    updatedAt: a.updatedAt,
    codes,
    versions: a.versions.length,
  };
}

function compareSummary(a: ArticleSummary, b: ArticleSummary): number {
  return a.project.localeCompare(b.project) || a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** Live list of all articles (sorted) with current per-article code counts. */
export function watchArticles(next: (list: ArticleSummary[]) => void): () => void {
  let stopped = false;
  let aUnsub: Unsubscribable | undefined;
  let cUnsub: Unsubscribable | undefined;
  let arts: ArticleData[] = [];
  let counts = new Map<string, number>();
  const emit = () => next(arts.map((a) => toSummary(a, counts.get(a.id) ?? 0)).sort(compareSummary));

  void getDb().then(({ articles, codes }) => {
    if (stopped) return;
    aUnsub = articles.find().$.subscribe((docs) => {
      arts = docs.map((d) => d.toJSON());
      emit();
    });
    cUnsub = codes.find().$.subscribe((docs) => {
      counts = new Map();
      for (const c of docs) counts.set(c.articleId, (counts.get(c.articleId) ?? 0) + 1);
      emit();
    });
  });

  return () => {
    stopped = true;
    aUnsub?.unsubscribe();
    cUnsub?.unsubscribe();
  };
}

/** Live view of one article (by project + name) plus its entries. */
export function watchArticle(
  project: string,
  name: string,
  next: (article: ArticleData | null, entries: CodeEntry[]) => void,
): () => void {
  let stopped = false;
  let aUnsub: Unsubscribable | undefined;
  let cUnsub: Unsubscribable | undefined;
  let currentId: string | null = null;
  let article: ArticleData | null = null;
  let entries: CodeEntry[] = [];
  const emit = () => next(article, entries);

  void getDb().then(({ articles, codes }) => {
    if (stopped) return;
    aUnsub = articles.find({ selector: { project, name } }).$.subscribe((docs) => {
      article = docs[0]?.toJSON() ?? null;
      const id = article?.id ?? null;
      if (id !== currentId) {
        currentId = id;
        cUnsub?.unsubscribe();
        cUnsub = undefined;
        entries = [];
        if (id !== null) {
          cUnsub = codes.find({ selector: { articleId: id } }).$.subscribe((cd) => {
            entries = cd.map(toEntry);
            emit();
          });
        }
      }
      emit();
    });
  });

  return () => {
    stopped = true;
    aUnsub?.unsubscribe();
    cUnsub?.unsubscribe();
  };
}

/** Replace an article's body + entries and bump updatedAt. */
/** CONFLICT (code CONFLICT/COL20 or storage 409) = a concurrent writer already applied/removed this change; skip. */
export function skipConflict(e: unknown): void {
  const err = e as { code?: string; parameters?: { writeError?: { status?: number } } };
  const status = err?.parameters?.writeError?.status;
  if (err?.code === "CONFLICT" || err?.code === "COL20" || status === 409) return;
  throw e;
}

export async function saveArticle(id: string, text: string, entries: CodeEntry[]): Promise<void> {
  const { articles, codes } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  await codes
    .find({ selector: { articleId: id } })
    .exec()
    .then((docs) => Promise.all(docs.map((d) => d.remove().catch(skipConflict))));
  // upsert (not insert): a concurrent commit flush must not CONFLICT on re-added ids
  if (entries.length > 0) await codes.bulkUpsert(entries.map((e) => toCodeDoc(id, e)));
  await doc.patch({ text, updatedAt: Date.now() }).catch(skipConflict);
}

/** Snapshot the article's current text + entries as a new version. */
export async function addVersion(id: string, label?: string): Promise<void> {
  const { articles, codes } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  const article = doc.toJSON();
  const entries = (await codes.find({ selector: { articleId: id } }).exec()).map(toEntry);
  const version: ArticleVersion = {
    savedAt: Date.now(),
    ...(label ? { label } : {}),
    text: article.text,
    codes: entries,
  };
  await doc.patch({ versions: [...article.versions, version] });
}

export async function renameArticle(id: string, name: string): Promise<void> {
  const { articles } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (doc) await doc.patch({ name, updatedAt: Date.now() });
}

/** Remove an article together with its code entries and stored PDF bytes. */
export async function deleteArticle(id: string): Promise<void> {
  const { articles, codes, pdfs } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  for (const c of await codes.find({ selector: { articleId: id } }).exec()) await c.remove();
  const pdf = await pdfs.findOne(id).exec();
  if (pdf) await pdf.remove();
  await doc.remove();
}

// ----- local folders -----

/** Names of all locally created folders (sorted). */
export async function listFolders(): Promise<string[]> {
  const { folders } = await getDb();
  return (await folders.find().exec()).map((d) => d.name).sort((a, b) => a.localeCompare(b));
}

/** Live list of local folder names (sorted). */
export function watchFolders(next: (names: string[]) => void): () => void {
  let stopped = false;
  let unsub: Unsubscribable | undefined;
  void getDb().then(({ folders }) => {
    if (stopped) return;
    unsub = folders.find().$.subscribe((docs) => next(docs.map((d) => d.name).sort((a, b) => a.localeCompare(b))));
  });
  return () => {
    stopped = true;
    unsub?.unsubscribe();
  };
}

/** Register a folder so it shows in the tree even while it holds no document. */
export async function createFolder(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const { folders } = await getDb();
  if (await folders.findOne(clean).exec()) return;
  await folders.insert({ name: clean, createdAt: Date.now() });
}

/** Remove a local folder together with every article (codes + PDFs) inside it. */
export async function deleteFolder(name: string): Promise<void> {
  const { articles, folders } = await getDb();
  for (const a of await articles.find({ selector: { project: name } }).exec()) await deleteArticle(a.id);
  const folder = await folders.findOne(name).exec();
  if (folder) await folder.remove();
}

// ----- local frame-device catalogs -----

/** Locally edited catalog for a folder (overrides the server catalog), or null. */
export async function getLocalCatalog(folder: string): Promise<Instructions | null> {
  const { catalogs } = await getDb();
  const doc = await catalogs.findOne(folder).exec();
  if (!doc) return null;
  try {
    return instructionsSchema.parse(JSON.parse(doc.data));
  } catch {
    return null;
  }
}

/** Store a locally edited catalog for a folder (validated; never touches the server file). */
export async function saveLocalCatalog(folder: string, instr: Instructions): Promise<void> {
  const parsed = instructionsSchema.parse(instr);
  if (!uniqueIds(parsed)) throw new Error("duplicate device ids in catalog");
  const { catalogs } = await getDb();
  const doc = await catalogs.findOne(folder).exec();
  const data = JSON.stringify(parsed);
  if (doc) await doc.patch({ data, updatedAt: Date.now() });
  else await catalogs.insert({ folder, data, updatedAt: Date.now() });
}

/** Drop the local override so the folder falls back to the server catalog. */
export async function clearLocalCatalog(folder: string): Promise<void> {
  const { catalogs } = await getDb();
  const doc = await catalogs.findOne(folder).exec();
  if (doc) await doc.remove();
}

/** All local catalog overrides, keyed by folder. */
export async function listLocalCatalogs(): Promise<Map<string, Instructions>> {
  const { catalogs } = await getDb();
  const out = new Map<string, Instructions>();
  for (const d of await catalogs.find().exec()) {
    try {
      out.set(d.folder, instructionsSchema.parse(JSON.parse(d.data)));
    } catch {
      // ignore invalid local copies
    }
  }
  return out;
}

// ----- entries (codes collection) -----

export async function readCodes(articleId: string): Promise<CodeEntry[]> {
  const { codes } = await getDb();
  return (await codes.find({ selector: { articleId } }).exec()).map(toEntry);
}

export async function addEntry(articleId: string, entry: CodeEntry): Promise<void> {
  const { codes } = await getDb();
  await codes.bulkUpsert([toCodeDoc(articleId, entry)]);
}

export async function removeEntry(articleId: string, entry: CodeEntry): Promise<void> {
  const { codes } = await getDb();
  const doc = await codes.findOne(entryId(articleId, entry)).exec();
  if (doc) await doc.remove();
}

export async function saveNote(articleId: string, entry: CodeEntry, note: string): Promise<void> {
  const { codes } = await getDb();
  const doc = await codes.findOne(entryId(articleId, entry)).exec();
  if (doc) await doc.patch({ note });
}

// ----- original PDF bytes (kind=pdf articles) -----

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000; // chunked: String.fromCharCode(...huge) blows the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Store the original PDF bytes for a kind=pdf article (1:1, keyed by article id). */
export async function savePdfData(articleId: string, bytes: Uint8Array, pages: number): Promise<void> {
  const { pdfs } = await getDb();
  const doc: PdfDocData = { id: articleId, data: bytesToBase64(bytes), pages, updatedAt: Date.now() };
  await pdfs.bulkUpsert([doc]);
}

export async function getPdfData(articleId: string): Promise<{ data: string; pages: number } | null> {
  const { pdfs } = await getDb();
  const doc = await pdfs.findOne(articleId).exec();
  return doc ? { data: doc.data, pages: doc.pages } : null;
}

// ----- whole-database export / import -----

export interface DatabaseExport {
  kind: "luci-bachelor-db";
  version: 3;
  exportedAt: number;
  articles: ArticleData[];
  codes: CodeDocData[];
  catalogs: { folder: string; instructions: Instructions }[];
  pdfs: PdfDocData[];
  folders: FolderDocData[];
}

/** Snapshot every local article, entry, PDF, folder and catalog override as plain JSON. */
export async function exportDatabase(): Promise<DatabaseExport> {
  const { articles, codes, catalogs, pdfs, folders } = await getDb();
  const out: DatabaseExport = {
    kind: "luci-bachelor-db",
    version: 3,
    exportedAt: Date.now(),
    articles: (await articles.find().exec()).map((d) => d.toJSON()),
    codes: (await codes.find().exec()).map((d) => d.toJSON()),
    catalogs: [],
    pdfs: (await pdfs.find().exec()).map((d) => d.toJSON()),
    folders: (await folders.find().exec()).map((d) => d.toJSON()),
  };
  for (const d of await catalogs.find().exec()) {
    try {
      out.catalogs.push({ folder: d.folder, instructions: instructionsSchema.parse(JSON.parse(d.data)) });
    } catch {
      // skip invalid local overrides
    }
  }
  return out;
}

/** Merge a `DatabaseExport` back in (upsert by id; nothing is deleted). */
export async function importDatabase(
  blob: unknown,
): Promise<{ articles: number; codes: number; catalogs: number; pdfs: number; folders: number }> {
  const data = blob as Partial<DatabaseExport>;
  if (data?.kind !== "luci-bachelor-db" || !Array.isArray(data.articles))
    throw new Error("not a luci-bachelor database export");
  const { articles, codes } = await getDb();
  // exported docs carry their old _rev — strip it so the upsert re-commits cleanly
  const strip = <T>(d: T & { _rev?: string }): T => {
    const { _rev: _ignored, ...rest } = d;
    return rest as T;
  };
  const arts = data.articles
    .filter((a) => a && typeof a.id === "string" && typeof a.project === "string")
    .map((a) => strip(a));
  const cds = (data.codes ?? [])
    .filter((c) => c && typeof c.id === "string" && typeof c.articleId === "string")
    .map((c) => strip(c));
  const pdfs = (data.pdfs ?? [])
    .filter((p) => p && typeof p.id === "string" && typeof p.data === "string")
    .map((p) => strip(p));
  // v2 exports have no folders array
  const folders = (data.folders ?? []).filter((f) => f && typeof f.name === "string").map((f) => strip(f));
  if (arts.length > 0) await articles.bulkUpsert(arts);
  if (cds.length > 0) await codes.bulkUpsert(cds);
  if (pdfs.length > 0) await (await getDb()).pdfs.bulkUpsert(pdfs);
  if (folders.length > 0) await (await getDb()).folders.bulkUpsert(folders);
  let catCount = 0;
  for (const c of data.catalogs ?? []) {
    try {
      await saveLocalCatalog(c.folder, c.instructions);
      catCount++;
    } catch {
      // skip invalid catalogs
    }
  }
  return { articles: arts.length, codes: cds.length, catalogs: catCount, pdfs: pdfs.length, folders: folders.length };
}
