/**
 * Quick select menu (opened by holding the right mouse button) for device codes.
 *
 * Pure logic only: the usage ranking behind the "top used/recent" list and the
 * stable slot reconciliation. The menu markup lives in `QuickSelect.svelte`,
 * its persistence in `quickselect.svelte.ts`.
 */

export const QUICK_COUNT_DEFAULT = 5;
/** the N most recent uses get a ranking boost, so a fresh code enters the menu */
export const QUICK_RECENCY_WINDOW = 3;

/**
 * Rank device ids by how much this document uses them.
 *
 * `counts` is entries per device id; `recency` lists device ids oldest → newest
 * (the order the entries were created). Usage count dominates, and the last
 * `QUICK_RECENCY_WINDOW` uses add a small boost so the code just coded enters
 * the menu even when the document already has busier codes.
 * Only ids with at least one entry are ranked.
 */
export function rankDevices(counts: Map<string, number>, recency: string[]): string[] {
  const lastAt = new Map<string, number>();
  recency.forEach((id, i) => lastAt.set(id, i));
  const n = recency.length;
  const boost = (id: string): number => {
    const at = lastAt.get(id);
    if (at === undefined) return 0;
    const ago = n - 1 - at;
    return ago < QUICK_RECENCY_WINDOW ? QUICK_RECENCY_WINDOW - ago : 0;
  };
  const score = (id: string): number => (counts.get(id) ?? 0) + boost(id);
  return [...counts.keys()]
    .filter((id) => (counts.get(id) ?? 0) > 0)
    .sort((a, b) => score(b) - score(a) || (lastAt.get(b) ?? -1) - (lastAt.get(a) ?? -1) || (a < b ? -1 : 1));
}

/** fixed tag box + row metrics (px): the lists are laid out arithmetically */
export const Q_TAG_W = 56;
export const Q_PIN_W = 20;
export const Q_ROW_H = 24;
export const Q_COL_W = 58;
/** breathing room around the cursor, between the two lists */
export const Q_GAP = 10;
/** max width of the full-name preview the menu shows outside a hovered tag */
export const Q_NAME_W = 110;
/** a right press becomes the menu after this many ms of being held ... */
export const Q_OPEN_MS = 100;
/** ... or as soon as it has moved this many px (a drag is an intentional press) */
export const Q_OPEN_SLOP = 4;

/** one tag box of the menu: top-left corner in viewport coordinates */
export interface QBox {
  id: string;
  kind: "slot" | "node";
  x: number;
  y: number;
}

/**
 * Column tops of the cascade, relative to the cursor.
 *
 * `sizes[c]` is how many tags column `c` shows and `parents[c]` is the row the
 * column hangs off. Column 0 is centred on the cursor; every deeper column is
 * centred on the item that opened it.
 */
export function cascadeTops(sizes: number[], parents: number[]): number[] {
  const tops: number[] = [];
  let top = 0;
  for (let c = 0; c < sizes.length; c++) {
    const h = sizes[c] * Q_ROW_H;
    if (c === 0) top = -h / 2;
    else top = top + (parents[c] ?? 0) * Q_ROW_H + Q_ROW_H / 2 - h / 2;
    tops.push(top);
  }
  return tops;
}

/** the tag box a point lands on (null = between the lists) */
export function hitBox(boxes: QBox[], x: number, y: number): QBox | null {
  for (const b of boxes) {
    if (x >= b.x && x < b.x + Q_TAG_W && y >= b.y && y < b.y + Q_ROW_H) return b;
  }
  return null;
}

/**
 * Fill the menu's slots from the ranking, keeping slots stable.
 *
 * A slot keeps its device as long as that device is still in the top `count` of
 * `ranked` — so an ejected item never shifts its neighbours. Only slots whose
 * device dropped out of the top list (or vanished from the catalog, see `known`)
 * are emptied, and they are refilled with the highest-ranked device that is not
 * already shown.
 *
 * `pins[i]` is the device pinned into slot `i` for this document: a pinned slot
 * keeps its tag no matter where the device ranks (it bypasses the top gate).
 * Empty string = not pinned.
 *
 * `known` (a `Set`/`Map`-like lookup) drops slots whose device is no longer in
 * the catalog, pinned ones included.
 */
export function reconcileSlots(
  slots: string[],
  pins: string[],
  ranked: string[],
  count: number,
  known?: { has(id: string): boolean },
): (string | null)[] {
  const top = ranked.slice(0, count);
  const out: (string | null)[] = [];
  const kept = new Set<string>();
  for (let i = 0; i < count; i++) {
    const cur = slots[i] ?? "";
    const pin = pins[i] ?? "";
    const gone = known !== undefined && cur !== "" && !known.has(cur);
    // a device shown twice is one device: the second slot is a free one
    const dupe = cur !== "" && kept.has(cur);
    if (gone || dupe) {
      out.push(null);
      continue;
    }
    if (cur !== "" && (cur === pin || top.includes(cur))) {
      out.push(cur);
      kept.add(cur);
      continue;
    }
    out.push(null);
  }
  const used = kept;
  for (let i = 0; i < count; i++) {
    if (out[i] !== null) continue;
    const next = top.find((id) => !used.has(id));
    if (next === undefined) break;
    out[i] = next;
    used.add(next);
  }
  return out;
}
