import type { Db } from "./db.ts";

/**
 * Access model: a project belongs to its owner; `members` rows are shared collaborators.
 * A user may read/write a project (and its documents/catalog) iff they own it or are a member.
 * Missing access answers 404 everywhere — the API never leaks which projects exist.
 */

export interface ProjectRow {
  id: string;
  owner: string;
  name: string;
  created: number;
}

export interface DocRow {
  id: string;
  project_id: string;
  name: string;
  folder: string;
  kind: string;
  text: string;
  codes: string;
  versions: string;
  updated: number;
}

export function projectAccess(db: Db, projectId: string, userId: string): ProjectRow | null {
  const row = db
    .prepare(
      `SELECT p.id, p.owner, p.name, p.created FROM projects p
       WHERE p.id = ? AND (p.owner = ? OR EXISTS (SELECT 1 FROM members m WHERE m.project_id = p.id AND m.user_id = ?))`,
    )
    .get(projectId, userId, userId) as ProjectRow | undefined;
  return row ?? null;
}

/** project lookup by NAME for a user who can access it (owner or member) — cross-project moves */
export function projectAccessByName(db: Db, name: string, userId: string): ProjectRow | null {
  const row = db
    .prepare(
      `SELECT p.id, p.owner, p.name, p.created FROM projects p
       WHERE p.name = ? AND (p.owner = ? OR EXISTS (SELECT 1 FROM members m WHERE m.project_id = p.id AND m.user_id = ?))`,
    )
    .get(name, userId, userId) as ProjectRow | undefined;
  return row ?? null;
}

export function docAccess(db: Db, docId: string, userId: string): DocRow | null {
  const row = db
    .prepare(
      `SELECT d.* FROM documents d
       WHERE d.id = ? AND (d.project_id IN (SELECT p.id FROM projects p WHERE p.owner = ?)
         OR d.project_id IN (SELECT m.project_id FROM members m WHERE m.user_id = ?))`,
    )
    .get(docId, userId, userId) as DocRow | undefined;
  return row ?? null;
}

export function docSummary(db: Db, d: DocRow): Record<string, unknown> {
  let codes = 0;
  try {
    codes = (JSON.parse(d.codes) as unknown[]).length;
  } catch {
    codes = 0;
  }
  return {
    id: d.id,
    project: d.project_id,
    name: d.name,
    folder: d.folder,
    kind: d.kind,
    codes,
    updated: d.updated,
  };
}

export function docFull(db: Db, d: DocRow): Record<string, unknown> {
  return {
    ...docSummary(db, d),
    text: d.text,
    codes: parseJson(d.codes, []),
    versions: parseJson(d.versions, []),
  };
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
