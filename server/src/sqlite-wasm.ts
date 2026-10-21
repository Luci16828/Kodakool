import type { Db, DbStatement } from "./db.ts";

/**
 * `Db` shim over @sqlite.org/sqlite-wasm — the worker's storage.
 *
 * In the browser worker the database lives on the OPFS SAHPool VFS: after the async
 * open, every statement is SYNCHRONOUS, exactly like node:sqlite, so the server code
 * (REST routes, auth, realtime rooms) runs unchanged. In Node (tests) the same shim
 * wraps the default VFS — the REST suite runs against both engines as a parity proof.
 */

import { initSchema } from "./db.ts";

/** the subset of sqlite-wasm's oo1.DB the shim uses */
interface Oo1Db {
  exec(...args: unknown[]): unknown;
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/** wrap any sqlite-wasm oo1.DB handle in the server's `Db` interface.
 *  oo1.exec takes (sql) or (sql, options) — bind/rowMode/resultRows ride IN the
 *  options object, so every call goes through the options form. */
export function wrapOo1(raw: Oo1Db): Db {
  const rows = (sql: string, bind: unknown[]): unknown[] => {
    const resultRows: unknown[] = [];
    raw.exec({ sql, bind, rowMode: "object", resultRows });
    return resultRows;
  };
  return {
    prepare(sql: string): DbStatement {
      return {
        get(...params: unknown[]) {
          return rows(sql, params)[0];
        },
        all(...params: unknown[]) {
          return rows(sql, params);
        },
        run(...params: unknown[]) {
          raw.exec({ sql, bind: params });
          return { changes: raw.changes, lastInsertRowid: raw.lastInsertRowid };
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
  };
}

async function initSqlite3(): Promise<any> {
  const mod = await import("@sqlite.org/sqlite-wasm");
  // literal so vite can analyze it and emit the wasm asset (dynamic concat is invisible to it)
  const wasmUrl = new URL("@sqlite.org/sqlite-wasm/sqlite3.wasm", import.meta.url).href;
  // the node build needs no config (the shipped types declare the 0-arg form)
  const init = mod.default as unknown as (opts?: unknown) => Promise<any>;
  return init(
    typeof process === "undefined" ? { locateFile: (f: string) => (f.endsWith(".wasm") ? wasmUrl : f) } : undefined,
  );
}

/** browser worker: OPFS-backed database (persistent, survives reloads).
 *  `proxyUri` points at the OPFS async-proxy worker script (the client knows the
 *  site's base path; sqlite-wasm resolves it lazily). */
export async function openWasmOpfsDb(name = "kodakool", proxyUri?: string): Promise<Db> {
  const sqlite3 = await initSqlite3();
  if (!sqlite3.installOpfsSAHPoolVfs) throw new Error("sqlite-wasm: OPFS SAHPool VFS unavailable");
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    initialCapacity: 32,
    ...(proxyUri ? { proxyUri: () => proxyUri } : {}),
  });
  // rwc: open the persisted store across reloads, create it on first run
  return initSchema(wrapOo1(new pool.OpfsSAHPoolDb(name, "rwc")));
}

/** Node (tests): the node build's `unix-none` VFS — synchronous in-memory files with
 *  full SQL semantics, fresh per engine, which is exactly what the parity suite needs
 *  (the browser worker uses the persistent OPFS pool above). */
export async function openWasmNodeDb(name: string): Promise<Db> {
  const sqlite3 = await initSqlite3();
  return initSchema(wrapOo1(new sqlite3.oo1.DB(name, "c", "unix-none")));
}
