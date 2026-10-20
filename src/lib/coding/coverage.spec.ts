import { describe, expect, test } from "vitest";
import { analysisRows, hotSetFor, litSegments, narrowest, spanOf, splitSegments, type Placed } from "./coverage";
import { entryId } from "./edit";
import type { CodeEntry } from "./types";

const DEV_A = "847c4079-1958-49fe-92e8-c7547308be18";
const DEV_B = "2f7c1d94-3b60-4a05-9a2e-5d1c8e6f3b70";

function placed(id: string, from: number, to: number, opts: Partial<Placed> = {}): Placed {
  return { id, code: id, devices: [id], from, to, faded: false, ...opts };
}

describe("splitSegments", () => {
  test("empty input yields no segments", () => {
    expect(splitSegments([])).toEqual([]);
  });

  test("a single placement is one segment", () => {
    const segs = splitSegments([placed("a", 3, 9)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ from: 3, to: 9, ids: ["a"] });
  });

  test("disjoint placements stay separate", () => {
    const segs = splitSegments([placed("a", 0, 5), placed("b", 8, 12)]);
    expect(segs.map((s) => [s.from, s.to, s.ids])).toEqual([
      [0, 5, ["a"]],
      [8, 12, ["b"]],
    ]);
  });

  test("overlapping placements split into A, A+B, B", () => {
    const segs = splitSegments([placed("a", 0, 10), placed("b", 5, 15)]);
    expect(segs.map((s) => [s.from, s.to, s.ids])).toEqual([
      [0, 5, ["a"]],
      [5, 10, ["a", "b"]],
      [10, 15, ["b"]],
    ]);
    // coverage keeps placement order, ids are the sorted coverage set
    expect(segs[1].cov.map((p) => p.id)).toEqual(["a", "b"]);
    expect(segs[1].id).toBe("a|b");
  });

  test("adjacent placements do not merge (a placement ends exactly where the next starts)", () => {
    const segs = splitSegments([placed("a", 0, 5), placed("b", 5, 10)]);
    expect(segs.map((s) => [s.from, s.to, s.ids])).toEqual([
      [0, 5, ["a"]],
      [5, 10, ["b"]],
    ]);
  });

  test("a nested entry splits a wide one and the outer coverage continues after it", () => {
    const segs = splitSegments([placed("wide", 0, 20), placed("narrow", 8, 12)]);
    // ids keep placement order (only the segment id itself is sorted)
    expect(segs.map((s) => [s.from, s.to, s.ids])).toEqual([
      [0, 8, ["wide"]],
      [8, 12, ["wide", "narrow"]],
      [12, 20, ["wide"]],
    ]);
  });

  test("identical boundaries produce one segment, not zero-width gaps", () => {
    const segs = splitSegments([placed("a", 4, 8), placed("b", 4, 8)]);
    expect(segs).toHaveLength(1);
    expect(segs[0].ids).toEqual(["a", "b"]);
  });
});

describe("spanOf/narrowest", () => {
  const entry = (line: number, endLine: number | undefined, from: number, to: number): CodeEntry => ({
    device: DEV_A,
    line,
    ...(endLine !== undefined ? { endLine } : {}),
    range: [from, to],
    excerpt: "x",
  });

  test("pseudo coverage (no entry) never wins the narrowest rule", () => {
    expect(spanOf(placed("sel", 0, 100))).toBe(Number.POSITIVE_INFINITY);
    expect(narrowest([placed("sel", 0, 100)])).toBeUndefined();
  });

  test("lines dominate characters", () => {
    const short: Placed = { ...placed("a", 0, 50), entry: entry(1, undefined, 0, 50) };
    const tall: Placed = { ...placed("b", 0, 10), entry: entry(1, 3, 0, 10) };
    expect(narrowest([tall, short])?.id).toBe("a");
  });

  test("same line count: the shorter span wins", () => {
    const wide: Placed = { ...placed("a", 0, 50), entry: entry(1, undefined, 0, 50) };
    const tight: Placed = { ...placed("b", 0, 7), entry: entry(1, undefined, 0, 7) };
    expect(narrowest([wide, tight])?.id).toBe("b");
  });
});

describe("hotSetFor", () => {
  const segs = splitSegments([placed("a", 0, 10), placed("b", 5, 15)]);

  test("a live selection takes over the emphasis: nothing is hot", () => {
    expect([...hotSetFor(segs, "seg", "chip", true)]).toEqual([]);
  });

  test("hovering a segment marks its narrowest entry hot", () => {
    const wide = {
      ...placed("wide", 0, 100),
      entry: { device: DEV_A, line: 1, range: [0, 100] as [number, number], excerpt: "x" },
    };
    const narrow = {
      ...placed("narrow", 20, 24),
      entry: { device: DEV_B, line: 1, range: [20, 24] as [number, number], excerpt: "x" },
    };
    const s = hotSetFor(splitSegments([wide, narrow]), "narrow|wide", null, false);
    expect([...s]).toEqual(["narrow"]);
  });

  test("hovering a chip marks exactly that entry hot", () => {
    expect([...hotSetFor(segs, null, "b", false)]).toEqual(["b"]);
  });

  test("an unknown hovered segment id contributes nothing", () => {
    expect([...hotSetFor(segs, "nope", null, false)]).toEqual([]);
  });
});

describe("litSegments", () => {
  const entry = (device: string): CodeEntry => ({ device, line: 1, range: [0, 4], excerpt: "x" });
  const a = placed("a", 0, 10, { devices: ["d1"], entry: entry(DEV_A) });
  const b = placed("b", 5, 15, { devices: ["d2"], entry: entry(DEV_B) });
  const segs = splitSegments([a, b]);

  test("no hovered subtree → nothing lit", () => {
    expect(litSegments(segs, null, new Set())).toEqual([]);
  });

  test("only segments covered by the hovered device (or a hot entry) survive", () => {
    const lit = litSegments(segs, new Set(["d2"]), new Set());
    expect(lit.map((s) => [s.from, s.to])).toEqual([
      [5, 10],
      [10, 15],
    ]);
    expect(lit[0].lit.map((p) => p.id)).toEqual(["b"]);
    // the full coverage is carried along for the devices/code summary
    expect(lit[0].cov.map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("hot entries light their segments even outside the hovered subtree", () => {
    const lit = litSegments(segs, new Set(["d1"]), new Set(["b"]));
    expect(lit.map((s) => s.from)).toEqual([0, 5, 10]);
    expect(lit[1].hotIds.has("b")).toBe(true);
    expect(lit[1].hotIds.has("a")).toBe(false);
  });
});

describe("analysisRows", () => {
  const key = "proj/doc.txt";
  const text = "Alpha bravo charlie.\nDelta echo.\nFoxtrot golf.";
  const docStarts = [0, 21, 33];
  const index = {
    displayByDevice: new Map<string, string>([
      [DEV_A, "1.1"],
      [DEV_B, "2"],
    ]),
    nameByDevice: new Map<string, string>([
      [DEV_A, "Zitat"],
      [DEV_B, "Kommentar"],
    ]),
    shortByCode: new Map<string, string>([
      ["1.1", "ZIT"],
      ["2", "KOM"],
    ]),
  };
  const styleOf = (code: string) => `--marker:${code}`;

  const e1: CodeEntry = { device: DEV_A, line: 2, range: [6, 10], excerpt: "echo" };
  const e2: CodeEntry = { device: DEV_B, line: 1, endLine: 2, range: [12, 4], excerpt: "charlie.\nDelta" };

  test("live geometry wins; stored line/range is the fallback", () => {
    const livePos = new Map<string, { from: number; to: number }>([[entryId(key, e1), { from: 27, to: 31 }]]);
    const rows = analysisRows([e1, e2], key, livePos, docStarts, index, styleOf);
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.id === entryId(key, e1))!;
    expect([r1.from, r1.to]).toEqual([27, 31]);
    // e2 has no live position: docStarts[0] + 12 … docStarts[1] + 4
    const r2 = rows.find((r) => r.id === entryId(key, e2))!;
    expect([r2.from, r2.to]).toEqual([12, 25]);
  });

  test("rows are sorted by position with palette identity + line label", () => {
    const rows = analysisRows([e2, e1], key, new Map(), docStarts, index, styleOf);
    expect(rows.map((r) => r.id)).toEqual([entryId(key, e2), entryId(key, e1)]);
    expect(rows[0]).toMatchObject({ code: "2", label: "KOM", name: "Kommentar", lines: "1–2", style: "--marker:2" });
    expect(rows[1]).toMatchObject({ code: "1.1", label: "ZIT", name: "Zitat", lines: "2", style: "--marker:1.1" });
  });

  test("out-of-range and degenerate entries are dropped", () => {
    const broken: CodeEntry = { device: DEV_A, line: 99, range: [0, 4], excerpt: "x" };
    const empty: CodeEntry = { device: DEV_A, line: 1, range: [4, 4], excerpt: "" };
    expect(analysisRows([broken, empty], key, new Map(), docStarts, index, styleOf)).toEqual([]);
  });

  test("legacy code keys resolve through the index with a raw fallback", () => {
    const legacy: CodeEntry = { code: "3.1", line: 1, range: [0, 5], excerpt: "Alpha" };
    const rows = analysisRows([legacy], key, new Map(), docStarts, index, styleOf);
    expect(rows[0]).toMatchObject({ code: "3.1", label: "3.1", name: "3.1" });
  });
});
