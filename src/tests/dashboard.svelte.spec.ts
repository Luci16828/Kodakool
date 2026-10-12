import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import Dashboard from "../routes/+page.svelte";
import { exportDatabase, getArticle, listArticles, saveLocalCatalog } from "$lib/client/coding-db";
import { resetArticles, seedArticle, testInstructions } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

function renderDashboard() {
  return render(Dashboard, {}, { wrapper: ColorProvider });
}

const chip = (text: string) => page.getByText(text, { exact: false }).first();

beforeEach(async () => {
  navigated.length = 0;
  await resetArticles();
});

describe("project screen", () => {
  it("lists projects with their documents and code counts", async () => {
    await seedArticle({
      project: "test",
      name: "spd 1",
      text: "Ein Artikel.",
      entries: [
        { line: 1, range: [0, 3], excerpt: "Ein", code: "1.1" },
        { line: 1, range: [4, 12], excerpt: " Artikel", code: "2" },
      ],
    });
    await seedArticle({ project: "test", name: "spd 2", text: "", versions: ["first"] });

    renderDashboard();

    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("Kodakool");
    await expect.element(chip("1 projects")).toBeInTheDocument();
    await expect.element(chip("2 documents")).toBeInTheDocument();
    await expect.element(chip("2 codes")).toBeInTheDocument();
    await expect.element(chip("1 versions")).toBeInTheDocument();

    await expect.element(page.getByRole("heading", { level: 2 }).first()).toHaveTextContent("test");
    await expect.element(page.getByRole("link", { name: /spd 1/ })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: /spd 2/ })).toBeInTheDocument();
    await expect.element(page.getByText("2", { exact: true }).first()).toBeInTheDocument();
  });

  it("shows the empty state while there are no projects", async () => {
    renderDashboard();

    await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
  });

  it("links each document to its coding page", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Text" });

    renderDashboard();

    await expect.element(page.getByRole("link", { name: /spd 1/ })).toBeInTheDocument();
    const link = await page.getByRole("link", { name: /spd 1/ }).element();
    expect(link.getAttribute("href")).toBe("/text/test/spd 1");
  });

  it("offers a .qdc export only for projects with a frame-device catalog", async () => {
    await seedArticle({ project: "test", name: "coded", text: "Text" });
    await seedArticle({ project: "other", name: "plain", text: "Text" });
    await saveLocalCatalog("test", testInstructions);

    renderDashboard();

    await expect.element(page.getByRole("button", { name: "export .qdc" })).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".export").length).toBe(1);
  });

  it("creates a new document in the project and opens it", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Text" });

    renderDashboard();

    await page.getByRole("button", { name: "new document in test" }).click();

    await expect.element(page.getByRole("link", { name: "Untitled 1" })).toBeInTheDocument();
    expect(navigated).toEqual(["/text/test/Untitled 1"]);
    expect((await listArticles()).map((a) => a.project)).toEqual(["test", "test"]);
    expect((await getArticle("test", "Untitled 1"))?.name).toBe("Untitled 1");
  });

  it("creates a project through the new-project input", async () => {
    renderDashboard();

    await page.getByRole("button", { name: "new project" }).click();
    const input = (await page.getByLabelText("new project name").element()) as HTMLInputElement;
    input.value = "research";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.getByRole("button", { name: "create" }).click();

    await expect.element(page.getByRole("heading", { level: 2 }).first()).toHaveTextContent("research");
    await expect.element(page.getByText("Empty project")).toBeInTheDocument();
  });

  it("deletes a project with its documents through the timed confirm dialog", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Ein Artikel." });

    renderDashboard();

    await page.getByRole("button", { name: "delete project test" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete project test/?" });
    await expect.element(dialog).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: /confirm/ });
    // the confirm button starts disabled with a visible countdown
    await expect.element(confirm).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "confirm" })).toBeEnabled();
    await dialog.getByRole("button", { name: "confirm" }).click();

    await expect.poll(async () => (await listArticles()).length).toBe(0);
    await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
  });

  it("offers database export/import and re-imports a dump", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Ein Artikel." });
    const dump = JSON.stringify(await exportDatabase());

    await resetArticles();
    renderDashboard();

    await expect.element(page.getByRole("button", { name: "database" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "import db" })).toBeInTheDocument();

    const input = document.querySelector(".dbfile") as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File([dump], "kodakool-db.json", { type: "application/json" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.poll(async () => (await getArticle("test", "spd 1"))?.text).toBe("Ein Artikel.");
    await expect.element(page.getByText(/imported 1 documents/).first()).toBeInTheDocument();
  });

  it("reports a database import that is not a Kodakool export", async () => {
    renderDashboard();

    const input = document.querySelector(".dbfile") as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify({ kind: "something-else" })], "foreign.json", { type: "application/json" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect
      .poll(() => document.querySelector(".dbmsg")?.textContent ?? "")
      .toMatch(/import failed: not a luci-bachelor database export/);
    expect((await listArticles()).length).toBe(0);
  });

  it("names new documents past an existing Untitled N without collision", async () => {
    await seedArticle({ project: "test", name: "Untitled 2", text: "x" });

    renderDashboard();

    await page.getByRole("button", { name: "new document in test" }).click();

    // max existing "Untitled 2" → the next free name is "Untitled 3"
    await expect.poll(async () => (await getArticle("test", "Untitled 3"))?.name).toBe("Untitled 3");
    expect(await getArticle("test", "Untitled 1")).toBeNull();
  });
});
