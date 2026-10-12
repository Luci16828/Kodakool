import {
  argbFromHex,
  Contrast,
  Hct,
  hexFromArgb,
  lstarFromArgb,
  themeFromSourceColor,
} from "@material/material-color-utilities";
import { codeHue } from "./tokens.ts";

/** Source color for the app-wide Material theme (light + dark schemes). */
export const THEME_SOURCE = "#4055a8";

export function circHue(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

function category(code: string): string {
  const m = /^(\d+)/.exec(code);
  return m ? `cat:${m[1]}` : `code:${code}`;
}

export interface PaletteOptions {
  /** Preferred hue per code; kept where contrast allows. Defaults to the code hash. */
  prefer?: Map<string, number>;
  /** Minimum circular hue distance between unrelated categories, when achievable. */
  minHueSeparation?: number;
  /** Max total hue spread within one category (same leading number). */
  categorySpread?: number;
  /** Minimum WCAG contrast of marker colors against the scheme surfaces. */
  minMarkerContrast?: number;
  /** Offset added to every fill/marker HCT chroma (0 = palette default; negative = greyer). */
  chromaAdj?: number;
  /** Offset added to every fill/marker HCT tone (0 = palette default; positive = lighter). */
  toneAdj?: number;
}

export interface CodeColor {
  hue: number;
  /** per-scheme colors as hex */
  light: { fill: string; fillHover: string; marker: string; on: string };
  dark: { fill: string; fillHover: string; marker: string; on: string };
}

const LIGHT = { surface: "#ffffff", fillT: 86, fillC: 35, fillHT: 74, fillHC: 45, markerT: 40 };
const DARK = { surface: "#121316", fillT: 34, fillC: 35, fillHT: 55, fillHC: 70, markerT: 75 };

const toneOf = (hex: string) => lstarFromArgb(argbFromHex(hex));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Readable text color for a solid background `hex`: whichever of near-white or
 * near-black has the higher WCAG contrast against it. Used to keep the text on a
 * highlight bar legible as its fill is re-tinted by the chroma/tone sliders.
 */
export function onForFill(hex: string): string {
  const t = toneOf(hex);
  const white = Contrast.ratioOfTones(t, toneOf("#ffffff"));
  const black = Contrast.ratioOfTones(t, toneOf("#101010"));
  return white >= black ? "#ffffff" : "#101010";
}

function markerFor(hue: number, spec: typeof LIGHT, min: number, chroma: number, tone0: number): string {
  const surfaceTone = toneOf(spec.surface);
  let tone = tone0;
  let hex = hexFromArgb(Hct.from(hue, chroma, tone).toInt());
  for (let i = 0; i < 60 && Contrast.ratioOfTones(toneOf(hex), surfaceTone) < min; i++) {
    tone += tone > (spec === DARK ? 90 : 10) ? 1.5 : -1.5;
    hex = hexFromArgb(Hct.from(hue, chroma, tone).toInt());
  }
  return hex;
}

/**
 * Deterministic code color palette. Codes sharing a category (leading number before
 * the dot, e.g. `6.2`/`6.3`) get similar hues within `categorySpread`. Unrelated
 * categories are pushed apart to `minHueSeparation` when that is geometrically
 * achievable, maximizing separation otherwise. Preferred hues are used as anchors.
 */
export function buildPalette(codes: string[], opts: PaletteOptions = {}): Map<string, CodeColor> {
  const minSep = opts.minHueSeparation ?? 30;
  const maxSpread = opts.categorySpread ?? 40;
  const minContrast = opts.minMarkerContrast ?? 4.5;

  const unique = [...new Set(codes)].sort((a, b) => a.localeCompare(b));
  const groups = new Map<string, string[]>();
  for (const code of unique) {
    const key = category(code);
    groups.set(key, [...(groups.get(key) ?? []), code]);
  }
  const anchors = [...groups.keys()].sort();

  const prefHue = (code: string) => opts.prefer?.get(code) ?? codeHue(code);
  const circMean = (hues: number[]) => {
    const x = hues.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
    const y = hues.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };

  const hueOf = new Map<string, number>();
  const placed: number[] = [];
  const offsets: number[] = [];
  for (let s = 0; s <= 180; s += 6) offsets.push(s, -s);
  offsets.sort((a, b) => Math.abs(a) - Math.abs(b));

  for (const key of anchors) {
    const members = groups.get(key)!;
    const spread = members.length < 2 ? 0 : Math.min(maxSpread, (members.length - 1) * 10);
    const anchorPref = circMean(members.map(prefHue));
    let best: { anchor: number; sep: number } | null = null;
    for (const off of offsets) {
      const anchor = (anchorPref + off + 360) % 360;
      const hues = members.map((_, i) =>
        members.length === 1 ? anchor : anchor - spread / 2 + (spread * i) / (members.length - 1),
      );
      const sep = placed.length ? Math.min(...placed.map((p) => Math.min(...hues.map((h) => circHue(h, p))))) : 360;
      if (best === null || sep > best.sep) best = { anchor, sep };
      if (sep >= minSep) break;
    }
    const chosen = (best?.anchor ?? anchorPref + placed.length * minSep) % 360;
    members.forEach((code, i) => {
      const hue =
        members.length === 1 ? chosen : (chosen - spread / 2 + (spread * i) / (members.length - 1) + 360) % 360;
      hueOf.set(code, hue);
      placed.push(hue);
    });
  }

  const ca = opts.chromaAdj ?? 0;
  const ta = opts.toneAdj ?? 0;
  const out = new Map<string, CodeColor>();
  for (const [code, hue] of hueOf) {
    const scheme = (spec: typeof LIGHT) => {
      const marker = markerFor(hue, spec, minContrast, clamp(50 + ca, 0, 130), clamp(spec.markerT + ta, 0, 100));
      return {
        fill: hexFromArgb(Hct.from(hue, clamp(spec.fillC + ca, 0, 130), clamp(spec.fillT + ta, 0, 100)).toInt()),
        fillHover: hexFromArgb(Hct.from(hue, clamp(spec.fillHC + ca, 0, 130), clamp(spec.fillHT + ta, 0, 100)).toInt()),
        marker,
        on: Contrast.ratioOfTones(toneOf(marker), toneOf("#ffffff")) >= minContrast ? "#ffffff" : "#101010",
      };
    };
    out.set(code, { hue, light: scheme(LIGHT), dark: scheme(DARK) });
  }
  return out;
}

/** CSS custom-property block (hex values) for the app theme, light and dark. */
export function themeTokens(source: string = THEME_SOURCE): {
  light: Record<string, string>;
  dark: Record<string, string>;
} {
  const theme = themeFromSourceColor(argbFromHex(source));
  const pick = (s: (typeof theme.schemes)["light"]) => ({
    surface: hexFromArgb(s.surface),
    onSurface: hexFromArgb(s.onSurface),
    surfaceVariant: hexFromArgb(s.surfaceVariant),
    onSurfaceVariant: hexFromArgb(s.onSurfaceVariant),
    outline: hexFromArgb(s.outline),
    primary: hexFromArgb(s.primary),
    onPrimary: hexFromArgb(s.onPrimary),
    primaryContainer: hexFromArgb(s.primaryContainer),
    onPrimaryContainer: hexFromArgb(s.onPrimaryContainer),
  });
  return { light: pick(theme.schemes.light), dark: pick(theme.schemes.dark) };
}
