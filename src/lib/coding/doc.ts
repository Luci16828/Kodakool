import type { CodeEntry } from "$lib/coding/types";

/**
 * The app's document shapes — the UI's view of a coding document.
 *
 * These types used to live in the RxDB layer (`coding-db.ts`); with the local
 * account served by the in-worker server they are plain data shapes shared by
 * every account: the worker's REST wire types are mapped onto them by the
 * screens, so the tree, the history graph and the download code are identical
 * for local and remote documents.
 */

export interface ArticleVersion {
  /** stable snapshot id — the graph node every child links to */
  id: string;
  savedAt: number;
  label?: string;
  /** snapshot this one continues from (null = root of a history) */
  parent: string | null;
  text: string;
  codes: CodeEntry[];
}

/** "pdf" articles carry extracted PDF text and are always read-only */
export type ArticleKind = "text" | "pdf";

export interface ArticleData {
  id: string;
  project: string;
  name: string;
  text: string;
  kind?: ArticleKind;
  /** subfolder path inside the project ("sources/interviews"); "" = project root */
  folder?: string;
  createdAt: number;
  updatedAt: number;
  versions: ArticleVersion[];
}

export interface ArticleSummary {
  id: string;
  project: string;
  name: string;
  kind: ArticleKind;
  /** subfolder path inside the project; "" = project root */
  folder: string;
  updatedAt: number;
  codes: number;
  versions: number;
}
