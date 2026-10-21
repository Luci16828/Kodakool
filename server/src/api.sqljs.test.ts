import { expect, it } from "vitest";
import { openSqlJsDb } from "./sqljs.ts";
import { runApiSuite } from "./api.suite.ts";

/**
 * The same REST suite against the sql.js shim — the engine the SharedWorker runs
 * (IndexedDB is absent in node, so the store stays in memory there). If this file
 * is green, the worker's storage behaves like node:sqlite.
 */
runApiSuite(() => openSqlJsDb());

it("sql.js shim round-trips BLOBs (doc_states storage)", async () => {
  const db = await openSqlJsDb();
  db.exec("CREATE TABLE t (b BLOB)");
  const bytes = new Uint8Array([1, 2, 3, 250]);
  db.prepare("INSERT INTO t (b) VALUES (?)").run(bytes);
  const row = db.prepare("SELECT b FROM t").get() as { b: Uint8Array };
  expect([...row.b]).toEqual([1, 2, 3, 250]);
});
