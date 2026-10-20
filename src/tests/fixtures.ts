import { addVersion, createArticle, getDb, renameArticle, saveArticle, skipConflict } from "$lib/client/coding-db";
import type { Instructions } from "$lib/coding/instructions";
import type { CodeEntry } from "$lib/coding/types";

/**
 * Shared fixtures for the UI (browser) tests: a small frame-device catalog and
 * helpers to seed/wipe the local-first RxDB article store.
 */

export const DEVICE_FRAME = "11111111-1111-4111-8111-111111111111";
export const DEVICE_QUOTE = "22222222-2222-4222-8222-222222222222";
export const DEVICE_COMMENT = "33333333-3333-4333-8333-333333333333";

/** `1 Rahmen > 1.1 Zitat` and `2 Kommentar` (codes are derived from tree position). */
export const testInstructions: Instructions = {
  version: 1,
  title: "Test catalog",
  devices: [
    {
      id: DEVICE_FRAME,
      name: "Rahmen",
      kind: "element",
      examples: [],
      children: [{ id: DEVICE_QUOTE, name: "Zitat", kind: "device", examples: [], children: [] }],
    },
    { id: DEVICE_COMMENT, name: "Kommentar", kind: "device", examples: [], children: [] },
  ],
};

/**
 * Drive a file input in the browser (vitest has no setInputFiles): build a
 * DataTransfer with the files and fire `change` — the pattern every upload
 * spec needs (db import, catalog import, dropzone, folder picker).
 * Dropzone/folder-picker specs target `.uprow input[type="file"]` (UploadZone
 * renders the `.upfolder` input before Melt's) — a bare `input[type="file"]`
 * would hit the sidebar's `.dbfile` import input, which sits above the row.
 */
export function uploadTo(selector: string, ...files: File[]): void {
  const input = document.querySelector(selector) as HTMLInputElement;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Remove every article + entry + PDF + folder + local catalog so a test file never depends on the previous one. */
export async function resetArticles(): Promise<void> {
  // a previous page's unmount autosave flush may race here: conflicts are expected, skip them —
  // but a skipped delete would leak a stale doc into the next test, so re-pass until empty
  for (let pass = 0; pass < 6; pass++) {
    const { articles, codes, catalogs, pdfs, folders } = await getDb();
    const cols = [codes, articles, catalogs, pdfs, folders];
    for (const c of cols) await Promise.all((await c.find().exec()).map((d) => d.remove().catch(skipConflict)));
    const left = await Promise.all(cols.map((c) => c.find().exec()));
    if (left.every((l) => l.length === 0)) break;
    await new Promise((r) => setTimeout(r, 60));
  }
}

export interface SeedArticle {
  project: string;
  name: string;
  text: string;
  /** "pdf" seeds a read-only PDF-derived article */
  kind?: "text" | "pdf";
  entries?: CodeEntry[];
  /** labels of versions to snapshot after seeding */
  versions?: string[];
}

/** Create an article with a fixed name/body/entries; returns its id. */
export async function seedArticle(seed: SeedArticle): Promise<string> {
  const created = await createArticle(seed.project, seed.kind ?? "text");
  await saveArticle(created.id, seed.text, seed.entries ?? []);
  await renameArticle(created.id, seed.name);
  for (const label of seed.versions ?? []) await addVersion(created.id, label);
  return created.id;
}
