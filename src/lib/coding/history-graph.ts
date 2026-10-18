import type { ArticleVersion } from "$lib/client/coding-db";

/**
 * Snapshot history as a commit graph.
 *
 * Versions form a DAG through their `parent` field: snapshots taken one after another
 * chain linearly, and reverting to an older snapshot moves the live document back onto
 * that node — the next snapshot then branches off it, exactly like a git branch.
 *
 * This module is the pure translation from that DAG to the ordered list of drawing
 * operations a graph renderer replays (`@gitgraph/js`'s `branch()` / `commit()` API).
 * No DOM here, so the whole mapping is testable outside a browser.
 */

/** Name of the first lineage; later ones read `line 2`, `line 3`, ... */
export const MAIN_BRANCH = "main";

/** One snapshot as the graph draws it, in chronological (oldest-first) order. */
export interface GraphOp {
  version: ArticleVersion;
  /** the branch this snapshot is drawn on */
  branch: string;
  /** `true` when this snapshot opens a new branch line (a root, or a fork off its parent) */
  create: boolean;
  /** commit hash the new branch starts from (null for a root) — only meaningful with `create` */
  from: string | null;
  /** `true` when the live document continues from this snapshot */
  head: boolean;
  /** `true` when this snapshot is the tip of its branch (where the label sits) */
  tip: boolean;
}

export interface SnapshotGraph {
  /** drawing operations, oldest snapshot first */
  ops: GraphOp[];
  /** snapshot id -> branch name */
  branchOf: Map<string, string>;
  /** branch name -> snapshot id its label sits on (the branch tip) */
  tips: Map<string, string>;
  /** the snapshot the live document continues from (null when there is no history yet) */
  head: string | null;
}

/** Display name of a snapshot inside the graph: its label, else its timestamp. */
export function snapshotLabel(v: ArticleVersion): string {
  const label = v.label?.trim();
  return label !== undefined && label !== "" ? label : new Date(v.savedAt).toLocaleString();
}

/**
 * Map the version DAG onto branch lines.
 *
 * Walking chronologically: a snapshot inherits its parent's branch, and a parent that
 * already has a successor gets a fresh line for its next child — that is the visual fork.
 * A `parent` that is not in `versions` (the MAX_VERSIONS cap dropped it) opens a root, so
 * a truncated history still draws.
 */
export function buildSnapshotGraph(versions: ArticleVersion[], head: string | null = null): SnapshotGraph {
  const known = new Set(versions.map((v) => v.id));
  const chronological = listSnapshots(versions).slice().reverse();

  const branchOf = new Map<string, string>();
  const tips = new Map<string, string>();
  const taken = new Set<string>();
  const ops: GraphOp[] = [];
  let lines = 0;

  for (const v of chronological) {
    const parent = v.parent !== null && known.has(v.parent) ? v.parent : null;
    let branch: string;
    let create = false;
    let from: string | null = null;
    if (parent === null) {
      branch = lines === 0 ? MAIN_BRANCH : `line ${++lines}`;
      if (lines === 0) lines = 1;
      create = true;
    } else if (!taken.has(parent)) {
      // first child continues its parent's line
      branch = branchOf.get(parent) as string;
      taken.add(parent);
    } else {
      // parent already has a successor on its line -> this snapshot forks
      branch = `line ${++lines}`;
      create = true;
      from = parent;
    }
    branchOf.set(v.id, branch);
    tips.set(branch, v.id);
    ops.push({ version: v, branch, create, from, head: false, tip: true });
  }

  // exactly one tip per branch: the newest snapshot written on it
  for (const op of ops) {
    op.tip = tips.get(op.branch) === op.version.id;
    op.head = op.version.id === head;
  }

  return { ops, branchOf, tips, head: head !== null && known.has(head) ? head : null };
}

/**
 * Snapshots newest-first for the list beside the drawing.
 *
 * Chronological order with stored-order tie-breaking, reversed — so the list reads the
 * same top-down as the graph.
 */
export function listSnapshots(versions: ArticleVersion[]): ArticleVersion[] {
  const index = new Map(versions.map((v, i) => [v.id, i]));
  return [...versions]
    .sort((a, b) => a.savedAt - b.savedAt || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
    .reverse();
}
