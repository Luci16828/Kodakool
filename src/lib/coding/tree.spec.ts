import { describe, expect, it } from "vitest";
import { buildTree, flattenRows, type TreeNode } from "./tree";
import type { ArticleSummary } from "$lib/client/coding-db";

const doc = (name: string, folder = ""): ArticleSummary => ({
  id: name,
  project: "p",
  name,
  kind: "text",
  folder,
  updatedAt: 0,
  codes: 0,
  versions: 0,
});

describe("buildTree", () => {
  it("nests registered subfolders by path prefix", () => {
    const roots = buildTree([], ["sources", "sources/interviews", "notes"]);
    expect(roots.map((r) => r.path)).toEqual(["notes", "sources"]);
    const sources = roots[1] as TreeNode;
    expect(sources.children.map((c) => c.path)).toEqual(["sources/interviews"]);
  });

  it("synthesizes nodes for documents in unregistered folders", () => {
    const roots = buildTree([doc("a.txt", "deep/nested")], []);
    expect(roots.map((r) => r.path)).toEqual(["deep"]);
    expect(roots[0].children[0].docs.map((d) => d.name)).toEqual(["a.txt"]);
  });

  it("keeps root documents out of the node tree", () => {
    expect(buildTree([doc("a.txt")], [])).toHaveLength(0);
  });
});

describe("flattenRows", () => {
  it("lists folders before docs and counts the whole subtree", () => {
    const rows = flattenRows(
      buildTree(
        [doc("x.txt", "sources/interviews"), doc("y.txt", "sources"), doc("r.txt")],
        ["sources", "sources/interviews"],
      ),
      new Set(["sources", "sources/interviews"]),
    );
    expect(rows.map((r) => [r.kind, "path" in r ? r.path : r.doc.name])).toEqual([
      ["folder", "sources"],
      ["folder", "sources/interviews"],
      ["doc", "x.txt"],
      ["doc", "y.txt"],
    ]);
    expect(rows[0].kind === "folder" && rows[0].count).toBe(2);
  });

  it("a folded folder contributes only its own row", () => {
    const rows = flattenRows(buildTree([doc("x.txt", "sources")], ["sources"]), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("folder");
  });

  it("indents by depth", () => {
    const rows = flattenRows(buildTree([], ["a", "a/b"]), new Set(["a"]));
    expect(rows.map((r) => r.depth)).toEqual([0, 1]);
  });
});
