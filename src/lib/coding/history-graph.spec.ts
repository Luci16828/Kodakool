import { describe, expect, it } from "vitest";
import { buildSnapshotGraph, listSnapshots, MAIN_BRANCH, snapshotLabel } from "./history-graph";
import type { ArticleVersion } from "$lib/coding/doc";

/** Minimal snapshot: only the graph fields matter here. */
function v(id: string, savedAt: number, parent: string | null, label?: string): ArticleVersion {
  return { id, savedAt, parent, text: `t${id}`, codes: [], ...(label ? { label } : {}) };
}

describe("snapshot graph", () => {
  it("draws nothing for an empty history", () => {
    const g = buildSnapshotGraph([], null);
    expect(g.ops).toEqual([]);
    expect(g.head).toBe(null);
    expect(g.tips.size).toBe(0);
  });

  it("keeps a linear history on one line", () => {
    const a = v("a", 1, null);
    const b = v("b", 2, "a");
    const c = v("c", 3, "b");
    const g = buildSnapshotGraph([a, b, c], "c");

    expect(g.ops.map((o) => [o.version.id, o.branch, o.create])).toEqual([
      ["a", MAIN_BRANCH, true],
      ["b", MAIN_BRANCH, false],
      ["c", MAIN_BRANCH, false],
    ]);
    expect(g.tips.get(MAIN_BRANCH)).toBe("c");
    expect(g.ops.at(-1)?.tip).toBe(true);
    expect(g.ops.slice(0, 2).every((o) => !o.tip)).toBe(true);
    expect(g.ops.at(-1)?.head).toBe(true);
  });

  it("forks a new line when a snapshot continues from an older node", () => {
    // a -> b -> c on main, then a revert to b makes the next snapshot fork off b
    const a = v("a", 1, null);
    const b = v("b", 2, "a");
    const c = v("c", 3, "b");
    const d = v("d", 4, "b");
    const g = buildSnapshotGraph([a, b, c, d], "d");

    expect(g.branchOf.get("d")).toBe("line 2");
    expect(g.ops.find((o) => o.version.id === "d")?.from).toBe("b");
    // the fork is a root of its own line, main keeps its own tip
    expect(g.tips.get(MAIN_BRANCH)).toBe("c");
    expect(g.tips.get("line 2")).toBe("d");
  });

  it("gives every root its own line and never reuses a taken name", () => {
    const a = v("a", 1, null);
    const b = v("b", 2, null);
    const c = v("c", 3, null);
    const g = buildSnapshotGraph([a, b, c], "c");

    expect(g.ops.map((o) => o.branch)).toEqual([MAIN_BRANCH, "line 2", "line 3"]);
    expect(new Set(g.ops.map((o) => o.branch)).size).toBe(3);
  });

  it("treats a parent the cap dropped as a root", () => {
    // MAX_VERSIONS sliced the oldest snapshot away: its child must still draw
    const b = v("b", 2, "gone");
    const c = v("c", 3, "b");
    const g = buildSnapshotGraph([b, c], "c");

    expect(g.ops.map((o) => o.branch)).toEqual([MAIN_BRANCH, MAIN_BRANCH]);
    expect(g.ops[0]?.create).toBe(true);
    expect(g.ops[0]?.from).toBe(null);
  });

  it("ignores a head id that is not in the history", () => {
    const a = v("a", 1, null);
    const g = buildSnapshotGraph([a], "stale");
    expect(g.head).toBe(null);
    expect(g.ops[0]?.head).toBe(false);
  });

  it("orders ops oldest-first and the list newest-first", () => {
    const a = v("a", 1, null);
    const b = v("b", 2, "a");
    const g = buildSnapshotGraph([b, a], "b");
    expect(g.ops.map((o) => o.version.id)).toEqual(["a", "b"]);
    expect(listSnapshots([b, a]).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("breaks timestamp ties by stored order", () => {
    const a = v("a", 5, null);
    const b = v("b", 5, "a");
    expect(listSnapshots([a, b]).map((x) => x.id)).toEqual(["b", "a"]);
    expect(buildSnapshotGraph([a, b], "b").ops.map((o) => o.version.id)).toEqual(["a", "b"]);
  });

  it("names a snapshot by its label, falling back to the timestamp", () => {
    expect(snapshotLabel(v("a", 1, null, "  chapter one  "))).toBe("chapter one");
    const dated = v("a", 1700000000000, null);
    expect(snapshotLabel(dated)).toBe(new Date(1700000000000).toLocaleString());
    expect(snapshotLabel(v("a", 1, null, "   "))).toBe(new Date(1).toLocaleString());
  });
});
