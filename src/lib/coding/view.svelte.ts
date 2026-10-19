/**
 * View-layer toggles for the coding page, persisted across documents and sessions.
 *
 * Instantiated per coding-page mount (like `QuickPrefs`), so it stays SSR-safe:
 * the localStorage reads are guarded and the write effects only run on the client.
 */

/** localStorage keys ("1" = on, anything else = off; width is a plain number) */
const MINIMAP_KEY = "luci-minimap";
const WIDTH_KEY = "luci-minimap-width";

/** minimap width bounds (px) + the default */
export const MINIMAP_W = 64;
export const MINIMAP_W_MIN = 40;
export const MINIMAP_W_MAX = 220;

function readMinimap(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(MINIMAP_KEY) === "1";
}

function readWidth(): number {
  if (typeof localStorage === "undefined") return MINIMAP_W;
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n >= MINIMAP_W_MIN && n <= MINIMAP_W_MAX ? n : MINIMAP_W;
}

export class ViewPrefs {
  /** show the coded-segment minimap beside the editor */
  minimap = $state(readMinimap());
  /** minimap width in px (drag its left edge to resize) */
  minimapWidth = $state(readWidth());

  constructor() {
    if (typeof localStorage === "undefined") return;
    $effect(() => localStorage.setItem(MINIMAP_KEY, this.minimap ? "1" : "0"));
    $effect(() => localStorage.setItem(WIDTH_KEY, String(this.minimapWidth)));
  }
}
