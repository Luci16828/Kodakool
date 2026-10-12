import { beforeAll, describe, expect, it } from "vitest";
import { parseCodingJson, verifyCoding, verifyEntry } from "$lib/coding/verify";
import { loadAllViews } from "$lib/server/coding/store";
import type { SourceView } from "$lib/server/coding/store";
import type { CodeEntry } from "$lib/coding/types";

const LINE = "Er ging mit dem Hund nach Hause";
const SOURCE = `first line\n${LINE}\nthird line`;

function entry(partial: Partial<CodeEntry>): CodeEntry {
  return {
    code: "test",
    line: 2,
    range: [0, LINE.length],
    excerpt: LINE,
    ...partial,
  };
}

describe("verifyEntry", () => {
  it("accepts a verbatim excerpt", () => {
    expect(verifyEntry(SOURCE, entry({}))).toBeNull();
    expect(verifyEntry(SOURCE, entry({ range: [3, 7], excerpt: "ging" }))).toBeNull();
  });

  it("rejects an excerpt that does not match the range", () => {
    expect(typeof verifyEntry(SOURCE, entry({ excerpt: "Er ging" }))).toBe("string");
  });

  it("rejects out-of-bounds ranges and lines", () => {
    expect(verifyEntry(SOURCE, entry({ range: [0, LINE.length + 5] }))).toMatch(/invalid/);
    expect(verifyEntry(SOURCE, entry({ line: 99 }))).toMatch(/out of range/);
  });

  it("accepts an excerpt with [...] collapsing the middle", () => {
    expect(verifyEntry(SOURCE, entry({ excerpt: "Er ging [...] nach Hause" }))).toBeNull();
    expect(verifyEntry(SOURCE, entry({ excerpt: "Er ging [...] dem [...] Hause" }))).toBeNull();
  });

  it("rejects [...] when segments are not anchored to the range", () => {
    const msg = verifyEntry(SOURCE, entry({ range: [3, LINE.length], excerpt: "Er ging [...] Hause" }));
    expect(msg).toMatch(/does not appear in order|start exactly|anchored/);
  });

  it("rejects [...] when the last segment ends before the range end", () => {
    expect(verifyEntry(SOURCE, entry({ excerpt: "Er ging [...] Hund" }))).toMatch(
      /last segment must end exactly at range end/,
    );
  });

  it("rejects [...] with nothing actually collapsed", () => {
    expect(
      verifyEntry("Er ging nach Hause", entry({ line: 1, range: [0, 18], excerpt: "Er ging [...] nach Hause" })),
    ).toMatch(/does not appear in order/);
  });

  it("rejects empty segments around [...]", () => {
    expect(verifyEntry(SOURCE, entry({ excerpt: "[...] Hund nach Hause" }))).toMatch(/\[\.\.\.\]/);
  });

  it("accepts an entry crossing line breaks", () => {
    const e = entry({
      line: 1,
      endLine: 3,
      range: [6, 5],
      excerpt: `line\n${LINE}\nthird`,
    });
    expect(verifyEntry(SOURCE, e)).toBeNull();
  });

  it("accepts [...] collapsing across line breaks", () => {
    const e = entry({
      line: 1,
      endLine: 3,
      range: [6, 5],
      excerpt: `line\nEr ging [...]third`,
    });
    expect(verifyEntry(SOURCE, e)).toBeNull();
  });

  it("rejects endLine before line or out of bounds", () => {
    expect(verifyEntry(SOURCE, entry({ endLine: 1 }))).toMatch(/endLine/);
    expect(verifyEntry(SOURCE, entry({ endLine: 99 }))).toMatch(/endLine/);
  });
});

describe("verifyCoding", () => {
  it("allows overlapping ranges on the same line", () => {
    const codes = [
      entry({ range: [0, 10], excerpt: LINE.slice(0, 10) }),
      entry({ range: [5, 12], excerpt: LINE.slice(5, 12) }),
    ];
    expect(verifyCoding(SOURCE, { source: "x.txt", codes })).toEqual([]);
  });
});

describe("parseCodingJson", () => {
  it("round-trips a valid coding file", () => {
    const coding = parseCodingJson(JSON.stringify({ source: "a.txt", codes: [entry({})] }));
    expect(coding.source).toBe("a.txt");
    expect(coding.codes).toHaveLength(1);
  });

  it("keeps endLine when present", () => {
    const coding = parseCodingJson(JSON.stringify({ source: "a.txt", codes: [entry({ endLine: 3 })] }));
    expect(coding.codes[0].endLine).toBe(3);
  });

  it("throws when endLine is before line", () => {
    expect(() => parseCodingJson(JSON.stringify({ source: "a.txt", codes: [entry({ line: 2, endLine: 1 })] }))).toThrow(
      /endLine/,
    );
  });

  it("throws on malformed entries", () => {
    expect(() => parseCodingJson(JSON.stringify({ source: "a.txt", codes: [{ code: "" }] }))).toThrow();
  });

  it("accepts device-UUID-only entries", () => {
    const coding = parseCodingJson(
      JSON.stringify({
        source: "a.txt",
        codes: [{ ...entry({}), code: undefined, device: "1b47ae32-ef71-4158-8c98-ebc3594efc41" }],
      }),
    );
    expect(coding.codes[0].code).toBeUndefined();
    expect(coding.codes[0].device).toBe("1b47ae32-ef71-4158-8c98-ebc3594efc41");
  });

  it("throws when an entry has neither code nor device", () => {
    const { code: _code, ...noCode } = entry({});
    expect(() => parseCodingJson(JSON.stringify({ source: "a.txt", codes: [noCode] }))).toThrow(/device/);
  });

  it("throws on a non-UUID device", () => {
    expect(() =>
      parseCodingJson(JSON.stringify({ source: "a.txt", codes: [{ ...entry({}), device: "not-a-uuid" }] })),
    ).toThrow();
  });
});

describe("coding files", () => {
  let views: SourceView[] = [];
  beforeAll(async () => {
    views = await loadAllViews();
  });

  it("has at least one coded source", () => {
    expect(views.some((v) => v.codes > 0)).toBe(true);
  });

  it("verifies every coding file against its source text", () => {
    const failures = views.flatMap((v) => (v.status === "failed" ? v.errors.map((e) => `${v.source}: ${e}`) : []));
    expect(failures).toEqual([]);
  });
});
