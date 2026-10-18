/**
 * View-layer toggles for the coding page, persisted across documents and sessions.
 *
 * Instantiated per coding-page mount (like `QuickPrefs`), so it stays SSR-safe:
 * the localStorage read is guarded and the write effect only runs on the client.
 */

/** localStorage key for the minimap toggle ("1" = on, anything else = off) */
const MINIMAP_KEY = "luci-minimap";

function readMinimap(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(MINIMAP_KEY) === "1";
}

export class ViewPrefs {
  /** show the coded-segment minimap beside the editor */
  minimap = $state(readMinimap());

  constructor() {
    if (typeof localStorage === "undefined") return;
    $effect(() => localStorage.setItem(MINIMAP_KEY, this.minimap ? "1" : "0"));
  }
}
