import { argbFromHex, Contrast, lstarFromArgb } from "@material/material-color-utilities";
import { describe, expect, it } from "vitest";
import { buildPalette, circHue, themeTokens } from "$lib/coding/palette";

const lstar = (hex: string) => lstarFromArgb(argbFromHex(hex));
const ratio = (a: string, b: string) => Contrast.ratioOfTones(lstar(a), lstar(b));

describe("buildPalette", () => {
  it("is deterministic", () => {
    const codes = ["6.2-sucht", "6.3-kampf", "4.1-ploetzlich", "1.1-identitaet"];
    const a = buildPalette(codes);
    const b = buildPalette(codes);
    expect(a).toEqual(b);
  });

  it("keeps same-category codes within the category spread but visually distinct", () => {
    const codes = ["6.1-a", "6.2-b", "6.3-c", "6.4-d", "6.7-e", "6.8-f", "6.9-g"];
    const p = buildPalette(codes);
    for (const a of codes) {
      for (const b of codes) {
        expect(circHue(p.get(a)!.hue, p.get(b)!.hue)).toBeLessThanOrEqual(40 + 1e-6);
      }
    }
    const adjacent = buildPalette(["2.1-a", "2.2-b", "2.3-c"]);
    const hues = ["2.1-a", "2.2-b", "2.3-c"].map((c) => adjacent.get(c)!.hue);
    expect(hues[1]).not.toBe(hues[0]);
    expect(circHue(hues[0], hues[1])).toBeGreaterThanOrEqual(5);
    expect(adjacent.get("2.1-a")!.light.fill).not.toBe(adjacent.get("2.2-b")!.light.fill);
  });

  it("separates unrelated categories", () => {
    const codes = ["1.a", "2.b", "3.c", "4.d", "5.e", "6.f", "7.g", "8.h", "9.i"];
    const p = buildPalette(codes);
    let minSep = 360;
    for (const a of codes) {
      for (const b of codes) {
        if (a < b) minSep = Math.min(minSep, circHue(p.get(a)!.hue, p.get(b)!.hue));
      }
    }
    expect(minSep).toBeGreaterThanOrEqual(28);
  });

  it("keeps preferred hues when contrast allows, and moves them when needed", () => {
    const free = buildPalette(["alpha", "beta"], { prefer: new Map([["alpha", 100]]) });
    expect(free.get("alpha")!.hue).toBeCloseTo(100, 6);

    const clash = buildPalette(["alpha", "beta"], {
      prefer: new Map([
        ["alpha", 100],
        ["beta", 100],
      ]),
      minHueSeparation: 40,
    });
    expect(circHue(clash.get("alpha")!.hue, clash.get("beta")!.hue)).toBeGreaterThanOrEqual(40);
  });

  it("marker colors contrast with their surfaces", () => {
    const codes = ["1.x", "2.x", "3.x", "4.x", "5.x", "6.x", "7.x", "8.x", "9.x", "10.x", "11.x"];
    const p = buildPalette(codes);
    for (const { light, dark } of p.values()) {
      expect(ratio(light.marker, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(dark.marker, "#121316")).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("themeTokens", () => {
  it("produces light and dark token sets with contrasting surfaces", () => {
    const t = themeTokens();
    expect(Object.keys(t.light).sort()).toEqual(Object.keys(t.dark).sort());
    expect(ratio(t.light.surface, t.light.onSurface)).toBeGreaterThanOrEqual(7);
    expect(ratio(t.dark.surface, t.dark.onSurface)).toBeGreaterThanOrEqual(7);
  });
});
