import { describe, expect, it } from "vitest";

/**
 * Migration proof: a store written by the pre-subfolder app (articles v2,
 * folders v0) must reopen cleanly with the current schemas (articles v3 with
 * the `folder` field, folders v1 with the `subs` registry) through the exact
 * migration strategies `getDb` registers. This is the path a real user's
 * browser takes on the first load after the update — the app's own specs
 * always start from a fresh database and never exercise it.
 */

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
};

const baseArticleProps = {
  id: { type: "string", maxLength: 100 },
  project: { type: "string", maxLength: 200 },
  name: { type: "string", maxLength: 200 },
  text: { type: "string" },
  kind: { type: "string", enum: ["text", "pdf"] },
  createdAt: { type: "number" },
  updatedAt: { type: "number" },
  versions: { type: "array", items: VERSION_SCHEMA },
};

const ARTICLES_V2 = {
  title: "articles",
  description: "one document per article",
  version: 2,
  type: "object",
  primaryKey: "id",
  properties: baseArticleProps,
  required: ["id", "project", "name", "text", "createdAt", "updatedAt"],
  indexes: ["project"],
};

const ARTICLES_V3 = {
  ...ARTICLES_V2,
  version: 3,
  properties: { ...baseArticleProps, folder: { type: "string", maxLength: 400 } },
};

const FOLDERS_V0 = {
  title: "folders",
  description: "locally created document folders",
  version: 0,
  type: "object",
  primaryKey: "name",
  properties: { name: { type: "string", maxLength: 200 }, createdAt: { type: "number" } },
  required: ["name", "createdAt"],
};

const FOLDERS_V1 = {
  ...FOLDERS_V0,
  version: 1,
  properties: {
    name: { type: "string", maxLength: 200 },
    subs: { type: "array", items: { type: "string", maxLength: 400 } },
    createdAt: { type: "number" },
  },
};

/** Open a database the way the pre-update app did (the migration plugin is required
 * as soon as a stored collection's schema version is behind the code's). */
async function openOldApp(name: string) {
  const { createRxDatabase, addRxPlugin } = await import("rxdb");
  const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
  const { RxDBMigrationSchemaPlugin } = await import("rxdb/plugins/migration-schema");
  try {
    addRxPlugin(RxDBMigrationSchemaPlugin);
  } catch {
    // the app module adds it on its first getDb — a double add throws, the plugin is active
  }
  return createRxDatabase({ name, storage: getRxStorageDexie() });
}

describe("schema migration (v2 articles + v0 folders → current)", () => {
  it("backfills folder '' and subs [] through the registered strategies", async () => {
    const name = `luci-mig-${crypto.randomUUID().slice(0, 8)}`;
    const { createRxDatabase } = await import("rxdb");
    const { getRxStorageDexie } = await import("rxdb/plugins/storage-dexie");
    const old = await openOldApp(name);
    await old.addCollections({
      articles: { schema: structuredClone(ARTICLES_V2) },
      folders: { schema: structuredClone(FOLDERS_V0) },
    });
    await old.articles.insert({
      id: "a1",
      project: "p",
      name: "n",
      text: "t",
      kind: "text",
      createdAt: 1,
      updatedAt: 1,
      versions: [{ savedAt: 1, text: "snap", codes: [] }],
    });
    await old.folders.insert({ name: "p", createdAt: 1 });
    await old.close();

    const fresh = await createRxDatabase({ name, storage: getRxStorageDexie() });
    await fresh.addCollections({
      articles: {
        schema: structuredClone(ARTICLES_V3),
        migrationStrategies: { 3: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, folder: "" }) },
      },
      folders: {
        schema: structuredClone(FOLDERS_V1),
        migrationStrategies: { 1: (oldDoc: Record<string, unknown>) => ({ ...oldDoc, subs: [] }) },
      },
    });

    const art = await fresh.articles.findOne("a1").exec();
    expect(art?.toJSON().folder).toBe("");
    expect(art?.toJSON().text).toBe("t");
    const folder = await fresh.folders.findOne("p").exec();
    expect(folder?.toJSON().subs).toEqual([]);

    await fresh.close();
  });
});

/**
 * Recovery proof for the interrupted-migration residue (the DM4 "is closed" case):
 * a second tab opening the store mid-migration cancels the migration and leaves an
 * ERROR status document in the internal store, so every later open re-throws DM4
 * while the data sits in the old-version IndexedDB. `getDb()` must clear the stuck
 * status, re-run the migration and rescue any stranded documents.
 *
 * The residue is built with RxDB itself (the real v2/v0 stores, the real collection
 * metas), because the migration replays the schema stored in those metas — a
 * hand-built store would not be the store the app actually meets in the field.
 */

const meta = { lastModified: 1, deleted: false, writtenAt: 1 };

/** Write the stuck migration-status documents a cancelled migration leaves behind. */
async function poisonMigrationStatus(collections: Array<{ name: string; to: number }>) {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const req = indexedDB.open("rxdb-dexie-luci-coding--0--_rxdb_internal");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("docs", "readwrite");
      for (const { name, to } of collections) {
        const key = `${name}-v${to}`;
        tx.objectStore("docs").put({
          id: `rx-migration-status|${key}`,
          key,
          context: "rx-migration-status",
          data: {
            status: "ERROR",
            collectionName: name,
            count: { total: 1, handled: 0, percent: 0 },
            error: { message: "RxStorageInstanceDexie is closed" },
          },
          _deleted: false,
          _rev: "1",
          _meta: meta,
          _attachments: {},
        });
      }
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

describe("recovery from an interrupted migration", () => {
  it("clears the stuck ERROR status, re-migrates and rescues the stranded documents", async () => {
    // the pre-update app, in the app's own database, with the user's data
    const old = await openOldApp("luci-coding");
    await old.addCollections({
      articles: { schema: structuredClone(ARTICLES_V2) },
      folders: { schema: structuredClone(FOLDERS_V0) },
    });
    await old.articles.insert({
      id: "stranded-1",
      project: "mig-recovery",
      name: "doc",
      text: "rescued text",
      kind: "text",
      createdAt: 1,
      updatedAt: 1,
      versions: [],
    });
    await old.folders.insert({ name: "mig-recovery", createdAt: 1 });
    await old.close();

    // the update lands, a second tab interrupts the migration → ERROR status docs
    await poisonMigrationStatus([
      { name: "articles", to: 3 },
      { name: "folders", to: 1 },
    ]);

    // the app's own open path must walk through DM4 → clear → re-migrate → rescue
    const { getDb, clearStuckMigrationStatuses } = await import("$lib/client/coding-db");
    const db = await getDb();
    const art = await db.articles.findOne("stranded-1").exec();
    expect(art?.toJSON().text).toBe("rescued text");
    expect(art?.toJSON().folder).toBe("");
    const folder = await db.folders.findOne("mig-recovery").exec();
    expect(folder?.toJSON().subs).toEqual([]);

    // the poison is gone (a cancelled first attempt can write its ERROR late) and
    // the spent old tables were removed (no resurrection later)
    await expect.poll(() => clearStuckMigrationStatuses(), { timeout: 15000 }).toBe(0);
    // the spent tables are emptied in place (deleting the database would block on the
    // migration's own open connection) — a reload can no longer resurrect from them
    for (const n of ["rxdb-dexie-luci-coding--2--articles", "rxdb-dexie-luci-coding--0--folders"]) {
      await expect
        .poll(
          () =>
            new Promise<number>((res) => {
              const req = indexedDB.open(n);
              req.onupgradeneeded = () => {
                req.transaction?.abort();
                req.result.close();
                res(0);
              };
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("docs")) {
                  db.close();
                  res(0);
                  return;
                }
                const count = db.transaction("docs", "readonly").objectStore("docs").count();
                count.onsuccess = () => {
                  db.close();
                  res(count.result);
                };
                count.onerror = () => {
                  db.close();
                  res(-1);
                };
              };
              req.onerror = () => res(-1);
            }),
          { timeout: 10000 },
        )
        .toBe(0);
    }

    const { resetArticles } = await import("./fixtures");
    await resetArticles();
  }, 60000);
});
