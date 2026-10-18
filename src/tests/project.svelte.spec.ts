import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ProjectPage from "../routes/project/[folder]/+page.svelte";
import { getArticle, listArticles, saveLocalCatalog } from "$lib/client/coding-db";
import { resetArticles, seedArticle, testInstructions } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

const FOLDER = "test";
const TEXT = "Ein Zitat im Text.";

let lastRender: ReturnType<typeof render> | undefined;

function renderProject(folder = FOLDER) {
  lastRender = render(ProjectPage, { data: { folder } }, { wrapper: ColorProvider });
  return lastRender;
}

/** the hidden folder-picker input every upload goes through */
function uploadInput(): HTMLInputElement {
  return document.querySelector(".upfolder input") as HTMLInputElement;
}

async function upload(...files: File[]): Promise<void> {
  const input = uploadInput();
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** shared countdown dialog: confirm only becomes enabled after the 3s timer */
async function confirmDelete(name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name });
  await expect.element(dialog).toBeInTheDocument();
  await expect
    .poll(() => (dialog.getByRole("button", { name: "confirm" }).element() as HTMLButtonElement).disabled, {
      timeout: 6000,
    })
    .toBe(false);
  await dialog.getByRole("button", { name: "confirm" }).click();
}

beforeEach(async () => {
  navigated.length = 0;
  await resetArticles();
});

describe("project page", () => {
  it("lists this project's documents with their code counts", async () => {
    await seedArticle({
      project: FOLDER,
      name: "spd 1",
      text: "Ein Artikel.",
      entries: [
        { line: 1, range: [0, 3], excerpt: "Ein", code: "1.1" },
        { line: 1, range: [4, 12], excerpt: " Artikel", code: "2" },
      ],
    });
    await seedArticle({ project: FOLDER, name: "spd 2", text: "", versions: ["first"] });

    renderProject();

    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("test");
    await expect.element(page.getByText("2 documents", { exact: true }).first()).toBeInTheDocument();
    await expect.element(page.getByText("2 codes", { exact: true }).first()).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "spd 1.txt" })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "spd 2.txt" })).toBeInTheDocument();
  });

  it("links each document to its coding page", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "Text" });

    renderProject();

    // .element() does not poll: wait for the RxDB-driven list first
    await expect.element(page.getByRole("link", { name: "spd 1.txt" })).toBeInTheDocument();
    const link = await page.getByRole("link", { name: "spd 1.txt" }).element();
    expect(link.getAttribute("href")).toBe("/text/test/spd 1");
  });

  it("shows only its own project's documents", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "Text" });
    await seedArticle({ project: "other", name: "foreign doc", text: "Text" });
    await seedArticle({ project: "other", name: "foreign note", text: "Text" });

    renderProject();

    await expect.element(page.getByRole("link", { name: "spd 1.txt" })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "foreign doc.txt" })).not.toBeInTheDocument();
    // the counts cover this project only
    expect(document.querySelectorAll(".docs li")).toHaveLength(1);
    await expect.element(page.getByText("1 documents", { exact: true }).first()).toBeInTheDocument();
  });

  it("links back to the project screen", async () => {
    renderProject();

    const link = await page.getByRole("link", { name: "projects", exact: true }).element();
    expect(link.getAttribute("href")).toBe("/");
  });

  it("creates a new document in the project and opens it", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "Text" });

    renderProject();

    await page.getByRole("button", { name: "new document" }).click();

    // new documents are markdown by default
    await expect.element(page.getByRole("link", { name: "Untitled 1.md" })).toBeInTheDocument();
    expect(navigated).toEqual(["/text/test/Untitled 1.md"]);
    expect((await listArticles()).map((a) => a.project)).toEqual(["test", "test"]);
    expect((await getArticle(FOLDER, "Untitled 1.md"))?.name).toBe("Untitled 1.md");
  });

  it("names new documents past an existing Untitled N without collision", async () => {
    await seedArticle({ project: FOLDER, name: "Untitled 2", text: "x" });

    renderProject();

    await page.getByRole("button", { name: "new document" }).click();

    // max existing "Untitled 2" → the next free name is "Untitled 3.md"
    await expect.poll(async () => (await getArticle(FOLDER, "Untitled 3.md"))?.name).toBe("Untitled 3.md");
    expect(await getArticle(FOLDER, "Untitled 1.md")).toBeNull();
  });

  it("shows the empty state for a project without documents", async () => {
    renderProject();

    await expect.element(page.getByText("Empty project")).toBeInTheDocument();
    expect(document.querySelectorAll(".docs li")).toHaveLength(0);
  });

  it("uploads text files into the project", async () => {
    renderProject();

    await upload(new File(["uploaded body here"], "spd upload.txt", { type: "text/plain" }));

    await expect.element(page.getByRole("link", { name: "spd upload.txt" })).toBeInTheDocument();
    const art = await getArticle(FOLDER, "spd upload");
    expect(art?.text).toBe("uploaded body here");
    expect(art?.project).toBe(FOLDER);
  });

  it("uploads a picked folder's files into the project (relative paths ignored)", async () => {
    const txt = new File(["folder body"], "sub.txt", { type: "text/plain" });
    const md = new File(["# note"], "note.md", { type: "text/markdown" });
    // vitest cannot open a real directory picker — fake the folder paths the browser sets
    Object.defineProperty(txt, "webkitRelativePath", { value: "proj/sub.txt" });
    Object.defineProperty(md, "webkitRelativePath", { value: "proj/note.md" });

    renderProject();
    await upload(txt, md);

    // the picked folder's own name is NOT used — everything lands in this project
    await expect.poll(async () => (await getArticle(FOLDER, "sub"))?.text).toBe("folder body");
    // .md keeps its extension (drives highlighting + download)
    await expect.element(page.getByRole("link", { name: "note.md" })).toBeInTheDocument();
    expect(await getArticle("proj", "sub")).toBeNull();
  });

  it("refuses an upload whose name already exists in the project", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });

    renderProject();
    await upload(new File(["dup body"], "spd 1.txt", { type: "text/plain" }));

    await expect.poll(() => document.querySelector(".upmsg")?.textContent ?? "").toBe('"spd 1" already exists');
    expect(await getArticle(FOLDER, "spd 1")).toMatchObject({ text: TEXT });
    expect((await listArticles()).length).toBe(1);
  });

  it("deletes a document through the timed confirm dialog", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });
    await seedArticle({ project: FOLDER, name: "spd 2", text: "x" });

    renderProject();

    await page.getByRole("button", { name: "menu for spd 1.txt" }).click();
    await page.getByRole("menuitem", { name: "delete document" }).click();
    await confirmDelete('Delete "spd 1.txt"?');

    await expect.element(page.getByRole("link", { name: "spd 1.txt" })).not.toBeInTheDocument();
    expect(await getArticle(FOLDER, "spd 1")).toBeNull();
    expect(await getArticle(FOLDER, "spd 2")).toBeTruthy();
  });

  it("deletes the whole project and returns to the project screen", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });
    await seedArticle({ project: "other", name: "foreign doc", text: "Text" });

    renderProject();

    await page.getByRole("button", { name: "project menu" }).click();
    await page.getByRole("menuitem", { name: "delete project" }).click();
    await confirmDelete("Delete project test/?");

    await expect.poll(async () => (await listArticles()).map((a) => a.project)).toEqual(["other"]);
    expect(navigated).toEqual(["/"]);
  });

  it("opens the document row's context menu on right click", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });

    renderProject();
    await expect.element(page.getByRole("link", { name: "spd 1.txt" })).toBeInTheDocument();

    const row = (await page.getByRole("link", { name: "spd 1.txt" }).element()).parentElement as HTMLElement;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(r.left + 20),
        clientY: Math.round(r.top + r.height / 2),
      }),
    );

    const menu = page.getByRole("menu");
    await expect.element(menu).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "open document" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "download document" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "delete document" })).toBeInTheDocument();
  });

  it("offers a .qdc export only when the project has a frame-device catalog", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: TEXT });
    await saveLocalCatalog(FOLDER, testInstructions);

    renderProject();

    await expect.element(page.getByRole("button", { name: "export .qdc" })).toBeInTheDocument();
    expect(document.querySelectorAll(".export")).toHaveLength(1);
  });

  it("marks the bundled example project", async () => {
    await seedArticle({ project: "example", name: "Junge Freiheit 22", text: TEXT });

    renderProject("example");

    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("example");
    await expect.element(page.getByText("example", { exact: true }).first()).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Junge Freiheit 22.txt" })).toBeInTheDocument();
  });

  it("hosts the colors dialog on the project page", async () => {
    renderProject();

    await page.getByRole("button", { name: "colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "colors" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("base color")).toBeInTheDocument();
    await page.getByRole("button", { name: "close colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "colors" })).not.toBeInTheDocument();
  });
});
