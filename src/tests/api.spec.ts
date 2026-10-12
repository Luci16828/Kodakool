import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GET as getCoding, PUT as putCoding } from "../routes/api/coding/[folder]/[name]/+server.ts";
import { GET as getInstructions } from "../routes/api/instructions/[folder]/+server.ts";
import { GET as getCatalog } from "../routes/api/catalog/+server.ts";
import { CODING_ROOT } from "$lib/server/coding/store";

const TARGET = path.join(CODING_ROOT, "test", "spd 1.json");

/** minimal RequestEvent stand-in: the handlers only read params/request */
function event(params: Record<string, string>, body?: unknown) {
  const request =
    body === undefined
      ? new Request("http://localhost/api", { method: "PUT" })
      : new Request("http://localhost/api", {
          method: "PUT",
          body: typeof body === "string" ? body : JSON.stringify(body),
        });
  return { params, request, url: new URL("http://localhost/api"), isDataRequest: false } as never;
}

/** status of a SvelteKit `error()` throw (handlers may throw synchronously) */
async function statusOf(run: () => unknown): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return (e as { status?: number }).status ?? null;
  }
}

let backup: string | null = null;

beforeEach(() => {
  backup = readFileSync(TARGET, "utf8");
});

afterEach(() => {
  if (backup !== null) writeFileSync(TARGET, backup, "utf8");
});

describe("GET /api/coding/[folder]/[name]", () => {
  test("returns the stored coding file with a clean verification", async () => {
    const res = await getCoding!(event({ folder: "test", name: "spd 1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("test/spd 1.txt");
    expect(body.codes).toHaveLength(3);
    expect(body.errors).toEqual([]);
  });

  test("404s for an unknown source", async () => {
    expect(await statusOf(() => getCoding!(event({ folder: "test", name: "nope" })))).toBe(404);
    expect(await statusOf(() => getCoding!(event({ folder: "nope", name: "x" })))).toBe(404);
  });
});

describe("PUT /api/coding/[folder]/[name]", () => {
  test("resubmitting the current file succeeds and keeps it verifiable", async () => {
    const current = JSON.parse(backup!);
    const res = await putCoding!(event({ folder: "test", name: "spd 1" }, current));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, errors: [] });
    const written = JSON.parse(readFileSync(TARGET, "utf8"));
    expect(written.codes).toHaveLength(3);
  });

  test("404s for an unknown source", async () => {
    const run = () => putCoding!(event({ folder: "test", name: "nope" }, { source: "x", codes: [] }));
    expect(await statusOf(run)).toBe(404);
  });

  test("400s on a malformed body", async () => {
    expect(await statusOf(() => putCoding!(event({ folder: "test", name: "spd 1" }, "not json")))).toBe(400);
    expect(await statusOf(() => putCoding!(event({ folder: "test", name: "spd 1" }, { codes: [] })))).toBe(400);
    const badEntry = () =>
      putCoding!(event({ folder: "test", name: "spd 1" }, { source: "test/spd 1.txt", codes: [{ line: 1 }] }));
    expect(await statusOf(badEntry)).toBe(400);
  });

  test("400s when the payload targets a different source", async () => {
    const run = () => putCoding!(event({ folder: "test", name: "spd 1" }, { source: "test/other.txt", codes: [] }));
    expect(await statusOf(run)).toBe(400);
  });

  test("422s with per-entry messages when verification fails (and writes nothing)", async () => {
    const body = {
      source: "test/spd 1.txt",
      codes: [{ code: "x", line: 1, range: [0, 16], excerpt: "PressemitteilunG" }],
    };
    const res = await putCoding!(event({ folder: "test", name: "spd 1" }, body));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.errors[0]).toMatch(/does not match/);
    expect(readFileSync(TARGET, "utf8")).toBe(backup);
  });
});

describe("GET /api/instructions/[folder]", () => {
  test("returns the raw catalog for a catalog folder", async () => {
    const res = await getInstructions!(event({ folder: "test" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Kodieranweisungen");
  });

  test("returns null for folders without a catalog", async () => {
    const res = await getInstructions!(event({ folder: "no-such-folder" }));
    expect(await res.json()).toBeNull();
  });

  test("400s on traversal-ish folder names", async () => {
    expect(await statusOf(() => getInstructions!(event({ folder: ".." })))).toBe(400);
    expect(await statusOf(() => getInstructions!(event({ folder: "a/b" })))).toBe(400);
  });
});

describe("GET /api/catalog", () => {
  test("lists every folder owning a catalog with its instructions", async () => {
    const res = await getCatalog();
    const body = await res.json();
    const test = body.find((c: { folder: string }) => c.folder === "test");
    expect(test.instructions.title).toBe("Kodieranweisungen");
  });
});
