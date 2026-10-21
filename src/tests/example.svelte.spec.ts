import { beforeEach, describe, expect, it } from "vitest";
import { getArticleByName as getArticle, getLocalCatalog, listFolders, readCodes } from "$lib/local/local-api";
import { EXAMPLE_DOC, EXAMPLE_PROJECT, seedExampleProject } from "$lib/client/examples";
import { deleteFolder } from "$lib/local/local-api";
import { resetArticles } from "./fixtures";

/**
 * The bundled example project (src/lib/assets/examples/) seeds the local RxDB
 * store once per browser profile: folder + article + entries + catalog.
 */
describe("example project seed", () => {
  beforeEach(async () => {
    localStorage.removeItem("luci-example-seeded");
    await resetArticles();
  });

  it("seeds the example folder, article, entries and catalog", async () => {
    expect(await seedExampleProject()).toBe(true);

    const article = await getArticle(EXAMPLE_PROJECT, EXAMPLE_DOC);
    expect(article).not.toBeNull();
    expect(article!.text).toContain("Demo für alle");
    expect((await readCodes(article!.id)).length).toBeGreaterThan(100);
    expect(await listFolders()).toContain(EXAMPLE_PROJECT);

    const catalog = await getLocalCatalog(EXAMPLE_PROJECT);
    expect(catalog?.devices.length).toBeGreaterThan(0);
  });

  it("runs at most once per profile and never resurrects a deleted example", async () => {
    await seedExampleProject();
    expect(await seedExampleProject()).toBe(false);

    const article = await getArticle(EXAMPLE_PROJECT, EXAMPLE_DOC);
    await deleteFolder(EXAMPLE_PROJECT);
    expect(await getArticle(EXAMPLE_PROJECT, EXAMPLE_DOC)).toBeNull();

    expect(await seedExampleProject()).toBe(false);
    expect(await getArticle(EXAMPLE_PROJECT, EXAMPLE_DOC)).toBeNull();
  });
});
