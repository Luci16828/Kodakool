import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import Dashboard from "../routes/+page.svelte";
import { exportDatabase, getArticle, listArticles, listFolders, saveLocalCatalog } from "$lib/client/coding-db";
import { resetArticles, seedArticle, testInstructions } from "./fixtures";

function renderDashboard() {
  return render(Dashboard, {}, { wrapper: ColorProvider });
}

const chip = (text: string) => page.getByText(text, { exact: false }).first();

beforeEach(async () => {
  await resetArticles();
});

describe("project screen", () => {
  it("lists projects with their document, code and version counts", async () => {
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
    await expect.element(page.getByText("2 documents", { exact: true }).first()).toBeInTheDocument();
    await expect.element(page.getByText("2 codes", { exact: true }).first()).toBeInTheDocument();
  });

  it("shows the empty state while there are no projects", async () => {
    renderDashboard();

    await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
  });

  it("links each project card to its project page", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Text" });

    renderDashboard();

    await expect.element(page.getByRole("link", { name: "test", exact: true })).toBeInTheDocument();
    const link = await page.getByRole("link", { name: "test", exact: true }).element();
    expect(link.getAttribute("href")).toBe("/project/test");
  });

  it("enters a project without listing its documents on the card", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Text" });
    await seedArticle({ project: "test", name: "spd 2", text: "Text" });

    renderDashboard();

    // the card is the way in: no document rows, no per-project document creation
    await expect.element(page.getByRole("link", { name: "test", exact: true })).toBeInTheDocument();
    expect(document.querySelectorAll(".card li")).toHaveLength(0);
    expect(document.querySelectorAll(".card .go")).toHaveLength(0);
    expect(document.querySelectorAll(".card")).toHaveLength(1);
  });

  it("offers a .qdc export only for projects with a frame-device catalog", async () => {
    await seedArticle({ project: "test", name: "coded", text: "Text" });
    await seedArticle({ project: "other", name: "plain", text: "Text" });
    await saveLocalCatalog("test", testInstructions);

    renderDashboard();

    await expect.element(page.getByRole("button", { name: "Export .qdc" })).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".export").length).toBe(1);
  });

  it("creates a project through the new-project input", async () => {
    renderDashboard();

    await page.getByRole("button", { name: "New project" }).click();
    const input = (await page.getByLabelText("New project name").element()) as HTMLInputElement;
    input.value = "research";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.getByRole("button", { name: "Create" }).click();

    await expect.element(page.getByRole("heading", { level: 2 }).first()).toHaveTextContent("research");
    await expect.element(page.getByText("Empty project")).toBeInTheDocument();
  });

  it("creates projects past the declared 200-char limit (maxLength is not enforced)", async () => {
    renderDashboard();

    const long = "f".repeat(250);
    await page.getByRole("button", { name: "New project" }).click();
    const input = (await page.getByLabelText("New project name").element()) as HTMLInputElement;
    input.value = long;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.getByRole("button", { name: "Create" }).click();

    await expect.poll(async () => (await listFolders()).includes(long)).toBe(true);
  });

  it("deletes a project with its documents through the timed confirm dialog", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Ein Artikel." });

    renderDashboard();

    await page.getByRole("button", { name: "Menu for project test" }).click();
    await page.getByRole("menuitem", { name: "Delete project" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete project test/?" });
    await expect.element(dialog).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: /Confirm/ });
    // the confirm button starts disabled with a visible countdown
    await expect.element(confirm).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "Confirm" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(async () => (await listArticles()).length).toBe(0);
    await expect.element(page.getByText("No projects yet")).toBeInTheDocument();
  });

  it("opens the project card's context menu on right click", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Ein Artikel." });
    await saveLocalCatalog("test", testInstructions);

    renderDashboard();
    await expect.element(page.getByRole("link", { name: "test", exact: true })).toBeInTheDocument();

    const card = document.querySelector(".card") as HTMLElement;
    const r = card.getBoundingClientRect();
    card.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(r.left + 30),
        clientY: Math.round(r.top + 10),
      }),
    );

    const menu = page.getByRole("menu");
    await expect.element(menu).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "Open project" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "Export .qdc" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "Delete project" })).toBeInTheDocument();
  });

  it("offers database export/import and re-imports a dump", async () => {
    await seedArticle({ project: "test", name: "spd 1", text: "Ein Artikel." });
    const dump = JSON.stringify(await exportDatabase());

    await resetArticles();
    renderDashboard();

    await expect.element(page.getByRole("button", { name: "Database" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Import DB" })).toBeInTheDocument();

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
});
