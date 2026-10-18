import { entryId } from "./edit";
import type { CodeEntry } from "./types";

/**
 * Controller for the entry detail popup (the chip-anchored note/delete panel).
 * Owns the anchored position, the note draft and the grace-close timer that
 * bridges the chip→popup gap (the popup sits directly above the chip, so
 * crossing the gap takes far under the grace period).
 */
export class EntryPopupCtl {
  popup = $state<{ id: string; x: number; y: number } | null>(null);
  note = $state("");
  /** entry id under a hovered label chip (heats the entry everywhere) */
  hoverChip = $state<string | null>(null);

  private static readonly GRACE_MS = 100;
  private overPopup = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private entries: () => CodeEntry[];
  private key: () => string;

  constructor(opts: { entries: () => CodeEntry[]; key: () => string }) {
    this.entries = opts.entries;
    this.key = opts.key;
  }

  /** (re)anchor the popup to the chip for `id`, resetting the note draft on a new tag */
  private show(id: string): void {
    // works for editor chips (.cm-tag) and PDF view chips alike
    const el = document.querySelector(`[data-tag-entry="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - 272));
    if (this.popup === null || this.popup.id !== id) {
      const e = this.entries().find((x) => entryId(this.key(), x) === id);
      this.note = e?.note ?? "";
    }
    // anchor the popup ABOVE the chip: y is its distance from the viewport bottom
    this.popup = { id, x, y: window.innerHeight - r.top };
  }

  /** chip hover: (re)anchor the popup; leaving a chip closes it after a short grace period */
  chipHover(id: string | null): void {
    if (id !== this.hoverChip) this.hoverChip = id;
    if (id === null) {
      if (!this.overPopup && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.overPopup && this.hoverChip === null) this.popup = null;
        }, EntryPopupCtl.GRACE_MS);
      }
    } else {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.show(id);
    }
  }

  /** pointer entered the popup itself (cancels the grace close) */
  enter(): void {
    this.overPopup = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** pointer left the popup: re-arm the grace close (re-entering cancels it) */
  leave(): void {
    this.overPopup = false;
    this.chipHover(null);
  }

  close(): void {
    this.popup = null;
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}
