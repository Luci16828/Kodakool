import { compareNames } from "./display";
import type { ArticleSummary } from "$lib/coding/doc";

/**
 * Pure document-tree builder for the sidebar: registered subfolder paths +
 * the project's documents become a nested node tree, which `flattenRows`
 * turns into the flat row list the sidebar renders (folder rows + doc rows,
 * depth-indented, folders before docs, folds respected).
 */

export interface TreeNode {
  /** subfolder path inside the project (never "") */
  path: string;
  /** last path segment — the display name */
  name: string;
  docs: ArticleSummary[];
  children: TreeNode[];
}

export type TreeRow =
  | { kind: "folder"; depth: number; path: string; name: string; count: number }
  | { kind: "doc"; depth: number; doc: ArticleSummary };

function segmentOf(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1] ?? path;
}

/** Every ancestor prefix of a path, shortest first ("a", "a/b", "a/b/c"). */
function ancestorsOf(path: string): string[] {
  const segs = path.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/**
 * Build the node tree from registered subfolders + documents. Documents whose
 * folder path is not registered (e.g. after an import) synthesize their nodes,
 * so the tree never hides a document.
 */
export function buildTree(docs: ArticleSummary[], subs: string[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const nodeFor = (path: string): TreeNode => {
    let n = nodes.get(path);
    if (!n) {
      n = { path, name: segmentOf(path), docs: [], children: [] };
      nodes.set(path, n);
    }
    return n;
  };
  for (const path of subs) for (const p of ancestorsOf(path)) nodeFor(p);
  for (const a of docs) for (const p of ancestorsOf(a.folder)) nodeFor(p);
  for (const a of docs) {
    const n = a.folder === "" ? null : nodes.get(a.folder);
    if (n) n.docs.push(a);
  }
  const roots: TreeNode[] = [];
  for (const n of [...nodes.values()].sort((x, y) => compareNames(x.path, y.path))) {
    const parent = n.path.includes("/") ? nodes.get(n.path.slice(0, n.path.lastIndexOf("/"))) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** Documents inside a node and all of its descendants. */
function subtreeDocs(node: TreeNode): ArticleSummary[] {
  return [...node.docs, ...node.children.flatMap(subtreeDocs)];
}

/**
 * Flatten to sidebar rows: folders first (sorted), then the node's documents,
 * depth-indented. A folded folder (not in `open`) contributes only its own row.
 */
export function flattenRows(roots: TreeNode[], open: Set<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const n of roots) {
    rows.push({ kind: "folder", depth, path: n.path, name: n.name, count: subtreeDocs(n).length });
    if (open.has(n.path))
      rows.push(
        ...flattenRows(n.children, open, depth + 1),
        ...n.docs.map((doc) => ({ kind: "doc" as const, depth: depth + 1, doc })),
      );
  }
  return rows;
}
