import { describe, expect, test } from "vitest";
import { excerptSegments, parseCodingJson, verifyCoding, verifyEntry } from "./verify";
import { ELLIPSIS } from "./types";
import type { CodeEntry } from "./types";

const TEXT = ["Alpha bravo charlie.", "Delta echo.", "", "Foxtrot golf."].join("\n");

const device = "847c4079-1958-49fe-92e8-c7547308be18";

function entry(patch: Partial<CodeEntry>): CodeEntry {
  return { device, line: 1, range: [0, 5], excerpt: "Alpha", ...patch };
}

describe("excerptSegments", () => {
  test("splits on the literal [...] ellipsis", () => {
    expect(excerptSegments("a b c")).toEqual(["a b c"]);
    expect(excerptSegments(`a ${ELLIPSIS} b`)).toEqual(["a ", " b"]);
    expect(excerptSegments(`a${ELLIPSIS}b${ELLIPSIS}c`)).toEqual(["a", "b", "c"]);
  });
});

describe("verifyEntry — verbatim spans", () => {
  test("accepts an excerpt that equals the range exactly", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, range: [6, 11], excerpt: "bravo" }))).toBeNull();
    expect(verifyEntry(TEXT, entry({ line: 1, range: [0, 20], excerpt: "Alpha bravo charlie." }))).toBeNull();
  });

  test("rejects an excerpt that differs from the range", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, range: [6, 11], excerpt: "Bravo" }))).toMatch(/does not match/);
    expect(verifyEntry(TEXT, entry({ line: 1, range: [6, 10], excerpt: "bravo" }))).toMatch(/does not match/);
  });

  test("accepts a multi-line span joined with newlines", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 2, range: [12, 5], excerpt: "charlie.\nDelta" }))).toBeNull();
  });

  test("endLine defaults to line", () => {
    expect(verifyEntry(TEXT, entry({ line: 2, range: [0, 11], excerpt: "Delta echo." }))).toBeNull();
  });

  test("a multi-line span may end at offset 0 of its endLine (trailing newline)", () => {
    expect(verifyEntry(TEXT, entry({ line: 2, endLine: 3, range: [6, 0], excerpt: "echo.\n" }))).toBeNull();
  });

  test("empty lines are valid span interiors", () => {
    expect(verifyEntry(TEXT, entry({ line: 2, endLine: 4, range: [10, 3], excerpt: ".\n\nFox" }))).toBeNull();
  });
});

describe("verifyEntry — ellipsis spans", () => {
  const ellipsis = (excerpt: string): string | null => verifyEntry(TEXT, entry({ line: 1, range: [0, 20], excerpt }));

  test("first segment anchors at the range start, last at its end", () => {
    expect(ellipsis(`Alpha ${ELLIPSIS} charlie.`)).toBeNull();
    expect(ellipsis(`Alpha${ELLIPSIS}bravo${ELLIPSIS}charlie.`)).toBeNull();
  });

  test("rejects a first segment that does not start at range start", () => {
    expect(ellipsis(`bravo ${ELLIPSIS} charlie.`)).toMatch(/segment 1 .* does not appear in order/);
  });

  test("rejects a last segment that does not end at range end", () => {
    expect(ellipsis(`Alpha ${ELLIPSIS} charlie`)).toMatch(/last segment must end exactly at range end/);
  });

  test("segments must appear in order", () => {
    expect(ellipsis(`charlie. ${ELLIPSIS} Alpha`)).toMatch(/does not appear in order/);
  });

  test("at least one character must be omitted between segments", () => {
    expect(ellipsis(`Alpha ${ELLIPSIS}bravo`)).toMatch(/does not appear in order/);
  });

  test("rejects leading, trailing and adjacent ellipses", () => {
    expect(ellipsis(`${ELLIPSIS} charlie.`)).toMatch(/must not start or end with/);
    expect(ellipsis(`Alpha ${ELLIPSIS}`)).toMatch(/must not start or end with/);
    expect(ellipsis(`Alpha ${ELLIPSIS}${ELLIPSIS} charlie.`)).toMatch(/must not start or end with/);
    expect(ellipsis(ELLIPSIS)).toMatch(/must not start or end with/);
  });

  test("an empty excerpt is rejected", () => {
    expect(verifyEntry(TEXT, entry({ excerpt: "" }))).toMatch(/must not start or end with/);
  });
});

describe("verifyEntry — range/line bounds", () => {
  test("line must be an integer within 1..lines", () => {
    expect(verifyEntry(TEXT, entry({ line: 0 }))).toMatch(/line 0 is out of range \(1-4\)/);
    expect(verifyEntry(TEXT, entry({ line: 5 }))).toMatch(/line 5 is out of range \(1-4\)/);
    expect(verifyEntry(TEXT, entry({ line: 1.5 }))).toMatch(/line 1.5 is out of range/);
  });

  test("endLine must be an integer between line and the last line", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 0 }))).toMatch(/endLine 0 is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 5 }))).toMatch(/endLine 5 is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 2, endLine: 1 }))).toMatch(/endLine 1 is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 2.5 }))).toMatch(/endLine 2.5 is invalid/);
  });

  test("range bounds must be integers", () => {
    expect(verifyEntry(TEXT, entry({ range: [0.5, 5] }))).toMatch(/must be integers/);
    expect(verifyEntry(TEXT, entry({ range: [0, 5.5] }))).toMatch(/must be integers/);
  });

  test("start must lie inside its line (empty lines accept no start)", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, range: [-1, 5] }))).toMatch(/range start -1 is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 1, range: [20, 21] }))).toMatch(
      /range start 20 is invalid for line 1 \(length 20\)/,
    );
    expect(verifyEntry(TEXT, entry({ line: 3, range: [0, 1] }))).toMatch(
      /range start 0 is invalid for line 3 \(length 0\)/,
    );
  });

  test("end must lie within its endLine", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, range: [0, -1] }))).toMatch(/range end -1 is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 1, range: [0, 21] }))).toMatch(
      /range end 21 is invalid for line 1 \(length 20\)/,
    );
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 2, range: [0, 12] }))).toMatch(
      /range end 12 is invalid for line 2 \(length 11\)/,
    );
  });

  test("same-line ranges must be non-empty and ordered", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, range: [5, 5] }))).toMatch(/range \[5, 5\) is invalid/);
    expect(verifyEntry(TEXT, entry({ line: 1, range: [9, 6] }))).toMatch(/range \[9, 6\) is invalid/);
  });

  test("multi-line ranges may end before their start offset", () => {
    expect(verifyEntry(TEXT, entry({ line: 1, endLine: 2, range: [12, 2], excerpt: "charlie.\nDe" }))).toBeNull();
  });
});

describe("verifyCoding", () => {
  test("empty coding files verify clean", () => {
    expect(verifyCoding(TEXT, { source: "t/x.txt", codes: [] })).toEqual([]);
  });

  test("overlapping entries are allowed", () => {
    const coding = {
      source: "t/x.txt",
      codes: [
        entry({ line: 1, range: [0, 11], excerpt: "Alpha bravo" }),
        entry({ line: 1, range: [6, 20], excerpt: "bravo charlie." }),
        entry({ line: 1, range: [0, 20], excerpt: `Alpha ${ELLIPSIS} charlie.` }),
      ],
    };
    expect(verifyCoding(TEXT, coding)).toEqual([]);
  });

  test("reports every failing entry with its index", () => {
    const coding = {
      source: "t/x.txt",
      codes: [entry({ line: 1, range: [0, 5], excerpt: "Alpha" }), entry({ line: 1, range: [0, 5], excerpt: "Bravo" })],
    };
    const errors = verifyCoding(TEXT, coding);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
    expect(errors[0].message).toMatch(/does not match/);
  });
});

describe("parseCodingJson", () => {
  test("accepts a valid coding file", () => {
    const raw = JSON.stringify({ source: "t/x.txt", codes: [{ device, line: 1, range: [0, 5], excerpt: "Alpha" }] });
    expect(parseCodingJson(raw)).toEqual(JSON.parse(raw));
  });

  test("accepts app-owned files with text + versions", () => {
    const raw = JSON.stringify({
      source: "p/n",
      text: "Alpha bravo",
      versions: [{ savedAt: "2026-01-01T00:00:00.000Z", text: "Alpha", codes: [] }],
      codes: [],
    });
    expect(parseCodingJson(raw).versions).toHaveLength(1);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseCodingJson("{ nope")).toThrow();
  });

  test("rejects entries without code label and device", () => {
    const raw = JSON.stringify({ source: "t/x.txt", codes: [{ line: 1, range: [0, 5], excerpt: "Alpha" }] });
    expect(() => parseCodingJson(raw)).toThrow(/entry needs a "code" label or a "device" UUID/);
  });

  test("rejects endLine below line and names the path", () => {
    const raw = JSON.stringify({
      source: "t/x.txt",
      codes: [{ device, line: 3, endLine: 2, range: [0, 5], excerpt: "Alpha" }],
    });
    expect(() => parseCodingJson(raw)).toThrow(/ at codes\.0\.endLine: endLine 2 must be >= line 3/);
  });

  test("rejects a missing source", () => {
    expect(() => parseCodingJson(JSON.stringify({ codes: [] }))).toThrow(/ at source/);
  });

  test("rejects non-integer line values", () => {
    const raw = JSON.stringify({ source: "t/x.txt", codes: [{ device, line: 1.5, range: [0, 5], excerpt: "Alpha" }] });
    expect(() => parseCodingJson(raw)).toThrow(/ at codes\.0\.line/);
  });
});
