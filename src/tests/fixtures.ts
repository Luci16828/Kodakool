import {
  addVersion,
  createArticleNamed,
  deleteFolder,
  listProjects,
  setLocalCodes,
  setLocalBackend,
} from "$lib/local/local-api";
import { AccountStore } from "$lib/remote/accounts.svelte";
import type { Instructions } from "$lib/coding/instructions";
import type { CodeEntry } from "$lib/coding/types";

/**
 * Shared fixtures for the UI (browser) tests: a small frame-device catalog and
 * helpers to seed/wipe the Local account — the server running in the SharedWorker.
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
 * Specs render pages directly (no layout), so the worker-backed Local store
 * needs its backend wired by hand — a bare AccountStore (its localStorage
 * $effect only runs for component-mounted stores, which the page wrappers do).
 */
let storeBound = false;
export function localBackend(): void {
  if (!storeBound) {
    setLocalBackend(new AccountStore());
    storeBound = true;
  }
}

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

/** Wipe every project (the server cascades docs + entries + PDFs + catalogs). */
export async function resetArticles(): Promise<void> {
  localBackend();
  // a previous page's unmount autosave flush may race here: re-pass until empty
  for (let pass = 0; pass < 6; pass++) {
    const projects = await listProjects();
    if (projects.length === 0) break;
    for (const p of projects) await deleteFolder(p.name);
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

/** Create a document with a fixed name/body/entries; returns its id. */
export async function seedArticle(seed: SeedArticle): Promise<string> {
  localBackend();
  const created = await createArticleNamed(seed.project, seed.name, seed.text, "", seed.kind ?? "text");
  if (seed.entries && seed.entries.length > 0) await setLocalCodes(created.id, seed.entries);
  for (const label of seed.versions ?? []) await addVersion(created.id, label);
  return created.id;
}
