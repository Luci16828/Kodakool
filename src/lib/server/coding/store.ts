import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCodingJson, verifyCoding } from "../../coding/verify.ts";
import { extractPdfText } from "../../coding/pdf.ts";
import { deviceIndex, instructionsSchema } from "../../coding/instructions.ts";
import { shortSlugs } from "../../coding/shortlabel.ts";
import type { Slug } from "../../coding/shortlabel.ts";
import type { CodeEntry, CodingFile, SourceStatus, SourceStatusKind } from "../../coding/types.ts";
import type { Instructions } from "../../coding/instructions.ts";

export const ROOT = process.cwd();
export const SOURCES_ROOT = path.join(ROOT, "coding_source");
export const CODING_ROOT = path.join(ROOT, "coding");
export const PROGRESS_PATH = path.join(CODING_ROOT, "progress.json");

export interface SourceRef {
  folder: string;
  /** base name without extension, e.g. "spd 1" */
  name: string;
  /** path relative to coding_source/, e.g. "test/spd 1.txt" */
  source: string;
  /** source file kind: PDF sources are verified against their extracted text */
  kind: "txt" | "pdf";
}

export interface CodeView extends Omit<CodeEntry, "code"> {
  /** display code: the stored label, or derived from the entry's device UUID via the folder catalog */
  code: string;
}

export interface CodingViewFile {
  source: string;
  codes: CodeView[];
}

export interface SourceView extends SourceStatus {
  coding: CodingViewFile | null;
  text: string;
}

export function listSources(): SourceRef[] {
  if (!existsSync(SOURCES_ROOT)) return [];
  const refs: SourceRef[] = [];
  for (const folder of readdirSync(SOURCES_ROOT, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const file of readdirSync(path.join(SOURCES_ROOT, folder.name))) {
      if (file.endsWith(".txt")) {
        refs.push({ folder: folder.name, name: file.slice(0, -4), source: `${folder.name}/${file}`, kind: "txt" });
      } else if (file.endsWith(".pdf")) {
        refs.push({ folder: folder.name, name: file.slice(0, -4), source: `${folder.name}/${file}`, kind: "pdf" });
      }
    }
  }
  refs.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return refs;
}

export async function loadSourceText(ref: SourceRef): Promise<string> {
  const raw = readFileSync(path.join(SOURCES_ROOT, ref.source));
  if (ref.kind === "pdf") return (await extractPdfText(raw)).text;
  return raw.toString("utf8");
}

/** Folder's .INSTRUCTIONS.md contents, or null when absent/empty. */
export function readInstructions(folder: string): string | null {
  const file = path.join(SOURCES_ROOT, folder, ".INSTRUCTIONS.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text === "" ? null : text;
}

/** Folder's parsed frame-device catalog document (coding/<folder>/.INSTRUCTIONS.json), or null when absent/invalid. */
export function loadInstructions(folder: string): Instructions | null {
  const file = path.join(CODING_ROOT, folder, ".INSTRUCTIONS.json");
  if (!existsSync(file)) return null;
  try {
    return instructionsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Folder's frame-device catalog (coding/<folder>/.INSTRUCTIONS.json), or null when absent/invalid. */
export function loadCatalog(folder: string): Map<string, { code: string; name: string }> | null {
  const instr = loadInstructions(folder);
  return instr ? deviceIndex(instr) : null;
}

/** Folder names under coding/ that own a frame-device catalog (.INSTRUCTIONS.json). */
export function listCatalogFolders(): string[] {
  if (!existsSync(CODING_ROOT)) return [];
  return readdirSync(CODING_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(CODING_ROOT, d.name, ".INSTRUCTIONS.json")))
    .map((d) => d.name)
    .sort();
}

/** Resolve display codes: device UUIDs become "N.M Name" via the catalog; plain labels pass through. */
export function toCodingView(
  coding: CodingFile,
  catalog: Map<string, { code: string; name: string }> | null,
): CodingViewFile {
  return {
    source: coding.source,
    codes: coding.codes.map((entry) => {
      const device = entry.device !== undefined ? catalog?.get(entry.device) : undefined;
      return {
        ...entry,
        code: device ? `${device.code} ${device.name}` : (entry.code ?? entry.device ?? "(unknown)"),
      };
    }),
  };
}

/** Catalog tree node for the UI; `count` = entries of this article assigned to the device. */
export interface CatalogView {
  id: string;
  code: string;
  name: string;
  kind: "device" | "element";
  count: number;
  /** Manual short-tag override (wins over the heuristic slug). */
  tag?: string | undefined;
  /** Heuristic short label (unique across this article's devices), or null when exhausted. */
  slug: Slug | null;
  /** Legacy code labels from this article that fold into this node. */
  alias?: string[];
  children: CatalogView[];
}

export function toCatalogView(folder: string, codes: CodeView[]): CatalogView[] {
  const keyOf = (c: CodeView) => c.device ?? c.code;
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);

  const file = path.join(CODING_ROOT, folder, ".INSTRUCTIONS.json");
  let nodes: CatalogView[] = [];
  if (existsSync(file)) {
    try {
      const instr = instructionsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      const walk = (d: (typeof instr.devices)[number], code: string): CatalogView => ({
        id: d.id,
        code,
        name: d.name,
        kind: d.kind,
        count: counts.get(d.id) ?? 0,
        ...(d.tag !== undefined ? { tag: d.tag } : {}),
        slug: null,
        children: d.children.map((c, i) => walk(c, `${code}.${i + 1}`)),
      });
      nodes = instr.devices.map((d, i) => walk(d, `${i + 1}`));
    } catch (e) {
      console.warn(`invalid catalog ${file}:`, e);
    }
  }

  const known = new Map<string, CatalogView>();
  const byLabel = new Map<string, CatalogView>();
  for (const n of nodes) {
    const stack = [n];
    while (stack.length) {
      const cur = stack.pop()!;
      known.set(cur.id, cur);
      byLabel.set(cur.code, cur);
      stack.push(...cur.children);
    }
  }
  const orphans = new Map<string, number>();
  for (const c of codes) {
    const key = keyOf(c);
    if (known.has(key)) continue;
    const match = byLabel.get(/^\d+(?:\.\d+)*/.exec(key)?.[0] ?? key);
    if (match) {
      match.count += 1;
      if (key !== match.id && key !== match.code) (match.alias ??= []).push(key);
      continue;
    }
    orphans.set(key, (orphans.get(key) ?? 0) + 1);
  }
  for (const [id, count] of orphans) {
    nodes.push({ id, code: id, name: "", kind: "element", count, slug: null, children: [] });
  }

  // Assign a unique heuristic short label to every node (devices + orphans), pre-order.
  const flat: CatalogView[] = [];
  const flatten = (list: CatalogView[]): void => {
    for (const n of list) {
      flat.push(n);
      flatten(n.children);
    }
  };
  flatten(nodes);
  const tags = flat.map((n) => n.tag).filter((t): t is string => t !== undefined);
  const slugs = shortSlugs(
    flat.map((n) => n.name || n.id),
    tags,
  );
  flat.forEach((n, i) => (n.slug = n.tag !== undefined ? { short: n.tag, bold: [] } : slugs[i]));

  return nodes;
}

export async function loadView(ref: SourceRef): Promise<SourceView> {
  const text = await loadSourceText(ref);
  const base: SourceView = {
    ...ref,
    status: "uncoded" as SourceStatusKind,
    codes: 0,
    errors: [],
    coding: null,
    text,
  };
  const file = path.join(CODING_ROOT, ref.folder, `${ref.name}.json`);
  if (!existsSync(file)) return base;
  let coding: CodingFile;
  try {
    coding = parseCodingJson(readFileSync(file, "utf8"));
  } catch (e) {
    return { ...base, status: "failed", errors: [e instanceof Error ? e.message : String(e)] };
  }
  const errors = (
    coding.source === ref.source ? [] : [`"source" is "${coding.source}" but expected "${ref.source}"`]
  ).concat(verifyCoding(text, coding).map((e) => `entry #${e.index + 1}: ${e.message}`));
  return {
    ...base,
    status: errors.length ? "failed" : "verified",
    codes: coding.codes.length,
    errors,
    coding: toCodingView(coding, loadCatalog(ref.folder)),
  };
}

export async function loadAllViews(): Promise<SourceView[]> {
  return Promise.all(listSources().map(loadView));
}
