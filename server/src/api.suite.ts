import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { nodeCrypto } from "./auth-node.ts";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";

/**
 * The full REST suite, engine-agnostic: `runApiSuite` is driven against node:sqlite
 * (api.test.ts) AND against the sqlite-wasm shim (api.wasm.test.ts) — the worker's
 * engine must behave identically, that is the point of the local worker.
 */
export function runApiSuite(newDb: () => Db | Promise<Db>): void {
  const cfg: Config = {
    port: 0,
    host: "127.0.0.1",
    dataDir: ":memory:",
    secret: new TextEncoder().encode("0123456789012345678901234567890123"),
    allowRegister: true,
    oidcAllow: null,
  };

  async function app(): Promise<Hono> {
    return createApp({ cfg, db: await newDb(), kdf: nodeCrypto });
  }

  async function register(h: Hono, email: string): Promise<string> {
    const r = await h.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "secret123", name: email[0] }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as any).token as string;
  }

  const json = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

  describe("auth endpoints", () => {
    it("registers, logs in, rejects bad credentials and duplicate emails", async () => {
      const h = await app();
      expect((await h.request("/api/health")).status).toBe(200);
      const dup = await h.request("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.de", password: "secret123" }),
      });
      expect(dup.status).toBe(201);
      const clash = await h.request("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.de", password: "secret123" }),
      });
      expect(clash.status).toBe(409);
      const bad = await h.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.de", password: "nope" }),
      });
      expect(bad.status).toBe(401);
      const ok = await h.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.de", password: "secret123" }),
      });
      expect(ok.status).toBe(200);
    });

    it("requires a bearer token for data routes", async () => {
      const h = await app();
      expect((await h.request("/api/projects")).status).toBe(401);
      expect((await h.request("/api/projects", { headers: { authorization: "Bearer garbage" } })).status).toBe(401);
    });

    it("rotates refresh tokens", async () => {
      const h = await app();
      const reg = await h.request("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "r@b.de", password: "secret123" }),
      });
      const { refresh } = (await reg.json()) as any;
      const re = await h.request("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      expect(re.status).toBe(200);
      const again = await h.request("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      expect(again.status).toBe(401);
    });
  });

  describe("projects + documents", () => {
    it("creates projects and documents with per-owner name uniqueness", async () => {
      const h = await app();
      const tok = await register(h, "a@b.de");
      const proj = (await (
        await h.request("/api/projects", {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "study" }),
        })
      ).json()) as any;
      expect(proj.role).toBe("owner");
      const clash = await h.request("/api/projects", {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify({ name: "study" }),
      });
      expect(clash.status).toBe(409);

      const doc = (await (
        await h.request(`/api/projects/${proj.id}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "a.txt", text: "hello" }),
        })
      ).json()) as any;
      expect(doc.text ?? doc.name).toBeTruthy();
      const docClash = await h.request(`/api/projects/${proj.id}/docs`, {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify({ name: "a.txt" }),
      });
      expect(docClash.status).toBe(409);

      const list = (await (await h.request(`/api/projects/${proj.id}/docs`, { headers: json(tok) })).json()) as any;
      expect(list.docs).toHaveLength(1);
      expect(list.docs[0].name).toBe("a.txt");
    });

    it("shares projects: member reads, non-members get 404", async () => {
      const h = await app();
      const owner = await register(h, "owner@b.de");
      const member = await register(h, "member@b.de");
      const stranger = await register(h, "x@b.de");
      const proj = (await (
        await h.request("/api/projects", {
          method: "POST",
          headers: json(owner),
          body: JSON.stringify({ name: "shared" }),
        })
      ).json()) as any;
      const share = await h.request(`/api/projects/${proj.id}/share`, {
        method: "POST",
        headers: json(owner),
        body: JSON.stringify({ email: "member@b.de" }),
      });
      expect(share.status).toBe(200);
      const doc = (await (
        await h.request(`/api/projects/${proj.id}/docs`, {
          method: "POST",
          headers: json(owner),
          body: JSON.stringify({ name: "d.md", text: "shared text" }),
        })
      ).json()) as any;

      const memberList = (await (await h.request("/api/projects", { headers: json(member) })).json()) as any;
      expect(memberList.projects[0]).toMatchObject({ name: "shared", role: "member" });
      const memberDoc = await h.request(`/api/docs/${doc.id}`, { headers: json(member) });
      expect(memberDoc.status).toBe(200);
      expect(((await memberDoc.json()) as any).text).toBe("shared text");

      const strangerDoc = await h.request(`/api/docs/${doc.id}`, { headers: json(stranger) });
      expect(strangerDoc.status).toBe(404);
      const strangerProj = await h.request(`/api/projects/${proj.id}/docs`, { headers: json(stranger) });
      expect(strangerProj.status).toBe(404);

      // members cannot share further
      const memberShare = await h.request(`/api/projects/${proj.id}/share`, {
        method: "POST",
        headers: json(member),
        body: JSON.stringify({ email: "x@b.de" }),
      });
      expect(memberShare.status).toBe(403);
      // members cannot delete the project
      const memberDel = await h.request(`/api/projects/${proj.id}`, { method: "DELETE", headers: json(member) });
      expect(memberDel.status).toBe(403);
    });

    it("patches documents: rename collision 409, codes/versions round-trip", async () => {
      const h = await app();
      const tok = await register(h, "p@b.de");
      const proj = (await (
        await h.request("/api/projects", {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "patch" }),
        })
      ).json()) as any;
      const a = (await (
        await h.request(`/api/projects/${proj.id}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "a.txt" }),
        })
      ).json()) as any;
      const b = (await (
        await h.request(`/api/projects/${proj.id}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "b.txt" }),
        })
      ).json()) as any;
      const collide = await h.request(`/api/docs/${a.id}`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ name: "b.txt" }),
      });
      expect(collide.status).toBe(409);

      const entry = { device: crypto.randomUUID(), line: 1, range: [0, 4], excerpt: "text" };
      const patched = await h.request(`/api/docs/${b.id}`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ name: "b.txt", text: "text body", codes: [entry] }),
      });
      expect(patched.status).toBe(200);
      const full = (await patched.json()) as any;
      expect(full.codes).toHaveLength(1);
      expect(full.codes[0].range).toEqual([0, 4]);
    });

    it("appends versions with a cap and relabels them", async () => {
      const h = await app();
      const tok = await register(h, "v@b.de");
      const proj = (await (
        await h.request("/api/projects", { method: "POST", headers: json(tok), body: JSON.stringify({ name: "ver" }) })
      ).json()) as any;
      const doc = (await (
        await h.request(`/api/projects/${proj.id}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "v.txt" }),
        })
      ).json()) as any;
      let versions: { id: string; parent: string | null; label?: string }[] = [];
      for (let i = 0; i < 205; i++) {
        const r = await h.request(`/api/docs/${doc.id}/versions`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ text: `t${i}`, codes: [], parent: versions.at(-1)?.id ?? null }),
        });
        expect(r.status).toBe(201);
        versions = ((await r.json()) as any).versions;
      }
      expect(versions.length).toBe(200); // MAX_VERSIONS cap, oldest dropped
      expect(versions[versions.length - 1].parent).toBe(versions[versions.length - 2].id);

      const relabel = await h.request(`/api/docs/${doc.id}/versions/${versions[0].id}/label`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ label: "checkpoint" }),
      });
      expect(relabel.status).toBe(200);
      expect(((await relabel.json()) as any).versions[0].label).toBe("checkpoint");
    });

    it("stores the project catalog last-write-wins", async () => {
      const h = await app();
      const tok = await register(h, "c@b.de");
      const proj = (await (
        await h.request("/api/projects", { method: "POST", headers: json(tok), body: JSON.stringify({ name: "cat" }) })
      ).json()) as any;
      const empty = (await (await h.request(`/api/projects/${proj.id}/catalog`, { headers: json(tok) })).json()) as any;
      expect(empty.data).toBeNull();
      const instr = {
        version: 1,
        title: "cat",
        devices: [{ id: crypto.randomUUID(), name: "D", kind: "device", examples: [], children: [] }],
      };
      const saved = await h.request(`/api/projects/${proj.id}/catalog`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ data: instr }),
      });
      expect(saved.status).toBe(200);
      const got = (await (await h.request(`/api/projects/${proj.id}/catalog`, { headers: json(tok) })).json()) as any;
      expect(got.data.devices[0].name).toBe("D");
      const bad = await h.request(`/api/projects/${proj.id}/catalog`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ data: { nope: true } }),
      });
      expect(bad.status).toBe(400);
    });

    it("deletes a project with its documents (owner only)", async () => {
      const h = await app();
      const tok = await register(h, "d@b.de");
      const proj = (await (
        await h.request("/api/projects", { method: "POST", headers: json(tok), body: JSON.stringify({ name: "gone" }) })
      ).json()) as any;
      await h.request(`/api/projects/${proj.id}/docs`, {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify({ name: "x.txt" }),
      });
      const del = await h.request(`/api/projects/${proj.id}`, { method: "DELETE", headers: json(tok) });
      expect(del.status).toBe(204);
      const list = (await (await h.request("/api/projects", { headers: json(tok) })).json()) as any;
      expect(list.projects).toHaveLength(0);
    });
  });

  describe("cutover endpoints (pdf, subs, moves, export)", () => {
    async function proj(h: Hono, tok: string, name: string): Promise<any> {
      return (
        await (
          await h.request("/api/projects", { method: "POST", headers: json(tok), body: JSON.stringify({ name }) })
        ).json()
      ).id;
    }

    it("stores and streams PDF bytes", async () => {
      const h = await app();
      const tok = await register(h, "p@b.de");
      const pid = await proj(h, tok, "pdfproj");
      const doc = (await (
        await h.request(`/api/projects/${pid}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "scan.pdf", text: "extracted", kind: "pdf" }),
        })
      ).json()) as any;
      const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3, 250]);
      const put = await h.request(`/api/docs/${doc.id}/pdf`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tok}` },
        body: bytes as BodyInit,
      });
      expect(put.status).toBe(204);
      const get = await h.request(`/api/docs/${doc.id}/pdf`, { headers: json(tok) });
      expect(get.status).toBe(200);
      expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...bytes]);
      const full = (await (await h.request(`/api/docs/${doc.id}`, { headers: json(tok) })).json()) as any;
      expect(full.kind).toBe("pdf");
    });

    it("registers subfolders on the project", async () => {
      const h = await app();
      const tok = await register(h, "s@b.de");
      const pid = await proj(h, tok, "subproj");
      const res = await h.request(`/api/projects/${pid}/subs`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ subs: ["a/b", "a//b", "../x", "c"] }),
      });
      expect(res.status).toBe(200);
      const projects = (await (await h.request("/api/projects", { headers: json(tok) })).json()) as any;
      expect(projects.projects[0].subs).toEqual(["a/b", "x", "c"]);
    });

    it("moves a document across projects with collision guard", async () => {
      const h = await app();
      const tok = await register(h, "m@b.de");
      const a = await proj(h, tok, "proj-a");
      const b = await proj(h, tok, "proj-b");
      const docA = (await (
        await h.request(`/api/projects/${a}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "move.txt" }),
        })
      ).json()) as any;
      await h.request(`/api/projects/${b}/docs`, {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify({ name: "move.txt" }),
      });
      const clash = await h.request(`/api/docs/${docA.id}`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ project: "proj-b" }),
      });
      expect(clash.status).toBe(409);
      const bDocs = (await (await h.request(`/api/projects/${b}/docs`, { headers: json(tok) })).json()) as any;
      await h.request(`/api/docs/${bDocs.docs[0].id}`, { method: "DELETE", headers: json(tok) });
      const moved = await h.request(`/api/docs/${docA.id}`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ project: "proj-b" }),
      });
      expect(moved.status).toBe(200);
      const movedDoc = (await (await h.request(`/api/docs/${docA.id}`, { headers: json(tok) })).json()) as any;
      expect(movedDoc.project).toBe(b);
    });

    it("exports the whole store and re-imports it intact", async () => {
      const h = await app();
      const tok = await register(h, "e@b.de");
      const pid = await proj(h, tok, "exportproj");
      const doc = (await (
        await h.request(`/api/projects/${pid}/docs`, {
          method: "POST",
          headers: json(tok),
          body: JSON.stringify({ name: "x.pdf", text: "t", kind: "pdf" }),
        })
      ).json()) as any;
      await h.request(`/api/docs/${doc.id}/pdf`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tok}` },
        body: new Uint8Array([1, 2, 3]) as BodyInit,
      });
      const blob = (await (await h.request("/api/export", { headers: json(tok) })).json()) as any;
      expect(blob.version).toBe(1);
      expect(blob.documents).toHaveLength(1);
      expect(blob.pdfs).toHaveLength(1);

      const bad = await h.request("/api/import", {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify({
          version: 1,
          users: [],
          projects: [],
          members: [],
          documents: [{ id: "x" }],
          catalogs: [],
          pdfs: [],
          states: [],
          meta: [],
        }),
      });
      expect(bad.status).toBe(400);

      const imp = await h.request("/api/import", {
        method: "POST",
        headers: json(tok),
        body: JSON.stringify(blob),
      });
      expect(imp.status).toBe(200);
      const after = (await (await h.request(`/api/docs/${doc.id}`, { headers: json(tok) })).json()) as any;
      expect(after.name).toBe("x.pdf");
      const pdf = await h.request(`/api/docs/${doc.id}/pdf`, { headers: json(tok) });
      expect([...new Uint8Array(await pdf.arrayBuffer())]).toEqual([1, 2, 3]);

      // subs survive export → import (the export carries the raw column string)
      await h.request(`/api/projects/${pid}/subs`, {
        method: "PUT",
        headers: json(tok),
        body: JSON.stringify({ subs: ["sources"] }),
      });
      const blob2 = (await (await h.request("/api/export", { headers: json(tok) })).json()) as any;
      expect(
        (await h.request("/api/import", { method: "POST", headers: json(tok), body: JSON.stringify(blob2) })).status,
      ).toBe(200);
      const back = (await (await h.request("/api/projects", { headers: json(tok) })).json()) as any;
      expect(back.projects.find((p: any) => p.id === pid).subs).toEqual(["sources"]);
    });
  });
}
