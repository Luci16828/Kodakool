import { QUICK_COUNT_DEFAULT } from "./quickselect";

/**
 * Persisted state of the quick select menu (right mouse button).
 *
 * - `count`: how many recent/top slots the menu shows — a fixed number
 *   (`QUICK_COUNT_DEFAULT`), so the menu is always the same shape.
 * - `slots`: the device id each slot currently prefers — per project, because
 *   the catalog is per project. Slots are position-stable: only a slot whose
 *   device dropped out of the top list is replaced.
 * - `pins`: the device pinned into a slot for THIS document, bypassing the
 *   recent/top gate.
 * - `recent`: the devices used on this document, oldest → newest — the
 *   "recent" of the ranking (RxDB's doc order says nothing about usage order).
 *
 * Instantiated per coding-page mount (like `ColorPrefs`), so it is SSR-safe.
 */

const slotsKey = (folder: string) => `luci-quick-slots:${folder}`;
const pinsKey = (doc: string) => `luci-quick-pins:${doc}`;
const recentKey = (doc: string) => `luci-quick-recent:${doc}`;
/** the menu only ranks the last uses of a document */
const RECENT_MAX = 24;

/** stored slot list, padded/truncated to the current slot count */
function readList(key: string, count: number): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    const list = raw === null ? [] : (JSON.parse(raw) as unknown);
    const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    return resize(ids, count);
  } catch {
    return [];
  }
}

function resize(list: string[], count: number): string[] {
  const out = list.slice(0, count);
  while (out.length < count) out.push("");
  return out;
}

/** stored list with no padding (recency has no fixed length) */
function readRaw(key: string, max: number): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    const list = raw === null ? [] : (JSON.parse(raw) as unknown);
    const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x !== "") : [];
    return ids.slice(-max);
  } catch {
    return [];
  }
}

export class QuickPrefs {
  /** number of recent/top slots shown left of the cursor (fixed menu shape) */
  count = QUICK_COUNT_DEFAULT;
  /** preferred device id per slot ("" = empty slot) */
  slots = $state<string[]>([]);
  /** device id pinned per slot for the current document ("" = not pinned) */
  pins = $state<string[]>([]);
  /**
   * Devices used on this document, oldest → newest.
   *
   * RxDB hands out code docs in primary-key order, so the entries array says
   * nothing about which code was coded last. This list is the recency signal.
   */
  recent = $state<string[]>([]);

  constructor(folder: () => string, docKey: () => string) {
    // (re)load the lists whenever the project/document changes
    $effect(() => {
      this.slots = readList(slotsKey(folder()), this.count);
      this.pins = readList(pinsKey(docKey()), this.count);
      this.recent = readRaw(recentKey(docKey()), RECENT_MAX);
    });
    if (typeof localStorage === "undefined") return;
    $effect(() => localStorage.setItem(slotsKey(folder()), JSON.stringify(this.slots)));
    $effect(() => localStorage.setItem(pinsKey(docKey()), JSON.stringify(this.pins)));
    $effect(() => localStorage.setItem(recentKey(docKey()), JSON.stringify(this.recent)));
  }

  /** record that a device was just used on this document (drives the "recent" boost) */
  use(id: string): void {
    if (id === "") return;
    const next = [...this.recent.filter((x) => x !== id), id].slice(-RECENT_MAX);
    if (next.length === this.recent.length && next.every((v, i) => v === this.recent[i])) return;
    this.recent = next;
  }

  /** pin `id` into slot `i` for this document (null = unpin, slot stays free) */
  pin(i: number, id: string | null): void {
    if (i < 0 || i >= this.count) return;
    const pins = [...this.pins];
    const slots = [...this.slots];
    pins[i] = id ?? "";
    if (id !== null && id !== "") slots[i] = id;
    this.pins = pins;
    this.slots = slots;
  }

  /**
   * Remember the reconciled slots so slot positions persist.
   *
   * The menu shows `reconcileSlots(slots, …)`; storing that result back makes a
   * slot sticky — the next reconciliation sees its own output and keeps every
   * slot whose device is still in the top list. Idempotent, and the equality
   * guard keeps the write from re-triggering itself.
   */
  sync(list: (string | null)[]): void {
    const next = list.map((x) => x ?? "");
    if (next.length === this.slots.length && next.every((v, i) => v === this.slots[i])) return;
    this.slots = next;
  }
}
