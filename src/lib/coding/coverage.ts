import { entryId } from "./edit";
import type { CodeEntry } from "./types";

/**
 * Pure coverage pipeline: the coded-segment geometry shared by the editor marks,
 * the PDF marks, the minimap bars, the sidebar-hover overlay and the Analysis tab.
 * Everything here is a plain function of its inputs — no reactivity, no DOM —
 * so it is unit-testable in isolation (coverage.spec.ts).
 */

/** One coverage placement: a real entry, or the selection/preview pseudo entry. */
export interface Placed {
  entry?: CodeEntry;
  id: string;
  code: string;
  devices: string[];
  from: number;
  to: number;
  faded: boolean;
}

/** Maximal interval with identical coverage, independent of any hover state. */
export interface CoverageSegment {
  id: string;
  ids: string[];
  from: number;
  to: number;
  cov: Placed[];
}

/**
 * Split overlapping placements into disjoint segments (article token parity):
 * sweep line over the boundary points — `active` holds the placements covering
 * the current interval (indices into `placed`, ascending, so cov keeps placed
 * order). The naive per-interval filter over all placements is O(P²) per
 * recompute, and placed changes on every keystroke, selection change and
 * preview crossing.
 */
export function splitSegments(placed: Placed[]): CoverageSegment[] {
  const points = [...new Set(placed.flatMap((p) => [p.from, p.to]))].sort((a, b) => a - b);
  const startsAt = new Map<number, number[]>();
  const endsAt = new Map<number, number[]>();
  placed.forEach((p, i) => {
    const s = startsAt.get(p.from);
    if (s) s.push(i);
    else startsAt.set(p.from, [i]);
    const e = endsAt.get(p.to);
    if (e) e.push(i);
    else endsAt.set(p.to, [i]);
  });
  const out: CoverageSegment[] = [];
  let active: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    // a placement ending exactly at `from` covers the previous interval, not this one
    const end = endsAt.get(from);
    if (end !== undefined) {
      const drop = new Set(end);
      active = active.filter((idx) => !drop.has(idx));
    }
    const start = startsAt.get(from);
    if (start !== undefined) {
      // merge the new indices into the ascending active list
      const merged: number[] = [];
      let a = 0;
      let b = 0;
      while (a < active.length && b < start.length) merged.push(active[a] < start[b] ? active[a++] : start[b++]);
      while (a < active.length) merged.push(active[a++]);
      while (b < start.length) merged.push(start[b++]);
      active = merged;
    }
    if (active.length === 0) continue;
    const cov = active.map((idx) => placed[idx]);
    const ids = cov.map((p) => p.id);
    out.push({ id: [...ids].sort().join("|"), ids, from, to, cov });
  }
  return out;
}

/**
 * Entry size metric (lines dominate chars) for the narrowest-entry rule;
 * pseudo coverage (selection/preview) is ignored (infinite span).
 */
export function spanOf(p: Placed): number {
  if (!p.entry) return Number.POSITIVE_INFINITY;
  return ((p.entry.endLine ?? p.entry.line) - p.entry.line) * 1_000_000 + (p.to - p.from);
}

/** The narrowest real entry of a coverage set (the one a hovered segment marks hot). */
export function narrowest(cov: Placed[]): Placed | undefined {
  return cov
    .filter((p) => p.entry !== undefined)
    .reduce<Placed | undefined>((a, b) => (a === undefined || spanOf(b) < spanOf(a) ? b : a), undefined);
}

/**
 * Single hover model (article hotSetFor parity): hovering a segment marks its
 * narrowest entry hot, hovering a chip marks that entry hot, and the entry is
 * then hot in EVERY segment and chip it covers — bars and chips both render
 * off this one set, so all hover sources go through the same code path.
 * A live selection takes over the emphasis: no hover highlight while it lasts.
 */
export function hotSetFor(
  segments: CoverageSegment[],
  hoverId: string | null,
  hoverChip: string | null,
  selectionActive: boolean,
): Set<string> {
  const s = new Set<string>();
  if (selectionActive) return s;
  const seg = hoverId === null ? undefined : segments.find((x) => x.id === hoverId);
  if (seg !== undefined) {
    const n = narrowest(seg.cov);
    if (n !== undefined) s.add(n.id);
  }
  if (hoverChip !== null) s.add(hoverChip);
  return s;
}

/** A segment with the placements a sidebar-hover subtree lights up (empty = skip). */
export interface LitSegment {
  id: string;
  ids: string[];
  from: number;
  to: number;
  /** the segment's full coverage (for the devices/code summary) */
  cov: Placed[];
  /** the placements lit by the hovered subtree (plus hot entries) */
  lit: Placed[];
  hotIds: Set<string>;
}

/**
 * Sidebar-hover overlay shared by the editor's `hoverSpecs` and the minimap's
 * solid bars: the placements of the hovered catalog subtree (plus hot entries)
 * per segment, in segment order. Segments with no lit placement are dropped.
 */
export function litSegments(segments: CoverageSegment[], keys: Set<string> | null, hot: Set<string>): LitSegment[] {
  if (keys === null) return [];
  const out: LitSegment[] = [];
  for (const { id, ids, from, to, cov } of segments) {
    const lit = cov.filter((p) => (p.entry !== undefined && p.devices[0] && keys.has(p.devices[0])) || hot.has(p.id));
    if (lit.length === 0) continue;
    out.push({ id, ids, from, to, cov, lit, hotIds: new Set(ids.filter((x) => hot.has(x))) });
  }
  return out;
}

/** One Analysis-tab row: a coded segment with its palette identity + line label. */
export interface AnalysisRow {
  id: string;
  from: number;
  to: number;
  code: string;
  label: string;
  name: string;
  excerpt: string;
  note: string;
  lines: string;
  style: string;
}

/**
 * Every coded segment in document order. Positions come from the live geometry
 * when available, else from the entry's stored line/range against the document
 * line starts — so the list is complete on the Preview tab too, where no editor
 * exists. The excerpt is shown verbatim, never re-derived.
 */
export function analysisRows(
  entries: CodeEntry[],
  key: string,
  livePos: Map<string, { from: number; to: number }>,
  docStarts: number[],
  index: { displayByDevice: Map<string, string>; nameByDevice: Map<string, string>; shortByCode: Map<string, string> },
  styleOf: (code: string) => string,
): AnalysisRow[] {
  const out: AnalysisRow[] = [];
  for (const e of entries) {
    const id = entryId(key, e);
    const r = livePos.get(id);
    const from = r?.from ?? docStarts[e.line - 1] + e.range[0];
    const to = r?.to ?? docStarts[(e.endLine ?? e.line) - 1] + e.range[1];
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) continue;
    const deviceKey = e.device ?? e.code ?? "";
    const code = index.displayByDevice.get(deviceKey) ?? deviceKey;
    const endLine = e.endLine ?? e.line;
    out.push({
      id,
      from,
      to,
      code,
      label: index.shortByCode.get(code) ?? code,
      name: index.nameByDevice.get(deviceKey) ?? code,
      excerpt: e.excerpt,
      note: e.note ?? "",
      lines: endLine > e.line ? `${e.line}–${endLine}` : `${e.line}`,
      style: styleOf(code),
    });
  }
  return out.sort((x, y) => x.from - y.from || x.to - y.to);
}
