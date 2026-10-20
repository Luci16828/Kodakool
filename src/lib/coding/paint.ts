import { alphaVar } from "./css-var";
import { onForFill, type CodeColor } from "./palette";
import type { Placed } from "./coverage";

/**
 * Paint layer: turns palette entries into the CSS strings the marks, chips,
 * sidebar rows and the minimap render with. Pure functions of (palette, short
 * tags, armed device) — created once per palette state as a `$derived` in
 * CodingDoc, so the memoized style cache lives and dies with the painter
 * (the old manual generation counter is gone).
 */

// selection & smart-preview are coverage pseudo-codes (rendered through the
// same segments/hatch pipeline as real entries, so overlaps hatch).
export const SEL_CODE = "__selection";
export const PREVIEW_CODE = "__preview";

/** Chip/tag identity for one code: short label + marker colors per scheme. */
export interface TagSpec {
  label: string;
  marker: string;
  markerD: string;
  on: string;
  onD: string;
}

export interface PainterOptions {
  palette: Map<string, CodeColor>;
  /** numeric display code → short tag (LTE etc.) */
  shortByCode: Map<string, string>;
  /** palette key of the armed device (its numeric display code, "" = unarmed) */
  armedCode: string;
}

export interface Painter {
  /** fill (or fillHover) of a code color for the given scheme/interaction state */
  fillOf(code: string, dark: boolean, hover: boolean): string;
  /** CSS custom properties for catalog rows / the armed cursor tag */
  colorVars(code: string): string;
  /** marker custom properties for the cursor tag + editor host */
  markerVars(code: string): string;
  /** chip identity (short label + colors) */
  tagFor(code: string): TagSpec;
  /** memoized coverage style: the gradient is a pure function of the coverage
      (ids, fade flags, hot flags, device alphas) + focus mode, so a hover/preview
      crossing — which changes only a handful of segments — re-strings only those */
  styleForCov(cov: Placed[], hotIds: Set<string>, focus: boolean): string;
}

// article parity: repeating stripes separated by surface gaps
export function hatch(stops: string[]): string {
  const w = 4;
  const p = w + 2;
  const total = stops.length * p;
  const stopsStr = stops
    .flatMap((col, k) => [`${col} ${k * p}px ${k * p + w}px`, `var(--surface, white) ${k * p + w}px ${(k + 1) * p}px`])
    .concat(`${stops[0]} ${total}px ${total}px`)
    .join(", ");
  return `repeating-linear-gradient(45deg, ${stopsStr})`;
}

const FALLBACK = "#888888";

export function createPainter({ palette, shortByCode, armedCode }: PainterOptions): Painter {
  const pickFill = (c: CodeColor, dark: boolean, hover: boolean): string => {
    const s = dark ? c.dark : c.light;
    return hover ? s.fillHover : s.fill;
  };

  const fillOf = (code: string, dark: boolean, hover: boolean): string => {
    // selection & preview take the armed frame device's color when one is armed,
    // otherwise their own palette entry (so the chroma/tone sliders re-tint them too)
    if (code === SEL_CODE || code === PREVIEW_CODE) {
      const c = palette.get(armedCode) ?? palette.get(code);
      if (c !== undefined) return pickFill(c, dark, hover);
      return code === SEL_CODE ? (dark ? "#7f97e6" : "#4a7ad4") : dark ? "#93a4d6" : "#829fcf";
    }
    const c = palette.get(code);
    return c === undefined ? FALLBACK : pickFill(c, dark, hover);
  };

  const colorVars = (code: string): string => {
    const c = palette.get(code);
    if (!c) return "";
    return [
      `--fill: ${c.light.fill}`,
      `--fill-d: ${c.dark.fill}`,
      `--marker: ${c.light.marker}`,
      `--marker-d: ${c.dark.marker}`,
      `--on-marker: ${c.light.on}`,
      `--on-marker-d: ${c.dark.on}`,
    ].join("; ");
  };

  const markerVars = (code: string): string => {
    const c = palette.get(code);
    if (!c) return "";
    return [
      `--marker:${c.light.marker}`,
      `--marker-d:${c.dark.marker}`,
      `--on-marker:${c.light.on}`,
      `--on-marker-d:${c.dark.on}`,
    ].join("; ");
  };

  const tagFor = (code: string): TagSpec => {
    const c = palette.get(code);
    return {
      label: shortByCode.get(code) ?? code,
      marker: c?.light.marker ?? FALLBACK,
      markerD: c?.dark.marker ?? FALLBACK,
      on: c?.light.on ?? "#ffffff",
      onD: c?.dark.on ?? "#ffffff",
    };
  };

  const mix = (col: string, faded: boolean) => (faded ? `color-mix(in srgb, ${col} 32%, transparent)` : col);
  const itemFill = (p: Placed, dark: boolean, hotFor: boolean) =>
    hotFor ? fillOf(p.code, dark, true) : mix(fillOf(p.code, dark, false), p.faded);
  // the sidebar hover fade is a per-device alpha variable (see css-var.ts):
  // the gradient stays the same, only the alpha variables animate
  const stop = (p: Placed, hotIds: Set<string>, dark: boolean, hotVariant: boolean) => {
    const col = itemFill(p, dark, hotVariant && hotIds.has(p.id));
    const dev = p.devices[0];
    return dev ? `color-mix(in srgb, ${col} ${alphaVar(dev)}, transparent)` : col;
  };
  const gradFor = (cov: Placed[], hotIds: Set<string>, dark: boolean, hotVariant: boolean, focus: boolean): string => {
    // focus mode (selection/preview/hover): highlighted markers fully cover
    // the faded ones below them — no hatching against faded coverage; same
    // color highlights merge into one solid fill
    const vis = focus ? cov.filter((p) => !p.faded || hotIds.has(p.id)) : cov;
    const stops = vis.map((p) => stop(p, hotIds, dark, hotVariant));
    const uniq = focus ? [...new Set(stops)] : stops;
    return uniq.length === 1 ? `linear-gradient(${uniq[0]}, ${uniq[0]})` : hatch(uniq);
  };
  const computeStyleForCov = (cov: Placed[], hotIds: Set<string>, focus: boolean): string => {
    // dominant code for the bar text: the first visible (non-faded) coverage
    const dom = cov.find((p) => !p.faded || hotIds.has(p.id)) ?? cov[0];
    return [
      `--bars:${gradFor(cov, hotIds, false, false, focus)}`,
      `--bars-d:${gradFor(cov, hotIds, true, false, focus)}`,
      `--bars-hot:${gradFor(cov, hotIds, false, true, focus)}`,
      `--bars-hot-d:${gradFor(cov, hotIds, true, true, focus)}`,
      // text on the bar: contrast against the dominant code's fill (per scheme/variant)
      `--on-bars:${onForFill(fillOf(dom.code, false, false))}`,
      `--on-bars-d:${onForFill(fillOf(dom.code, true, false))}`,
      `--on-bars-hot:${onForFill(fillOf(dom.code, false, true))}`,
      `--on-bars-hot-d:${onForFill(fillOf(dom.code, true, true))}`,
    ].join("; ");
  };

  // memoized style strings: every other segment hits the cache on a hover
  // crossing. The cache is per painter, so a palette (chroma/tone/theme) or
  // armed-device change — which moves the fills — simply builds a new painter.
  const styleCache = new Map<string, string>();
  const styleForCov = (cov: Placed[], hotIds: Set<string>, focus: boolean): string => {
    let key = focus ? "f|" : "n|";
    for (const p of cov) key += `${p.id}:${p.faded ? 1 : 0}${hotIds.has(p.id) ? 1 : 0}:${p.devices[0] ?? ""}|`;
    const hit = styleCache.get(key);
    if (hit !== undefined) return hit;
    const style = computeStyleForCov(cov, hotIds, focus);
    if (styleCache.size > 4000) styleCache.clear();
    styleCache.set(key, style);
    return style;
  };

  return { fillOf, colorVars, markerVars, tagFor, styleForCov };
}

/**
 * The mark shape the PDF surface paints: CodingDoc's `pdfMarks` derived and
 * PdfView's `PdfMark` prop are structurally identical, so the fill/gradient
 * math lives here once (the editor's own pipeline works on coverage segments
 * with hot-id sets instead — see the painter's styleForCov).
 */
export interface MarkColors {
  color: string;
  colorD: string;
  colorHot: string;
  colorHotD: string;
  faded: boolean;
  hot: boolean;
  devices: string[];
}

/**
 * Editor parity: normal/hot fills render opaque, faded coverage stays
 * translucent — the blend layer makes opaque stripes behave like a real
 * highlighter. The sidebar hover fade rides the per-device alpha variable
 * (see css-var.ts), so the gradient itself never changes on hover.
 */
export function markFill(m: MarkColors, dark: boolean): string {
  const col = dark ? (m.hot ? m.colorHotD : m.colorD) : m.hot ? m.colorHot : m.color;
  const base = m.faded && !m.hot ? `color-mix(in srgb, ${col} 32%, transparent)` : col;
  const dev = m.devices[0];
  return dev ? `color-mix(in srgb, ${base} ${alphaVar(dev)}, transparent)` : base;
}

/**
 * Gradient for a coverage set: one stop renders solid, several hatch.
 * In focus mode (selection/preview/hover) hot marks fully cover the faded
 * ones below them and same-color highlights merge into one solid fill.
 */
export function markGradient(cov: MarkColors[], dark: boolean, focus: boolean): string {
  if (cov.length === 0) return "none";
  const vis = focus ? cov.filter((m) => !m.faded || m.hot) : cov;
  const stops = vis.map((m) => markFill(m, dark));
  const uniq = focus ? [...new Set(stops)] : stops;
  return uniq.length === 1 ? `linear-gradient(${uniq[0]}, ${uniq[0]})` : hatch(uniq);
}
