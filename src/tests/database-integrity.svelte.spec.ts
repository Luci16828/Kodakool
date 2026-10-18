import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_VERSIONS,
  addVersion,
  createArticle,
  createFolder,
  deleteArticle,
  deleteFolder,
  exportDatabase,
  getArticle,
  getDb,
  getLocalCatalog,
  importDatabase,
  integritySweep,
  listArticles,
  listFolders,
  readCodes,
  removeEntry,
  renameArticle,
  saveArticle,
} from "$lib/client/coding-db";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";
import type { CodeEntry } from "$lib/coding/types";
import type { ArticleData } from "$lib/client/coding-db";

/**
 * Database integrity attacks: hostile import blobs, concurrent writers racing each
 * other, and simulated crash windows. The invariants under test:
 *  - every code/PDF document has a live parent article (no orphans, ever)
 *  - (project, name) stays unique (it is the app's addressing key)
 *  - a broken import never writes anything (no half-imported store)
 *  - a failed/crashed save never loses the previously stored text + entries
 *  - articles always carry a usable `versions` array
 *  - version history is capped (every snapshot stores the full text)
 */

const FOLDER = "test";
const NAME = "spd 1";
const TEXT = "Ein Zitat im Text.";
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };
const otherEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 3], excerpt: "Ein" };

/** export as a plain mutable object so tests can corrupt it */
const dumpOf = async (): Promise<Record<string, unknown>> => JSON.parse(JSON.stringify(await exportDatabase()));

describe("database integrity", () => {
  beforeEach(async () => {
    await resetArticles();
  });

  describe("import hardening", () => {
    it("normalizes an article imported without versions or kind", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const dump = await dumpOf();
      delete (dump.articles as Record<string, unknown>[])[0].versions;
      delete (dump.articles as Record<string, unknown>[])[0].kind;

      await resetArticles();
      await importDatabase(dump);

      const art = await getArticle(FOLDER, NAME);
      expect(art?.versions).toEqual([]);
      expect(art?.kind).toBe("text");
      // the summary/version/save paths that a raw import used to crash
      expect((await listArticles()).find((a) => a.id === id)?.versions).toBe(0);
      await addVersion(id, "after-import");
      expect((await getArticle(FOLDER, NAME))?.versions).toHaveLength(1);
      await saveArticle(id, "new text", [quoteEntry]);
      expect((await getArticle(FOLDER, NAME))?.text).toBe("new text");
      expect(await readCodes(id)).toHaveLength(1);
    });

    it("rejects a malformed codes array without writing anything", async () => {
      await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const dump = await dumpOf();
      dump.codes = "not-an-array";
      await expect(importDatabase(dump)).rejects.toThrow(/codes must be an array/);
      expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    });

    it("rejects malformed code entries before writing any article", async () => {
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [{ id: "imp-art", project: "imp", name: "n", text: "t", createdAt: 1, updatedAt: 1, versions: [] }],
        codes: [{ id: "imp-code", articleId: "imp-art", line: 1, range: [0], excerpt: "x" }],
        catalogs: [],
        pdfs: [],
        folders: [],
      };
      await expect(importDatabase(dump)).rejects.toThrow(/invalid code entry/);
      expect(await getArticle("imp", "n")).toBeNull();
    });

    it("rejects a malformed version snapshot", async () => {
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [
          {
            id: "imp-art",
            project: "imp",
            name: "n",
            text: "t",
            createdAt: 1,
            updatedAt: 1,
            versions: [{ savedAt: "yesterday", text: "t", codes: [] }],
          },
        ],
        codes: [],
        catalogs: [],
        pdfs: [],
        folders: [],
      };
      await expect(importDatabase(dump)).rejects.toThrow(/invalid article version/);
      expect(await getArticle("imp", "n")).toBeNull();
    });

    it("drops codes and PDFs whose article is missing", async () => {
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [],
        codes: [
          { id: "ghost", articleId: "no-such-article", line: 1, range: [0, 1], excerpt: "x", device: DEVICE_QUOTE },
        ],
        catalogs: [],
        pdfs: [{ id: "no-such-article", data: "AAAA", pages: 1, updatedAt: 1 }],
        folders: [],
      };
      const counts = await importDatabase(dump);
      expect(counts.codes).toBe(0);
      expect(counts.pdfs).toBe(0);
      const { codes, pdfs } = await getDb();
      expect(await codes.find().exec()).toHaveLength(0);
      expect(await pdfs.find().exec()).toHaveLength(0);
    });

    it("keeps imported codes whose article already exists locally", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [],
        codes: [{ id: "late-code", articleId: id, line: 1, range: [4, 9], excerpt: "Zitat", device: DEVICE_QUOTE }],
        catalogs: [],
        pdfs: [],
        folders: [],
      };
      const counts = await importDatabase(dump);
      expect(counts.codes).toBe(1);
      expect((await readCodes(id)).map((c) => c.excerpt)).toEqual(["Zitat"]);
    });

    it("rejects a code entry with a non-uuid device (write-boundary contract)", async () => {
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [{ id: "imp-art", project: "imp", name: "n", text: "t", createdAt: 1, updatedAt: 1, versions: [] }],
        codes: [{ id: "imp-code", articleId: "imp-art", line: 1, range: [0, 1], excerpt: "x", device: "not-a-uuid" }],
        catalogs: [],
        pdfs: [],
        folders: [],
      };
      // accepting it would poison the article: every later save re-validates and throws
      await expect(importDatabase(dump)).rejects.toThrow(/invalid code entry/);
      expect(await getArticle("imp", "n")).toBeNull();
    });

    it("imports valid catalogs and skips invalid entries", async () => {
      const dump = {
        kind: "luci-bachelor-db",
        version: 3,
        exportedAt: 1,
        articles: [],
        codes: [],
        catalogs: [
          { folder: "good", instructions: testInstructions },
          { folder: "bad", instructions: { nope: 1 } },
          "junk",
        ],
        pdfs: [],
        folders: [],
      };
      const counts = await importDatabase(dump);
      expect(counts.catalogs).toBe(1);
      expect((await getLocalCatalog("good"))?.title).toBe("Test catalog");
      expect(await getLocalCatalog("bad")).toBeNull();
    });

    it("rejects a non-array folders list", async () => {
      await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const dump = await dumpOf();
      dump.folders = { name: "obj" };
      await expect(importDatabase(dump)).rejects.toThrow(/folders must be an array/);
      expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    });
  });

  describe("integrity sweep", () => {
    it("removes orphan codes and PDFs and keeps real data", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      const { codes, pdfs } = await getDb();
      await codes.bulkUpsert([{ id: "ghost", articleId: "missing-article", line: 1, range: [0, 1], excerpt: "x" }]);
      await pdfs.bulkUpsert([{ id: "ghost-pdf", data: "AAAA", pages: 1, updatedAt: 1 }]);

      const removed = await integritySweep();
      expect(removed).toEqual({ codes: 1, pdfs: 1 });
      expect(await getArticle(FOLDER, NAME)).toBeTruthy();
      expect(await readCodes(id)).toHaveLength(1);
      const { codes: c2, pdfs: p2 } = await getDb();
      expect(await c2.find().exec()).toHaveLength(1);
      expect(await p2.find().exec()).toHaveLength(0);
    });

    it("removes malformed code entries the JSON schema let through", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      const { codes } = await getDb();
      // range arity is not schema-enforced: a legacy store can hold a one-sided range
      await codes.bulkUpsert([
        { id: "broken", articleId: id, line: 1, range: [4] as unknown as [number, number], excerpt: "Zitat" },
      ]);
      expect(await codes.find({ selector: { articleId: id } }).exec()).toHaveLength(2);

      const removed = await integritySweep();
      expect(removed.codes).toBe(1);
      expect((await readCodes(id)).map((c) => c.excerpt)).toEqual(["Zitat"]);
    });

    it("removes entries that fail the write-boundary contract and poisoned versions", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      const { articles, codes } = await getDb();
      // the JSON schema accepts any string device — a uuid-violating entry makes every
      // later save throw; a poisoned version does the same after a revert
      await codes.bulkUpsert([
        { id: "poison", articleId: id, line: 1, range: [0, 3], excerpt: "Ein", device: "not-a-uuid" },
      ]);
      await articles
        .findOne(id)
        .exec()
        .then((d) =>
          d?.patch({
            versions: [
              { savedAt: 1, text: TEXT, codes: [{ line: 1, range: [4, 9], excerpt: "Zitat", device: "not-a-uuid" }] },
              { savedAt: 2, text: TEXT, codes: [quoteEntry] },
            ],
          }),
        );

      const removed = await integritySweep();
      expect(removed.codes).toBe(1);
      expect(await readCodes(id)).toHaveLength(1);
      const art = await getArticle(FOLDER, NAME);
      expect(art?.versions).toHaveLength(1);
      expect(art?.versions[0].codes.map((c) => c.excerpt)).toEqual(["Zitat"]);
      // the article is savable again
      await saveArticle(id, TEXT, [quoteEntry]);
      expect((await getArticle(FOLDER, NAME))?.text).toBe(TEXT);
    });

    it("gives pre-graph snapshots an id and a linear parent chain", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const { articles } = await getDb();
      // a store from before snapshots were graph nodes: no id, no parent
      await articles
        .findOne(id)
        .exec()
        .then((d) =>
          d?.patch({
            versions: [
              { savedAt: 1, text: "a", codes: [] },
              { savedAt: 2, text: "b", codes: [] },
              { savedAt: 3, text: "c", codes: [] },
            ],
          }),
        );

      await integritySweep();
      const vers = (await getArticle(FOLDER, NAME))!.versions;
      expect(new Set(vers.map((v) => v.id)).size).toBe(3);
      expect(vers.map((v) => v.parent)).toEqual([null, vers[0].id, vers[1].id]);

      // the repaired history is addressable: a snapshot hangs on the node it was told to
      const fork = await addVersion(id, "fork", vers[0].id);
      expect(fork?.parent).toBe(vers[0].id);
      expect((await getArticle(FOLDER, NAME))!.versions.at(-1)?.label).toBe("fork");
    });

    it("roots a snapshot whose parent the version cap dropped", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      const { articles } = await getDb();
      await articles
        .findOne(id)
        .exec()
        .then((d) =>
          d?.patch({
            versions: [
              { id: "n1", savedAt: 1, text: "a", codes: [], parent: "dropped-by-the-cap" },
              { id: "n2", savedAt: 2, text: "b", codes: [], parent: "n1" },
            ],
          }),
        );

      await integritySweep();
      const vers = (await getArticle(FOLDER, NAME))!.versions;
      // the dangling link becomes a root, the rest of the chain survives untouched
      expect(vers.map((v) => [v.id, v.parent])).toEqual([
        ["n1", null],
        ["n2", "n1"],
      ]);
    });

    it("normalizes an article missing versions and kind", async () => {
      // a store written by an older app version: versions/kind are not schema-required
      const { articles } = await getDb();
      const legacy = { id: "nv1", project: "nv", name: "doc", text: "t", createdAt: 1, updatedAt: 1 };
      await articles.insert(legacy as unknown as ArticleData);

      await integritySweep();
      const art = await getArticle("nv", "doc");
      expect(art?.versions).toEqual([]);
      expect(art?.kind).toBe("text");
      await addVersion("nv1", "v");
      expect((await getArticle("nv", "doc"))?.versions).toHaveLength(1);
    });
  });

  describe("concurrent writers", () => {
    it("parallel document creation yields unique names", async () => {
      const created = await Promise.all([createArticle(FOLDER), createArticle(FOLDER), createArticle(FOLDER)]);
      const names = created.map((c) => c.name);
      expect(new Set(names).size).toBe(3);
      const { articles } = await getDb();
      for (const n of names) {
        expect(await articles.find({ selector: { project: FOLDER, name: n } }).exec()).toHaveLength(1);
      }
      for (const c of created) expect((await getArticle(FOLDER, c.name))?.id).toBe(c.id);
    });

    it("parallel rename to the same name keeps (project, name) unique", async () => {
      const a = await seedArticle({ project: FOLDER, name: "a", text: "1" });
      const b = await seedArticle({ project: FOLDER, name: "b", text: "2" });
      const results = await Promise.allSettled([renameArticle(a, "x"), renameArticle(b, "x")]);
      const won = results.filter((r) => r.status === "fulfilled").length;
      expect(won).toBeLessThanOrEqual(1);
      const { articles } = await getDb();
      const docs = await articles.find().exec();
      expect(docs.filter((d) => d.name === "x")).toHaveLength(won);
      expect(new Set(docs.map((d) => d.name)).size).toBe(2);
    });

    it("parallel project creation is idempotent", async () => {
      await Promise.all([createFolder("dup"), createFolder("dup"), createFolder("dup")]);
      expect(await listFolders()).toEqual(["dup"]);
    });

    it("a save racing a delete leaves no orphan codes", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      await Promise.all([saveArticle(id, `${TEXT} edited`, [quoteEntry, otherEntry]), deleteArticle(id)]);
      expect(await getArticle(FOLDER, NAME)).toBeNull();
      const { codes } = await getDb();
      expect(await codes.find({ selector: { articleId: id } }).exec()).toHaveLength(0);
    });

    it("a save racing a project delete leaves no residue", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      await Promise.all([saveArticle(id, TEXT, [quoteEntry, otherEntry]), deleteFolder(FOLDER)]);
      expect(await getArticle(FOLDER, NAME)).toBeNull();
      expect(await listFolders()).not.toContain(FOLDER);
      const { codes, articles } = await getDb();
      expect(await codes.find().exec()).toHaveLength(0);
      expect(await articles.find().exec()).toHaveLength(0);
    });

    it("deleteArticle tolerates concurrent entry removals", async () => {
      const entries: CodeEntry[] = [
        quoteEntry,
        otherEntry,
        { device: DEVICE_QUOTE, line: 1, range: [10, 12], excerpt: "Text" },
      ];
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries });
      await Promise.all([deleteArticle(id), ...entries.map((e) => removeEntry(id, e))]);
      expect(await getArticle(FOLDER, NAME)).toBeNull();
      expect(await readCodes(id)).toHaveLength(0);
    });
  });

  describe("crash windows", () => {
    it("a failed save keeps the previous text and entries intact", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      // schema-invalid entry (range is not a pair): the write must fail BEFORE
      // deleting anything existing, so the stored state survives untouched
      const bad = { device: DEVICE_QUOTE, line: 1, range: [4], excerpt: "Zitat" } as unknown as CodeEntry;
      await expect(saveArticle(id, "rewritten", [bad])).rejects.toThrow();
      expect((await getArticle(FOLDER, NAME))?.text).toBe(TEXT);
      expect((await readCodes(id)).map((c) => c.excerpt)).toEqual(["Zitat"]);
    });

    it("a save with an inconsistent entry (endLine < line) is rejected intact", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      const bad: CodeEntry = { device: DEVICE_QUOTE, line: 2, endLine: 1, range: [0, 3], excerpt: "Ein" };
      await expect(saveArticle(id, "rewritten", [bad])).rejects.toThrow();
      expect((await getArticle(FOLDER, NAME))?.text).toBe(TEXT);
      expect((await readCodes(id)).map((c) => c.excerpt)).toEqual(["Zitat"]);
    });

    it("a late save for a deleted article sweeps the leaked codes", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
      await deleteArticle(id);
      // a stale tab's autosave flush landing after the delete
      await saveArticle(id, TEXT, [quoteEntry, otherEntry]);
      const { codes } = await getDb();
      expect(await codes.find({ selector: { articleId: id } }).exec()).toHaveLength(0);
    });
  });

  describe("version history", () => {
    it("caps the version history and keeps the newest snapshots", async () => {
      const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
      for (let i = 0; i < MAX_VERSIONS + 5; i++) await addVersion(id, `v${i}`);
      const art = await getArticle(FOLDER, NAME);
      expect(art?.versions).toHaveLength(MAX_VERSIONS);
      expect(art?.versions.at(-1)?.label).toBe(`v${MAX_VERSIONS + 4}`);
      expect(art?.versions[0]?.label).toBe("v5");
    });
  });
});
