import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_BASE, ensureLocalSession, localFetch, onLocalMutated } from "$lib/local/worker-client";
import { createFolder, saveLocalCatalog, watchLocalCatalog, watchProjectsLocal } from "$lib/local/local-api";
import { localBackend, resetArticles, testInstructions } from "./fixtures";
import type { Instructions } from "$lib/coding/instructions";

/**
 * Live structural sync PROOFS for the Local account: after every successful REST
 * mutation the worker broadcasts `{type:"mutated"}` to EVERY connected port
 * (cross-tab tree/catalog sync — this page is a stand-in for "a tab that changed
 * nothing itself"), and `local-api` coalesces those signals into tree/catalog refetches.
 * Remote accounts ride the server's SSE feed instead (server suite: "store events").
 *
 * The mutations below go through RAW `localFetch` on purpose: local-api's own
 * mutation helpers refresh directly, so only a raw call proves the broadcast path.
 */

const auth = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

async function quiet(): Promise<void> {
  // drain broadcasts still in flight from the fixture's deletes
  await new Promise((r) => setTimeout(r, 400));
}

describe("live store sync (worker broadcast)", () => {
  beforeAll(() => localBackend());

  afterEach(async () => {
    await resetArticles();
    await quiet();
  });

  it("broadcasts every successful mutation to the page", async () => {
    const { token } = await ensureLocalSession();
    await quiet();
    let hits = 0;
    const off = onLocalMutated(() => hits++);
    const res = await localFetch(`${LOCAL_BASE}/api/projects`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ name: "bc" }),
    });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(hits).toBeGreaterThan(0), { timeout: 4000 });
    off();
  });

  it("broadcasts nothing for plain reads", async () => {
    const { token } = await ensureLocalSession();
    await quiet();
    let hits = 0;
    const off = onLocalMutated(() => hits++);
    const res = await localFetch(`${LOCAL_BASE}/api/projects`, { headers: auth(token) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 350));
    expect(hits).toBe(0);
    off();
  });

  it("a project created by RAW REST reaches the tree watchers", async () => {
    const { token } = await ensureLocalSession();
    const seen: string[][] = [];
    const off = watchProjectsLocal((names) => seen.push([...names]));
    const res = await localFetch(`${LOCAL_BASE}/api/projects`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ name: "echo" }),
    });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(seen.some((names) => names.includes("echo"))).toBe(true), { timeout: 5000 });
    off();
  });

  it("watchLocalCatalog delivers the initial value and every store update", async () => {
    await createFolder("catlive");
    const got: (Instructions | null)[] = [];
    const off = watchLocalCatalog("catlive", (d) => got.push(d));
    // initial pull: the (empty) catalog arrives without any mutation
    await vi.waitFor(() => expect(got.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(got.at(-1)).toBeNull();
    await saveLocalCatalog("catlive", testInstructions);
    await vi.waitFor(() => expect(got.at(-1)?.title).toBe("Test catalog"), { timeout: 5000 });
    off();
  });
});
