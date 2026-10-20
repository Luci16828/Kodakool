import { beforeEach, describe, expect, it } from "vitest";
import {
  createSubfolder,
  deleteSubfolder,
  duplicateArticle,
  exportDatabase,
  getArticle,
  getArticleById,
  getDb,
  importDatabase,
  integritySweep,
  listArticles,
  moveArticle,
  moveArticleProject,
  readCodes,
  renameSubfolder,
  savePdfData,
  watchSubfolders,
} from "$lib/client/coding-db";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";
import type { CodeEntry } from "$lib/coding/types";

const FOLDER = "test";
const TEXT = "Ein Zitat im Text.";
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

const subsOf = (project: string): Promise<string[]> =>
  new Promise((res) => {
    const un = watchSubfolders(project, (paths) => {
      un();
      res(paths);
    });
  });

describe("subfolders + file operations", () => {
  beforeEach(async () => {
    await resetArticles();
  });

  it("registers subfolders (nested paths included) on the project doc", async () => {
    await createSubfolder(FOLDER, "sources");
    await createSubfolder(FOLDER, "sources/interviews");
    await createSubfolder(FOLDER, " sources / "); // normalized away
    expect(await subsOf(FOLDER)).toEqual(["sources", "sources/interviews"]);
  });

  it("moves documents into subfolders and back to the root", async () => {
    const id = await seedArticle({ project: FOLDER, name: "a", text: TEXT });
    await createSubfolder(FOLDER, "sources");
    await moveArticle(id, "sources");
    expect((await listArticles()).find((a) => a.id === id)?.folder).toBe("sources");
    await moveArticle(id, "no/such/folder"); // unregistered paths are fine — the tree synthesizes them
    expect((await listArticles()).find((a) => a.id === id)?.folder).toBe("no/such/folder");
    await moveArticle(id, "");
    expect((await listArticles()).find((a) => a.id === id)?.folder).toBe("");
  });

  it("moves a document to another project and rejects name collisions", async () => {
    const id = await seedArticle({ project: FOLDER, name: "a", text: TEXT });
    await seedArticle({ project: "other", name: "taken", text: "x" });
    await moveArticleProject(id, "other");
    const moved = await getArticleById(id);
    expect(moved?.project).toBe("other");
    expect(moved?.folder).toBe("");
    // a name collision on move: the loser reverts to its original project
    const second = await seedArticle({ project: FOLDER, name: "taken", text: "y" });
    await expect(moveArticleProject(second, "other")).rejects.toThrow(/"taken" already exists in other/);
    expect((await getArticleById(second))?.project).toBe(FOLDER);
  });

  it("duplicates a document with its entries and PDF bytes", async () => {
    const id = await seedArticle({ project: FOLDER, name: "a", text: TEXT, entries: [quoteEntry] });
    await savePdfData(id, new TextEncoder().encode("%PDF-1.4 fake"), 1);
    const copy = await duplicateArticle(id);
    expect(copy?.name).toBe("a copy");
    expect((await getArticleById(copy?.id ?? ""))?.text).toBe(TEXT);
    expect((await readCodes(copy?.id ?? "")).map((c) => c.device)).toEqual([DEVICE_QUOTE]);
    const { pdfs } = await getDb();
    expect(await pdfs.findOne(copy?.id ?? "").exec()).toBeTruthy();
    const again = await duplicateArticle(id);
    expect(again?.name).toBe("a copy 2");
    // duplicating the copy strips the suffix: "a copy" → base "a" → "a copy 3"
    expect((await duplicateArticle(copy?.id ?? ""))?.name).toBe("a copy 3");
  });

  it("deleting a subfolder moves its documents (and nested ones) to the root", async () => {
    const a = await seedArticle({ project: FOLDER, name: "a", text: "a" });
    const b = await seedArticle({ project: FOLDER, name: "b", text: "b" });
    await createSubfolder(FOLDER, "sources");
    await createSubfolder(FOLDER, "sources/interviews");
    await moveArticle(a, "sources");
    await moveArticle(b, "sources/interviews");
    await deleteSubfolder(FOLDER, "sources");
    expect((await getArticleById(a))?.folder).toBe("");
    expect((await getArticleById(b))?.folder).toBe("");
    expect(await subsOf(FOLDER)).toEqual([]);
  });

  it("renames a subfolder, rewriting documents + nested subfolders, and rejects taken names", async () => {
    const a = await seedArticle({ project: FOLDER, name: "a", text: "a" });
    await createSubfolder(FOLDER, "src");
    await createSubfolder(FOLDER, "src/deep");
    await createSubfolder(FOLDER, "dst");
    await moveArticle(a, "src/deep");
    await renameSubfolder(FOLDER, "src", "dst/inner");
    expect((await getArticleById(a))?.folder).toBe("dst/inner/deep");
    expect(await subsOf(FOLDER)).toEqual(["dst", "dst/inner", "dst/inner/deep"]);
    await expect(renameSubfolder(FOLDER, "dst/inner", "dst")).rejects.toThrow(/"dst" already exists/);
  });

  it("export + import round-trips folders, subfolders and document paths", async () => {
    const id = await seedArticle({ project: FOLDER, name: "a", text: TEXT, entries: [quoteEntry] });
    await createSubfolder(FOLDER, "sources");
    await moveArticle(id, "sources");
    const dump = await exportDatabase();
    expect(dump.version).toBe(5);
    expect(dump.articles[0].folder).toBe("sources");

    await resetArticles();
    expect(await getArticle(FOLDER, "a")).toBeNull();
    await importDatabase(dump);
    expect((await getArticle(FOLDER, "a"))?.folder).toBe("sources");
    expect(await subsOf(FOLDER)).toEqual(["sources"]);
  });

  it("the sweep normalizes pre-v3 articles and pre-v1 folder docs", async () => {
    const id = await seedArticle({ project: FOLDER, name: "a", text: TEXT });
    const { articles, folders } = await getDb();
    // simulate a pre-v3 store: strip the folder field + the subfolder registry
    const art = await articles.findOne(id).exec();
    await art?.patch({ folder: undefined });
    await createSubfolder(FOLDER, "sources");
    const fd = await folders.findOne(FOLDER).exec();
    await fd?.patch({ subs: undefined });
    await integritySweep();
    expect((await getArticleById(id))?.folder).toBe("");
    expect(await subsOf(FOLDER)).toEqual([]);
  });
});
