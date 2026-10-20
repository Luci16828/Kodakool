import { beforeEach, describe, expect, it } from "vitest";
import {
  createFolder,
  exportDatabase,
  exportProject,
  getArticle,
  getLocalCatalog,
  getPdfData,
  importDatabase,
  listFolders,
  readCodes,
  saveLocalCatalog,
  savePdfData,
} from "$lib/client/coding-db";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";
import type { CodeEntry } from "$lib/coding/types";

const FOLDER = "test";
const NAME = "spd 1";
const TEXT = "Ein Zitat im Text.";
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

describe("database export/import", () => {
  beforeEach(async () => {
    await resetArticles();
  });

  it("exports every article, entry, PDF and catalog override", async () => {
    const id = await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry],
      versions: ["snap"],
    });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"), 1);
    await createFolder("archive");

    const dump = await exportDatabase();
    expect(dump.kind).toBe("luci-bachelor-db");
    expect(dump.articles).toHaveLength(1);
    expect(dump.articles[0].versions).toHaveLength(1);
    expect(dump.codes).toHaveLength(1);
    expect(dump.catalogs).toEqual([{ folder: FOLDER, instructions: testInstructions }]);
    expect(dump.pdfs).toHaveLength(1);
    expect(dump.folders.map((f) => f.name)).toEqual(["archive"]);
  });

  it("exports only the requested project's documents, entries, PDFs, catalog and folder", async () => {
    const id = await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry],
      versions: ["snap"],
    });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"), 1);
    await seedArticle({ project: "other", name: "foreign doc", text: "x" });
    await createFolder(FOLDER);
    await createFolder("archive");

    const dump = await exportProject(FOLDER);
    expect(dump.kind).toBe("luci-bachelor-db");
    expect(dump.articles.map((a) => a.project)).toEqual([FOLDER]);
    expect(dump.codes).toHaveLength(1);
    expect(dump.catalogs).toEqual([{ folder: FOLDER, instructions: testInstructions }]);
    expect(dump.pdfs).toHaveLength(1);
    expect(dump.folders.map((f) => f.name)).toEqual([FOLDER]);

    // a project blob is a valid DatabaseExport subset: importDatabase accepts it unchanged
    await resetArticles();
    const counts = await importDatabase(dump);
    expect(counts).toEqual({ articles: 1, codes: 1, catalogs: 1, pdfs: 1, folders: 1 });
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle("other", "foreign doc")).toBeNull();
  });

  it("re-imports a dump into a wiped database", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"), 1);
    await createFolder("archive");
    const dump = await exportDatabase();

    await resetArticles();
    expect(await getArticle(FOLDER, NAME)).toBeNull();

    const counts = await importDatabase(dump);
    expect(counts).toEqual({ articles: 1, codes: 1, catalogs: 1, pdfs: 1, folders: 1 });
    expect(await listFolders()).toEqual(["archive"]);

    const art = await getArticle(FOLDER, NAME);
    expect(art?.text).toBe(TEXT);
    const codes = await readCodes(art?.id ?? "");
    expect(codes.map((c) => c.device)).toEqual([DEVICE_QUOTE]);
    expect((await getLocalCatalog(FOLDER))?.title).toBe("Test catalog");
    expect(await getPdfData(id)).toBeTruthy();
  });

  it("merges an import over newer local copies by id", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    const dump = await exportDatabase();

    await seedArticle({ project: FOLDER, name: "second", text: "other" });
    const counts = await importDatabase(dump);
    expect(counts.articles).toBe(1);

    // both the imported doc and the one created after the export are present
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle(FOLDER, "second")).toBeTruthy();
    expect(id).toBeTruthy();
  });

  it("rejects a foreign blob", async () => {
    await expect(importDatabase({ kind: "something-else", articles: [] })).rejects.toThrow(
      /not a luci-bachelor database export/,
    );
    await expect(importDatabase(null)).rejects.toThrow(/not a luci-bachelor database export/);
  });
});
