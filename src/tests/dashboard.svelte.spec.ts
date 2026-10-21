import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import Root from "../routes/+page.svelte";
import {
  createFolder,
  exportDatabase,
  getArticleByName as getArticle,
  listFolders,
  saveLocalCatalog,
} from "$lib/local/local-api";
import { resetArticles, seedArticle, testInstructions, uploadTo } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

const FOLDER = "test";
const TEXT = "Ein Zitat im Text.";

function renderRoot() {
  return render(Root, {}, { wrapper: ColorProvider });
}

/** the coding page records the document it opens here; the root reopens it */
function setLastDoc(folder: string, name: string): void {
  localStorage.setItem("luci-last-doc", JSON.stringify({ folder, name }));
}

async function uploadDbFile(dump: string): Promise<void> {
  uploadTo(".dbfile", new File([dump], "kodakool-db.json", { type: "application/json" }));
}

beforeEach(async () => {
  navigated.length = 0;
  localStorage.removeItem("luci-last-doc");
  // the root page seeds the example itself: mark the profile as already seeded
  // (the once-per-profile flag), so the store is exactly what each test seeds
  localStorage.setItem("luci-example-seeded", "1");
  await resetArticles();
});

describe("root page — opening the app", () => {
  it("opens the last document the coding page recorded", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "a" });
    await seedArticle({ project: FOLDER, name: "spd 2", text: "b" });
    setLastDoc(FOLDER, "spd 2");

    renderRoot();

    await expect.poll(() => navigated).toEqual(["/text/test/spd 2"]);
  });

  it("falls back to the first document when the last opened one no longer exists", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "a" });
    await seedArticle({ project: FOLDER, name: "spd 2", text: "b" });
    setLastDoc(FOLDER, "deleted doc");

    renderRoot();

    await expect.poll(() => navigated).toEqual(["/text/test/spd 1"]);
  });

  it("falls back to the first document (project, then name) on a fresh profile", async () => {
    await seedArticle({ project: "test", name: "zeta", text: "a" });
    await seedArticle({ project: "archive", name: "note", text: "b" });

    renderRoot();

    await expect.poll(() => navigated).toEqual(["/text/archive/note"]);
  });

  it("shows the start screen with an empty database", async () => {
    renderRoot();

    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(navigated).toEqual([]);
  });

  it("creates a project through the new-project input and opens its first document", async () => {
    renderRoot();
    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();

    await page.getByRole("button", { name: "New project" }).click();
    const input = (await page.getByLabelText("New project name").element()) as HTMLInputElement;
    input.value = "research";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.getByRole("button", { name: "Create" }).click();

    // the fresh project's default document opens right away (markdown by default)
    await expect.poll(() => navigated).toEqual(["/text/research/Untitled 1.md"]);
    expect((await getArticle("research", "Untitled 1.md"))?.name).toBe("Untitled 1.md");
  });

  it("creates a document in an existing project straight from the start screen", async () => {
    // a registered folder WITHOUT documents: the start screen offers it
    await createFolder("archive");

    renderRoot();
    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /New document in archive/ })).toBeInTheDocument();
    await page.getByRole("button", { name: /New document in archive/ }).click();
    await expect.poll(() => navigated).toEqual(["/text/archive/Untitled 1.md"]);
  });

  it("hosts the colors dialog on the start screen", async () => {
    renderRoot();
    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();

    await page.getByRole("button", { name: "Colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "Colors" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("base color")).toBeInTheDocument();
    await page.getByRole("button", { name: "Close colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "Colors" })).not.toBeInTheDocument();
  });
});

describe("root page — database", () => {
  it("offers database export/import and re-imports a dump", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });
    await saveLocalCatalog(FOLDER, testInstructions);
    const dump = JSON.stringify(await exportDatabase());

    await resetArticles();
    renderRoot();
    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();

    await uploadDbFile(dump);

    await expect.poll(async () => (await getArticle(FOLDER, "spd 1"))?.text).toBe(TEXT);
    await expect.element(page.getByText(/imported 1 documents/).first()).toBeInTheDocument();
  });

  it("reports a database import that is not a Kodakool export", async () => {
    renderRoot();
    await expect.element(page.getByText("Nothing open yet")).toBeInTheDocument();

    await uploadDbFile(JSON.stringify({ kind: "something-else" }));

    await expect
      .poll(() => document.querySelector(".dbmsg")?.textContent ?? "")
      .toMatch(/import failed: not a luci-bachelor database export/);
    expect((await listFolders()).length).toBe(0);
  });
});
