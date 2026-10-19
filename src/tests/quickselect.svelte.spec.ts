import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ArticlePage from "../routes/text/[folder]/[name]/+page.svelte";
import { saveLocalCatalog } from "$lib/client/coding-db";
import { Q_OPEN_MS } from "$lib/coding/quickselect";
import type { CodeEntry } from "$lib/coding/types";
import { DEVICE_COMMENT, DEVICE_FRAME, DEVICE_QUOTE, resetArticles, seedArticle, testInstructions } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

const FOLDER = "qtest";
const NAME = "quick.txt";
const TEXT = "Ein Zitat im Text.";
/** two sentences, so two smart clicks code two different spans */
const TWO = "Ein Zitat im Text. Ein zweiter Satz.";

/** short tag of the fixture catalog → its device id */
const idOfTag: Record<string, string> = { R: DEVICE_FRAME, Z: DEVICE_QUOTE, K: DEVICE_COMMENT };

/** `Zitat` (offsets 4..9) coded with the quote device */
const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };
/** `Ein` (offsets 0..3) coded with the quote device: a second, distinct quote entry */
const einEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 3], excerpt: "Ein" };
/** `Text` (offsets 13..17) coded with the comment device */
const commentEntry: CodeEntry = { device: DEVICE_COMMENT, line: 1, range: [13, 17], excerpt: "Text" };

let lastRender: ReturnType<typeof render> | undefined;

function renderArticle() {
  lastRender = render(ArticlePage, { data: { folder: FOLDER, name: NAME } }, { wrapper: ColorProvider });
  return lastRender;
}

/** waits until the article is live in CodeMirror */
async function ready(): Promise<void> {
  await expect.element(page.getByRole("textbox")).toBeInTheDocument();
  // the icon font arrives asynchronously: every icon width (and with it the bar's
  // whole layout) jumps when it lands, so a click can straddle the shift
  await document.fonts.ready;
}

const editor = () => page.getByRole("textbox").first();
const marks = () => document.querySelectorAll(".cm-underline").length;
const chips = () => [...document.querySelectorAll(".cm-tag")].map((el) => el.textContent ?? "");
const ctag = () => document.querySelector(".ctag")?.textContent ?? "";

/** a point inside the editor, so both lists of the menu have room */
function centerPoint(): { x: number; y: number } {
  const c = document.querySelector(".cm-content")!.getBoundingClientRect();
  return { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) };
}

/** short tag of a menu tag (the cascade arrow is not part of the label) */
const tagText = (el: Element) => (el.textContent ?? "").replace("›", "").trim();
const leftTags = () => [...document.querySelectorAll(".qleft .qtag")].map(tagText);
const columns = () =>
  [...document.querySelectorAll(".qright .qcol")].map((c) => [...c.querySelectorAll(".qtag")].map(tagText));
const menuOpen = () => document.querySelectorAll(".quickmenu").length;
const hotTags = () => document.querySelectorAll(".qtag.hot").length;
const mid = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/**
 * Where the right button was pressed. The menu runs on pointer lock when the
 * browser grants it, and then only reports movement deltas — so the helpers move
 * the synthetic cursor by the same amount the pointer travelled.
 */
let press = { x: 0, y: 0 };

/** vitest's `page` has no Playwright mouse: dispatch the events the menu listens for */
function fire(target: EventTarget, type: string, init: MouseEventInit): void {
  // CodeMirror derives the click type from `detail`: 0 reads as a triple click
  // (select the whole block), so button events must carry a click count of 1.
  const click = type === "mousedown" || type === "mouseup" || type === "click";
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: click ? 1 : 0, ...init }),
  );
}

/** the editor body: the right press that arms the menu is listened for on the document surface */
const surface = () => document.querySelector(".cm-content")!;

async function openMenu(): Promise<void> {
  press = centerPoint();
  fire(surface(), "mousedown", { clientX: press.x, clientY: press.y, button: 2, buttons: 2 });
  await expect.poll(menuOpen).toBe(1);
}

async function releaseMenu(): Promise<void> {
  fire(window, "mouseup", { clientX: press.x, clientY: press.y, button: 2, buttons: 0 });
  await expect.poll(menuOpen).toBe(0);
}

/** drag the held cursor onto the menu tag labelled `label` */
async function moveToTag(label: string): Promise<void> {
  const el = [...document.querySelectorAll<HTMLElement>(".qtag")].find((e) => tagText(e) === label);
  if (!el) throw new Error(`no quick select tag ${label}`);
  const b = el.getBoundingClientRect();
  const to = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  // hover drives the no-lock fallback, the deltas drive the pointer-lock cursor
  el.dispatchEvent(
    new PointerEvent("pointerover", { bubbles: true, cancelable: true, clientX: to.x, clientY: to.y, pointerId: 1 }),
  );
  el.dispatchEvent(new PointerEvent("pointerenter", { cancelable: true, clientX: to.x, clientY: to.y, pointerId: 1 }));
  fire(window, "mousemove", {
    clientX: to.x,
    clientY: to.y,
    movementX: to.x - press.x,
    movementY: to.y - press.y,
    buttons: 2,
  });
  press = to;
  await expect.poll(hotTags).toBe(1);
}

/** left click while the menu is held: pins the tag under the cursor */
async function clickPin(): Promise<void> {
  fire(window, "mousedown", { clientX: press.x, clientY: press.y, button: 0, buttons: 1 });
  fire(window, "mouseup", { clientX: press.x, clientY: press.y, button: 0, buttons: 0 });
}

/** the text nodes carrying a line's characters, in document order (chips excluded) */
function lineChars(line: Element): Text[] {
  const out: Text[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n as Text);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    // chips and widget buffers carry label text, not document characters
    if (el.classList.contains("cm-tag") || el.classList.contains("cm-widgetBuffer")) return;
    for (const c of n.childNodes) walk(c);
  };
  for (const c of line.childNodes) walk(c);
  return out;
}

/** viewport x of a character range in the editor's first line (font-true, not offsets) */
function wordBounds(from: number, to: number): { left: number; right: number; y: number } {
  const line = document.querySelector(".cm-line")!;
  // the line mixes plain text nodes, `.cm-underline` wrappers and chip widgets,
  // so offsets are accumulated over the text nodes that carry characters
  const nodes = lineChars(line);
  const r = document.createRange();
  let acc = 0;
  let started = false;
  let ended = false;
  for (const n of nodes) {
    const len = n.data.length;
    if (!started && from <= acc + len) {
      r.setStart(n, from - acc);
      started = true;
    }
    if (started && !ended && to <= acc + len) {
      r.setEnd(n, to - acc);
      ended = true;
      break;
    }
    acc += len;
  }
  if (!started) {
    const last = nodes[nodes.length - 1];
    r.setStart(last, last.data.length);
    r.setEnd(last, last.data.length);
  } else if (!ended) {
    const last = nodes[nodes.length - 1];
    r.setEnd(last, last.data.length);
  }
  const b = r.getBoundingClientRect();
  const l = line.getBoundingClientRect();
  return { left: b.left, right: b.right, y: Math.round(l.top + l.height / 2) };
}

/** drag-select the character range `[from, to)` (smart select snaps it to the words) */
async function selectSpan(from: number, to: number): Promise<void> {
  const content = document.querySelector(".cm-content")!;
  const w = wordBounds(from, to);
  fire(content, "mousedown", { clientX: Math.round(w.left) + 1, clientY: w.y, button: 0, buttons: 1 });
  fire(content, "mousemove", { clientX: Math.round(w.right) - 1, clientY: w.y, buttons: 1 });
  fire(content, "mouseup", { clientX: Math.round(w.right) - 1, clientY: w.y, button: 0, buttons: 0 });
}

/** code a span by releasing the held right button over a menu tag (works for parents too) */
async function codeWithMenu(tag: string, from: number, to: number): Promise<void> {
  // disarm first: a release over a tag keeps that device armed, and the drag below
  // would then code with the stale device instead of the one picked here
  await userEvent.keyboard("{Escape}");
  await selectSpan(from, to);
  await openMenu();
  await moveToTag(tag);
  await releaseMenu();
}

/** the pinned device ids of the open document (the store keys them by article id) */
function pinnedIds(): string[] {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith("luci-quick-pins:"));
  return keys.flatMap((k) => (JSON.parse(localStorage.getItem(k) ?? "[]") as string[]).filter((x) => x !== ""));
}

const quickKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("luci-quick"));

/** code one span with a catalog device (tree click + smart click at `x`) */
async function codeWith(deviceName: string, x: number): Promise<void> {
  await page.getByRole("treeitem", { name: deviceName }).click();
  await editor().click({ position: { x, y: 30 } });
}

afterEach(async () => {
  // unmount before the next test seeds: the page's unmount commit flush must land
  // before the store is emptied, or its write resurrects code docs the next
  // test's seed then collides with (RxDB COL22 on the codes collection)
  lastRender?.unmount();
  lastRender = undefined;
  await new Promise((r) => setTimeout(r, 150));
  await resetArticles();
});

beforeEach(async () => {
  navigated.length = 0;
  for (const k of quickKeys()) localStorage.removeItem(k);
  await resetArticles();
  await saveLocalCatalog(FOLDER, testInstructions);
});

describe("quick select menu", () => {
  it("opens on the right button: recent slots left, top-level categories right", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [einEntry, quoteEntry, commentEntry] });
    renderArticle();
    await ready();

    await openMenu();

    // five slots by default, the used codes in the first rows
    await expect.poll(() => document.querySelectorAll(".qleft .qrow").length).toBe(5);
    expect(new Set(leftTags().slice(0, 2))).toEqual(new Set(["K", "Z"]));
    // the catalog's top level (Rahmen, Kommentar) starts the cascade
    expect(columns()).toEqual([["R", "K"]]);
    // the lists hang off the cursor with a gap on both sides, centred on it
    const p = centerPoint();
    const left = document.querySelector(".qleft")!.getBoundingClientRect();
    const right = document.querySelector(".qright")!.getBoundingClientRect();
    expect(left.right).toBeLessThan(p.x - 5);
    expect(right.left).toBeGreaterThan(p.x + 5);
    expect(Math.abs((left.top + left.bottom) / 2 - p.y)).toBeLessThan(3);

    await releaseMenu();
  });

  it("stays closed on a quick plain right click and opens on the first drag", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry, commentEntry] });
    renderArticle();
    await ready();

    // dismissing a popover with the right button must not flash the menu: a press
    // released inside the hold window never opens it
    press = centerPoint();
    fire(surface(), "mousedown", { clientX: press.x, clientY: press.y, button: 2, buttons: 2 });
    fire(window, "mouseup", { clientX: press.x, clientY: press.y, button: 2, buttons: 0 });
    await expect.poll(menuOpen, { timeout: 500, interval: 50 }).toBe(0);

    // a drag is an intentional press: it opens before the hold window ends
    press = centerPoint();
    fire(surface(), "mousedown", { clientX: press.x, clientY: press.y, button: 2, buttons: 2 });
    fire(window, "mousemove", {
      clientX: press.x + 14,
      clientY: press.y,
      movementX: 14,
      movementY: 0,
      buttons: 2,
    });
    await expect.poll(menuOpen, { timeout: 60 }).toBe(1);
    await releaseMenu();
  });

  it("gives every tag the same width and no rounded corners", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry, commentEntry] });
    renderArticle();
    await ready();

    await openMenu();
    const tags = [...document.querySelectorAll<HTMLElement>(".qtag")];
    expect(tags.length).toBeGreaterThan(3);
    expect(new Set(tags.map((e) => e.offsetWidth)).size).toBe(1);
    expect(tags[0].offsetWidth).toBe(56);
    expect(new Set(tags.map((e) => getComputedStyle(e).borderRadius)).size).toBe(1);
    expect(tags[0].offsetWidth).toBe(56);
    await releaseMenu();
  });

  it("arms the tag the right button is released on, with the sidebar color", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await openMenu();
    await moveToTag("K");
    await releaseMenu();

    // the cursor tag carries the short tag, colored like the catalog sidebar's selection
    await expect.poll(ctag).toBe("K");
    // the sidebar row fades into its marker color, so compare after the transition
    await expect
      .poll(() => {
        const sel = document.querySelector<HTMLElement>(".tnode.sel");
        const tag = document.querySelector<HTMLElement>(".ctag");
        if (!sel || !tag) return false;
        return getComputedStyle(tag).backgroundColor === getComputedStyle(sel).backgroundColor;
      })
      .toBe(true);

    // Esc disarms again
    await userEvent.keyboard("{Escape}");
    await expect.poll(ctag).toBe("");
  });

  it("codes the live selection with the released tag", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();
    await expect.poll(marks).toBe(1);

    await selectSpan(4, 9);
    await openMenu();
    await moveToTag("K");
    await releaseMenu();

    // the released selection is coded with the tag picked in the menu
    await expect.poll(marks).toBe(1);
    await expect.poll(() => chips().sort()).toEqual(["K", "Z"]);
  });

  it("de-arms when the right button is released over nothing", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await codeWith("Kommentar", 12);
    await expect.poll(ctag).toBe("K");

    await openMenu();
    await releaseMenu();
    await expect.poll(ctag).toBe("");
  });

  it("opens sub-categories as the cursor drags over a category", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await openMenu();
    expect(columns()).toEqual([["R", "K"]]);

    // `Rahmen` has a child: dragging onto it opens the next column
    await moveToTag("R");
    await expect.poll(columns).toEqual([["R", "K"], ["Z"]]);

    // the opened chain keeps its selected styling while the sub-menu is used
    const selOf = () => [...document.querySelectorAll<HTMLElement>(".qright .qtag.sel")].map(tagText);
    expect(selOf()).toEqual(["R"]);
    await moveToTag("Z");
    expect(selOf()).toEqual(["R"]);

    // the new column is centred on the item that opened it
    const parent = [...document.querySelectorAll<HTMLElement>(".qright .qcol .qtag")].find((e) => tagText(e) === "R")!;
    const child = document.querySelectorAll<HTMLElement>(".qright .qcol")[1].querySelector(".qtag")!;
    expect(Math.abs(mid(parent) - mid(child))).toBeLessThan(2);

    // a leaf closes the deeper columns again
    await moveToTag("K");
    await expect.poll(columns).toEqual([["R", "K"]]);
    await releaseMenu();
  });

  it("previews the full name of the hovered code on the outer side", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await openMenu();
    // right-hand leaf: the name appears right of the cascade
    await moveToTag("R");
    await expect.poll(() => document.querySelector(".qright .qname")?.textContent).toBe("Rahmen");
    const name = document.querySelector(".qright .qname")!.getBoundingClientRect();
    const last = [...document.querySelectorAll(".qright .qcol")].at(-1)!.getBoundingClientRect();
    expect(name.left).toBeGreaterThan(last.right - 1);

    // left-hand slot: the name appears left of the slot list
    await moveToTag("Z");
    await expect.poll(() => document.querySelector(".qleft .qname")?.textContent).toBe("Zitat");
    const lname = document.querySelector(".qleft .qname")!.getBoundingClientRect();
    const list = document.querySelector(".qleft")!.getBoundingClientRect();
    expect(lname.right).toBeLessThan(list.left + 1);

    await releaseMenu();
  });

  it("keeps slot positions stable when a new code enters the list", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [einEntry, quoteEntry, commentEntry] });
    renderArticle();
    await ready();

    await openMenu();
    const before = leftTags().slice(0, 2);
    expect(new Set(before)).toEqual(new Set(["K", "Z"]));
    await releaseMenu();

    // coding a span with the frame device puts it into the ranking
    await codeWithMenu("R", 4, 9);
    await expect.poll(() => chips().sort()).toEqual(["K", "R", "Z", "Z"]);

    // the fresh code takes the first free slot; the used codes keep their rows
    await openMenu();
    const after = leftTags().slice(0, 3);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toBe("R");
    await releaseMenu();
  });

  it("pins a code in its slot, past the recent/top gate", async () => {
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TWO,
      entries: [quoteEntry, commentEntry, { ...commentEntry, line: 1, range: [19, 22], excerpt: "Ein" }],
    });
    renderArticle();
    await ready();

    await openMenu();
    const last = leftTags()[1];
    await moveToTag(last);
    await clickPin();
    await releaseMenu();
    await expect.poll(() => pinnedIds()).toContain(idOfTag[last]);

    // the pinned tag keeps its row while the codes coded afterwards fill the free slots
    await codeWithMenu("R", 4, 9);
    await codeWithMenu("R", 31, 35);
    await expect.poll(marks).toBeGreaterThanOrEqual(4);

    await openMenu();
    expect(leftTags()[1]).toBe(last);
    await expect.element(page.getByRole("button", { name: `unpin ${last} for this document` })).toBeInTheDocument();

    // unpinning leaves the row to the ranking again
    await moveToTag(last);
    await clickPin();
    await releaseMenu();
    await openMenu();
    expect(pinnedIds()).toEqual([]);
    expect(leftTags()).toContain("R");
    await releaseMenu();
  });

  it("hands an unpinned slot back to the ranking", async () => {
    await seedArticle({
      project: FOLDER,
      name: NAME,
      text: TWO,
      entries: [quoteEntry, commentEntry, { ...commentEntry, line: 1, range: [19, 22], excerpt: "Ein" }],
    });
    renderArticle();
    await ready();

    await openMenu();
    expect(leftTags()).not.toContain("R");
    await releaseMenu();

    await codeWithMenu("R", 4, 9);
    await codeWithMenu("R", 31, 35);
    await expect.poll(marks).toBeGreaterThanOrEqual(4);

    await openMenu();
    // the new top code takes a slot that nothing is pinned to
    expect(leftTags()).toContain("R");
    await releaseMenu();
  });

  it("pins a cascade tag into a free slot", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await openMenu();
    // K is a top-level category here, not one of the recent slots
    expect(leftTags()).not.toContain("K");
    await moveToTag("K");
    await clickPin();
    await releaseMenu();
    await expect.poll(() => pinnedIds()).toContain(DEVICE_COMMENT);

    // a pinned code with no entries at all survives the recent/top gate
    await openMenu();
    expect(leftTags()).toContain("K");
    await releaseMenu();
  });

  it("closes with Escape and stays closed on the right button in edit mode", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    await openMenu();
    await userEvent.keyboard("{Escape}");
    await expect.poll(menuOpen).toBe(0);

    await page.getByRole("tab", { name: "Edit" }).click();
    const p = centerPoint();
    fire(surface(), "mousedown", { clientX: p.x, clientY: p.y, button: 2, buttons: 2 });
    expect(menuOpen()).toBe(0);
    fire(window, "mouseup", { clientX: p.x, clientY: p.y, button: 2, buttons: 0 });
  });

  it("arms only on the document surface: a right press in the sidebar never opens it", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    // the tree sidebar is outside the document: holding the right button there
    // must not arm the menu (its own context menus own that region)
    const aside = document.querySelector("aside.docs")!;
    const r = aside.getBoundingClientRect();
    fire(aside, "mousedown", {
      clientX: Math.round(r.left + 20),
      clientY: Math.round(r.top + 20),
      button: 2,
      buttons: 2,
    });
    // past the hold window: still closed
    await new Promise((res) => setTimeout(res, Q_OPEN_MS + 150));
    expect(menuOpen()).toBe(0);
    fire(window, "mouseup", {
      clientX: Math.round(r.left + 20),
      clientY: Math.round(r.top + 20),
      button: 2,
      buttons: 0,
    });

    // inside the editor the same press opens it
    await openMenu();
    await releaseMenu();
  });

  it("a plain left click dismisses the menu and de-arms", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    // arm a device first, so the de-arm is observable
    await codeWith("Kommentar", 12);
    await expect.poll(ctag).toBe("K");

    await openMenu();
    // no movement needed: the left click itself closes the menu and drops the armed device
    fire(window, "mousedown", { clientX: press.x, clientY: press.y, button: 0, buttons: 1 });
    fire(window, "mouseup", { clientX: press.x, clientY: press.y, button: 0, buttons: 0 });
    await expect.poll(menuOpen).toBe(0);
    await expect.poll(ctag).toBe("");
  });

  it("keeps the bar above the text on a single line", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT, entries: [quoteEntry] });
    renderArticle();
    await ready();

    const bar = document.querySelector(".bar")!;
    const mids = [...bar.children].map((el) => mid(el));
    expect(mids.length).toBeGreaterThan(5);
    // one line: every pill shares the bar's vertical centre
    expect(Math.max(...mids) - Math.min(...mids)).toBeLessThan(2);
    expect(getComputedStyle(bar).flexWrap).toBe("nowrap");
  });
});
