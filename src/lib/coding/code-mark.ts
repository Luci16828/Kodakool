import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, EditorState } from "@codemirror/state";
import { elementSpan, sentenceSpan, snapWords, type Span } from "$lib/coding/segment";

/** One code label rendered as a chip above the segment. */
export interface CodingMarkTag {
  label: string;
  /** entry id the chip belongs to (hover lookup) */
  id: string;
  /** catalog id of the device this chip codes (sidebar hover fade) */
  device?: string;
  /** brighten (entry hot under the mouse or as narrowest of its segment) */
  hot?: boolean;
  /** dim this chip's color (a selection elsewhere fades unrelated marks + tags) */
  faded?: boolean;
  /** this chip has its detail popup open below it (seam joins chip + popup) */
  open?: boolean;
  marker: string;
  markerD: string;
  on: string;
  onD: string;
}

/**
 * One rendered mark segment. Segments are disjoint: every overlapping entry
 * range is split at its boundaries so a segment always carries the full set of
 * entries covering it (hatch colors, click lookup).
 */
export interface CodingMarkSpec {
  /** stable segment key: the covering entry ids joined with "|" */
  id: string;
  /** deterministic entry ids (entryId()) covered by this segment */
  ids: string[];
  /** catalog ids covering this segment (the sidebar hover fade matches on these) */
  devices: string[];
  from: number;
  to: number;
  /** display code labels joined with " · ", shown as tooltip */
  code: string;
  /** css custom properties for the mark (--bars, --bars-d, --bars-hot, --bars-hot-d) */
  style: string;
  /** code label chips shown above the segment (one per distinct covering code) */
  tags: CodingMarkTag[];
  /** brighten (related entry hovered) */
  hot?: boolean;
}

const setCodingMarks = StateEffect.define<CodingMarkSpec[]>({
  map: (specs, change) => specs.map((s) => ({ ...s, from: change.mapPos(s.from), to: change.mapPos(s.to) })),
});

const setCodingHover = StateEffect.define<CodingMarkSpec[]>({
  map: (specs, change) => specs.map((s) => ({ ...s, from: change.mapPos(s.from), to: change.mapPos(s.to) })),
});

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCodingMarks)) {
        const sorted = [...e.value].sort((a, b) => a.from - b.from || b.to - a.to);
        marks = Decoration.set(
          sorted.map((s) => {
            const cls = s.hot ? "cm-underline cm-hot" : "cm-underline";
            const attributes = {
              style: s.style,
              "data-entry": s.ids.join(" "),
              "data-seg": s.id,
              "data-devices": s.devices.join(" "),
              title: s.code,
            };
            return Decoration.mark({ class: cls, attributes }).range(s.from, s.to);
          }),
          true,
        );
      }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Zero-width inline widget: the code label chips floating above a segment. */
class LabelWidget extends WidgetType {
  constructor(readonly spec: CodingMarkSpec) {
    super();
  }

  eq(other: LabelWidget): boolean {
    const a = this.spec.tags;
    const b = other.spec.tags;
    return (
      this.spec.id === other.spec.id &&
      a.length === b.length &&
      a.every(
        (t, i) =>
          t.label === b[i].label &&
          t.device === b[i].device &&
          t.marker === b[i].marker &&
          t.hot === b[i].hot &&
          t.faded === b[i].faded &&
          t.open === b[i].open,
      )
    );
  }

  toDOM(): HTMLElement {
    const line = document.createElement("span");
    line.className = "cm-tagline";
    line.setAttribute("data-segment", this.spec.id);
    const row = document.createElement("span");
    row.className = "cm-tagrow";
    for (const t of this.spec.tags) {
      const chip = document.createElement("span");
      const cls = ["cm-tag", t.hot ? "cm-tag-hot" : "", t.faded ? "cm-tag-faded" : "", t.open ? "cm-tag-open" : ""]
        .filter(Boolean)
        .join(" ");
      chip.className = cls;
      chip.style.cssText = `--tag:${t.marker}; --tag-d:${t.markerD}; --tag-on:${t.on}; --tag-on-d:${t.onD}`;
      chip.setAttribute("data-entry", this.spec.ids.join(" "));
      chip.setAttribute("data-tag-entry", t.id);
      if (t.device) chip.setAttribute("data-device", t.device);
      chip.appendChild(document.createTextNode(t.label));
      row.appendChild(chip);
    }
    line.appendChild(row);
    return line;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const labelsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(labels, tr) {
    labels = labels.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCodingMarks)) {
        const sorted = [...e.value]
          .filter((s) => s.tags.length > 0)
          .sort((a, b) => a.from - b.from || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        labels = Decoration.set(
          sorted.map((s) => Decoration.widget({ widget: new LabelWidget(s), side: 1 }).range(s.from)),
          true,
        );
      }
    return labels;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Sidebar-hover overlay: only the segments in the editor's current viewport get a
 * focus decoration (solid highlighted coverage over the faded hatch). Keeping this
 * in its own field means a hover change never rebuilds the base marks.
 */
const hoverMarksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCodingHover)) {
        const sorted = [...e.value].sort((a, b) => a.from - b.from || b.to - a.to);
        marks = Decoration.set(
          sorted.map((s) => {
            const cls = `cm-underline cm-hover${s.hot ? " cm-hot" : ""}`;
            const attributes = {
              style: s.style,
              "data-entry": s.ids.join(" "),
              "data-seg": s.id,
              "data-devices": s.devices.join(" "),
              title: s.code,
            };
            return Decoration.mark({ class: cls, attributes }).range(s.from, s.to);
          }),
          true,
        );
      }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Replace the full mark set (called whenever the entry list changes). */
export function syncCodingMarks(view: EditorView, specs: CodingMarkSpec[]): void {
  view.dispatch({ effects: setCodingMarks.of(specs) });
}

/** Replace the viewport-only sidebar-hover overlay. */
export function syncCodingHover(view: EditorView, specs: CodingMarkSpec[]): void {
  view.dispatch({ effects: setCodingHover.of(specs) });
}

// resolve hover from the element under the pointer, not posAtCoords: with the
// wide 2.55 leading posAtCoords snaps to the nearest char, so leaving a mark into
// the gap between lines would keep it hot
function hit(event: MouseEvent): { seg: string | null; tag: string | null } | null {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return null;
  const chip = el.closest(".cm-tag");
  if (chip) {
    return {
      seg: chip.closest(".cm-tagline")?.getAttribute("data-segment") ?? null,
      tag: chip.getAttribute("data-tag-entry"),
    };
  }
  if (el.closest(".cm-tagline")) return { seg: null, tag: null };
  const mark = el.closest(".cm-underline");
  return { seg: mark?.getAttribute("data-seg") ?? null, tag: null };
}

/** Extension: fields + hover detection for marks and label chips. */
export function codingMarks(
  onTagHover?: (id: string | null) => void,
  onMarkHover?: (id: string | null) => void,
  onAdd?: (from: number, to: number) => void,
) {
  return [
    marksField,
    labelsField,
    hoverMarksField,
    EditorView.domEventHandlers({
      mouseup(_event, view) {
        // the quick select menu rides the right button: releasing it must not code
        // whatever selection happens to be live
        if (_event.button !== 0) return false;
        const r = view.state.selection.main;
        if (!r.empty) onAdd?.(r.from, r.to);
        return false;
      },
      // hover must be resolved on mousemove, not mouseover: every hot-state change
      // rebuilds the mark DOM under the pointer, and after such a swap no mouseover
      // fires until a new element boundary is crossed, leaving stale hot segments
      mousemove(event) {
        const h = hit(event);
        onTagHover?.(h?.tag ?? null);
        onMarkHover?.(h?.seg ?? null);
        return false;
      },
      mouseleave() {
        onMarkHover?.(null);
        onTagHover?.(null);
        return false;
      },
    }),
  ];
}

// --- smart (logical) selection -------------------------------------------------

export interface SmartOptions {
  /** live toggle from the UI */
  enabled: () => boolean;
  /** when present, hover preview only shows while this returns true (armed) */
  armed?: () => boolean;
  /** after a click selects a logical element; used to code it while armed */
  onSelect?: (from: number, to: number) => void;
  /** the span a click would select right now (null = none), reported on hover */
  onPreview?: (span: { from: number; to: number } | null) => void;
  /** treat every newline as a paragraph boundary (PDF extracted text) */
  hard?: () => boolean;
}

/** px a pointer may travel between down and up and still count as a click */
const CLICK_SLOP = 5;

/** chars of context sliced around the pointer for logical spans: sentences and
 * quote pairs never approach this size, so the paragraph bounds always clamp
 * inside the window in practice — and sliceDoc() never copies the whole doc */
const LOGICAL_WINDOW = 4000;
/** chars of context sliced around a pointer selection for word snapping:
 * snapWords only expands over one word + a bounded punctuation/whitespace run */
const SNAP_WINDOW = 512;

/**
 * Logical selection: drags snap to whole words (transactionFilter on
 * select.pointer), plain clicks select the element (quotes/brackets) containing
 * the point or else its whole sentence, and hovering reports that span back via
 * onPreview so the page can render it as just another mark.
 */
export function smartSelect(o: SmartOptions) {
  let downX = 0;
  let downY = 0;
  let last: Span | null = null;
  const logicalAt = (view: EditorView, pos: number): Span | null => {
    const doc = view.state.doc;
    // windowed slice: sliceDoc() would copy the whole document on every mousemove
    const lo = Math.max(0, pos - LOGICAL_WINDOW);
    const text = doc.sliceString(lo, Math.min(doc.length, pos + LOGICAL_WINDOW));
    const hard = o.hard?.() ?? false;
    const s = elementSpan(text, pos - lo, hard) ?? sentenceSpan(text, pos - lo, hard);
    return s === null ? null : { from: s.from + lo, to: s.to + lo };
  };
  const report = (s: Span | null) => {
    if (last === s) return;
    if (last !== null && s !== null && last.from === s.from && last.to === s.to) return;
    last = s;
    o.onPreview?.(s === null || s.from >= s.to ? null : { from: s.from, to: s.to });
  };
  return [
    EditorState.transactionFilter.of((tr) => {
      if (!o.enabled() || !tr.selection || !tr.isUserEvent("select.pointer")) return tr;
      const main = tr.selection.main;
      if (main.empty) return tr;
      // windowed slice: a pointer drag dispatches a selection transaction per
      // mousemove, so sliceDoc() here would copy the whole document per pixel
      const doc = tr.state.doc;
      const lo = Math.max(0, main.from - SNAP_WINDOW);
      const text = doc.sliceString(lo, Math.min(doc.length, main.to + SNAP_WINDOW));
      const s = snapWords(text, main.from - lo, main.to - lo);
      const from = s.from + lo;
      const to = s.to + lo;
      if (from === main.from && to === main.to) return tr;
      return {
        selection: main.head < main.anchor ? { anchor: to, head: from } : { anchor: from, head: to },
        userEvent: "select.pointer",
      };
    }),
    EditorView.domEventHandlers({
      mousedown(event) {
        // only the primary button anchors a click; a right-press must not steal the
        // down position of a left-press (the click slop check below compares them)
        if (event.button !== 0) return false;
        downX = event.clientX;
        downY = event.clientY;
        report(null);
        return false;
      },
      mousemove(event, view) {
        if (!o.enabled() || (o.armed !== undefined && !o.armed()) || event.buttons !== 0) {
          report(null);
          return false;
        }
        if (event.target instanceof Element && event.target.closest(".cm-tag,.cm-tagline,.cm-widget")) {
          report(null);
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        report(pos === null ? null : logicalAt(view, pos));
        return false;
      },
      mouseup(event, view) {
        // right button = the quick select menu, never a selection/coding gesture
        if (event.button !== 0) return false;
        if (!o.enabled()) return false;
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP) return false;
        if (event.target instanceof Element && event.target.closest(".cm-tag,.cm-tagline,.cm-widget")) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        if (pos === null) return false;
        const s = logicalAt(view, pos);
        if (s !== null && s.to > s.from) {
          view.dispatch({ selection: { anchor: s.from, head: s.to } });
          o.onSelect?.(s.from, s.to);
        }
        return false;
      },
      mouseleave(_event, _view) {
        report(null);
        return false;
      },
    }),
  ];
}
