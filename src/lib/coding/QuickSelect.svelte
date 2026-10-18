<script lang="ts">
  import { onDestroy } from "svelte";
  import "material-symbols/rounded.css";
  import type { CatalogView } from "./catalog-view";
  import {
    cascadeTops,
    hitBox,
    Q_COL_W,
    Q_GAP,
    Q_NAME_W,
    Q_OPEN_MS,
    Q_OPEN_SLOP,
    Q_PIN_W,
    Q_ROW_H,
    Q_TAG_W,
    type QBox,
  } from "./quickselect";

  /**
   * Quick select menu for device codes: hold the **right mouse button** and two
   * context-menu lists open centred on the cursor.
   *
   * - left of the cursor: the recent / most used codes, one row per stable slot,
   *   each tag carrying a pin button on its far left (pins that tag for this
   *   document, bypassing the recent/top gate),
   * - right of the cursor: the catalog's top-level categories; dragging over one
   *   opens its sub-categories as the next column, centred on the item opened,
   *   and so on. The opened chain stays marked like the catalog sidebar's selection.
   *
   * Only the short tag is shown — every tag box has the same width, so the lists
   * stay narrow and the pointer travels little; the full name of the item under the
   * pointer is previewed on the outer side. Hovering uses the catalog sidebar's own
   * fill/marker styling. Releasing the right button over a tag arms that device (and
   * codes the live selection when there is one); releasing over nothing de-arms.
   *
   * While the menu is held, the page takes pointer lock: the system cursor is hidden
   * and the menu is driven by a synthetic cursor built from the movement deltas, so
   * releasing the button warps the real cursor back to where the press happened
   * (Pointer Lock 2.0 §2.4). Browsers that refuse the lock fall back to plain
   * pointer-hover over the lists.
   */
  interface Props {
    /** menu may open (coding mode, no dialog/renaming in the way) */
    enabled: boolean;
    /**
     * The document surface (editor / PDF page): the right press that arms the menu
     * is listened for HERE only, so a right click on the sidebars, bar or any other
     * part of the page stays untouched (their own context menus own those regions).
     */
    surface: HTMLElement | null;
    /** top-level catalog nodes (the right-hand cascade) */
    tree: CatalogView[];
    /** every catalog node by id, to resolve the cascade + slot ids */
    nodeById: Map<string, CatalogView>;
    /** device id per slot to show (null = empty slot) */
    display: (string | null)[];
    /** device id pinned per slot for this document ("" = not pinned) */
    pins: string[];
    /** short tag of a device id */
    labelOf: (id: string) => string;
    /** full device name of a device id (hover preview) */
    nameOf: (id: string) => string;
    /** marker color vars of a device id */
    styleFor: (id: string) => string;
    /** release over a tag: arm it (and code the live selection) */
    onpick: (id: string) => void;
    /** release over nothing: drop the armed device */
    oncancel: () => void;
    /** left click on a cascade tag: pin it into a slot of this document */
    onpinid: (id: string) => void;
    /** pin button of slot `i` clicked */
    onpin: (i: number, id: string | null) => void;
  }

  let {
    enabled,
    surface,
    tree,
    nodeById,
    display,
    pins,
    labelOf,
    nameOf,
    styleFor,
    onpick,
    oncancel,
    onpinid,
    onpin,
  }: Props = $props();

  /** fixed tag box + row metrics (px): the lists are laid out arithmetically */
  const TAG_W = Q_TAG_W;
  const PIN_W = Q_PIN_W;
  const ROW_H = Q_ROW_H;
  const COL_W = Q_COL_W;
  /** breathing room around the cursor, between the two lists */
  const GAP = Q_GAP;

  let open = $state(false);
  /** cursor position the lists are centred on */
  let anchor = $state({ x: 0, y: 0 });
  /** synthetic cursor while the pointer is locked */
  let virtual = $state({ x: 0, y: 0 });
  /** pointer lock granted: the menu is driven by movement deltas */
  let locked = $state(false);
  /** opened cascade: device ids, one per sub-category level */
  let path = $state<string[]>([]);
  /** tag the cursor is on right now (released on it = picked) */
  let hover = $state<{ kind: "slot" | "node"; id: string } | null>(null);
  /** element the pointer is locked to (always mounted: the lock needs a live target) */
  let lockTarget = $state<HTMLDivElement | null>(null);
  /**
   * A right press becomes the menu only when it is held past `Q_OPEN_MS` or dragged:
   * a plain right click — the way people dismiss a popover — must not flash the menu.
   */
  let arming = $state(false);
  let armTimer: number | undefined;
  let armX = 0;
  let armY = 0;

  /** column 0 = top level, then the children of each opened cascade entry */
  const columns = $derived.by(() => {
    const cols: CatalogView[][] = [tree];
    for (const id of path) {
      const node = nodeById.get(id);
      if (node === undefined || node.children.length === 0) break;
      cols.push(node.children);
    }
    return cols;
  });

  /**
   * Column offsets inside `.qright` (whose origin is the cursor): the first
   * column is centred on the cursor, every deeper column on the item that opened it.
   */
  const cascade = $derived(
    cascadeTops(
      columns.map((c) => c.length),
      columns.map((_, c) =>
        c === 0
          ? 0
          : Math.max(
              0,
              columns[c - 1].findIndex((n) => n.id === path[c - 1]),
            ),
      ),
    ),
  );

  /**
   * Hit boxes of every tag, in viewport coordinates. Under pointer lock the page
   * gets no hover events, so the synthetic cursor is matched against these boxes —
   * they are computed from the same metrics the CSS uses.
   */
  const boxes = $derived.by(() => {
    const out: QBox[] = [];
    const listTop = anchor.y - (display.length * ROW_H - 2) / 2;
    display.forEach((id, i) => {
      if (id === null) return;
      out.push({ id, kind: "slot", x: anchor.x - GAP - TAG_W, y: listTop + i * ROW_H });
    });
    columns.forEach((col, c) => {
      const x = anchor.x + GAP + c * COL_W;
      col.forEach((n, j) => out.push({ id: n.id, kind: "node", x, y: anchor.y + cascade[c] + j * ROW_H }));
    });
    return out;
  });

  /** the tag box under a point (null = between the lists) */
  function hitAt(x: number, y: number): { kind: "slot" | "node"; id: string } | null {
    const b = hitBox(boxes, x, y);
    return b === null ? null : { kind: b.kind, id: b.id };
  }

  /** row of the hovered tag, to anchor the full-name preview */
  const preview = $derived.by(() => {
    const h = hover;
    if (h === null) return null;
    if (h.kind === "slot") {
      const i = display.findIndex((x) => x === h.id);
      if (i < 0) return null;
      const top = -(display.length * ROW_H - 2) / 2 + i * ROW_H + ROW_H / 2;
      return { side: "left" as const, top, left: 0 };
    }
    for (let c = 0; c < columns.length; c++) {
      const at = columns[c].findIndex((n) => n.id === h.id);
      if (at >= 0) {
        return { side: "right" as const, top: cascade[c] + (at + 0.5) * ROW_H, left: columns.length * COL_W };
      }
    }
    return null;
  });

  const previewName = $derived(hover === null ? "" : nameOf(hover.id));
  const isPinned = (i: number, id: string | null) => id !== null && (pins[i] ?? "") === id;

  /** keep both lists inside the viewport around the cursor */
  function anchorFor(x: number, y: number): { x: number; y: number } {
    // the lists plus the name preview's capped width: the anchor is kept inside the
    // viewport by this much on each side, so the menu never needs the cursor to sit
    // far from the text it opened on
    const leftW = GAP + PIN_W + TAG_W + Q_NAME_W;
    const rightW = GAP + columns.length * COL_W + Q_NAME_W;
    const h = display.length * ROW_H + 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const lo = leftW + 6;
    const half = h / 2 + 6;
    return {
      x: Math.round(Math.min(Math.max(x, lo), Math.max(lo, vw - rightW - 6))),
      y: Math.round(Math.min(Math.max(y, half), Math.max(half, vh - half - 6))),
    };
  }

  function close(): void {
    open = false;
    arming = false;
    clearTimeout(armTimer);
    armTimer = undefined;
    path = [];
    hover = null;
    locked = false;
  }

  /**
   * The right button is held long enough (or dragged) to become the menu: the lists
   * open centred on the press point and the cursor is hidden for the duration.
   */
  function openMenu(vx: number, vy: number): void {
    clearTimeout(armTimer);
    armTimer = undefined;
    arming = false;
    open = true;
    virtual = { x: vx, y: vy };
    requestLock();
  }

  /** dragging onto a category opens its children as the next column */
  function enter(col: number, node: CatalogView): void {
    hover = { kind: "node", id: node.id };
    path = node.children.length > 0 ? [...path.slice(0, col), node.id] : path.slice(0, col);
  }

  /**
   * Hide the system cursor for the duration of the menu (so it can warp back).
   * Raw deltas: with the OS pointer acceleration in the way the synthetic cursor
   * lags far behind the hand, so ask for unadjusted movement first.
   */
  function requestLock(): void {
    const el = lockTarget;
    if (el === null || typeof el.requestPointerLock !== "function") return;
    const r = el.requestPointerLock({ unadjustedMovement: true }) as unknown;
    if (r instanceof Promise) r.catch(() => undefined);
  }

  /** total pointer delta of one event, including the moves coalesced into its frame */
  function deltaOf(e: MouseEvent): { dx: number; dy: number } {
    // getCoalescedEvents is a PointerEvent member the MouseEvent type does not carry
    const ev = e as MouseEvent & { getCoalescedEvents?(): MouseEvent[] };
    const coalesced = ev.getCoalescedEvents?.() ?? [];
    if (coalesced.length === 0) return { dx: e.movementX, dy: e.movementY };
    let dx = 0;
    let dy = 0;
    for (const c of coalesced) {
      dx += c.movementX;
      dy += c.movementY;
    }
    return { dx, dy };
  }

  // leaving coding mode (edit mode, a dialog, renaming) closes an open menu
  $effect(() => {
    if (!enabled && open) {
      close();
      if (document.pointerLockElement !== null) document.exitPointerLock();
    }
  });

  /**
   * The right press is listened for on the document surface only: a right click
   * anywhere else on the page (sidebars, bar, popovers) never arms the menu, and
   * the native context menu is suppressed only over the surface as well.
   */
  $effect(() => {
    const el = surface;
    if (el === null) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2 || !enabled || open) return;
      anchor = anchorFor(e.clientX, e.clientY);
      virtual = { x: e.clientX, y: e.clientY };
      path = [];
      hover = null;
      // hold (or drag) opens; a quick plain right click stays inert
      armX = e.clientX;
      armY = e.clientY;
      arming = true;
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => openMenu(armX, armY), Q_OPEN_MS);
    };
    const onMenu = (e: MouseEvent) => {
      if (enabled) e.preventDefault();
    };
    el.addEventListener("mousedown", onDown);
    el.addEventListener("contextmenu", onMenu);
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("contextmenu", onMenu);
      clearTimeout(armTimer);
      armTimer = undefined;
    };
  });

  // pointer lock reports its state on document events (not part of svelte:window)
  $effect(() => {
    const onChange = () => {
      locked = document.pointerLockElement !== null;
      // the browser's own unlock gesture (Esc) or a lost window focus ends the menu
      if (!locked && open) close();
    };
    const onError = () => {
      locked = false;
    };
    window.addEventListener("pointerlockchange", onChange);
    window.addEventListener("pointerlockerror", onError);
    return () => {
      window.removeEventListener("pointerlockchange", onChange);
      window.removeEventListener("pointerlockerror", onError);
    };
  });

  onDestroy(() => {
    clearTimeout(armTimer);
    if (document.pointerLockElement !== null) document.exitPointerLock();
  });
</script>

<svelte:window
  onmousedown={(e) => {
    // left click while the menu is held: pin the tag the cursor is on, then the
    // click dismisses the menu and de-arms (a plain left click closes it too)
    if (e.button === 0 && open) {
      if (hover !== null) {
        e.preventDefault();
        if (hover.kind === "node") onpinid(hover.id);
        else {
          const i = display.indexOf(hover.id);
          if (i >= 0) onpin(i, isPinned(i, hover.id) ? null : hover.id);
        }
      }
      close();
      if (document.pointerLockElement !== null) document.exitPointerLock();
      oncancel();
    }
  }}
  onmousemove={(e) => {
    // held right button, menu not open yet: a drag opens it immediately
    if (arming && !open) {
      if (e.buttons !== 2) return;
      if (Math.hypot(e.clientX - armX, e.clientY - armY) > Q_OPEN_SLOP) openMenu(e.clientX, e.clientY);
      return;
    }
    // under pointer lock the page only reports deltas: rebuild the cursor from them
    if (!open || !locked) return;
    const { dx, dy } = deltaOf(e);
    if (dx === 0 && dy === 0) return;
    const x = Math.min(Math.max(virtual.x + dx, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(virtual.y + dy, 0), window.innerHeight - 1);
    virtual = { x, y };
    const hit = hitAt(x, y);
    // gaps between the tags keep the last target: the pointer never loses the menu
    if (hit === null) return;
    if (hit.kind === "slot") hover = hit;
    else {
      const c = columns.findIndex((col) => col.some((n) => n.id === hit.id));
      if (c >= 0) enter(c, nodeById.get(hit.id)!);
    }
  }}
  onmouseup={(e) => {
    if (e.button !== 2) return;
    // released before the menu armed: a plain right click, nothing to pick
    if (arming) {
      close();
      return;
    }
    if (!open) return;
    const hit = hover;
    const wasLocked = locked;
    close();
    if (wasLocked) document.exitPointerLock();
    if (hit !== null) onpick(hit.id);
    else oncancel();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape" && open) {
      close();
      if (document.pointerLockElement !== null) document.exitPointerLock();
    }
  }}
/>

<div class="qlock" bind:this={lockTarget}></div>

{#if open}
  <div class="quickmenu" style={`left: ${anchor.x}px; top: ${anchor.y}px`}>
    <div class="qleft" role="menu" aria-label="recent codes">
      {#each display as id, i (i)}
        {@const label = id === null ? "" : labelOf(id)}
        {@const pinned = isPinned(i, id)}
        <div class="qrow">
          {#if id !== null}
            <button
              type="button"
              class={`qpin ${pinned ? "on" : ""}`}
              aria-pressed={pinned}
              aria-label={label === ""
                ? "no code to pin"
                : pinned
                  ? `unpin ${label} for this document`
                  : `pin ${label} for this document`}
              title={label === ""
                ? "nothing to pin"
                : pinned
                  ? `unpin ${label} (keeps the recent/top ranking free again)`
                  : `pin ${label} for this document (bypasses the recent/top gate)`}
              onpointerenter={() => (hover = null)}
              onclick={() => onpin(i, pinned ? null : id)}
            >
              <span class="material-symbols-rounded" aria-hidden="true">push_pin</span>
            </button>
            <button
              type="button"
              class={`qtag ${hover?.kind === "slot" && hover.id === id ? "hot" : ""}`}
              role="menuitem"
              style={styleFor(id)}
              data-qid={id}
              title={label}
              onpointerenter={() => (hover = { kind: "slot", id })}
            >
              {label}
            </button>
          {:else}
            <span class="qempty" title="empty slot"></span>
          {/if}
        </div>
      {/each}
      {#if preview?.side === "left"}
        <span class="qname" style={`top: ${preview.top}px; right: calc(100% + 5px)`}>{previewName}</span>
      {/if}
    </div>
    <div class="qright" role="menu" aria-label="device categories">
      {#each columns as col, c (c)}
        <div class="qcol" style={`top: ${cascade[c]}px; left: ${c * COL_W}px`}>
          {#each col as node (node.id)}
            <button
              type="button"
              class={`qtag ${hover?.kind === "node" && hover.id === node.id ? "hot" : ""} ${path.includes(node.id) ? "sel" : ""}`}
              role="menuitem"
              style={styleFor(node.id)}
              data-qid={node.id}
              title={node.name || node.code}
              onpointerenter={() => enter(c, node)}
            >
              {labelOf(node.id)}
              {#if node.children.length > 0}
                <span class="qsub" aria-hidden="true">›</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}
      {#if preview?.side === "right"}
        <span class="qname" style={`top: ${preview.top}px; left: ${preview.left}px`}>{previewName}</span>
      {/if}
    </div>
  </div>

  {#if locked}
    <!-- the system cursor is hidden while locked: show where it is -->
    <div class="qcursor" style={`left: ${virtual.x}px; top: ${virtual.y}px`} aria-hidden="true"></div>
  {/if}
{/if}

<style lang="scss">
  /* pointer-lock target: invisible, but rendered (a hidden element cannot be locked) */
  .qlock {
    position: fixed;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  /* zero-size anchor: the two lists hang off its left and right edge */
  .quickmenu {
    position: fixed;
    z-index: 45;
    width: 0;
    height: 0;
    pointer-events: none;
    font-family: var(--font-sans, system-ui, sans-serif);
  }

  /* the slot list ends a little left of the cursor and is centred on it */
  .qleft {
    position: absolute;
    right: 10px;
    top: 0;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    pointer-events: auto;
  }

  /* origin = cursor: the cascade columns are placed by `cascade` (centred on the cursor / their parent) */
  .qright {
    position: absolute;
    left: 10px;
    top: 0;
    height: 0;
    pointer-events: auto;
  }

  .qcol {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  /* pin + tag form one box */
  .qrow {
    display: flex;
    align-items: stretch;
    gap: 0;
  }

  /* catalog-sidebar look: code fill at rest, solid marker under the pointer */
  .qtag {
    box-sizing: border-box;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
    /* every tag the same width: the lists stay narrow and aligned */
    width: 56px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--surface);
    border-radius: 0;
    background: var(--fill, transparent);
    color: var(--on-surface);
    white-space: nowrap;
    cursor: pointer;
  }
  :root[data-theme="dark"] .qtag {
    background: var(--fill-d, transparent);
  }
  .qtag:hover,
  .qtag.hot,
  .qtag.sel {
    background: var(--marker);
    color: var(--on-marker);
  }
  :root[data-theme="dark"] .qtag:hover,
  :root[data-theme="dark"] .qtag.hot,
  :root[data-theme="dark"] .qtag.sel {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }

  .qsub {
    margin-left: 0.15rem;
    font-size: 0.7rem;
    opacity: 0.7;
  }

  /* pin: the left segment of the tag box */
  .qpin {
    box-sizing: border-box;
    font: inherit;
    width: 20px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--surface);
    border-right: none;
    border-radius: 0;
    background: var(--fill, transparent);
    color: var(--on-surface-variant, #777);
    cursor: pointer;

    .material-symbols-rounded {
      font-size: 0.8rem;
    }
  }
  :root[data-theme="dark"] .qpin {
    background: var(--fill-d, transparent);
  }
  .qpin:hover,
  .qpin.on {
    background: var(--marker);
    color: var(--on-marker);
  }
  :root[data-theme="dark"] .qpin:hover,
  :root[data-theme="dark"] .qpin.on {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }

  /* empty slot keeps the list's shape stable */
  .qempty {
    box-sizing: border-box;
    display: inline-block;
    width: 76px;
    height: 22px;
    border: 1px dashed var(--outline, #888);
    border-radius: 0;
    opacity: 0.5;
  }

  /* full name of the item under the pointer, on the outer side of the lists */
  .qname {
    position: absolute;
    transform: translateY(-50%);
    font-size: 0.75rem;
    line-height: 1.2;
    padding: 2px 5px;
    border: 1px solid var(--outline, #888);
    border-radius: 0;
    background: var(--surface, #fff);
    color: var(--on-surface-variant, #666);
    white-space: nowrap;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  /* the synthetic cursor shown while the system cursor is locked away */
  .qcursor {
    position: fixed;
    z-index: 46;
    width: 9px;
    height: 9px;
    margin: -4px 0 0 -4px;
    border: 2px solid var(--on-surface, #1c1b1f);
    border-radius: 50%;
    background: color-mix(in srgb, var(--primary, #6750a4) 45%, transparent);
    pointer-events: none;
  }
</style>
