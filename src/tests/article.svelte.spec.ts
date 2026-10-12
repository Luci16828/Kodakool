import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ArticlePage from "../routes/text/[folder]/[name]/+page.svelte";
import { getArticle, getLocalCatalog, getPdfData, readCodes, savePdfData } from "$lib/client/coding-db";
import { extractPdfDoc } from "$lib/coding/pdf";
import { buildPdf } from "$lib/coding/pdf-sample";
import type { CodeEntry } from "$lib/coding/types";
import { DEVICE_COMMENT, DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

const FOLDER = "test";
const NAME = "spd 1";
const TEXT = "Ein Zitat im Text.";

/** entry for the word `Zitat` (offsets 4..9 of the single-line body) */
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

let lastRender: ReturnType<typeof render> | undefined;

function renderArticle(name = NAME, instructions = testInstructions) {
  lastRender = render(ArticlePage, { data: { folder: FOLDER, name, instructions } }, { wrapper: ColorProvider });
  return lastRender;
}

/** waits until the local article has been handed to CodeMirror */
async function ready(): Promise<void> {
  await expect.element(page.getByRole("textbox")).toBeInTheDocument();
}

const editor = () => page.getByRole("textbox").first();
const marks = () => document.querySelectorAll(".cm-underline").length;
/** marks whose gradient hatches overlapping coverage */
const hatchedMarks = () =>
  [...document.querySelectorAll(".cm-underline")].filter((el) =>
    (el.getAttribute("style") ?? "").includes("repeating-linear-gradient"),
  ).length;
const chips = () => [...document.querySelectorAll(".cm-tag")].map((el) => el.textContent ?? "");

/** editor body without the floating code-label widgets */
function editorText(): string {
  const clone = (document.querySelector(".cm-content") as HTMLElement).cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".cm-tagline").forEach((el) => el.remove());
  return (clone.textContent ?? "").trim();
}

/** count shown on the catalog row of `name` (own entries + children) */
function treeCount(name: string): string | null {
  const row = [...document.querySelectorAll(".tnode")].find((r) => r.textContent?.includes(name));
  return row?.querySelector(".tcount")?.textContent ?? null;
}

/** edit-mode row addressed by the value of one of its inputs */
function editRow(value: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".tnode")].find((r) =>
    [...r.querySelectorAll("input")].some((i) => (i as HTMLInputElement).value === value),
  );
}

afterEach(() => {
  // unmount before the next test seeds: the page's unmount commit flush must not
  // race with resetArticles/seedArticle (RxDB CONFLICT on the codes collection)
  lastRender?.unmount();
  lastRender = undefined;
});

beforeEach(async () => {
  navigated.length = 0;
  await resetArticles();
});

describe("article coding page", () => {
  it("reports an article that is not in local storage", async () => {
    renderArticle("missing");

    await expect.element(page.getByText("This article does not exist in local storage.")).toBeInTheDocument();
    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders the body with a mark and a label chip for each code", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await expect.element(editor()).toHaveTextContent("Zitat");
    expect(editorText()).toBe(TEXT);
    await expect.poll(marks).toBe(1);
    await expect.poll(chips).toEqual(["Z"]);

    const mark = document.querySelector(".cm-underline") as HTMLElement;
    expect(mark.getAttribute("title")).toBe("1.1");
    expect(mark.textContent).toBe("Zitat");
  });

  it("counts the entries per frame device in the catalog sidebar", async () => {
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry, { device: DEVICE_COMMENT, line: 1, range: [13, 17], excerpt: "Text" }],
    });

    renderArticle();
    await ready();

    await expect.poll(() => treeCount("Zitat")).toBe("1");
    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await expect.poll(() => treeCount("Rahmen")).toBe("1");
  });

  it("covers faded marks solidly when hovering a frame device", async () => {
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry, { device: DEVICE_COMMENT, line: 1, range: [6, 12], excerpt: "tat im" }],
    });

    renderArticle();
    await ready();

    // overlapping entries split into 3 segments; the shared one hatches in normal mode
    await expect.poll(marks).toBe(3);
    await expect.poll(hatchedMarks).toBe(1);

    // hovering `Zitat` fades the comment entry: the quote mark covers the
    // overlap solidly — no hatching against faded coverage
    const row = page.getByRole("treeitem", { name: "Zitat" });
    await expect.element(row).toBeInTheDocument();
    const el = await row.element();
    el.dispatchEvent(new Event("mouseenter"));
    await expect.poll(hatchedMarks).toBe(0);

    el.dispatchEvent(new Event("mouseleave"));
    await expect.poll(hatchedMarks).toBe(1);
  });

  it("arms a frame device on click and disarms it with Escape", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("treeitem", { name: "Zitat" }).click();
    await expect.element(page.getByText("armed").first()).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".ctag").length).toBe(1);

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("armed").first()).not.toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".ctag").length).toBe(0);
  });

  it("codes the released selection with the armed device", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    // smart select is the default: the click selects the clicked sentence and
    // the released mouseup codes it with the armed device
    await page.getByRole("treeitem", { name: "Kommentar" }).click();
    await editor().click({ position: { x: 5, y: 30 } });

    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await expect.poll(chips).toEqual(expect.arrayContaining(["Z", "K"]));

    await expect.poll(async () => (await readCodes(id)).length).toBe(2);
    const codes = await readCodes(id);
    expect(codes.find((c) => c.device === DEVICE_COMMENT)?.excerpt).toBe("Ein Zitat im Text");
  });

  it("keeps the body read-only until edit mode, and arming returns to coding", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    // coding mode (default for a non-empty body): typing does not change the doc
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("X");
    await expect.poll(editorText).toBe(TEXT);

    await page.getByRole("button", { name: "edit text" }).click();
    await expect.element(page.getByText("editing", { exact: true })).toBeInTheDocument();
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("X");
    await expect.poll(editorText).toMatch(/X/);

    // arming a device auto-exits edit mode
    await page.getByRole("treeitem", { name: "Zitat" }).click();
    await expect.element(page.getByText("armed").first()).toBeInTheDocument();
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("Y");
    await expect.poll(editorText).not.toMatch(/Y/);
  });

  it("toggles smart select on the editor", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    const smart = page.getByRole("button", { name: /Smart Select/ });
    await expect.element(smart).toHaveAttribute("aria-pressed", "true");
    await smart.click();
    await expect.element(smart).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => document.querySelector(".editor")?.classList.contains("smartsel")).toBe(false);

    await smart.click();
    await expect.element(smart).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => document.querySelector(".editor")?.classList.contains("smartsel")).toBe(true);
  });

  it("opens the colors customization dialog from the colors button", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "colors" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("base color")).toBeInTheDocument();

    await page.getByRole("button", { name: "close colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "colors" })).not.toBeInTheDocument();
  });

  it("hosts the theme toggle inside the colors dialog", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    // the coding bar no longer carries a toggle of its own
    expect(document.querySelector(".theme-toggle")).toBe(null);

    await page.getByRole("button", { name: "colors" }).click();
    const toggle = page.getByRole("button", { name: "switch color theme" });
    await expect.element(toggle).toBeInTheDocument();
    const before = document.documentElement.dataset.theme ?? "light";
    await toggle.click();
    await expect.poll(() => document.documentElement.dataset.theme).toBe(before === "dark" ? "light" : "dark");
  });

  it("saves an edited body into the local article", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "edit text" }).click();
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("{End}!");

    await expect.element(page.getByRole("button", { name: "save" })).toBeInTheDocument();
    await expect.poll(editorText).toMatch(/Text\.!$/);
    await expect.poll(async () => (await getArticle(FOLDER, NAME))?.text).toMatch(/Text\.!$/);
  });

  it("re-anchors entries when a text edit is undone", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "edit text" }).click();
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("Vorgeschichte. "); // 15 chars → Zitat shifts 4..9 → 19..24
    await expect.poll(async () => (await readCodes(id))[0]?.range).toEqual([19, 24]);

    // session undo (CodeMirror Mod-z): the entry remap must follow it back
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.poll(async () => (await readCodes(id))[0]?.range).toEqual([4, 9]);
  });

  it("snapshots versions and reverts to one", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("button", { name: "versions (0)" })).toBeInTheDocument();
    await page.getByRole("button", { name: "versions (0)" }).click();
    await expect.element(page.getByText("No versions yet")).toBeInTheDocument();
    await page.getByRole("button", { name: "snapshot now" }).click();
    await expect.element(page.getByRole("button", { name: "versions (1)" })).toBeInTheDocument();
    await expect.element(page.getByText("version saved")).toBeInTheDocument();

    // change the body, then revert to the snapshot
    await page.getByRole("button", { name: "edit text" }).click();
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("{End} CHANGED");
    await expect.poll(editorText).toMatch(/CHANGED$/);

    await page.getByRole("button", { name: "versions (1)" }).click();
    await page.getByRole("button", { name: "revert" }).click();

    await expect.poll(editorText).toBe(TEXT);
    // the pre-revert state was kept as a new version
    await expect.element(page.getByRole("button", { name: "versions (2)" })).toBeInTheDocument();
    await expect.poll(async () => (await getArticle(FOLDER, NAME))?.text).toBe(TEXT);
  });

  it("renames the document and follows to the new url", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    const input = page.getByRole("textbox", { name: "document name" });
    await input.fill("spd 2");
    await userEvent.keyboard("{Enter}");

    await expect.poll(async () => (await getArticle(FOLDER, "spd 2"))?.name).toBe("spd 2");
    expect(navigated).toEqual(["/text/test/spd 2"]);
  });

  it("edits the frame-device catalog locally: rename, tag override, drag reorder", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "edit devices" }).click();
    await page.getByRole("textbox", { name: "name Zitat" }).fill("Markierung");
    await page.getByRole("textbox", { name: "tag Kommentar" }).fill("KOM");

    // drag Kommentar onto Rahmen (top-level reorder)
    editRow("Kommentar")?.querySelector(".grip")?.dispatchEvent(new Event("dragstart"));
    editRow("Rahmen")?.dispatchEvent(new Event("dragover", { cancelable: true }));
    editRow("Rahmen")?.dispatchEvent(new Event("drop", { cancelable: true }));

    await page.getByRole("button", { name: "save catalog" }).click();

    await expect
      .poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name))
      .toEqual(["Kommentar", "Rahmen"]);
    const local = await getLocalCatalog(FOLDER);
    expect(local?.devices[0].tag).toBe("KOM");
    expect(local?.devices[1].children[0]?.name).toBe("Markierung");
    // the override shows as the row tag after the tree reloads
    await expect.element(page.getByText("KOM").first()).toBeInTheDocument();
  });

  it("adds and deletes frame devices in catalog edit mode", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "edit devices" }).click();
    await page.getByRole("button", { name: "new device" }).click();

    // the new top-level device arrives with an editable name row
    await expect.element(page.getByRole("textbox", { name: "name New device" })).toBeInTheDocument();
    await page.getByRole("textbox", { name: "name New device" }).fill("Extra");

    // deleting a device goes through the countdown confirmation
    await page.getByRole("button", { name: "delete Kommentar" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete device "Kommentar"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "confirm" }).click();
    await expect.element(page.getByRole("button", { name: "delete Kommentar" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "save catalog" }).click();
    await expect
      .poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name))
      .toEqual(["Rahmen", "Extra"]);
  });

  it("shows a collapsible document tree with the current document marked", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("link", { name: "other doc.txt" })).toBeInTheDocument();
    // accessible name ignores the aria-hidden kind icon
    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).toBeInTheDocument();
    expect(document.querySelector(".docs li.current")).toBeTruthy();

    await page.getByRole("button", { name: "toggle document tree" }).click();
    await expect.element(page.getByRole("link", { name: "other doc.txt" })).not.toBeInTheDocument();
  });

  it("marks tree entries with kind icons (text, markdown, pdf)", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "note.md", text: "# hi" });
    await seedArticle({ project: FOLDER, name: "scan", text: "x", kind: "pdf" });

    renderArticle();
    await ready();

    await expect.poll(() => document.querySelectorAll(".docs .docicon").length).toBe(3);
    const iconFor = (name: string) => {
      const li = [...document.querySelectorAll(".docs li")].find((l) => l.textContent?.includes(name));
      return li?.querySelector(".docicon")?.textContent?.trim() ?? null;
    };
    expect(iconFor(NAME)).toBe("article");
    expect(iconFor("note.md")).toBe("markdown_document");
    expect(iconFor("scan")).toBe("newsmode");
  });

  it("collapses and expands document folders", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const group = page.getByRole("button", { name: /test\// });
    await expect.element(group).toBeInTheDocument();
    await group.click();
    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).not.toBeInTheDocument();
    await group.click();
    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).toBeInTheDocument();
  });

  it("creates and deletes local folders (confirm waits for the countdown)", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "new folder" }).click();
    await page.getByRole("textbox", { name: "new folder name" }).fill("archive");
    await page.getByRole("button", { name: "create" }).click();

    // registered-but-empty folders show up in the tree too
    await expect.element(page.getByRole("button", { name: /archive\// })).toBeInTheDocument();

    await page.getByRole("button", { name: "delete folder archive" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete folder "archive"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "confirm" }).click();

    await expect.element(page.getByRole("button", { name: /archive\// })).not.toBeInTheDocument();
  });

  it("deletes a document from the tree after the confirmation countdown", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "delete other doc.txt" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete "other doc.txt"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "confirm" }).click();

    await expect.element(page.getByRole("link", { name: "other doc.txt" })).not.toBeInTheDocument();
    expect(await getArticle(FOLDER, "other doc")).toBeNull();
  });

  it("collapses the frame-devices aside", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const heading = page.getByRole("heading", { name: "Frame devices" });
    await expect.element(heading).toBeInTheDocument();
    await page.getByRole("button", { name: "toggle frame devices" }).click();
    await expect.element(heading).not.toBeInTheDocument();
    await page.getByRole("button", { name: "toggle frame devices" }).click();
    await expect.element(heading).toBeInTheDocument();
  });

  it("uploads text files from the sidebar dropzone into the tree", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    // the tests run in the browser: feed the Melt FileUpload input a real File
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File(["uploaded body here"], "spd upload.txt", { type: "text/plain" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByRole("link", { name: "spd upload.txt" })).toBeInTheDocument();
    const art = await getArticle(FOLDER, "spd upload");
    expect(art?.text).toBe("uploaded body here");
  });

  it("uploads a picked folder's files into the ACTIVE folder (relative paths ignored)", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const input = document.querySelector(".upfolder input") as HTMLInputElement;
    const dt = new DataTransfer();
    const txt = new File(["folder body"], "sub.txt", { type: "text/plain" });
    const md = new File(["# note"], "note.md", { type: "text/markdown" });
    // vitest cannot open a real directory picker — fake the folder paths the browser sets
    Object.defineProperty(txt, "webkitRelativePath", { value: "proj/sub.txt" });
    Object.defineProperty(md, "webkitRelativePath", { value: "proj/note.md" });
    dt.items.add(txt);
    dt.items.add(md);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // the picked folder's own name is NOT used — everything lands in the active folder
    await expect.poll(async () => (await getArticle(FOLDER, "sub"))?.text).toBe("folder body");
    // .md keeps its extension (drives highlighting + download)
    await expect.poll(async () => (await getArticle(FOLDER, "note.md"))?.name).toBe("note.md");
    await expect.element(page.getByRole("link", { name: "note.md" })).toBeInTheDocument();
    expect(await getArticle("proj", "sub")).toBeNull();
  });

  it("keeps PDF articles read-only but codable", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf" });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();

    // the PDF surface: canvas page + transparent selectable text layer, no CodeMirror
    expect(document.querySelector(".pdfpage canvas")).toBeTruthy();
    expect(document.querySelectorAll(".pdfspan").length).toBeGreaterThan(0);
    expect(document.querySelector(".cm-content")).toBe(null);
    // no edit affordance at all
    expect(document.querySelector('[aria-label="edit text"]')).toBe(null);

    // typing does nothing: the text layer is not an input
    await page.getByText("Hello coding world.").first().click();
    await userEvent.keyboard("X");
    expect(document.querySelector(".pdfspan")?.textContent).toBe("Hello coding world.");

    // coding works: an armed smart click on the sentence codes it
    await page.getByRole("treeitem", { name: "Kommentar" }).click();
    await page.getByText("Hello coding world.").first().click();
    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    // first sentence of a paragraph drops its terminator (segment.ts rule, editor parity)
    await expect.poll(async () => (await readCodes(id)).map((c) => c.excerpt)).toEqual(["Hello coding world"]);
  });

  it("renders coding marks and chips over the PDF pages", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const entry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 19], excerpt: "Hello coding world." };
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [entry] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelector('.pdfchip[data-tag-entry][style*="--tag"]') !== null).toBe(true);
  });

  it("toggles between rendered pages and extracted text for PDFs", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const entry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 19], excerpt: "Hello coding world." };
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [entry] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();
    expect(document.querySelector(".cm-content")).toBe(null);

    // text surface: CodeMirror over the same canonical text, same marks
    await page.getByRole("radio", { name: "Plain Text" }).click();
    await expect.element(page.getByRole("radio", { name: "Plain Text" })).toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("radio", { name: "Full" })).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => document.querySelector(".cm-content") !== null).toBe(true);
    expect(document.querySelector(".pdfpage")).toBe(null);
    await expect.poll(() => document.querySelectorAll(".cm-underline").length).toBeGreaterThan(0);

    // hard-break smart select: a click codes only its own line (line 2)
    await page.getByRole("treeitem", { name: "Kommentar" }).click();
    const content = document.querySelector(".cm-content")!.getBoundingClientRect();
    const l = document.querySelectorAll(".cm-line")[1].getBoundingClientRect();
    await page
      .getByRole("textbox")
      .first()
      .click({ position: { x: l.left - content.left + 5, y: l.top - content.top + l.height / 2 } });
    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await expect
      .poll(async () => (await readCodes(id)).map((c) => c.excerpt).sort())
      .toEqual(["Hello coding world.", "Zweite Zeile."]);

    // back to the rendered surface
    await page.getByRole("radio", { name: "Full" }).click();
    await expect.poll(() => document.querySelector(".pdfpage canvas") !== null).toBe(true);
    expect(document.querySelector(".cm-content")).toBe(null);
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
  });

  it("drag-selecting on the PDF surface codes word-snapped selections", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();
    await page.getByRole("treeitem", { name: "Kommentar" }).click();

    // delegated drag: native selection is off, the drag maps to canonical offsets
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const sp = document.querySelector('.pdfspan[data-start="0"]')!.getBoundingClientRect();
    const y = sp.top + sp.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    fire("mousedown", sp.left + 2, 1);
    fire("mousemove", sp.left + sp.width * 0.6, 1);
    fire("mouseup", sp.left + sp.width * 0.6, 0);

    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await expect.poll(async () => (await readCodes(id)).map((c) => c.excerpt)).toEqual(["Hello coding"]);
    // the persisted selection renders as coverage pseudo-mark (editor parity),
    // not as a separate flat layer
    expect(document.querySelector(".pdfsel")).toBe(null);
    expect(document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
  });

  it("coding the same span twice stores a single entry", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await ready();
    await page.getByRole("treeitem", { name: "Kommentar" }).click();

    // same armed smart click twice: the entry id is content-hashed → upsert dedupes
    await page.getByText("Hello coding world.").first().click();
    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await page.getByText("Hello coding world.").first().click();
    await expect.poll(async () => (await readCodes(id)).length).toBe(1);
    expect(treeCount("Kommentar")).toBe("1");
  });

  it("multi-line drag on the PDF surface stores an entry crossing lines", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await ready();
    await page.getByRole("treeitem", { name: "Kommentar" }).click();

    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const s1 = document.querySelector('.pdfspan[data-start="0"]')!.getBoundingClientRect();
    const s2 = document.querySelector('.pdfspan[data-start="20"]')!.getBoundingClientRect();
    textEl.dispatchEvent(
      new MouseEvent("mousedown", { clientX: s1.left + 2, clientY: s1.top + s1.height / 2, buttons: 1, bubbles: true }),
    );
    textEl.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: s2.left + s2.width * 0.4,
        clientY: s2.top + s2.height / 2,
        buttons: 1,
        bubbles: true,
      }),
    );
    textEl.dispatchEvent(
      new MouseEvent("mouseup", {
        clientX: s2.left + s2.width * 0.4,
        clientY: s2.top + s2.height / 2,
        buttons: 0,
        bubbles: true,
      }),
    );

    await expect.poll(() => treeCount("Kommentar")).toBe("1");
    await expect
      .poll(async () => {
        const codes = await readCodes(id);
        const c = codes[0];
        return (
          codes.length === 1 && c.line === 1 && c.endLine === 2 && c.excerpt.startsWith("Hello coding world.\nZweite")
        );
      })
      .toBe(true);
  });

  it("deleting an entry through its chip popup removes the mark", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const entry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 19], excerpt: "Hello coding world." };
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [entry] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await ready();
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelector(".pdfchip") !== null).toBe(true);

    // chip hover opens the entry popup (shared anchor with the editor tags)
    (document.querySelector(".pdfchip") as HTMLElement).dispatchEvent(new MouseEvent("mouseenter"));
    await expect.element(page.getByRole("dialog", { name: "code entry" })).toBeInTheDocument();
    await page.getByRole("button", { name: "delete", exact: true }).click();

    await expect.poll(async () => (await readCodes(id)).length).toBe(0);
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBe(0);
    expect(document.querySelector(".pdfchip")).toBe(null);
  });

  it("keeps the entry popup open when the pointer moves from the chip into it", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();
    await expect.poll(() => document.querySelector(".cm-tag") !== null).toBe(true);

    // editor chip hover is resolved on mousemove (code-mark.ts)
    (document.querySelector(".cm-tag") as HTMLElement).dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const popup = page.getByRole("dialog", { name: "code entry" });
    await expect.element(popup).toBeInTheDocument();

    // leaving the chip only starts the grace period; entering the popup cancels it
    (document.querySelector(".cm-content") as HTMLElement).dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true }),
    );
    (document.querySelector(".tpopup") as HTMLElement).dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 600)); // past the 400ms grace window
    await expect.element(popup).toBeInTheDocument();

    // the popup is now usable: the note textarea accepts a selection
    await popup.getByRole("textbox").fill("selected note");
    await expect.poll(async () => (await readCodes(id)).some((e) => e.note === "selected note")).toBe(true);
  });

  it("starts an empty PDF article in coding mode, not edit mode", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: "", kind: "pdf" });

    renderArticle();
    // no stored bytes → fallback notice instead of a surface; still no edit affordance
    await expect.element(page.getByText("no stored PDF")).toBeInTheDocument();
    expect(document.querySelector('[aria-label="finish editing"]')).toBe(null);
    expect(document.querySelector('[aria-label="edit text"]')).toBe(null);
  });

  it("uploads a PDF as a read-only extracted-text article", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File([buildPdf(["Pdf uploaded body."])], "spd pdf.pdf", { type: "application/pdf" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByRole("link", { name: "spd pdf.pdf" })).toBeInTheDocument();
    const art = await getArticle(FOLDER, "spd pdf");
    expect(art?.kind).toBe("pdf");
    expect(art?.text).toContain("Pdf uploaded body.");
    // the original bytes are stored locally for the PDF view
    expect(await getPdfData(art?.id ?? "")).toBeTruthy();
  });

  it("offers document download and catalog export/import controls", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("button", { name: "download document" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "json", exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: ".qdc" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "import", exact: true })).toBeInTheDocument();
    expect(document.querySelector(".upfolder")).toBeTruthy();
  });

  it("highlights markdown and YAML frontmatter in .md documents", async () => {
    const mdText = "---\ntitle: Test\ncount: 3\n---\n# Head\n**bold** word";
    await seedArticle({ project: FOLDER, name: "doc.md", text: mdText });

    renderArticle("doc.md");
    await ready();

    // frontmatter block tint + YAML token classes (code-md.ts)
    await expect.poll(() => document.querySelectorAll(".cm-frontmatter").length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelector(".cm-property")?.textContent).toBe("title");
    await expect.poll(() => document.querySelector(".cm-number")?.textContent).toBe("3");
    // markdown tokens (lang-markdown; the # / ** markers carry the class too)
    await expect
      .poll(() => [...document.querySelectorAll(".cm-header-1")].map((e) => e.textContent?.trim()))
      .toContain("Head");
    await expect
      .poll(() => [...document.querySelectorAll(".cm-strong")].map((e) => e.textContent?.trim()))
      .toContain("bold");
  });

  it("plain .txt documents get no markdown highlighting", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: "# not a heading" });

    renderArticle();
    await ready();

    await expect.element(editor()).toBeInTheDocument();
    expect(document.querySelector(".cm-header-1")).toBeNull();
    expect(document.querySelector(".cm-frontmatter")).toBeNull();
  });
});
