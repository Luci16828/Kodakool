import { expect, it } from "vitest";
import { openWasmNodeDb } from "./sqlite-wasm.ts";
import { runApiSuite } from "./api.suite.ts";

/**
 * The same REST suite against the sqlite-wasm shim — the engine the browser worker
 * runs. If this file is green, the worker's storage behaves like node:sqlite.
 */
let n = 0;
runApiSuite(() => openWasmNodeDb(`suite-${process.pid}-${n++}`));

it("wasm shim round-trips BLOBs (doc_states storage)", async () => {
  const db = await openWasmNodeDb(`blob-${process.pid}`);
  db.exec("CREATE TABLE t (b BLOB)");
  const bytes = new Uint8Array([1, 2, 3, 250]);
  db.prepare("INSERT INTO t (b) VALUES (?)").run(bytes);
  const row = db.prepare("SELECT b FROM t").get() as { b: Uint8Array };
  expect([...row.b]).toEqual([1, 2, 3, 250]);
});
