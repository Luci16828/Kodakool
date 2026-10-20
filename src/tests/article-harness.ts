import { page } from "vitest/browser";
import { expect } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ArticlePage from "../routes/text/[folder]/[name]/+page.svelte";
import type { CodeEntry } from "$lib/coding/types";
import { DEVICE_QUOTE } from "./fixtures";

/**
 * Shared coding-page harness for the UI specs (article / coding-edge /
 * quickselect): the seeded document identity, the keyed page mount with the
 * colors context, and the locators every coding spec repeats.
 */

export { page };

export const FOLDER = "test";
export const NAME = "spd 1";
export const TEXT = "Ein Zitat im Text.";

/** entry for the word `Zitat` (offsets 4..9 of the single-line body) */
export const quoteEntry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" };

let lastRender: ReturnType<typeof render> | undefined;

/** mount the coding page for this project + document with the colors context */
export function renderArticle(name = NAME, folder = FOLDER) {
  lastRender = render(ArticlePage, { data: { folder, name } }, { wrapper: ColorProvider });
  return lastRender;
}

/**
 * Unmount the last render: the coding page flushes queued autosaves on unmount,
 * so the next test's resetArticles/seedArticle never races a late flush (CONFLICT).
 */
export function unmountArticle(): void {
  lastRender?.unmount();
  lastRender = undefined;
}

/** waits until the local article has been handed to CodeMirror */
export async function ready(): Promise<void> {
  await expect.element(page.getByRole("textbox")).toBeInTheDocument();
  // the icon font arrives asynchronously: every icon width (and with it the bar's
  // whole layout) jumps when it lands, so a click can straddle the shift
  await document.fonts.ready;
}

export const editor = () => page.getByRole("textbox").first();
export const marks = () => document.querySelectorAll(".cm-underline").length;
export const chips = () => [...document.querySelectorAll(".cm-tag")].map((el) => el.textContent ?? "");
