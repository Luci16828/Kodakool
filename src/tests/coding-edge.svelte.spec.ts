import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getArticle, listArticles, readCodes, saveLocalCatalog, savePdfData } from "$lib/client/coding-db";
import { extractPdfDoc } from "$lib/coding/pdf";
import { buildPdf } from "$lib/coding/pdf-sample";
import type { CodeEntry } from "$lib/coding/types";
import { FOLDER, NAME, page, quoteEntry, ready, renderArticle, TEXT, unmountArticle } from "./article-harness";
import { DEVICE_QUOTE, resetArticles, seedArticle, testInstructions, uploadTo } from "./fixtures";

const navigated = vi.hoisted(() => [] as string[]);
vi.mock("$app/navigation", () => ({
  goto: (url: string) => {
    navigated.push(url);
    return Promise.resolve();
  },
}));

/** feed the Melt FileUpload input a real File (vitest has no setInputFiles) */
async function upload(...files: File[]): Promise<void> {
  uploadTo('input[type="file"]', ...files);
}

const barError = () => document.querySelector(".bar .msg.err")?.textContent ?? "";

afterEach(() => {
  unmountArticle();
});

beforeEach(async () => {
  navigated.length = 0;
  await resetArticles();
  // the catalog is local-only now: seed it like the example project does
  await saveLocalCatalog(FOLDER, testInstructions);
});

describe("coding page edge cases", () => {
  it("refuses a rename that collides with an existing document", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });
    await seedArticle({ project: FOLDER, name: "other", text: "zweite" });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    await page.getByRole("textbox", { name: "Document name" }).fill("other");
    await userEvent.keyboard("{Enter}");

    await expect.poll(barError).toBe('"other" already exists in test/');
    expect(navigated).toEqual([]);
    await expect.poll(async () => (await getArticle(FOLDER, NAME))?.name).toBe(NAME);
    expect(await getArticle(FOLDER, "other")).not.toBeNull();
  });

  it("accepts a rename over the declared 200-char limit (maxLength is not enforced)", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const long = "x".repeat(250);
    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    await page.getByRole("textbox", { name: "Document name" }).fill(long);
    await userEvent.keyboard("{Enter}");

    // the schema declares maxLength 200, but the Dexie storage accepts it —
    // the rename must complete and follow to the new name
    await expect.poll(async () => (await getArticle(FOLDER, long))?.name).toBe(long);
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain(long);
  });

  it("renames through url-unsafe characters and follows the new url", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    const tricky = "Zitat: 100% #1&2";
    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    await page.getByRole("textbox", { name: "Document name" }).fill(tricky);
    await userEvent.keyboard("{Enter}");

    await expect.poll(async () => (await getArticle(FOLDER, tricky))?.name).toBe(tricky);
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain(tricky);
  });

  it("Escape cancels the rename without touching the database", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await page.getByRole("button", { name: `${NAME}.txt`, exact: true }).click();
    const input = page.getByRole("textbox", { name: "Document name" });
    await input.fill("abgebrochen");
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("button", { name: `${NAME}.txt`, exact: true })).toBeInTheDocument();
    expect(await getArticle(FOLDER, "abgebrochen")).toBeNull();
    expect(navigated).toEqual([]);
  });

  it("refuses an upload whose name already exists in the folder", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await upload(new File(["dup body"], "spd 1.txt", { type: "text/plain" }));

    await expect.poll(() => document.querySelector(".upmsg")?.textContent ?? "").toBe('"spd 1" already exists');
    expect(await getArticle(FOLDER, "spd 1")).toMatchObject({ text: TEXT });
    await expect.poll(async () => (await listArticles()).filter((a) => a.project === FOLDER).length).toBe(1);
  });

  it("ignores a non-text file dropped on the upload input", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await upload(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pic.png", { type: "image/png" }));

    await expect.poll(async () => (await listArticles()).filter((a) => a.project === FOLDER).length).toBe(1);
    expect(await getArticle(FOLDER, "pic")).toBeNull();
  });

  it("reports a broken PDF upload and stores nothing", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await upload(new File(["%PDF-1.4 not a real pdf"], "kaputt.pdf", { type: "application/pdf" }));

    await expect.poll(() => document.querySelector(".upmsg")?.textContent ?? "").toMatch(/^pdf: /);
    expect(await getArticle(FOLDER, "kaputt")).toBeNull();
  });

  it("accepts an empty text upload as an empty article", async () => {
    await seedArticle({ project: FOLDER, name: NAME, text: TEXT });

    renderArticle();
    await ready();

    await upload(new File([""], "leer.txt", { type: "text/plain" }));

    await expect.element(page.getByRole("link", { name: "leer.txt" })).toBeInTheDocument();
    await expect.poll(async () => (await getArticle(FOLDER, "leer"))?.text).toBe("");
  });

  it("reverts a PDF document to a snapshot in the rendered-page view", async () => {
    const bytes = buildPdf(["Hello coding world.", "Zweite Zeile."]);
    const doc = await extractPdfDoc(bytes);
    const entry: CodeEntry = { device: DEVICE_QUOTE, line: 1, range: [0, 19], excerpt: "Hello coding world." };
    const id = await seedArticle({ project: FOLDER, name: NAME, text: doc.text, kind: "pdf", entries: [entry] });
    await savePdfData(id, bytes, doc.pages);

    renderArticle();
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();
    await expect.poll(() => document.querySelector(".pdfpage canvas") !== null).toBe(true);

    // snapshot the initial one-entry state (no CodeMirror exists in this view)
    await page.getByRole("button", { name: "versions (0)" }).click();
    await page.getByRole("button", { name: "Snapshot current state" }).click();
    await expect.element(page.getByRole("button", { name: "versions (1)" })).toBeInTheDocument();

    // code a second entry on the PDF surface
    await page.getByRole("treeitem", { name: "Kommentar" }).click();
    await page.getByText("Zweite Zeile.").first().click();
    await expect.poll(async () => (await readCodes(id)).length).toBe(2);

    // revert must restore the snapshot — the view-less (PDF) commit path
    await page.getByRole("button", { name: "versions (1)" }).click();
    await page.getByRole("button", { name: /Revert to/ }).click();

    await expect.poll(async () => (await readCodes(id)).map((c) => c.excerpt)).toEqual(["Hello coding world."]);
    await expect.element(page.getByRole("button", { name: "versions (2)" })).toBeInTheDocument();
    // one coded entry = one tag chip (selection/preview pseudo-marks are tagless)
    await expect.poll(() => document.querySelectorAll(".pdfchip[data-tag-entry]").length).toBe(1);
  });
});
