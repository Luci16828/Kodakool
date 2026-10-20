import { entryId } from "$lib/coding/edit";
import { compareDocs, compareNames } from "$lib/coding/display";
import { instructionsSchema, uniqueIds, type Instructions } from "$lib/coding/instructions";
import { codeEntrySchema, type CodeEntry } from "$lib/coding/types";

/**
 * Local-first store. The browser RxDB/Dexie database is the single source of
 * truth: articles (documents, with their own text + version history) and their
 * coding entries both live here. A remote/replication layer can be attached to
 * this database later; nothing in the app reads documents from the server.
 */

export const DEFAULT_PROJECT = "default";

export interface ArticleVersion {
  /** stable snapshot id — the graph node every child links to */
  id: string;
  savedAt: number;
  label?: string;
  /** snapshot this one continues from (null = root of a history) */
  parent: string | null;
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
  /** subfolder path inside the project ("sources/interviews"); "" = project root */
  folder?: string;
  createdAt: number;
  updatedAt: number;
  versions: ArticleVersion[];
}

export interface ArticleSummary {
  id: string;
  project: string;
  name: string;
  kind: ArticleKind;
  /** subfolder path inside the project; "" = project root */
  folder: string;
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
    id: { type: "string", maxLength: 100 },
    savedAt: { type: "number" },
    label: { type: "string" },
    parent: { type: ["string", "null"], maxLength: 100 },
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
  version: 1,
  type: "object",
  primaryKey: "name",
  properties: {
    name: { type: "string", maxLength: 200 },
    /** registered subfolder paths inside the project ("sources", "sources/interviews") */
    subs: { type: "array", items: { type: "string", maxLength: 400 } },
    createdAt: { type: "number" },
  },
  required: ["name", "createdAt"],
} as const;

const ARTICLE_SCHEMA = {
  title: "articles",
  description: "one document per article (local-first, carries its own text + history)",
  version: 3,
  type: "object",
  primaryKey: "id",
  properties: {
    id: { type: "string", maxLength: 100 },
    project: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 200 },
    text: { type: "string" },
    kind: { type: "string", enum: ["text", "pdf"] },
    /** subfolder path inside the project; "" = project root */
    folder: { type: "string", maxLength: 400 },
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
  /** registered subfolder paths inside the project (sorted) */
  subs?: string[];
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

/** Test seam: forget the memoized instance so a spec can exercise the open path from scratch. */
export function __resetDbForTests(): void {
  dbPromise = null;
}
/** addRxPlugin throws when the same plugin is added twice — only add it on the first open attempt */
let pluginsAdded = false;

const DB_NAME = "luci-coding";
/** RxDB's Dexie storage keeps one IndexedDB per (database, schema version, collection) */
const dexieDbName = (collection: string, version: number) => `rxdb-dexie-${DB_NAME}--${version}--${collection}`;

/** Raw IndexedDB open; resolves null when the database does not exist (the creating open is aborted). */
function idbOpen(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      settled = true;
      req.transaction?.abort();
      resolve(null);
    };
    req.onblocked = () => {
      settled = true;
      resolve(null);
    };
    req.onsuccess = () => {
      if (!settled) resolve(req.result);
    };
    req.onerror = () => {
      if (!settled) reject(req.error);
    };
  });
}

/** All rows of a Dexie storage instance's docs table; [] when the database does not exist. */
async function idbReadDocs(name: string): Promise<Record<string, unknown>[]> {
  const db = await idbOpen(name);
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("docs")) return [];
    return await new Promise((resolve, reject) => {
      const req = db.transaction("docs", "readonly").objectStore("docs").getAll();
      req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * RxDB v17 runs a schema migration as a cross-tab coordinated replication. When a
 * second tab opens the store mid-migration, the coordination cancels the migration
 * and leaves an `ERROR` status document in the internal store — and `migratePromise`
 * races DONE vs ERROR, so EVERY later open re-throws DM4 forever. The document data
 * itself is untouched; deleting the stuck status documents lets the next open
 * migrate cleanly. Returns how many were removed.
 */
export async function clearStuckMigrationStatuses(): Promise<number> {
  const db = await idbOpen(dexieDbName("_rxdb_internal", 0));
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains("docs")) return 0;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("docs", "readwrite");
      const store = tx.objectStore("docs");
      let removed = 0;
      const req = store.getAll();
      req.onsuccess = () => {
        for (const row of req.result as Record<string, unknown>[]) {
          const status = (row.data as { status?: string } | undefined)?.status;
          if (row.context === "rx-migration-status" && status === "ERROR") {
            store.delete(row.id as IDBValidKey);
            removed++;
          }
        }
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Collections whose schema version was bumped by the subfolder update; their
 * old-version Dexie tables can hold the only copy of the data when a migration
 * was interrupted (the migration writes into a NEW per-version IndexedDB). */
const STRANDED: Array<{ collection: "articles" | "folders"; below: number }> = [
  { collection: "articles", below: 3 },
  { collection: "folders", below: 1 },
];

/** Empty a Dexie storage instance's docs table. Clearing (not deleting the database)
 * is the safe form: the migration keeps its connection to the old table open, and a
 * `deleteDatabase` request against it stays blocked forever — blocking every later
 * open of that database. A transaction works alongside the open connection. */
async function idbClearDocs(name: string): Promise<void> {
  const db = await idbOpen(name);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains("docs")) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("docs", "readwrite");
      tx.objectStore("docs").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Rescue documents stranded by an interrupted migration: the live collection is
 * empty while the old-version IndexedDB still holds the data. Copy every document
 * the live collection does not have (oldest version first, so the newest wins),
 * backfilling the fields the migration strategy would have added, then empty the
 * old table so a later reload can never resurrect deleted documents. Idempotent.
 */
async function rescueStrandedDocs(db: Db): Promise<void> {
  for (const { collection, below } of STRANDED) {
    const col = db[collection];
    const have = new Set((await col.find().exec()).map((d) => d.id));
    for (let version = 0; version < below; version++) {
      const name = dexieDbName(collection, version);
      const rows = await idbReadDocs(name);
      if (rows.length === 0) continue;
      const docs: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (row._deleted || have.has(row.id)) continue;
        const { _rev, _meta, _attachments, _deleted, ...plain } = row;
        docs.push(plain);
      }
      if (docs.length > 0) {
        if (collection === "articles") {
          for (const d of docs) d.folder = normalizeSubPath(String(d.folder ?? ""));
        } else {
          for (const d of docs) d.subs = Array.isArray(d.subs) ? d.subs : [];
        }
        await (col as unknown as Collection<Record<string, unknown>>).bulkUpsert(docs);
        for (const d of docs) have.add(d.id as string);
      }
      // the table is spent (the data is live now) — empty it so a later reload can
      // never resurrect documents the user deleted in the meantime
      await idbClearDocs(name);
    }
  }
}

export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const { createRxDatabase, addRxPlugin } = await import("rxdb");
    const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
    // required since the articles schema was bumped to version 1 (kind field)
    const { RxDBMigrationSchemaPlugin } = await import("rxdb/plugins/migration-schema");
    if (!pluginsAdded) {
      addRxPlugin(RxDBMigrationSchemaPlugin);
      pluginsAdded = true;
    }
    const collections = () => ({
      articles: {
        schema: structuredClone(ARTICLE_SCHEMA),
        // v0 → v1 added the kind field: pre-existing articles are plain text
        migrationStrategies: {
          1: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, kind: "text" as const }),
          // v1 → v2 made every snapshot a graph node (id + parent)
          2: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, versions: normalizeVersions(oldDoc.versions) }),
          // v2 → v3 added the subfolder path: pre-existing articles sit at the project root
          3: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, folder: "" }),
        },
      },
      codes: { schema: structuredClone(CODE_SCHEMA) },
      catalogs: { schema: structuredClone(CATALOG_SCHEMA) },
      pdfs: { schema: structuredClone(PDF_SCHEMA) },
      folders: {
        schema: structuredClone(FOLDER_SCHEMA),
        // v0 → v1 added the subfolder registry: pre-existing projects have no subfolders
        migrationStrategies: {
          1: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, subs: [] as string[] }),
        },
      },
    });
    const open = async () => {
      const db = await createRxDatabase({ name: DB_NAME, storage: getRxStorageDexie() });
      try {
        await db.addCollections(collections());
        return db;
      } catch (e) {
        // close the failed instance: its migration state keeps the leader-election
        // BroadcastChannel held, so a retry on the same instance would deadlock
        await db.close().catch(() => undefined);
        throw e;
      }
    };
    let db: Awaited<ReturnType<typeof open>>;
    try {
      db = await open();
    } catch (e) {
      // a migration cancelled by a second tab poisons the internal store with an
      // ERROR status doc that makes every later open throw DM4 — clear the stuck
      // docs and retry once (a background migration that already finished shows a
      // DONE status, so the retry succeeds in that case too)
      await clearStuckMigrationStatuses().catch(() => undefined);
      db = await open();
    }
    const typed = db as unknown as Db;
    // an interrupted migration strands the data in the old-version IndexedDB; copy it back
    await rescueStrandedDocs(typed).catch(() => undefined);
    // repair crash residue (orphan codes/pdfs, half-normalized articles) once per page load
    await sweep(typed).catch(() => undefined);
    return typed;
  })().catch((e: unknown) => {
    // a failed open must NOT be memoized: the next getDb() retries (e.g. a transient
    // IndexedDB block in private mode); a poisoned promise would break the app until reload
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Cap on the version history per article (every snapshot stores the full text). */
export const MAX_VERSIONS = 200;

/**
 * Repair the store after a crash mid-write: code/PDF documents whose article is gone
 * are removed, and articles missing `versions`/`kind` are normalized so every reader
 * can rely on them. Runs automatically on every database open.
 */
async function sweep(db: Db): Promise<{ codes: number; pdfs: number }> {
  const articleIds = new Set((await db.articles.find().exec()).map((d) => d.id));
  let codes = 0;
  let pdfs = 0;
  for (const c of await db.codes.find().exec()) {
    // orphan, or an entry that fails the write-boundary contract (range arity, uuid
    // device, endLine >= line) — the JSON schema validator enforces neither
    if (articleIds.has(c.articleId) && codeEntrySchema.safeParse(toEntry(c)).success) continue;
    await c.remove().catch(skipConflict);
    codes++;
  }
  for (const p of await db.pdfs.find().exec()) {
    if (articleIds.has(p.id)) continue;
    await p.remove().catch(skipConflict);
    pdfs++;
  }
  for (const a of await db.articles.find().exec()) {
    const patch: Record<string, unknown> = {};
    // normalizeVersions drops poisoned snapshots and mints the graph identity
    // (id + parent) a pre-graph store never had
    if (needsNormalize(a.versions)) patch.versions = normalizeVersions(a.versions);
    if (a.kind !== "text" && a.kind !== "pdf") patch.kind = "text";
    // pre-v3 stores have no subfolder path — every article sits at the project root
    if (typeof a.folder !== "string") patch.folder = "";
    if (Object.keys(patch).length > 0) await a.patch(patch).catch(skipConflict);
  }
  for (const f of await db.folders.find().exec()) {
    if (Array.isArray(f.subs)) continue;
    await f.patch({ subs: [] as string[] }).catch(skipConflict);
  }
  return { codes, pdfs };
}

export async function integritySweep(): Promise<{ codes: number; pdfs: number }> {
  return sweep(await getDb());
}

function toCodeDoc(articleId: string, entry: CodeEntry): CodeDocData {
  // the JSON schema validator does NOT enforce range arity / excerpt length, so
  // validate at the write boundary: a malformed entry throws before anything is stored
  codeEntrySchema.parse(entry);
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

/**
 * Next free `Untitled N.md` name inside a project (max existing N + 1).
 * New documents are markdown by default, so the generated name carries `.md`
 * (it drives highlighting, the cheatsheet button and the download ending).
 */
export async function nextUntitledName(project: string): Promise<string> {
  const { articles } = await getDb();
  const docs = await articles.find({ selector: { project } }).exec();
  let max = 0;
  for (const d of docs) {
    const m = /^Untitled (\d+)(?:\.md)?$/.exec(d.name);
    // cap guards against a hand-named `Untitled 99999999999999999999.md` overflowing
    // Number and producing scientific-notation names like `Untitled 1e+21.md`
    if (m) max = Math.max(max, Math.min(Number(m[1]), 1_000_000));
  }
  let n = max + 1;
  while (docs.some((d) => d.name === `Untitled ${n}.md`)) n++;
  return `Untitled ${n}.md`;
}

export async function createArticle(
  project: string = DEFAULT_PROJECT,
  kind: ArticleKind = "text",
  folder = "",
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
    folder: normalizeSubPath(folder),
    createdAt: now,
    updatedAt: now,
    versions: [],
  };
  await articles.insert(article);
  // concurrent creators can compute the same `Untitled N` name: losers rename
  // themselves so (project, name) — the app's addressing key — stays unique
  const name = await resolveArticleName(id, cleanProject, article.name);
  return {
    id,
    project: cleanProject,
    name,
    kind,
    folder: article.folder ?? "",
    updatedAt: now,
    codes: 0,
    versions: 0,
  };
}

async function resolveArticleName(id: string, project: string, name: string): Promise<string> {
  const { articles } = await getDb();
  for (let i = 0; i < 4; i++) {
    const same = await articles.find({ selector: { project, name } }).exec();
    if (same.length <= 1) return name;
    const next = await nextUntitledName(project);
    const doc = await articles.findOne(id).exec();
    if (!doc) return name;
    await doc.patch({ name: next }).catch(skipConflict);
    name = next;
  }
  // last resort: a uuid-suffixed name is unique by construction
  const unique = `${name} (${id.slice(0, 8)})`;
  const doc = await articles.findOne(id).exec();
  if (doc) await doc.patch({ name: unique }).catch(skipConflict);
  return unique;
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
  return docs.map((d) => toSummary(d.toJSON(), counts.get(d.id) ?? 0)).sort(compareDocs);
}

function toSummary(a: ArticleData, codes: number): ArticleSummary {
  return {
    id: a.id,
    project: a.project,
    name: a.name,
    kind: a.kind ?? "text",
    // a store written before the folder field may lack it — treat as project root
    folder: typeof a.folder === "string" ? a.folder : "",
    updatedAt: a.updatedAt,
    codes,
    // a store written by an older app version may lack versions — never crash on it
    versions: a.versions?.length ?? 0,
  };
}

/** Live list of all articles (sorted) with current per-article code counts. */
export function watchArticles(next: (list: ArticleSummary[]) => void): () => void {
  let stopped = false;
  let aUnsub: Unsubscribable | undefined;
  let cUnsub: Unsubscribable | undefined;
  let arts: ArticleData[] = [];
  let counts = new Map<string, number>();
  const emit = () => next(arts.map((a) => toSummary(a, counts.get(a.id) ?? 0)).sort(compareDocs));

  void getDb()
    .then(({ articles, codes }) => {
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
    })
    .catch(() => undefined);

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

  void getDb()
    .then(({ articles, codes }) => {
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
    })
    .catch(() => undefined);

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
  if (!doc) {
    // the article is gone (concurrent delete): sweep codes a racing commit leaked for it
    await sweepCodesOf(codes, id);
    return;
  }
  const docs = entries.map((e) => toCodeDoc(id, e));
  const keep = new Set(docs.map((d) => d.id));
  // write the new codes FIRST: a crash mid-save can leave old + new codes side by side
  // (self-healed by the next commit), it can never leave the document entry-less.
  // An invalid entry throws here, before anything existing is touched.
  if (docs.length > 0) await codes.bulkUpsert(docs);
  for (const d of await codes.find({ selector: { articleId: id } }).exec()) {
    if (!keep.has(d.id)) await d.remove().catch(skipConflict);
  }
  // upsert (not insert): a concurrent commit flush must not CONFLICT on re-added ids
  await doc.patch({ text, updatedAt: Date.now() }).catch(skipConflict);
  // if the article was deleted concurrently, the codes upserted above are now orphans
  if (!(await articles.findOne(id).exec())) await sweepCodesOf(codes, id);
}

async function sweepCodesOf(codes: Collection<CodeDocData>, articleId: string): Promise<void> {
  for (const d of await codes.find({ selector: { articleId } }).exec()) {
    await d.remove().catch(skipConflict);
  }
}

/**
 * Snapshot the article's current text + entries as a new version (oldest dropped past
 * MAX_VERSIONS).
 *
 * `parent` picks the graph node the snapshot hangs on: omit it to continue the newest
 * snapshot (linear history), pass an older snapshot's id after a revert — the next
 * snapshot then forks off that node. Returns the stored snapshot (its id becomes the
 * live HEAD) or null when the article is gone.
 */
export async function addVersion(id: string, label?: string, parent?: string | null): Promise<ArticleVersion | null> {
  const { articles, codes } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return null;
  const article = doc.toJSON();
  const history = normalizeVersions(article.versions);
  const entries = (await codes.find({ selector: { articleId: id } }).exec()).map(toEntry);
  const from = parent === undefined ? (history.at(-1)?.id ?? null) : parent;
  const version: ArticleVersion = {
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    // a parent the store does not know becomes a root: the cap drops the oldest snapshots
    parent: from !== null && history.some((v) => v.id === from) ? from : null,
    ...(label !== undefined && label.trim() !== "" ? { label: label.trim() } : {}),
    text: article.text,
    codes: entries,
  };
  // every version stores the full text: cap the history so one article cannot
  // grow the store without bound through repeated snapshots
  const versions = [...history, version];
  await doc.patch({ versions: versions.slice(-MAX_VERSIONS) });
  return version;
}

/**
 * Rename a snapshot in place — the label input in the history popover writes
 * through here. The graph identity (id + parent) is untouched; an empty label
 * clears it back to the timestamp fallback.
 */
export async function setVersionLabel(id: string, versionId: string, label: string): Promise<void> {
  const { articles } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  const versions = normalizeVersions(doc.toJSON().versions);
  const v = versions.find((x) => x.id === versionId);
  if (!v) return;
  const clean = label.trim();
  if (clean === "" ? v.label === undefined : v.label === clean) return;
  if (clean === "") delete v.label;
  else v.label = clean;
  await doc.patch({ versions });
}

export async function renameArticle(id: string, name: string): Promise<void> {
  const { articles } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  const old = doc.name;
  await doc.patch({ name, updatedAt: Date.now() });
  // concurrent renames to the same target: the loser reverts, keeping (project, name) unique
  const same = await articles.find({ selector: { project: doc.project, name } }).exec();
  if (same.length > 1) {
    const fresh = await articles.findOne(id).exec();
    if (fresh) await fresh.patch({ name: old }).catch(skipConflict);
    throw new Error(`"${name}" already exists`);
  }
}

/** Normalize a subfolder path: trim segments, drop empty ones and "."/"..", join with "/". */
export function normalizeSubPath(path: string): string {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

/** Move an article into a subfolder of its project ("" = project root). */
export async function moveArticle(id: string, folder: string): Promise<void> {
  const { articles } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  await doc.patch({ folder: normalizeSubPath(folder), updatedAt: Date.now() }).catch(skipConflict);
}

/** Move an article to another project's root. (project, name) uniqueness is re-checked:
 * the loser reverts and throws, same as renameArticle. */
export async function moveArticleProject(id: string, project: string): Promise<void> {
  const { articles } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  const clean = project.trim();
  if (!clean || clean === doc.project) return;
  const oldProject = doc.project;
  await doc.patch({ project: clean, folder: "", updatedAt: Date.now() }).catch(skipConflict);
  const same = await articles.find({ selector: { project: clean, name: doc.name } }).exec();
  if (same.length > 1) {
    const fresh = await articles.findOne(id).exec();
    if (fresh) await fresh.patch({ project: oldProject, folder: "" }).catch(skipConflict);
    throw new Error(`"${doc.name}" already exists in ${clean}`);
  }
}

/** Copy an article (text + entries + PDF bytes) beside the original as "<name> copy [N]". */
export async function duplicateArticle(id: string): Promise<ArticleSummary | null> {
  const { articles, codes, pdfs } = await getDb();
  const src = await articles.findOne(id).exec();
  if (!src) return null;
  const taken = async (n: string) =>
    (await articles.find({ selector: { project: src.project, name: n } }).exec()).length > 0;
  const base = src.name.replace(/ copy( \d+)?$/, "");
  let name = `${base} copy`;
  for (let n = 2; await taken(name); n++) name = `${base} copy ${n}`;
  const newId = crypto.randomUUID();
  const now = Date.now();
  const article: ArticleData = {
    id: newId,
    project: src.project,
    name,
    text: src.text,
    kind: src.kind ?? "text",
    folder: typeof src.folder === "string" ? src.folder : "",
    createdAt: now,
    updatedAt: now,
    versions: [],
  };
  await articles.insert(article);
  // same name-race resolution as createArticle: losers rename themselves
  const finalName = await resolveArticleName(newId, src.project, name);
  // entries keep their uids — entryId hashes articleId + uid, so the copy's ids are unique
  const entries = (await codes.find({ selector: { articleId: id } }).exec()).map(toEntry);
  if (entries.length > 0) await codes.bulkUpsert(entries.map((e) => toCodeDoc(newId, e)));
  const pdf = await pdfs.findOne(id).exec();
  if (pdf) await pdfs.insert({ id: newId, data: pdf.data, pages: pdf.pages, updatedAt: now });
  return { ...toSummary(article, entries.length), name: finalName };
}

/** Remove an article together with its code entries and stored PDF bytes. */
export async function deleteArticle(id: string): Promise<void> {
  const { articles, codes, pdfs } = await getDb();
  const doc = await articles.findOne(id).exec();
  if (!doc) return;
  // article FIRST: the visible document disappears in one atomic write; a crash after
  // this point leaves only invisible orphan codes/pdfs, which the startup sweep repairs.
  // (Deleting the codes first could crash into a document that shows zero entries.)
  await doc.remove().catch(skipConflict);
  for (const c of await codes.find({ selector: { articleId: id } }).exec()) {
    await c.remove().catch(skipConflict);
  }
  const pdf = await pdfs.findOne(id).exec();
  if (pdf) await pdf.remove().catch(skipConflict);
}

// ----- local folders -----

/** Names of all locally created folders (sorted). */
export async function listFolders(): Promise<string[]> {
  const { folders } = await getDb();
  return (await folders.find().exec()).map((d) => d.name).sort(compareNames);
}

/** Live list of local folder names (sorted). */
export function watchFolders(next: (names: string[]) => void): () => void {
  let stopped = false;
  let unsub: Unsubscribable | undefined;
  void getDb()
    .then(({ folders }) => {
      if (stopped) return;
      unsub = folders.find().$.subscribe((docs) => next(docs.map((d) => d.name).sort(compareNames)));
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    unsub?.unsubscribe();
  };
}

/** Register a folder so it shows in the tree even while it holds no document (idempotent). */
export async function createFolder(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const { folders } = await getDb();
  if (await folders.findOne(clean).exec()) return;
  try {
    await folders.insert({ name: clean, createdAt: Date.now() });
  } catch (e) {
    // a concurrent creator won the primary key: the folder exists now — idempotent no-op
    skipConflict(e);
  }
}

/** Remove a local folder together with every article (codes + PDFs) inside it. */
export async function deleteFolder(name: string): Promise<void> {
  const { articles, folders } = await getDb();
  // folder doc FIRST: a crash mid-cascade leaves articles whose project has no folder
  // doc — the project screen shows those (folders + article projects are unioned), so
  // the user can simply delete the project again; nothing becomes invisible.
  const folder = await folders.findOne(name).exec();
  if (folder) await folder.remove().catch(skipConflict);
  for (const a of await articles.find({ selector: { project: name } }).exec()) await deleteArticle(a.id);
}

// ----- subfolders (organization layer inside one project) -----

/** Live list of a project's registered subfolder paths (sorted). */
export function watchSubfolders(project: string, next: (paths: string[]) => void): () => void {
  let stopped = false;
  let unsub: Unsubscribable | undefined;
  void getDb()
    .then(({ folders }) => {
      if (stopped) return;
      unsub = folders
        .find({ selector: { name: project } })
        .$.subscribe((docs) => next([...(docs[0]?.toJSON().subs ?? [])].sort(compareNames)));
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    unsub?.unsubscribe();
  };
}

/** Register a subfolder path inside a project (creates the project doc when missing; idempotent). */
export async function createSubfolder(project: string, path: string): Promise<void> {
  const clean = normalizeSubPath(path);
  if (!clean) return;
  await createFolder(project);
  const { folders } = await getDb();
  const doc = await folders.findOne(project).exec();
  if (!doc) return;
  const subs = doc.toJSON().subs ?? [];
  if (subs.includes(clean)) return;
  await doc.patch({ subs: [...subs, clean].sort(compareNames) }).catch(skipConflict);
}

/** Remove a subfolder: its documents (and nested folders' ones) move to the project root first. */
export async function deleteSubfolder(project: string, path: string): Promise<void> {
  const clean = normalizeSubPath(path);
  if (!clean) return;
  const { articles, folders } = await getDb();
  // move contained documents FIRST: a crash mid-way leaves them visible at the root,
  // never stranded inside a folder that no longer exists
  for (const a of await articles.find({ selector: { project } }).exec()) {
    const f = typeof a.folder === "string" ? a.folder : "";
    if (f === clean || f.startsWith(clean + "/")) await a.patch({ folder: "" }).catch(skipConflict);
  }
  const doc = await folders.findOne(project).exec();
  if (!doc) return;
  const subs = (doc.toJSON().subs ?? []).filter((s) => s !== clean && !s.startsWith(clean + "/"));
  await doc.patch({ subs }).catch(skipConflict);
}

/** Rename a subfolder: rewrites the path prefix on every contained document + nested subfolder. */
export async function renameSubfolder(project: string, oldPath: string, newPath: string): Promise<void> {
  const old = normalizeSubPath(oldPath);
  const next = normalizeSubPath(newPath);
  if (!old || !next || old === next) return;
  const { articles, folders } = await getDb();
  const doc = await folders.findOne(project).exec();
  const subs = doc?.toJSON().subs ?? [];
  if (subs.includes(next)) throw new Error(`"${next}" already exists`);
  const rel = (f: string) => (f === old ? next : f.startsWith(old + "/") ? next + f.slice(old.length) : f);
  for (const a of await articles.find({ selector: { project } }).exec()) {
    const cur = typeof a.folder === "string" ? a.folder : "";
    const f = rel(cur);
    if (f !== cur) await a.patch({ folder: f }).catch(skipConflict);
  }
  if (!doc) return;
  await doc.patch({ subs: [...new Set(subs.map(rel))].sort(compareNames) }).catch(skipConflict);
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
  // CONFLICT here means a racing delete/save already removed it — the entry is gone either way
  if (doc) await doc.remove().catch(skipConflict);
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
  version: 5;
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
    version: 5,
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

/** Snapshot ONE project — its documents, their entries + PDF bytes, its catalog
 * override and its folder registration. The result is a valid `DatabaseExport`
 * subset, so `importDatabase` accepts a project blob unchanged (merge by id). */
export async function exportProject(project: string): Promise<DatabaseExport> {
  const { articles, codes, catalogs, pdfs, folders } = await getDb();
  const mine = (await articles.find().exec()).filter((d) => d.project === project).map((d) => d.toJSON());
  const ids = new Set(mine.map((a) => a.id));
  const out: DatabaseExport = {
    kind: "luci-bachelor-db",
    version: 5,
    exportedAt: Date.now(),
    articles: mine,
    codes: (await codes.find().exec()).filter((d) => ids.has(d.articleId)).map((d) => d.toJSON()),
    catalogs: [],
    pdfs: (await pdfs.find().exec()).filter((d) => ids.has(d.id)).map((d) => d.toJSON()),
    folders: (await folders.find().exec()).filter((d) => d.name === project).map((d) => d.toJSON()),
  };
  const cat = await catalogs.findOne(project).exec();
  if (cat) {
    try {
      out.catalogs.push({ folder: cat.folder, instructions: instructionsSchema.parse(JSON.parse(cat.data)) });
    } catch {
      // skip invalid local override
    }
  }
  return out;
}

/** Merge a `DatabaseExport` back in (upsert by id; nothing is deleted).
 * The whole blob is validated BEFORE anything is written, so a broken file can never
 * leave a half-imported database; codes/PDFs whose article is missing are dropped
 * (orphans would inflate exports and resurrect as entries when an id reappears). */
export async function importDatabase(
  blob: unknown,
): Promise<{ articles: number; codes: number; catalogs: number; pdfs: number; folders: number }> {
  const data = blob as Partial<DatabaseExport>;
  if (data?.kind !== "luci-bachelor-db" || !Array.isArray(data.articles))
    throw new Error("not a luci-bachelor database export");
  const rawCodes = data.codes ?? [];
  const rawPdfs = data.pdfs ?? [];
  const rawFolders = data.folders ?? [];
  const rawCats = data.catalogs ?? [];
  if (!Array.isArray(rawCodes)) throw new Error("import: codes must be an array");
  if (!Array.isArray(rawPdfs)) throw new Error("import: pdfs must be an array");
  if (!Array.isArray(rawFolders)) throw new Error("import: folders must be an array");
  if (!Array.isArray(rawCats)) throw new Error("import: catalogs must be an array");

  const arts: ArticleData[] = [];
  for (const a of data.articles) {
    const x = a as (Partial<ArticleData> & { _rev?: string }) | null;
    if (
      !x ||
      typeof x.id !== "string" ||
      typeof x.project !== "string" ||
      typeof x.name !== "string" ||
      typeof x.text !== "string"
    )
      throw new Error("import: invalid article");
    if (x.kind !== undefined && x.kind !== "text" && x.kind !== "pdf") throw new Error("import: invalid article kind");
    if (x.versions !== undefined && (!Array.isArray(x.versions) || !x.versions.every(versionOk)))
      throw new Error("import: invalid article version");
    arts.push({
      id: x.id,
      project: x.project,
      name: x.name,
      text: x.text,
      kind: x.kind ?? "text",
      // pre-v3 exports have no subfolder path — the article lands at the project root
      folder: typeof x.folder === "string" ? normalizeSubPath(x.folder) : "",
      createdAt: num(x.createdAt, Date.now()),
      updatedAt: num(x.updatedAt, Date.now()),
      // exports from before versions were graph nodes have no id/parent — chain them
      versions: normalizeVersions(x.versions ?? []),
    });
  }
  for (const c of rawCodes) {
    const x = c as (Partial<CodeDocData> & { _rev?: string }) | null;
    // codeEntrySchema is the exact write-boundary contract (uuid device/uid, range
    // arity, endLine >= line): accepting anything looser here would poison the
    // article, because every later saveArticle re-validates its codes and would throw
    if (!x || typeof x.id !== "string" || typeof x.articleId !== "string" || !codeEntrySchema.safeParse(x).success)
      throw new Error("import: invalid code entry");
  }
  for (const p of rawPdfs) {
    const x = p as (Partial<PdfDocData> & { _rev?: string }) | null;
    if (!x || typeof x.id !== "string" || typeof x.data !== "string") throw new Error("import: invalid pdf entry");
  }
  for (const f of rawFolders) {
    const x = f as (Partial<FolderDocData> & { _rev?: string }) | null;
    if (!x || typeof x.name !== "string") throw new Error("import: invalid folder entry");
  }

  const { articles, codes } = await getDb();
  // exported docs carry their old _rev — strip it so the upsert re-commits cleanly
  const strip = <T>(d: T & { _rev?: string }): T => {
    const { _rev: _ignored, ...rest } = d;
    return rest as T;
  };
  // a code/PDF needs a parent article — from this blob or already in the store
  const known = new Set(arts.map((a) => a.id));
  for (const d of await articles.find().exec()) known.add(d.id);
  const cds = (rawCodes as CodeDocData[]).filter((c) => known.has(c.articleId)).map((c) => strip(c));
  const pdfs = (rawPdfs as PdfDocData[]).filter((p) => known.has(p.id)).map((p) => strip(p));
  // v2 exports have no folders array; v4 folder docs have no subfolder registry
  const folders = (rawFolders as (FolderDocData & { subs?: unknown })[]).map((f) => {
    const { _rev: _ignored, ...rest } = f as FolderDocData & { _rev?: string };
    const subs = Array.isArray(f.subs)
      ? [...new Set(f.subs.filter((s) => typeof s === "string").map(normalizeSubPath))].sort(compareNames)
      : [];
    return { ...rest, subs } as FolderDocData;
  });

  if (arts.length > 0) await articles.bulkUpsert(arts);
  if (cds.length > 0) await codes.bulkUpsert(cds);
  if (pdfs.length > 0) await (await getDb()).pdfs.bulkUpsert(pdfs);
  if (folders.length > 0) await (await getDb()).folders.bulkUpsert(folders);
  let catCount = 0;
  for (const c of rawCats) {
    try {
      const x = c as { folder?: unknown; instructions?: unknown };
      if (typeof x?.folder !== "string") continue;
      await saveLocalCatalog(x.folder, x.instructions as Instructions);
      catCount++;
    } catch {
      // skip invalid catalogs
    }
  }
  return { articles: arts.length, codes: cds.length, catalogs: catCount, pdfs: pdfs.length, folders: folders.length };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function versionOk(v: unknown): boolean {
  const x = v as { savedAt?: unknown; label?: unknown; text?: unknown; codes?: unknown };
  if (!x || typeof x.savedAt !== "number" || typeof x.text !== "string" || !Array.isArray(x.codes)) return false;
  if (x.label !== undefined && typeof x.label !== "string") return false;
  return x.codes.every((c) => codeEntrySchema.safeParse(c).success);
}

/** Cheap "does this history need the repair below?" check (versions carry full text). */
function needsNormalize(versions: unknown): boolean {
  if (!Array.isArray(versions)) return true;
  // a poisoned snapshot must go, exactly like the sweep always removed it
  if (!versions.every(versionOk)) return true;
  const ids = new Set(versions.map((v) => (v as ArticleVersion)?.id));
  return versions.some((v) => {
    const x = v as ArticleVersion;
    if (typeof x.id !== "string") return true;
    return x.parent !== null && (typeof x.parent !== "string" || !ids.has(x.parent));
  });
}

/**
 * Give every snapshot the identity the history graph needs (`id` + `parent`).
 *
 * Stores written before versions were graph nodes carry neither: they are chained in
 * stored order, which is exactly the linear history the app produced for them. Content-
 * invalid snapshots are dropped (reverting to one would poison the live entries), and a
 * `parent` left pointing at a dropped or truncated node becomes a root, so a history
 * that lost its oldest entries to the MAX_VERSIONS cap still draws.
 */
function normalizeVersions(versions: unknown): ArticleVersion[] {
  if (!Array.isArray(versions)) return [];
  const out: ArticleVersion[] = [];
  for (const raw of versions) {
    if (!versionOk(raw)) continue;
    const v = raw as Partial<ArticleVersion>;
    const id = typeof v.id === "string" && v.id !== "" ? v.id : crypto.randomUUID();
    const parent = v.parent === null || typeof v.parent === "string" ? v.parent : (out.at(-1)?.id ?? null);
    out.push({ ...(v as ArticleVersion), id, parent });
  }
  const kept = new Set(out.map((v) => v.id));
  for (const v of out) if (v.parent !== null && !kept.has(v.parent)) v.parent = null;
  return out;
}
