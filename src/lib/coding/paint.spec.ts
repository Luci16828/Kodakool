import { describe, expect, test } from "vitest";
import { createPainter, markFill, markGradient, PREVIEW_CODE, SEL_CODE, type PainterOptions } from "./paint";
import type { CodeColor } from "./palette";
import type { Placed } from "./coverage";

function color(marker: string, fill: string, fillHover: string, on: string): CodeColor {
  return {
    hue: 0,
    light: { marker, fill, fillHover, on },
    dark: { marker, fill, fillHover, on },
  };
}

const RED = color("#ff0000", "#fee0e0", "#ff8080", "#200000");
const BLUE = color("#0000ff", "#e0e0fe", "#8080ff", "#000020");

const base: PainterOptions = {
  palette: new Map<string, CodeColor>([
    ["1", RED],
    ["2", BLUE],
    [SEL_CODE, color("#4a7ad4", "#dde6f8", "#93b3e8", "#0a1e3d")],
    [PREVIEW_CODE, color("#829fcf", "#e8edf8", "#b5c6e4", "#12233f")],
  ]),
  shortByCode: new Map<string, string>([
    ["1", "ROT"],
    ["2", "BLU"],
  ]),
  armedCode: "",
};

describe("fillOf", () => {
  test("plain codes take their palette fill", () => {
    const p = createPainter(base);
    expect(p.fillOf("1", false, false)).toBe("#fee0e0");
    expect(p.fillOf("1", false, true)).toBe("#ff8080");
  });

  test("unknown codes fall back to gray", () => {
    expect(createPainter(base).fillOf("99", false, false)).toBe("#888888");
  });

  test("selection takes the armed device's color while one is armed", () => {
    const p = createPainter({ ...base, armedCode: "2" });
    expect(p.fillOf(SEL_CODE, false, false)).toBe("#e0e0fe");
  });

  test("selection falls back to its own palette entry when unarmed", () => {
    expect(createPainter(base).fillOf(SEL_CODE, false, false)).toBe("#dde6f8");
  });

  test("pseudo codes without any palette entry use the fixed blue fallbacks", () => {
    const p = createPainter({ ...base, palette: new Map([["1", RED]]) });
    expect(p.fillOf(SEL_CODE, false, false)).toBe("#4a7ad4");
    expect(p.fillOf(PREVIEW_CODE, true, false)).toBe("#93a4d6");
  });
});

describe("colorVars/markerVars/tagFor", () => {
  test("colorVars carries the full token set, unknown codes render nothing", () => {
    const p = createPainter(base);
    expect(p.colorVars("1")).toContain("--fill: #fee0e0");
    expect(p.colorVars("1")).toContain("--marker: #ff0000");
    expect(p.colorVars("nope")).toBe("");
  });

  test("markerVars carries only the marker tokens", () => {
    const vars = createPainter(base).markerVars("2");
    expect(vars).toBe("--marker:#0000ff; --marker-d:#0000ff; --on-marker:#000020; --on-marker-d:#000020");
  });

  test("tagFor prefers the short slug and falls back to the raw code", () => {
    const p = createPainter(base);
    expect(p.tagFor("1").label).toBe("ROT");
    expect(p.tagFor("7").label).toBe("7");
    expect(p.tagFor("7").marker).toBe("#888888");
  });
});

describe("styleForCov", () => {
  const a: Placed = { id: "a", code: "1", devices: ["d1"], from: 0, to: 5, faded: false };
  const b: Placed = { id: "b", code: "2", devices: ["d2"], from: 2, to: 8, faded: false };
  const hot = new Set<string>();

  test("a single coverage renders as one solid gradient", () => {
    const style = createPainter(base).styleForCov([a], hot, false);
    expect(style).toContain("--bars:linear-gradient(");
    expect(style).toContain("--on-bars:");
  });

  test("overlapping coverages hatch", () => {
    const style = createPainter(base).styleForCov([a, b], hot, false);
    expect(style).toContain("--bars:repeating-linear-gradient(45deg");
  });

  test("focus mode merges same-color highlights into one solid fill", () => {
    const c: Placed = { id: "c", code: "1", devices: ["d1"], from: 6, to: 9, faded: true };
    const style = createPainter(base).styleForCov([a, c], new Set(["a"]), true);
    // a is hot, c is faded and not hot → filtered out → single stop → solid
    expect(style).toContain("--bars:linear-gradient(");
  });

  test("faded coverage is color-mixed into the hatch", () => {
    const faded: Placed = { ...b, faded: true };
    const style = createPainter(base).styleForCov([a, faded], hot, false);
    expect(style).toContain("color-mix(in srgb, #e0e0fe 32%, transparent)");
  });

  test("device alpha variables ride the stops (sidebar hover fades via CSS)", () => {
    const style = createPainter(base).styleForCov([a], hot, false);
    expect(style).toContain("var(--a-d1");
  });

  test("the same coverage hits the cache: identical string identity", () => {
    const p = createPainter(base);
    const s1 = p.styleForCov([a, b], hot, false);
    const s2 = p.styleForCov([a, b], hot, false);
    expect(s2).toBe(s1);
  });

  test("a new painter (palette/armed change) starts from a fresh cache", () => {
    const s1 = createPainter(base).styleForCov([a, b], hot, false);
    const s2 = createPainter(base).styleForCov([a, b], hot, false);
    expect(s2).toBe(s1); // same palette → same style
    const armed = createPainter({ ...base, armedCode: "2" });
    expect(armed.fillOf(SEL_CODE, false, false)).toBe("#e0e0fe");
  });

  test("hot flags change the cache key", () => {
    const p = createPainter(base);
    expect(p.styleForCov([a, b], new Set(["a"]), false)).not.toBe(p.styleForCov([a, b], hot, false));
  });
});

describe("markFill/markGradient (PDF surface)", () => {
  const mark = (over: Partial<Parameters<typeof markFill>[0]> = {}) => ({
    color: "#ff0000",
    colorD: "#800000",
    colorHot: "#ff8080",
    colorHotD: "#b04040",
    faded: false,
    hot: false,
    devices: ["d1"],
    ...over,
  });

  test("normal marks render opaque per scheme", () => {
    expect(markFill(mark(), false)).toContain("color-mix(in srgb, #ff0000 var(--a-d1");
    expect(markFill(mark(), true)).toContain("color-mix(in srgb, #800000 var(--a-d1");
  });

  test("hot marks take the hot fill", () => {
    expect(markFill(mark({ hot: true }), false)).toContain("#ff8080");
    expect(markFill(mark({ hot: true }), true)).toContain("#b04040");
  });

  test("faded non-hot marks drop to 32%", () => {
    expect(markFill(mark({ faded: true }), false)).toContain("color-mix(in srgb, #ff0000 32%, transparent)");
  });

  test("faded + hot stays opaque (focus mode covers the faded hatch)", () => {
    expect(markFill(mark({ faded: true, hot: true }), false)).toContain("#ff8080");
  });

  test("no device → no alpha variable", () => {
    expect(markFill(mark({ devices: [] }), false)).toBe("#ff0000");
  });

  test("empty coverage renders nothing", () => {
    expect(markGradient([], false, false)).toBe("none");
  });

  test("one stop is solid, several hatch", () => {
    expect(markGradient([mark()], false, false)).toContain("linear-gradient(");
    expect(markGradient([mark(), mark({ devices: ["d2"] })], false, false)).toContain(
      "repeating-linear-gradient(45deg",
    );
  });

  test("focus mode drops faded non-hot marks and merges same-color stops", () => {
    const hotMark = mark({ hot: true, devices: ["d1"] });
    const fadedSame = mark({ faded: true, devices: ["d1"] });
    const style = markGradient([hotMark, fadedSame], false, true);
    // the faded mark shares the hot mark's stop after filtering → single solid fill
    expect(style).toContain("linear-gradient(");
    expect(style).not.toContain("32%");
  });
});
