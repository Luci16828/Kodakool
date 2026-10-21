import { beforeEach, describe, expect, it } from "vitest";
import {
  createFolder,
  exportDatabase,
  exportProject,
  getArticleByName as getArticle,
  getLocalCatalog,
  getPdfData,
  importDatabase,
  listFolders,
  readCodes,
  saveLocalCatalog,
  savePdfData,
  type StoreBlob,
} from "$lib/local/local-api";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";
import type { CodeEntry } from "$lib/coding/types";

const FOLDER = "test";
const NAME = "spd 1";
const TEXT = "Ein Zitat im Text.";
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

/** JSON columns of the export's document rows are raw strings (the server's storage) */
function jsonOf(cell: string | undefined): unknown[] {
  return JSON.parse(cell ?? "[]") as unknown[];
}

describe("database export/import", () => {
  beforeEach(async () => {
    await resetArticles();
  });

  it("exports every document, entry, PDF and catalog override", async () => {
    const id = await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry],
      versions: ["snap"],
    });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await createFolder("archive");

    const dump = (await exportDatabase()) as StoreBlob;
    expect(dump.version).toBe(1);
    expect(dump.documents).toHaveLength(1);
    expect(jsonOf(dump.documents[0].versions)).toHaveLength(1);
    expect(jsonOf(dump.documents[0].codes)).toHaveLength(1);
    expect(dump.catalogs.map((c) => JSON.parse(c.data))).toEqual([testInstructions]);
    expect(dump.pdfs).toHaveLength(1);
    expect(dump.projects.map((p) => p.name)).toContain("archive");
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
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await seedArticle({ project: "other", name: "foreign doc", text: "x" });
    await createFolder(FOLDER);
    await createFolder("archive");

    const dump = await exportProject(FOLDER);
    expect(dump.version).toBe(1);
    expect(dump.projects.map((p) => p.name)).toEqual([FOLDER]);
    expect(dump.documents.map((d) => d.name)).toEqual([NAME]);
    expect(jsonOf(dump.documents[0].codes)).toHaveLength(1);
    expect(dump.catalogs.map((c) => JSON.parse(c.data))).toEqual([testInstructions]);
    expect(dump.pdfs).toHaveLength(1);

    // a project blob is a valid StoreBlob subset: importDatabase accepts it (replace-import)
    const counts = dump.documents.length;
    await importDatabase(dump);
    expect(counts).toBe(1);
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle("other", "foreign doc")).toBeNull();
  });

  it("re-imports a dump into a wiped database", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    await saveLocalCatalog(FOLDER, testInstructions);
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"));
    await createFolder("archive");
    const dump = (await exportDatabase()) as StoreBlob;

    await resetArticles();
    expect(await getArticle(FOLDER, NAME)).toBeNull();

    await importDatabase(dump);
    expect((await listFolders()).sort()).toEqual(["archive", "test"]);

    const art = await getArticle(FOLDER, NAME);
    expect(art?.text).toBe(TEXT);
    const codes = await readCodes(art?.id ?? "");
    expect(codes.map((c) => c.device)).toEqual([DEVICE_QUOTE]);
    expect((await getLocalCatalog(FOLDER))?.title).toBe("Test catalog");
    expect(await getPdfData(id)).toBeTruthy();
  });

  it("import replaces the store wholesale (the UI merges by id on top)", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    const dump = (await exportDatabase()) as StoreBlob;

    await seedArticle({ project: FOLDER, name: "second", text: "other" });
    await importDatabase(dump);

    // the imported snapshot wins: the document created after the export is gone
    expect(await getArticle(FOLDER, NAME)).toBeTruthy();
    expect(await getArticle(FOLDER, "second")).toBeNull();
    expect(id).toBeTruthy();
  });

  it("rejects a foreign blob", async () => {
    await expect(importDatabase({ kind: "something-else", articles: [] })).rejects.toThrow(
      /unsupported import version/,
    );
    await expect(importDatabase(null)).rejects.toThrow(/import blob must be an object/);
  });
});
