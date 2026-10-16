import { describe, expect, it, vi } from "vitest";
import { getDb } from "$lib/client/coding-db";

/**
 * A failed database open (e.g. IndexedDB blocked by browser privacy mode) must not
 * poison the memoized promise: the next getDb() call retries and succeeds.
 * The rxdb mock fails the very first createRxDatabase call, then passes through.
 */
const attempts = vi.hoisted(() => ({ n: 0 }));

vi.mock("rxdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rxdb")>();
  const real = actual.createRxDatabase;
  return {
    ...actual,
    createRxDatabase: ((opts: Parameters<typeof real>[0]) => {
      attempts.n++;
      if (attempts.n === 1) return Promise.reject(new Error("storage blocked"));
      return real(opts);
    }) as typeof real,
  };
});

describe("database open", () => {
  it("retries after a failed open instead of poisoning the memoized promise", async () => {
    await expect(getDb()).rejects.toThrow("storage blocked");
    const db = await getDb();
    expect(await db.articles.find().exec()).toEqual([]);
    expect(attempts.n).toBe(2);
  });
});
