import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { LOCAL_BASE, ensureLocalSession, localFetch, onLocalMutated } from "$lib/local/worker-client";
import { PortProvider } from "$lib/local/port-provider";
import {
  addVersion,
  createArticleNamed,
  createFolder,
  saveLocalCatalog,
  watchLocalCatalog,
  watchProjectsLocal,
} from "$lib/local/local-api";
import { localBackend, resetArticles, seedArticle, testInstructions } from "./fixtures";
import { ready, renderArticle, unmountArticle } from "./article-harness";
import { page } from "vitest/browser";
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
    unmountArticle();
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

  it("room persistence (marking) broadcasts the store change", async () => {
    // marking writes through the Yjs ROOM, never a REST request: the debounced
    // room persist materializes text + entries into the documents row and emits
    // on the app's store-events bus — in the worker that bus must reach the
    // ports too, or every other tab's tree counts stay stale after marking
    const doc = await createArticleNamed("marks", "marked.md", "text to mark");
    const { token } = await ensureLocalSession();
    await quiet();
    let hits = 0;
    const off = onLocalMutated(() => hits++);
    const ydoc = new Y.Doc();
    const provider = new PortProvider(ydoc, doc.id, token);
    await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 5000 });
    expect(hits).toBe(0);
    ydoc
      .getMap("entries")
      .set("e1", JSON.stringify({ device: "d1", code: "1", line: 1, range: [0, 4], excerpt: "text" }));
    // 400 ms persist debounce + materialize emit + port hop
    await vi.waitFor(() => expect(hits).toBeGreaterThan(0), { timeout: 5000 });
    provider.destroy();
    ydoc.destroy();
    off();
  });

  it("a snapshot created through REST re-renders the open document's version pill", async () => {
    // versions are REST data: the broadcast must reach the OPEN coding page too
    // (idle-coalesced whole-doc refetch, 2 s after the store goes quiet)
    const id = await seedArticle({ project: "live", name: "snaps.md", text: "snapshot target" });
    renderArticle("snaps.md", "live");
    await ready();
    await expect.element(page.getByRole("button", { name: "versions (0)" })).toBeInTheDocument();
    await addVersion(id, "snap one");
    // broadcast → 2 s idle-coalesced doc refetch → pill re-renders (Title Case label!)
    await expect
      .poll(() => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Versions (1)")))
      .toBe(true);
  });
});
