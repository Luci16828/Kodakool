/**
 * Keyboard-accessible opening of a Bits context menu.
 *
 * A `ContextMenu.Trigger` anchors its menu at the point of the `contextmenu`
 * event it receives, so a plain button opens the same menu by dispatching one
 * at its own center. The event must be dispatched ON the trigger element:
 * Svelte 5 delegates `contextmenu`, and a delegated handler only fires when
 * the event's own target carries it (dispatching on an ancestor never reaches
 * the trigger's handler). The trigger's handler calls `preventDefault`, which
 * keeps the native browser menu from ever appearing.
 */
export function openRowMenu(trigger: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  trigger.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }),
  );
}
