import { describe, expect, it, vi } from "vitest";
import { getDb } from "$lib/client/coding-db";

/**
 * Opening the database can fail transiently (private mode blocking IndexedDB, a
 * migration cancelled by a second tab). Two guarantees:
 *  - `getDb()` repairs and retries inside the same call, so one failed attempt
 *    never reaches the app;
 *  - a call that fails completely must NOT memoize the rejection, or every later
 *    getDb() would keep returning the dead promise until a reload.
 * The rxdb mock fails the first `attempts.fail` createRxDatabase calls.
 */
const attempts = vi.hoisted(() => ({ n: 0, fail: 0 }));

function rxdbMock(importOriginal: () => Promise<typeof import("rxdb")>) {
  return importOriginal().then((actual) => ({
    ...actual,
    createRxDatabase: ((opts: Parameters<typeof actual.createRxDatabase>[0]) => {
      attempts.n++;
      if (attempts.n <= attempts.fail) return Promise.reject(new Error("storage blocked"));
      return actual.createRxDatabase(opts);
    }) as typeof actual.createRxDatabase,
  }));
}

vi.mock("rxdb", rxdbMock);

describe("database open", () => {
  it("repairs a transient open failure inside the same call", async () => {
    attempts.fail = 1;
    const db = await getDb();
    expect(attempts.n).toBe(2);
    expect(await db.articles.find().exec()).toEqual([]);
    attempts.fail = 0;
  });

  it("does not memoize a call where every attempt failed", async () => {
    // drop the instance the test above opened: this call starts from scratch
    const { __resetDbForTests } = await import("$lib/client/coding-db");
    __resetDbForTests();
    attempts.fail = 99;
    await expect(getDb()).rejects.toThrow("storage blocked");
    attempts.fail = 0;
    const db = await getDb();
    expect(await db.articles.find().exec()).toEqual([]);
  });
});
