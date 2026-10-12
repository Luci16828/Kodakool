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
