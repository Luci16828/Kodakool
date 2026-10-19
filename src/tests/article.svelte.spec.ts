import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ArticlePage from "../routes/text/[folder]/[name]/+page.svelte";
import {
  createFolder,
  getArticle,
  getLocalCatalog,
  getPdfData,
  listFolders,
  readCodes,
  saveLocalCatalog,
  savePdfData,
} from "$lib/client/coding-db";
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

function renderArticle(name = NAME) {
  lastRender = render(ArticlePage, { data: { folder: FOLDER, name } }, { wrapper: ColorProvider });
  return lastRender;
}

/** waits until the local article has been handed to CodeMirror */
async function ready(): Promise<void> {
  await expect.element(page.getByRole("textbox")).toBeInTheDocument();
  // the icon font arrives asynchronously: every icon width (and with it the bar's
  // whole layout) jumps when it lands, so a click can straddle the shift
  await document.fonts.ready;
}

const editor = () => page.getByRole("textbox").first();
const marks = () => document.querySelectorAll(".cm-underline").length;
/** marks whose gradient hatches overlapping coverage */
const hatchedMarks = () =>
  [...document.querySelectorAll(".cm-underline")].filter((el) =>
    (el.getAttribute("style") ?? "").includes("repeating-linear-gradient"),
  ).length;
const chips = () => [...document.querySelectorAll(".cm-tag")].map((el) => el.textContent ?? "");

/**
 * Place the caret at the end of the body by clicking right of the line's text
 * (CodeMirror clamps a click past the last glyph to the line end).
 * Typing `{End}` after a click is flaky under load: the keypress can reach the
 * editor before its click-driven selection/focus settles, and the text lands at 0.
 */
async function caretAtEnd(): Promise<void> {
  const content = document.querySelector(".cm-content") as HTMLElement;
  const line = document.querySelector(".cm-line") as HTMLElement;
  const c = content.getBoundingClientRect();
  const l = line.getBoundingClientRect();
  // stay INSIDE the content box (a point past its edge hits the parent <main>
  // and Playwright reports "intercepts pointer events")
  await editor().click({
    position: { x: Math.max(0, Math.round(l.right - c.left) - 4), y: Math.round(l.top - c.top + l.height / 2) },
  });
}

/**
 * Press + release one mouse button at a point inside the editor body.
 * `detail: 1` matters: CodeMirror reads `detail: 0` as a triple click.
 */
function clickWithButton(button: number, x: number, y: number): void {
  const content = document.querySelector(".cm-content") as HTMLElement;
  const r = content.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    clientX: r.left + x,
    clientY: r.top + y,
    button,
    buttons: button === 2 ? 2 : 1,
  };
  content.dispatchEvent(new MouseEvent("mousedown", at));
  content.dispatchEvent(new MouseEvent("mouseup", at));
}

/** the editor's selection text (CodeMirror draws the native DOM selection) */
const selText = () => window.getSelection()?.toString() ?? "";

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

/**
 * Right-click a catalog tree row (the Bits context menu anchors at the pointer).
 * Playwright's right-click needs a visible locator; the rows are dense flex items,
 * so the event is dispatched on the row element itself.
 */
async function rightClickRow(name: string): Promise<void> {
  await expect
    .poll(() => [...document.querySelectorAll(".tnode")].some((r) => r.textContent?.includes(name)))
    .toBe(true);
  const row = [...document.querySelectorAll<HTMLElement>(".tnode")].find((r) => r.textContent?.includes(name))!;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(r.left + 10),
      clientY: Math.round(r.top + r.height / 2),
    }),
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
  localStorage.removeItem("luci-minimap");
  await resetArticles();
  // the catalog is local-only now: seed it like the example project does
  await saveLocalCatalog(FOLDER, testInstructions);
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
    // the cursor tag is the arming indicator (the bar no longer spells it out)
    await expect.poll(() => document.querySelectorAll(".ctag").length).toBe(1);

    await userEvent.keyboard("{Escape}");
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

  it("keeps the right button out of selection and coding", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    // the quick select menu rides the right button: a right press+release inside the
    // editor must not select anything ...
    clickWithButton(2, 5, 30);
    expect(selText()).toBe("");

    // ... while the same gesture with the left button selects the whole sentence
    // (the selection text carries the floating `Z` chip of the seeded entry, so compare
    // the letters only)
    clickWithButton(0, 5, 30);
    await expect.poll(() => selText().replace(/\s+/g, "")).toContain("ZitatimText");

    // ... and a right release over a live selection must not code it
    await page.getByRole("treeitem", { name: "Kommentar" }).click();
    clickWithButton(2, 5, 30);
    clickWithButton(2, 5, 30);
    await expect.poll(async () => (await readCodes(id)).length).toBe(1);
  });

  it("keeps the body read-only until edit mode, and arming returns to coding", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    // coding mode (default for a non-empty body): typing does not change the doc
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("X");
    await expect.poll(editorText).toBe(TEXT);

    await page.getByRole("tab", { name: "Edit" }).click();
    await expect.element(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
    await editor().click({ position: { x: 5, y: 30 } });
    await userEvent.keyboard("X");
    await expect.poll(editorText).toMatch(/X/);

    // arming a device auto-exits edit mode
    await page.getByRole("treeitem", { name: "Zitat" }).click();
    await expect.poll(() => document.querySelectorAll(".ctag").length).toBe(1);
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

    await page.getByRole("button", { name: "Colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "Colors" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("base color")).toBeInTheDocument();

    await page.getByRole("button", { name: "Close colors" }).click();
    await expect.element(page.getByRole("dialog", { name: "Colors" })).not.toBeInTheDocument();
  });

  it("hosts the theme toggle inside the colors dialog", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    // the coding bar no longer carries a toggle of its own
    expect(document.querySelector(".theme-toggle")).toBe(null);

    await page.getByRole("button", { name: "Colors" }).click();
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

    await page.getByRole("tab", { name: "Edit" }).click();
    await caretAtEnd();
    await userEvent.keyboard("!");

    await expect.element(page.getByRole("button", { name: "Save" })).toBeInTheDocument();
    await expect.poll(editorText).toMatch(/Text\.!$/);
    await expect.poll(async () => (await getArticle(FOLDER, NAME))?.text).toMatch(/Text\.!$/);
  });

  it("re-anchors entries when a text edit is undone", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("tab", { name: "Edit" }).click();
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
    // the dashed pending node is the live working state: its dot snapshots it
    await page.getByRole("button", { name: "Snapshot current state" }).click();
    await expect.element(page.getByRole("button", { name: "versions (1)" })).toBeInTheDocument();

    // change the body, then revert via the commit dot: the changed state is kept as a version
    await page.getByRole("tab", { name: "Edit" }).click();
    await caretAtEnd();
    await userEvent.keyboard(" CHANGED");
    await expect.poll(editorText).toMatch(/CHANGED$/);

    await page.getByRole("button", { name: "versions (1)" }).click();
    await page.getByRole("button", { name: /Revert to/ }).click();

    await expect.poll(editorText).toBe(TEXT);
    // the pre-revert state was kept as a new version
    await expect.element(page.getByRole("button", { name: "versions (2)" })).toBeInTheDocument();
    await expect.poll(async () => (await getArticle(FOLDER, NAME))?.text).toBe(TEXT);
  });

  it("names, renames and forks snapshots in the graph", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    // the graph is the whole UI: dots carry the actions, labels are editable inputs
    const dots = () => document.querySelectorAll(".histgraph .crow:not(.pending) .cdot").length;
    /** dot column (x offset) per row, newest first — the fork shows as a second column */
    const columns = () =>
      [...document.querySelectorAll(".histgraph .crow:not(.pending) .cdot")].map(
        (el) => (el.getAttribute("style") ?? "").match(/left: (\d+)px/)?.[1],
      );
    const snapNow = () => page.getByRole("button", { name: "Snapshot current state" });
    const labelBox = () => page.getByRole("textbox", { name: "Snapshot name" }).first();

    // the pending node shows the live time + (current); its + dot snapshots with the time as label
    await page.getByRole("button", { name: "versions (0)" }).click();
    await expect.element(page.getByText("(current)")).toBeInTheDocument();
    await snapNow().click();
    await expect.element(page.getByRole("button", { name: "versions (1)" })).toBeInTheDocument();
    const [a] = (await getArticle(FOLDER, NAME))!.versions;
    expect(a.label).toMatch(/\d/); // the live time became the label
    expect(a.parent).toBe(null);

    // the snapshot is drawn as a dot with its label editable in place
    await page.getByRole("button", { name: "versions (1)" }).click();
    await expect.poll(dots).toBe(1);
    await expect.element(labelBox()).toHaveValue(a.label!);
    await labelBox().fill("Stand A2");
    await userEvent.keyboard("{Enter}");
    await expect.poll(async () => (await getArticle(FOLDER, NAME))!.versions[0].label).toBe("Stand A2");

    // a second snapshot continues the same line
    await snapNow().click();
    await expect.poll(async () => (await getArticle(FOLDER, NAME))!.versions.length).toBe(2);
    const two = (await getArticle(FOLDER, NAME))!.versions;
    expect(two[1].parent).toBe(a.id);

    // revert to Stand A2: nothing changed since Stand B, so NO pre-revert version is made
    await page.getByRole("button", { name: "versions (2)" }).click();
    await page.getByRole("button", { name: /Revert to Stand A2/ }).click();
    await expect.poll(editorText).toBe(TEXT);
    await expect.poll(async () => (await getArticle(FOLDER, NAME))!.versions.length).toBe(2);

    // going back onto a node that already has a child makes the live state a NEW
    // branch: the pending node draws in its own column forking off A
    const pendingLeft = () =>
      (document.querySelector(".crow.pending .cdot")?.getAttribute("style") ?? "").match(/left: (\d+)px/)?.[1];
    await page.getByRole("button", { name: "versions (2)" }).click();
    await expect.poll(pendingLeft).toBe("31");

    // the snapshot lands on that branch — the fork is a second dot column
    await snapNow().click();
    await expect.poll(async () => (await getArticle(FOLDER, NAME))!.versions.length).toBe(3);
    const vers = (await getArticle(FOLDER, NAME))!.versions;
    expect(vers[2].parent).toBe(a.id); // branched off A, not off B

    await page.getByRole("button", { name: "versions (3)" }).click();
    await expect.poll(dots).toBe(3);
    await expect.poll(columns).toEqual(["34", "12", "12"]); // C on its own line, B + A on main

    // the fork peels off just ABOVE A (y 120) — it must not run down A's column
    // past B (y 100) before branching sideways
    const forkPath = () =>
      [...document.querySelectorAll(".histgraph .glines path")]
        .map((p) => p.getAttribute("d") ?? "")
        .find((d) => d.startsWith("M 41 60"));
    await expect.poll(forkPath).toBe("M 41 60 V 120 H 19 V 140");
  });

  it("renames the document and follows to the new url", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    const input = page.getByRole("textbox", { name: "Document name" });
    await input.fill("spd 2");
    await userEvent.keyboard("{Enter}");

    await expect.poll(async () => (await getArticle(FOLDER, "spd 2"))?.name).toBe("spd 2");
    expect(navigated).toEqual(["/text/test/spd 2"]);
  });

  it("places the rename caret at the end of a regular name", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    await expect.element(page.getByRole("textbox", { name: "Document name" })).toBeInTheDocument();
    const input = document.querySelector(".rename") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([NAME.length, NAME.length]);
  });

  it("selects a default Untitled name fully in the rename input", async () => {
    await seedArticle({ project: FOLDER, name: "Untitled 3.md", text: "x" });

    renderArticle("Untitled 3.md");
    await ready();

    await page.getByRole("button", { name: "Untitled 3.md", exact: true }).click();
    await expect.element(page.getByRole("textbox", { name: "Document name" })).toBeInTheDocument();
    const input = document.querySelector(".rename") as HTMLInputElement;
    // typing replaces the whole default name
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Untitled 3.md".length]);
  });

  it("edits the frame-device catalog locally: rename, tag override, drag reorder", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "Edit devices" }).click();
    await page.getByRole("textbox", { name: "name Zitat" }).fill("Markierung");
    await page.getByRole("textbox", { name: "tag Kommentar" }).fill("KOM");

    // drag Kommentar onto Rahmen (top-level reorder)
    editRow("Kommentar")?.querySelector(".grip")?.dispatchEvent(new Event("dragstart"));
    editRow("Rahmen")?.dispatchEvent(new Event("dragover", { cancelable: true }));
    editRow("Rahmen")?.dispatchEvent(new Event("drop", { cancelable: true }));

    await page.getByRole("button", { name: "Save catalog" }).click();

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

    await page.getByRole("button", { name: "Edit devices" }).click();
    await page.getByRole("button", { name: "New device" }).click();

    // the new top-level device arrives with an editable name row
    await expect.element(page.getByRole("textbox", { name: "name New device" })).toBeInTheDocument();
    await page.getByRole("textbox", { name: "name New device" }).fill("Extra");

    // the row's context menu carries the delete action; it goes through the countdown
    // confirmation (edit-mode rows carry their name in an input → address them via `editRow`)
    const delRow = () => editRow("Kommentar");
    await expect.poll(delRow).toBeTruthy();
    const dr = delRow()!.getBoundingClientRect();
    delRow()!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(dr.left + 10),
        clientY: Math.round(dr.top + dr.height / 2),
      }),
    );
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete device "Kommentar"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(delRow).toBeUndefined();

    await page.getByRole("button", { name: "Save catalog" }).click();
    await expect
      .poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name))
      .toEqual(["Rahmen", "Extra"]);
  });

  it("starts catalog editing from the header add buttons", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    // "New category" enters edit mode with a fresh top-level device
    await page.getByRole("button", { name: "New category" }).click();
    await expect.element(page.getByRole("button", { name: "Save catalog" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Save catalog" }).click();
    await expect
      .poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name))
      .toEqual(["Rahmen", "Kommentar", "New device"]);
  });

  it("shows the markdown cheatsheet in edit mode of .md documents only", async () => {
    await seedArticle({ project: FOLDER, name: "doc.md", text: "# hi" });

    renderArticle("doc.md");
    await ready();

    // coding mode: no cheatsheet button
    expect(document.querySelector(".mdhelp")).toBe(null);
    await page.getByRole("tab", { name: "Edit" }).click();
    const btn = page.getByRole("button", { name: "Markdown" });
    await expect.element(btn).toBeInTheDocument();
    await btn.click();
    await expect.element(page.getByRole("dialog", { name: "Markdown cheatsheet" })).toBeInTheDocument();
    await expect.element(page.getByText("YAML header", { exact: false })).toBeInTheDocument();
  });

  it("shows the document tree with the current document marked", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("link", { name: "other doc.txt" })).toBeInTheDocument();
    // accessible name ignores the aria-hidden kind icon
    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).toBeInTheDocument();
    expect(document.querySelector(".docs li.current")).toBeTruthy();
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

  it("marks the project header as the selected upload target and folds its document list", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const group = page.getByRole("button", { name: /test\// });
    await expect.element(group).toBeInTheDocument();
    await expect.element(group).toHaveAttribute("aria-pressed", "true");
    // expanded: the folder glyph is the open folder and the list is visible
    const glyph = () => document.querySelector(".fgroup .material-symbols-rounded")?.textContent;
    expect(glyph()).toBe("folder_open");
    // fold: the list slides away and the glyph closes
    await group.click();
    await expect.poll(() => document.querySelectorAll(".doclist").length).toBe(0);
    expect(glyph()).toBe("folder");
    // unfold: the document row is back
    await group.click();
    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).toBeInTheDocument();
    expect(glyph()).toBe("folder_open");
  });

  it("lists only the current project's documents in the tree", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: "other", name: "foreign doc", text: "x" });
    await seedArticle({ project: "second", name: "foreign note", text: "x" });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("link", { name: `${NAME}.txt` })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "foreign doc.txt" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "foreign note.txt" })).not.toBeInTheDocument();
    // one project header only, counting this project's documents
    expect(document.querySelectorAll(".fgroup")).toHaveLength(1);
    await expect.element(page.getByRole("button", { name: /test\/ 1/ })).toBeInTheDocument();
  });

  it("switches to another project from the sidebar's project switcher", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: "other", name: "foreign doc", text: "x" });
    await createFolder("archive");

    renderArticle();
    await ready();

    const trigger = page.getByRole("button", { name: "Switch project" });
    await expect.element(trigger).toBeInTheDocument();
    // the trigger shows the current project
    await expect.element(trigger).toHaveTextContent(FOLDER);

    await trigger.click();
    await expect.element(page.getByRole("listbox")).toBeInTheDocument();
    // every OTHER project is offered (registered folders + projects holding documents) and
    // the open one is not: the chip itself is the current project
    const list = await page.getByRole("listbox").element();
    await expect
      .poll(() => [...list.querySelectorAll("[data-value]")].map((el) => el.getAttribute("data-value")))
      .toEqual(["archive", "other", "__new__"]);

    await page.getByRole("option", { name: "other" }).click();
    expect(navigated).toEqual(["/project/other"]);
  });

  it("creates a project from the dropdown's new-project row and opens it", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("option", { name: "New project" }).click();
    const input = (await page.getByLabelText("New project name").element()) as HTMLInputElement;
    // the row focuses its input so typing starts immediately
    expect(document.activeElement).toBe(input);
    input.value = "field study";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.getByRole("button", { name: "Create" }).click();

    await expect.poll(async () => (await listFolders()).includes("field study")).toBe(true);
    expect(navigated).toEqual(["/project/field study"]);
  });

  it("opens an existing project when the new-project name is taken", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("option", { name: "New project" }).click();
    const input = page.getByLabelText("New project name");
    await input.fill(FOLDER);
    await userEvent.keyboard("{Enter}");

    // createFolder is idempotent: the name is registered once, the project opens
    await expect.poll(async () => (await listFolders()).length).toBe(1);
    expect(navigated).toEqual([`/project/${FOLDER}`]);
  });

  it("links back to the project page from the coding bar", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const back = await page.getByRole("link", { name: "Back to project test" }).element();
    expect(back.getAttribute("href")).toBe("/project/test");
  });

  it("returns to the project page when the open document is deleted", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `menu for ${NAME}.txt` }).click();
    await page.getByRole("menuitem", { name: "Delete document" }).click();
    await expect.element(page.getByRole("dialog", { name: `Delete "${NAME}.txt"?` })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(async () => await getArticle(FOLDER, NAME)).toBeNull();
    expect(navigated).toEqual(["/project/test"]);
  });

  it("deletes a document from the tree after the confirmation countdown", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: "Menu for other doc.txt" }).click();
    await page.getByRole("menuitem", { name: "Delete document" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete "other doc.txt"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect.element(page.getByRole("link", { name: "other doc.txt" })).not.toBeInTheDocument();
    expect(await getArticle(FOLDER, "other doc")).toBeNull();
  });

  it("opens the document row's context menu on right click", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    const li = (await page.getByRole("link", { name: "other doc.txt" }).element()).parentElement as HTMLElement;
    const r = li.getBoundingClientRect();
    li.dispatchEvent(
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
    await expect.element(menu.getByRole("menuitem", { name: "Open document" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "Download document" })).toBeInTheDocument();
    await expect.element(menu.getByRole("menuitem", { name: "Delete document" })).toBeInTheDocument();
  });

  it("downloads a document through its context menu", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other doc", text: "x" });

    renderArticle();
    await ready();

    // downloads go through a generated <a> click — record it instead of downloading
    const downloads: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    try {
      const li = (await page.getByRole("link", { name: "other doc.txt" }).element()).parentElement as HTMLElement;
      const r = li.getBoundingClientRect();
      li.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(r.left + 20),
          clientY: Math.round(r.top + r.height / 2),
        }),
      );
      await page.getByRole("menuitem", { name: "Download document" }).click();
      await expect.poll(() => downloads).toEqual(["other doc.txt"]);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it("arms a device from its context menu and deletes catalog rows through it", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    // view mode: right-click the leaf row → arm it via the menu
    await rightClickRow("Zitat");
    await page.getByRole("menuitem", { name: "Code with this device" }).click();
    await expect.poll(() => document.querySelector(".tnode.sel")?.textContent?.includes("Zitat") ?? false).toBe(true);

    // right-click the top-level row → delete goes through the shared countdown dialog
    await rightClickRow("Kommentar");
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.element(page.getByRole("dialog", { name: 'Delete device "Kommentar"?' })).toBeInTheDocument();
    await expect
      .poll(() => (document.querySelector(".cfconfirm") as HTMLButtonElement | null)?.disabled, { timeout: 6000 })
      .toBe(false);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name)).toEqual(["Rahmen"]);
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
    expect(document.querySelectorAll('[role="tab"]').length).toBe(3);

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
    await page.getByRole("tab", { name: "Coding" }).click();
    await expect.element(page.getByRole("tab", { name: "Coding" })).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "false");
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
    await page.getByRole("tab", { name: "Preview" }).click();
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
    await expect.element(page.getByRole("dialog", { name: "Code entry" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

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
    const popup = page.getByRole("dialog", { name: "Code entry" });
    await expect.element(popup).toBeInTheDocument();

    // leaving the chip only starts the grace period; entering the popup cancels it
    (document.querySelector(".cm-content") as HTMLElement).dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true }),
    );
    (document.querySelector(".tpopup") as HTMLElement).dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 600)); // far past the 100ms grace window
    await expect.element(popup).toBeInTheDocument();

    // the popup is now usable: the note textarea accepts a selection
    await popup.getByRole("textbox").fill("selected note");
    await expect.poll(async () => (await readCodes(id)).some((e) => e.note === "selected note")).toBe(true);
  });

  it("lists the coded segments with a diagram in the Analysis tab", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect.element(page.getByRole("img", { name: /Coding diagram/ })).toBeInTheDocument();
    // the single entry: one proportional stripe + one list row carrying tag, excerpt + device
    await expect.poll(() => document.querySelectorAll(".astripe").length).toBe(1);
    const row = page.getByRole("listitem").filter({ hasText: "Zitat" });
    await expect.element(row).toBeInTheDocument();
    await expect.element(page.getByText("Zitat", { exact: true }).first()).toBeInTheDocument();
  });

  it("deletes a coded segment from the Analysis list", async () => {
    const id = await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect.poll(() => document.querySelectorAll(".arow").length).toBe(1);
    await page.getByRole("button", { name: /Delete segment/ }).click();

    await expect.poll(async () => (await readCodes(id)).length).toBe(0);
    await expect.poll(() => document.querySelectorAll(".astripe").length).toBe(0);
    await expect.element(page.getByText("No coded segments yet")).toBeInTheDocument();
  });

  it("keeps the diagram a fixed height when segments overlap", async () => {
    const many: CodeEntry[] = Array.from({ length: 12 }, (_, i) => ({
      uid: crypto.randomUUID(),
      device: DEVICE_QUOTE,
      line: 1,
      range: [0, 4 + i],
      excerpt: TEXT.slice(0, 4 + i),
    }));
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: many });

    renderArticle();
    await ready();

    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect.poll(() => document.querySelectorAll(".astripe").length).toBe(12);
    // lanes wrap, so the diagram never grows tall enough to squeeze the list out
    const diag = document.querySelector(".adiag") as HTMLElement | null;
    expect(diag).toBeTruthy();
    expect(parseFloat(diag!.style.height)).toBeLessThanOrEqual(100);
    await expect.element(page.getByRole("listitem").first()).toBeInTheDocument();
  });

  it("returns from the Analysis tab with the same editor mounted", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();
    await expect.poll(() => document.querySelectorAll(".cm-underline").length).toBeGreaterThan(0);

    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect.poll(() => document.querySelectorAll(".arow").length).toBe(1);
    // the editor steps out of the layout, it is never unmounted
    expect(document.querySelector(".editor")?.classList.contains("hidden")).toBe(true);

    await page.getByRole("tab", { name: "Coding" }).click();
    await expect.poll(() => document.querySelector(".editor")?.classList.contains("hidden")).toBe(false);
    // CodeMirror's own DOM is back — the body and its marks are rendered again
    await expect.poll(() => document.querySelector(".cm-content")?.textContent).toContain("Zitat");
    await expect.poll(() => document.querySelectorAll(".cm-underline").length).toBeGreaterThan(0);
  });

  it("jumps from an Analysis row to its segment in the Coding tab", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });

    renderArticle();
    await ready();

    await page.getByRole("tab", { name: "Analysis" }).click();
    await expect.poll(() => document.querySelectorAll(".arow").length).toBe(1);
    await page.getByRole("button", { name: /Open segment .* Coding tab/ }).click();

    await expect.element(page.getByRole("tab", { name: "Coding" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => document.querySelector(".cm-content")?.textContent).toContain("Zitat");
  });

  it("folds and unfolds catalog subtrees with an animated caret", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await saveLocalCatalog(FOLDER, testInstructions);

    renderArticle();
    await ready();

    // the seeded catalog opens expanded: the child device is visible
    await expect.element(page.getByRole("treeitem", { name: "Zitat" })).toBeInTheDocument();

    const group = page.getByRole("treeitem", { name: "Rahmen" });
    await expect.element(group).toBeInTheDocument();
    const caret = () => (group.element() as HTMLElement).querySelector(".caret") as HTMLElement | null;
    await expect.poll(() => caret() !== null).toBe(true);

    // fold: the caret rotates back to the chevron and the subtree slides away
    caret()!.click();
    await expect.poll(() => caret()!.classList.contains("open")).toBe(false);
    // the fixture catalog has 2 top-level devices + the folded child = 3 rows
    await expect.poll(() => document.querySelectorAll(".tnode").length).toBe(2);

    // unfold: the caret turns down and the subtree returns
    caret()!.click();
    await expect.poll(() => caret()!.classList.contains("open")).toBe(true);
    await expect.poll(() => document.querySelectorAll(".tnode").length).toBe(3);
    await expect.element(page.getByRole("treeitem", { name: "Zitat" })).toBeInTheDocument();
  });

  it("starts an empty PDF article on Preview, never on Edit", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: "", kind: "pdf" });

    renderArticle();
    // no stored bytes → fallback notice instead of a surface; still no edit affordance
    await expect.element(page.getByText("no stored PDF")).toBeInTheDocument();
    expect(document.querySelectorAll('[role="tab"]').length).toBe(3);
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

  it("offers a download picker and catalog export/import controls", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await expect.element(page.getByRole("button", { name: "Download files" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "JSON", exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: ".qdc" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Import", exact: true })).toBeInTheDocument();
    expect(document.querySelector(".upfolder")).toBeTruthy();

    // the picker lists this project's documents with a select-all toggle
    await page.getByRole("button", { name: "Download files" }).click();
    await expect.element(page.getByRole("dialog", { name: "Download files" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Select all" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "download", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Select all" }).click();
    await expect.element(page.getByRole("button", { name: "download 1", exact: true })).toBeEnabled();
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

describe("minimap", () => {
  const stripes = () => document.querySelectorAll(".mstripe").length;
  const minimapCount = () => document.querySelectorAll(".minimap").length;
  const toggle = () => page.getByRole("button", { name: "Minimap" });

  it("is off by default and toggles the strip on and off", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    expect(minimapCount()).toBe(0);

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);

    await toggle().click();
    await expect.poll(minimapCount).toBe(0);
  });

  it("renders one stripe per coded segment", async () => {
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TEXT,
      entries: [quoteEntry, { device: DEVICE_COMMENT, line: 1, range: [13, 17], excerpt: "Text" }],
    });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);
    // two non-overlapping entries → two disjoint coverage segments → two stripes
    await expect.poll(stripes).toBe(2);
  });

  it("renders nested coverage whose segments share a coverage id", async () => {
    // entry A spans [0,20]; entry B nests inside [5,10]. A splits into [0,5] and
    // [10,20], both covered ONLY by A → the same covering-entry set → the same
    // coverage id. The keyed each must key by segment start, not the coverage id.
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: "aaaaaaaaaaaaaaaaaaaa",
      entries: [
        { device: DEVICE_QUOTE, line: 1, range: [0, 20], excerpt: "a".repeat(20) },
        { device: DEVICE_COMMENT, line: 1, range: [5, 10], excerpt: "aaaaa" },
      ],
    });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);
    // [0,5] {A} · [5,10] {A,B} · [10,20] {A} → three segments, two sharing an id
    await expect.poll(stripes).toBe(3);
  });

  it("persists the toggle across documents", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(() => localStorage.getItem("luci-minimap")).toBe("1");

    // a fresh mount reads the persisted flag: the strip is already on
    lastRender?.unmount();
    lastRender = undefined;
    renderArticle();
    await ready();
    await expect.poll(minimapCount).toBe(1);
  });

  it("scrolls the editor when the minimap track is clicked", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    await seedArticle({ project: FOLDER, name: NAME, text: long, entries: [] });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);

    const scroller = document.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller.scrollTop).toBe(0);

    const mm = document.querySelector(".minimap") as HTMLElement;
    const r = mm.getBoundingClientRect();
    // click near the bottom of the strip: the viewport jumps toward the document end
    mm.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height - 4),
      }),
    );
    await expect.poll(() => (document.querySelector(".cm-scroller") as HTMLElement).scrollTop).toBeGreaterThan(0);
  });

  it("dragging the viewport thumb scrolls the editor", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    await seedArticle({ project: FOLDER, name: NAME, text: long, entries: [] });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);

    const mm = document.querySelector(".minimap") as HTMLElement;
    const thumb = document.querySelector(".mview") as HTMLElement;
    const mr = mm.getBoundingClientRect();
    const tr = thumb.getBoundingClientRect();
    const x = Math.round(mr.left + mr.width / 2);
    const y0 = Math.round(tr.top + tr.height / 2);
    const dy = 100;
    const pev = (type: string, y: number) =>
      mm.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, buttons: 1 }),
      );
    pev("pointerdown", y0);
    pev("pointermove", y0 + dy);
    pev("pointerup", y0 + dy);

    // the thumb follows the cursor downward: the editor scrolls down
    await expect.poll(() => (document.querySelector(".cm-scroller") as HTMLElement).scrollTop).toBeGreaterThan(0);
  });

  it("resizes the strip by dragging its left edge", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);

    const mm = document.querySelector(".minimap") as HTMLElement;
    const grip = document.querySelector(".mmresize") as HTMLElement;
    const before = mm.getBoundingClientRect().width;
    const gr = grip.getBoundingClientRect();
    const y = Math.round(gr.top + gr.height / 2);
    const dx = 50;
    const gx = Math.round(gr.left + 2);
    grip.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        clientX: gx,
        clientY: y,
        buttons: 1,
      }),
    );
    // the strip owns the move (pointer capture routes it there)
    mm.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        clientX: gx - dx,
        clientY: y,
        buttons: 1,
      }),
    );
    mm.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        clientX: gx - dx,
        clientY: y,
        buttons: 1,
      }),
    );

    // dragging the edge leftwards widens the strip, and the width persists
    await expect
      .poll(() => (document.querySelector(".minimap") as HTMLElement).getBoundingClientRect().width)
      .toBeGreaterThan(before + 20);
    await expect.poll(() => localStorage.getItem("luci-minimap-width")).not.toBeNull();
  });

  it("hides the native scrollbar while the minimap is on", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    const sw = () => getComputedStyle(document.querySelector(".cm-scroller") as HTMLElement).scrollbarWidth;
    expect(sw()).not.toBe("none");

    await toggle().click();
    await expect.poll(minimapCount).toBe(1);
    await expect.poll(sw).toBe("none");
  });
});
