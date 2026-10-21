import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA, applyMigrations } from "./db.ts";

/**
 * Node storage openers (node:sqlite — Node's built-in SQLite, no native npm deps).
 * The worker uses sqlite-wasm/OPFS instead (sqlite-wasm.ts); everything above the
 * `Db` interface is shared.
 */

export function openDb(dataDir: string, file = "kodakool.sqlite"): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, file));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** in-memory database for tests */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}
