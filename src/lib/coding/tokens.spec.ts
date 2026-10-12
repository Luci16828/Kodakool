import { describe, expect, it } from "vitest";
import { buildTokens } from "$lib/coding/tokens";
import type { CodeEntry } from "$lib/coding/types";

const TEXT = "aaa bbb ccc\nddd\neee";

const flat = (tokens: { text: string }[]) => tokens.map((t) => t.text).join("");

describe("buildTokens", () => {
  it("reproduces the source text exactly", () => {
    const codes: CodeEntry[] = [
      { code: "a", line: 1, range: [0, 5], excerpt: "aaa b" },
      { code: "b", line: 1, range: [4, 8], excerpt: "bbb " },
      { code: "c", line: 1, endLine: 3, range: [9, 2], excerpt: "cc\nddd\nee" },
    ];
    expect(flat(buildTokens(TEXT, codes))).toBe(TEXT);
  });

  it("lists both codes for overlapping characters", () => {
    const codes: CodeEntry[] = [
      { code: "a", line: 1, range: [0, 5], excerpt: "aaa b" },
      { code: "b", line: 1, range: [4, 8], excerpt: "bbb " },
    ];
    const overlap = buildTokens(TEXT, codes).find((t) => t.codes.length === 2);
    expect(overlap?.text).toBe("b");
    expect(overlap?.codes).toEqual([0, 1]);
  });

  it("splits cross-line entries into per-line tokens", () => {
    const codes: CodeEntry[] = [{ code: "c", line: 1, endLine: 3, range: [9, 2], excerpt: "cc\nddd\nee" }];
    const coded = buildTokens(TEXT, codes).filter((t) => t.codes.length > 0);
    expect(coded.map((t) => t.text)).toEqual(["cc", "ddd", "ee"]);
  });

  it("marks tokens where an entry starts", () => {
    const codes: CodeEntry[] = [
      { code: "a", line: 1, range: [0, 5], excerpt: "aaa b" },
      { code: "b", line: 1, range: [4, 8], excerpt: "bbb " },
      { code: "c", line: 1, endLine: 3, range: [9, 2], excerpt: "cc\nddd\nee" },
    ];
    const tokens = buildTokens(TEXT, codes);
    expect(tokens.find((t) => t.text === "aaa ")?.starts).toEqual([0]);
    expect(tokens.find((t) => t.codes.length === 2)?.starts).toEqual([1]);
    const continuation = buildTokens(TEXT, codes)
      .filter((t) => t.codes.length > 0)
      .find((t) => t.text === "ddd");
    expect(continuation?.text).toBe("ddd");
    expect(continuation?.starts).toEqual([]);
  });
});
