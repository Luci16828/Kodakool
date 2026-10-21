/**
 * Storage interface the whole server codes against. `node:sqlite`'s `DatabaseSync`
 * satisfies it structurally (see db-node.ts), and the browser worker provides the
 * same shape over sqlite-wasm + OPFS (see sqlite-wasm.ts) — so the REST routes,
 * the auth flows and the realtime rooms run UNCHANGED in both environments
 * (the point: one behavior, no local/server drift).
 *
 * This module is environment-free (no node: imports): the worker bundles it safely.
 */
export interface DbStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
}

/**
 * Storage layout (node:sqlite — Node's built-in SQLite, no native npm deps):
 *
 * - users: password logins (pass) and OIDC identities (oidc_iss + oidc_sub), one row per user.
 * - sessions: hashed refresh tokens (the access token is a stateless JWT).
 * - projects + members: a project belongs to its owner; members are shared collaborators.
 * - documents: the materialized state of a collaborative document (text + codes + versions),
 *   kept in sync with the document's Yjs room by realtime.ts.
 * - catalogs: per-project frame-device catalog JSON (last-write-wins).
 * - doc_states: the persisted Yjs binary state per document.
 * - oidc_flows: in-flight PKCE authorization requests (state → verifier, 10 min TTL).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT NOT NULL,
  pass TEXT,
  oidc_iss TEXT,
  oidc_sub TEXT,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc ON users(oidc_iss, oidc_sub);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_name ON projects(owner, name);
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL DEFAULT '',
  codes TEXT NOT NULL DEFAULT '[]',
  versions TEXT NOT NULL DEFAULT '[]',
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_project_name ON documents(project_id, name);
CREATE TABLE IF NOT EXISTS catalogs (
  project_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_states (
  doc_id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_flows (
  state TEXT PRIMARY KEY,
  iss TEXT NOT NULL,
  client_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  redirect TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pdfs (
  doc_id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** additive column migrations for stores created before a schema addition */
export function applyMigrations(db: Db): void {
  try {
    db.exec("ALTER TABLE projects ADD COLUMN subs TEXT NOT NULL DEFAULT '[]'");
  } catch {
    /* column already present */
  }
}

/** create the schema + apply additive migrations (used by every engine opener) */
export function initSchema(db: Db): Db {
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** the schema text, shared by the node opener and the wasm shim */
export { SCHEMA };

export interface UserRow {
  id: string;
  email: string | null;
  name: string;
  pass: string | null;
  oidc_iss: string | null;
  oidc_sub: string | null;
}

export function userById(db: Db, id: string): UserRow | null {
  const r = db.prepare("SELECT id, email, name, pass, oidc_iss, oidc_sub FROM users WHERE id = ?").get(id);
  return (r as unknown as UserRow | undefined) ?? null;
}

export function userByEmail(db: Db, email: string): UserRow | null {
  const r = db
    .prepare("SELECT id, email, name, pass, oidc_iss, oidc_sub FROM users WHERE lower(email) = lower(?)")
    .get(email);
  return (r as unknown as UserRow | undefined) ?? null;
}

export function userByOidc(db: Db, iss: string, sub: string): UserRow | null {
  const r = db
    .prepare("SELECT id, email, name, pass, oidc_iss, oidc_sub FROM users WHERE oidc_iss = ? AND oidc_sub = ?")
    .get(iss, sub);
  return (r as unknown as UserRow | undefined) ?? null;
}
