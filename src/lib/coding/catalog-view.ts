import type { FrameDevice, Instructions } from "./instructions";
import { shortSlugs } from "./shortlabel";
import type { Slug } from "./shortlabel";

/** Catalog tree node for the UI; `count` = entries assigned to this device. */
export interface CatalogView {
  id: string;
  code: string;
  name: string;
  kind: "device" | "element";
  count: number;
  /** Manual short-tag override (wins over the heuristic slug). */
  tag?: string | undefined;
  /** Heuristic short label (unique across the catalog's devices), or null when exhausted. */
  slug: Slug | null;
  /** Legacy code labels from this article that fold into this node. */
  alias?: string[];
  children: CatalogView[];
}

/**
 * Client-side CatalogView builder:
 * numeric codes are derived from tree position, short tags from `shortSlugs`
 * (manual `tag` overrides win and reserve their label), entry keys that are
 * not in the catalog fold into matching nodes or surface as orphan rows.
 *
 * `entryKeys` is one raw key (`device` uuid or legacy `code`) per entry.
 */
export function buildCatalogView(instr: Instructions | null, entryKeys: Iterable<string>): CatalogView[] {
  const keyCount = new Map<string, number>();
  for (const key of entryKeys) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);

  const walk = (d: FrameDevice, code: string): CatalogView => ({
    id: d.id,
    code,
    name: d.name,
    kind: d.kind,
    count: keyCount.get(d.id) ?? 0,
    ...(d.tag !== undefined ? { tag: d.tag } : {}),
    slug: null,
    children: d.children.map((c, i) => walk(c, `${code}.${i + 1}`)),
  });
  const nodes: CatalogView[] = instr ? instr.devices.map((d, i) => walk(d, `${i + 1}`)) : [];

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
  for (const [key, count] of keyCount) {
    if (known.has(key)) continue;
    const match = byLabel.get(/^\d+(?:\.\d+)*/.exec(key)?.[0] ?? key);
    if (match) {
      match.count += count;
      continue;
    }
    orphans.set(key, count);
  }
  for (const [id, count] of orphans) {
    nodes.push({ id, code: id, name: "", kind: "element", count, slug: null, children: [] });
  }

  const flat = flattenCatalog(nodes);
  const tags = flat.map((n) => n.tag).filter((t): t is string => t !== undefined);
  const slugs = shortSlugs(
    flat.map((n) => n.name || n.id),
    tags,
  );
  flat.forEach((n, i) => (n.slug = n.tag !== undefined ? { short: n.tag, bold: [] } : slugs[i]));

  return nodes;
}

/** Depth-first flatten: every node once, parents before children. */
export function flattenCatalog(nodes: CatalogView[]): CatalogView[] {
  const flat: CatalogView[] = [];
  const walk = (list: CatalogView[]): void => {
    for (const n of list) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return flat;
}

/**
 * One-pass lookup index over a flattened catalog, built by a single walk:
 * the sidebar rows, the entry-key → node mapping, the numeric display codes,
 * the names and the short tags all come from the same traversal.
 */
export interface CatalogIndex {
  /** every node, parents before children (sidebar order + quick select lookup) */
  nodes: CatalogView[];
  /** catalog id → node */
  byId: Map<string, CatalogView>;
  /** catalog id → numeric display code */
  displayByDevice: Map<string, string>;
  /** catalog id → device name */
  nameByDevice: Map<string, string>;
  /** numeric display code → short tag (LTE etc.) */
  shortByCode: Map<string, string>;
  /** entry key (device id | numeric code | legacy alias) → catalog id */
  keyToId: Map<string, string>;
}

export function indexCatalog(nodes: CatalogView[]): CatalogIndex {
  const flat = flattenCatalog(nodes);
  const byId = new Map<string, CatalogView>();
  const displayByDevice = new Map<string, string>();
  const nameByDevice = new Map<string, string>();
  const shortByCode = new Map<string, string>();
  const keyToId = new Map<string, string>();
  for (const n of flat) {
    byId.set(n.id, n);
    displayByDevice.set(n.id, n.code);
    nameByDevice.set(n.id, n.name);
    if (n.slug) shortByCode.set(n.code, n.slug.short);
    keyToId.set(n.id, n.id);
    keyToId.set(n.code, n.id);
    for (const a of n.alias ?? []) keyToId.set(a, n.id);
  }
  return { nodes: flat, byId, displayByDevice, nameByDevice, shortByCode, keyToId };
}
