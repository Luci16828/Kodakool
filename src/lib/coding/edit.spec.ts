import { describe, expect, test } from "vitest";
import { entryFromOffsets, entryId, lineAt, lineStarts } from "./edit";
import { verifyEntry } from "./verify";

const text = "Alpha bravo charlie.\nDelta echo.\nFoxtrot.";
const starts = lineStarts(text);

describe("lineStarts/lineAt", () => {
  test("maps positions to 0-based lines", () => {
    expect(starts).toEqual([0, 21, 33]);
    expect(lineAt(starts, 0)).toBe(0);
    expect(lineAt(starts, 20)).toBe(0);
    expect(lineAt(starts, 21)).toBe(1);
    expect(lineAt(starts, 32)).toBe(1);
    expect(lineAt(starts, 33)).toBe(2);
    expect(lineAt(starts, text.length - 1)).toBe(2);
  });
});

describe("entryFromOffsets", () => {
  const device = "847c4079-1958-49fe-92e8-c7547308be18";

  test("single-line selection produces a verifying entry", () => {
    const from = text.indexOf("bravo");
    const to = from + "bravo charlie".length;
    const entry = entryFromOffsets("test/x.txt", starts, text, from, to, device);
    expect(entry).toEqual({
      device,
      line: 1,
      range: [6, 19],
      excerpt: "bravo charlie",
    });
    expect(verifyEntry(text, entry)).toBeNull();
  });

  test("multi-line selection sets endLine and crosses the newline", () => {
    const from = text.indexOf("charlie");
    const to = text.indexOf("echo") + "echo".length;
    const entry = entryFromOffsets("test/x.txt", starts, text, from, to, device);
    expect(entry.line).toBe(1);
    expect(entry.endLine).toBe(2);
    expect(entry.range).toEqual([12, 10]);
    expect(entry.excerpt).toBe("charlie.\nDelta echo");
    expect(verifyEntry(text, entry)).toBeNull();
  });

  test("selection ending exactly at a line end keeps a valid exclusive range", () => {
    const from = text.indexOf("Delta");
    const to = starts[2]; // start of line 3
    const entry = entryFromOffsets("test/x.txt", starts, text, from, to, device);
    expect(entry.line).toBe(2);
    expect(entry.endLine).toBeUndefined();
    expect(entry.range).toEqual([0, 11]);
    expect(verifyEntry(text, entry)).toBeNull();
  });
});

describe("entryId", () => {
  test("is deterministic and distinguishes ranges", () => {
    const a = { device: "d1", line: 2, range: [0, 5] as [number, number], excerpt: "x" };
    const b = { ...a, range: [1, 5] as [number, number] };
    expect(entryId("s.txt", a)).toBe(entryId("s.txt", a));
    expect(entryId("s.txt", a)).not.toBe(entryId("s.txt", b));
    expect(entryId("s.txt", { ...a, endLine: 3 })).not.toBe(entryId("s.txt", a));
  });
});
