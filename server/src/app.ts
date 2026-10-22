import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { UserRow } from "./db.ts";
import { userByEmail, userById } from "./db.ts";
import { dropSession, issueSession, publicUser, requireAuth, rotateSession, type Crypto } from "./auth.ts";
import { beginFlow, exchangeFlow } from "./oidc.ts";
import { storeEvents } from "./events.ts";
import { streamSSE } from "hono/streaming";
import { docAccess, docFull, docSummary, parseJson, projectAccess, projectAccessByName } from "./access.ts";
import {
  catalogBody,
  docBody,
  docPatchBody,
  labelBody,
  loginBody,
  oidcBeginBody,
  oidcExchangeBody,
  projectBody,
  refreshBody,
  registerBody,
  shareBody,
  subsBody,
  versionBody,
} from "./types.ts";

export interface AppDeps {
  cfg: Config;
  db: Db;
  /** environment crypto: nodeCrypto on the server, webCrypto in the worker */
  kdf: Crypto;
}

const MAX_VERSIONS = 200;

/**
 * The REST API (all under /api). Auth: register/login (scrypt), OIDC PKCE begin/exchange,
 * refresh rotation. Data: projects (owner + shared members), documents, catalogs, versions.
 * Real-time document rooms live in realtime.ts (WebSocket upgrade on /api/realtime/:docId).
 */
export function createApp({ cfg, db, kdf }: AppDeps): Hono {
  const app = new Hono();
  const me = (c: Context): UserRow => c.get("user") as UserRow;

  // CORS: the app is a static site that can be hosted anywhere (GitHub Pages) and talks
  // to this server cross-origin. Tokens travel in the Authorization header, never cookies,
  // so a wildcard origin is safe here.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    c.header("access-control-allow-headers", "authorization,content-type");
    c.header("access-control-max-age", "600");
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.res.headers });
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: "kodakool-server" }));

  /* ----- auth ----- */

  app.post("/api/auth/register", async (c) => {
    if (!cfg.allowRegister) return c.json({ error: "registration is disabled on this server" }, 403);
    const body = registerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid body" }, 400);
    const email = body.data.email.toLowerCase();
    if (userByEmail(db, email)) return c.json({ error: "this email is already registered" }, 409);
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, email, name, pass, oidc_iss, oidc_sub, created) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
    ).run(
      id,
      email,
      body.data.name?.trim() || email.split("@")[0],
      await kdf.hashPassword(body.data.password),
      Date.now(),
    );
    const user = userById(db, id)!;
    return c.json(await issueSession(db, kdf, cfg.secret, user), 201);
  });

  app.post("/api/auth/login", async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid body" }, 400);
    const user = userByEmail(db, body.data.email);
    if (!user || user.pass === null || !(await kdf.verifyPassword(body.data.password, user.pass))) {
      return c.json({ error: "invalid email or password" }, 401);
    }
    return c.json(await issueSession(db, kdf, cfg.secret, user));
  });

  app.post("/api/auth/oidc/begin", async (c) => {
    const body = oidcBeginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid body" }, 400);
    try {
      return c.json(await beginFlow(db, cfg, body.data));
    } catch (e) {
      const [status, msg] = splitErr(e);
      return c.json({ error: msg }, status as 400);
    }
  });

  app.post("/api/auth/oidc/exchange", async (c) => {
    const body = oidcExchangeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid body" }, 400);
    try {
      const user = await exchangeFlow(db, cfg, body.data);
      return c.json(await issueSession(db, kdf, cfg.secret, user));
    } catch (e) {
      const [status, msg] = splitErr(e);
      return c.json({ error: msg }, status as 400);
    }
  });

  app.post("/api/auth/refresh", async (c) => {
    const body = refreshBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const result = await rotateSession(db, kdf, cfg.secret, body.data.refresh);
    if (!result) return c.json({ error: "session expired" }, 401);
    return c.json(result);
  });

  app.post("/api/auth/logout", async (c) => {
    const body = refreshBody.safeParse(await c.req.json().catch(() => null));
    if (body.success) await dropSession(db, kdf, body.data.refresh);
    return c.body(null, 204);
  });

  /* ----- authenticated data ----- */

  app.use("/api/me", requireAuth(cfg, db));
  app.use("/api/projects/*", requireAuth(cfg, db));
  app.use("/api/projects", requireAuth(cfg, db));
  app.use("/api/docs/*", requireAuth(cfg, db));
  app.use("/api/export", requireAuth(cfg, db));
  app.use("/api/import", requireAuth(cfg, db));
  app.use("/api/events", requireAuth(cfg, db));

  app.get("/api/me", (c) => c.json({ user: publicUser(me(c)) }));

  app.get("/api/projects", (c) => {
    const u = me(c);
    const rows = db
      .prepare(
        `SELECT p.id, p.owner, p.name, p.created, p.subs,
           CASE WHEN p.owner = ? THEN 'owner' ELSE 'member' END AS role,
           (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS docs,
           (SELECT u2.name FROM users u2 WHERE u2.id = p.owner) AS owner_name
         FROM projects p
         WHERE p.owner = ? OR EXISTS (SELECT 1 FROM members m WHERE m.project_id = p.id AND m.user_id = ?)
         ORDER BY p.name`,
      )
      .all(u.id, u.id, u.id) as {
      id: string;
      owner: string;
      name: string;
      subs: string;
      role: string;
      docs: number;
      owner_name: string | null;
    }[];
    return c.json({
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        owner: p.owner,
        ownerName: p.owner_name ?? "",
        role: p.role,
        docs: p.docs,
        subs: parseJson<string[]>(p.subs, []),
      })),
    });
  });

  app.post("/api/projects", async (c) => {
    const body = projectBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name required" }, 400);
    const u = me(c);
    const name = body.data.name.trim();
    if (name === "") return c.json({ error: "name required" }, 400);
    const taken = db.prepare("SELECT id FROM projects WHERE owner = ? AND name = ?").get(u.id, name);
    if (taken) return c.json({ error: `"${name}" already exists` }, 409);
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO projects (id, owner, name, created) VALUES (?, ?, ?, ?)").run(id, u.id, name, Date.now());
    storeEvents.emit({ kind: "project", project: id });
    return c.json({ id, name, owner: u.id, ownerName: u.name, role: "owner", docs: 0, subs: [] }, 201);
  });

  /** the project's registered subfolder paths (the tree's folder registry) */
  app.put("/api/projects/:id/subs", async (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    const body = subsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const subs = [...new Set(body.data.subs.map((s) => normalizeSub(s)))].filter((s) => s !== "");
    db.prepare("UPDATE projects SET subs = ? WHERE id = ?").run(JSON.stringify(subs), p.id);
    storeEvents.emit({ kind: "subs", project: p.id });
    return c.json({ subs });
  });

  app.delete("/api/projects/:id", (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.owner !== u.id) return c.json({ error: "only the owner can delete a project" }, 403);
    // cascade order matters: the doc_id subqueries need the documents still present
    db.prepare("DELETE FROM pdfs WHERE doc_id IN (SELECT id FROM documents WHERE project_id = ?)").run(p.id);
    db.prepare("DELETE FROM doc_states WHERE doc_id IN (SELECT id FROM documents WHERE project_id = ?)").run(p.id);
    db.prepare("DELETE FROM documents WHERE project_id = ?").run(p.id);
    db.prepare("DELETE FROM catalogs WHERE project_id = ?").run(p.id);
    db.prepare("DELETE FROM members WHERE project_id = ?").run(p.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    storeEvents.emit({ kind: "project", project: p.id });
    return c.body(null, 204);
  });

  app.get("/api/projects/:id/docs", (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = db.prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY name").all(p.id) as DocRowLike[];
    return c.json({ docs: rows.map((d) => docSummary(db, toDoc(d, p.id))) });
  });

  app.post("/api/projects/:id/docs", async (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    const body = docBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name required" }, 400);
    const name = body.data.name.trim();
    if (name === "") return c.json({ error: "name required" }, 400);
    const taken = db.prepare("SELECT id FROM documents WHERE project_id = ? AND name = ?").get(p.id, name);
    if (taken) return c.json({ error: `"${name}" already exists in this project` }, 409);
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO documents (id, project_id, name, folder, kind, text, codes, versions, updated) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?)",
    ).run(id, p.id, name, body.data.folder ?? "", body.data.kind ?? "text", body.data.text ?? "", Date.now());
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocRowLike;
    storeEvents.emit({ kind: "docs", project: p.id });
    return c.json(docSummary(db, toDoc(row, p.id)), 201);
  });

  app.get("/api/projects/:id/catalog", (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    const row = db.prepare("SELECT data FROM catalogs WHERE project_id = ?").get(p.id) as { data: string } | undefined;
    return c.json({ data: row === undefined ? null : parseJson(row.data, null) });
  });

  app.put("/api/projects/:id/catalog", async (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    const body = catalogBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid catalog" }, 400);
    if (body.data.data === null) db.prepare("DELETE FROM catalogs WHERE project_id = ?").run(p.id);
    else
      db.prepare(
        "INSERT INTO catalogs (project_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
      ).run(p.id, JSON.stringify(body.data.data), Date.now());
    storeEvents.emit({ kind: "catalog", project: p.id });
    return c.json({ data: body.data.data });
  });

  app.post("/api/projects/:id/share", async (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.owner !== u.id) return c.json({ error: "only the owner can share a project" }, 403);
    const body = shareBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "email required" }, 400);
    const target = userByEmail(db, body.data.email);
    if (!target) return c.json({ error: "no user with that email on this server" }, 404);
    db.prepare(
      "INSERT INTO members (project_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT(project_id, user_id) DO NOTHING",
    ).run(p.id, target.id);
    storeEvents.emit({ kind: "project", project: p.id });
    return c.json({ shared: publicUser(target) });
  });

  app.delete("/api/projects/:id/share/:userId", (c) => {
    const u = me(c);
    const p = projectAccess(db, c.req.param("id"), u.id);
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.owner !== u.id) return c.json({ error: "only the owner can unshare a project" }, 403);
    db.prepare("DELETE FROM members WHERE project_id = ? AND user_id = ?").run(p.id, c.req.param("userId"));
    storeEvents.emit({ kind: "project", project: p.id });
    return c.body(null, 204);
  });

  /* ----- whole-store export/import (the app's Database row; local worker backups) ----- */

  app.get("/api/export", (c) => {
    me(c);
    const users = db.prepare("SELECT id, email, name, pass, oidc_iss, oidc_sub, created FROM users").all();
    const projects = db.prepare("SELECT id, owner, name, subs, created FROM projects").all();
    const members = db.prepare("SELECT project_id, user_id, role FROM members").all();
    const documents = db
      .prepare("SELECT id, project_id, name, folder, kind, text, codes, versions, updated FROM documents")
      .all();
    const catalogs = db.prepare("SELECT project_id, data, updated FROM catalogs").all();
    const pdfs = (db.prepare("SELECT doc_id, bytes FROM pdfs").all() as { doc_id: string; bytes: Uint8Array }[]).map(
      (p) => ({ doc_id: p.doc_id, b64: bytesToB64(p.bytes) }),
    );
    const states = (
      db.prepare("SELECT doc_id, state FROM doc_states").all() as { doc_id: string; state: Uint8Array }[]
    ).map((s) => ({ doc_id: s.doc_id, b64: bytesToB64(s.state) }));
    const meta = db.prepare("SELECT key, value FROM meta").all();
    return c.json({ version: 1, users, projects, members, documents, catalogs, pdfs, states, meta });
  });

  app.post("/api/import", async (c) => {
    me(c);
    const raw = await c.req.json().catch(() => null);
    const err = validateImport(raw);
    if (err) return c.json({ error: err }, 400);
    const blob = raw as ExportBlob;
    // full replace in one transaction: a failed import leaves the store untouched
    try {
      db.exec("BEGIN");
      db.exec("DELETE FROM pdfs; DELETE FROM doc_states; DELETE FROM catalogs; DELETE FROM members;");
      db.exec(
        "DELETE FROM documents; DELETE FROM projects; DELETE FROM sessions; DELETE FROM users; DELETE FROM meta;",
      );
      for (const u of blob.users)
        db.prepare(
          "INSERT INTO users (id, email, name, pass, oidc_iss, oidc_sub, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(u.id, u.email ?? null, u.name, u.pass ?? null, u.oidc_iss ?? null, u.oidc_sub ?? null, u.created);
      for (const p of blob.projects)
        db.prepare("INSERT INTO projects (id, owner, name, subs, created) VALUES (?, ?, ?, ?, ?)").run(
          p.id,
          p.owner,
          p.name,
          // exports carry subs as the raw column string: re-stringify only real arrays
          JSON.stringify(Array.isArray(p.subs) ? p.subs : parseJson<string[]>(p.subs as unknown as string, [])),
          p.created,
        );
      for (const m of blob.members)
        db.prepare("INSERT INTO members (project_id, user_id, role) VALUES (?, ?, ?)").run(
          m.project_id,
          m.user_id,
          m.role,
        );
      for (const d of blob.documents)
        db.prepare(
          "INSERT INTO documents (id, project_id, name, folder, kind, text, codes, versions, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          d.id,
          d.project_id,
          d.name,
          d.folder ?? "",
          d.kind ?? "text",
          d.text ?? "",
          d.codes ?? "[]",
          d.versions ?? "[]",
          d.updated,
        );
      for (const cat of blob.catalogs)
        db.prepare("INSERT INTO catalogs (project_id, data, updated) VALUES (?, ?, ?)").run(
          cat.project_id,
          cat.data,
          cat.updated,
        );
      for (const p of blob.pdfs)
        db.prepare("INSERT INTO pdfs (doc_id, bytes, updated) VALUES (?, ?, ?)").run(
          p.doc_id,
          b64ToBytes(p.b64),
          Date.now(),
        );
      for (const s of blob.states)
        db.prepare("INSERT INTO doc_states (doc_id, state, updated) VALUES (?, ?, ?)").run(
          s.doc_id,
          b64ToBytes(s.b64),
          Date.now(),
        );
      for (const m of blob.meta) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(m.key, m.value);
      db.exec("COMMIT");
      storeEvents.emit({ kind: "project" });
    } catch (e) {
      db.exec("ROLLBACK");
      return c.json({ error: `import failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }
    return c.json({ ok: true });
  });

  app.get("/api/docs/:id", (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json(docFull(db, d));
  });

  app.put("/api/docs/:id", async (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    const body = docPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const name = body.data.name?.trim() ?? d.name;
    if (name !== d.name) {
      const taken = db
        .prepare("SELECT id FROM documents WHERE project_id = ? AND name = ? AND id != ?")
        .get(d.project_id, name, d.id);
      if (taken) return c.json({ error: `"${name}" already exists in this project` }, 409);
    }
    // cross-project move: the user must have access to the target project, name must be free
    let projectId = d.project_id;
    if (body.data.project !== undefined && body.data.project !== "") {
      const target = projectAccessByName(db, body.data.project, u.id);
      if (!target) return c.json({ error: `project "${body.data.project}" not found` }, 404);
      projectId = target.id;
      if (projectId !== d.project_id) {
        const taken = db.prepare("SELECT id FROM documents WHERE project_id = ? AND name = ?").get(projectId, name);
        if (taken) return c.json({ error: `"${name}" already exists in ${target.name}` }, 409);
      }
    }
    db.prepare(
      "UPDATE documents SET project_id = ?, name = ?, folder = ?, text = ?, codes = ?, versions = ?, updated = ? WHERE id = ?",
    ).run(
      projectId,
      name,
      body.data.folder ?? d.folder,
      body.data.text ?? d.text,
      body.data.codes !== undefined ? JSON.stringify(body.data.codes) : d.codes,
      body.data.versions !== undefined ? JSON.stringify(body.data.versions.slice(-MAX_VERSIONS)) : d.versions,
      Date.now(),
      d.id,
    );
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(d.id) as DocRowLike;
    storeEvents.emit({ kind: "docs", project: projectId });
    if (projectId !== d.project_id) storeEvents.emit({ kind: "docs", project: d.project_id });
    return c.json(docFull(db, toDoc(row, projectId)));
  });

  /* ----- PDF bytes (stored per document, streamed for the Preview tab) ----- */

  app.get("/api/docs/:id/pdf", async (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    const row = db.prepare("SELECT bytes FROM pdfs WHERE doc_id = ?").get(d.id) as { bytes: Uint8Array } | undefined;
    if (!row) return c.json({ error: "no pdf stored" }, 404);
    return new Response(row.bytes as BodyInit, { headers: { "content-type": "application/pdf" } });
  });

  app.put("/api/docs/:id/pdf", async (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) return c.json({ error: "invalid pdf body" }, 400);
    db.prepare(
      "INSERT INTO pdfs (doc_id, bytes, updated) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET bytes = excluded.bytes, updated = excluded.updated",
    ).run(d.id, bytes, Date.now());
    db.prepare("UPDATE documents SET kind = 'pdf' WHERE id = ?").run(d.id);
    storeEvents.emit({ kind: "docs", project: d.project_id });
    return c.body(null, 204);
  });

  app.delete("/api/docs/:id", (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    db.prepare("DELETE FROM documents WHERE id = ?").run(d.id);
    db.prepare("DELETE FROM doc_states WHERE doc_id = ?").run(d.id);
    db.prepare("DELETE FROM pdfs WHERE doc_id = ?").run(d.id);
    storeEvents.emit({ kind: "docs", project: d.project_id });
    return c.body(null, 204);
  });

  app.post("/api/docs/:id/versions", async (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    const body = versionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const versions = parseJson<VersionRow[]>(d.versions, []);
    versions.push({
      id: crypto.randomUUID(),
      parent: body.data.parent ?? versions.at(-1)?.id ?? null,
      time: Date.now(),
      text: body.data.text,
      codes: body.data.codes,
      ...(body.data.label !== undefined ? { label: body.data.label } : {}),
    });
    const capped = versions.slice(-MAX_VERSIONS);
    db.prepare("UPDATE documents SET versions = ?, updated = ? WHERE id = ?").run(
      JSON.stringify(capped),
      Date.now(),
      d.id,
    );
    return c.json({ versions: capped }, 201);
  });

  app.put("/api/docs/:id/versions/:vid/label", async (c) => {
    const u = me(c);
    const d = docAccess(db, c.req.param("id"), u.id);
    if (!d) return c.json({ error: "not found" }, 404);
    const body = labelBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const versions = parseJson<{ id: string; label?: string }[]>(d.versions, []);
    const v = versions.find((x) => x.id === c.req.param("vid"));
    if (!v) return c.json({ error: "version not found" }, 404);
    if (body.data.label === "") delete v.label;
    else v.label = body.data.label;
    db.prepare("UPDATE documents SET versions = ? WHERE id = ?").run(JSON.stringify(versions), d.id);
    return c.json({ versions });
  });

  /**
   * SSE store-change feed (`GET /api/events`). One stream per connected client; the
   * client refetches its tree/catalog when an event arrives. EventSource cannot send
   * an Authorization header, so requireAuth also accepts `?token=` (same as the
   * realtime WebSocket). The Local account never connects here: its worker delivers
   * the same signal as a `mutated` port message (worker-client.onLocalMutated).
   */
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      // a write racing a client disconnect must never reject unobserved
      const send = (event: string, data: string) => {
        if (closed) return;
        stream.writeSSE({ event, data }).catch(() => {
          closed = true;
        });
      };
      const off = storeEvents.subscribe((e) => send(e.kind, JSON.stringify(e)));
      stream.onAbort(() => {
        closed = true;
      });
      // handshake: the client knows the bus subscription is live from here on
      await stream.writeSSE({ event: "hello", data: "1" }).catch(() => undefined);
      // keep proxies from dropping an idle stream
      const ping = setInterval(() => send("ping", String(Date.now())), 25_000);
      await new Promise<void>((res) => stream.onAbort(res));
      clearInterval(ping);
      off();
    }),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}

/** node:sqlite returns plain rows; keep the DocRow shape local to this module */
type DocRowLike = {
  id: string;
  project_id: string;
  name: string;
  folder: string;
  kind: string;
  text: string;
  codes: string;
  versions: string;
  updated: number;
};

/** one stored snapshot in the versions JSON (mirrors the app's ArticleVersion) */
type VersionRow = {
  id: string;
  parent: string | null;
  time: number;
  text: string;
  codes: unknown[];
  label?: string;
};

function toDoc(r: DocRowLike, projectId: string) {
  return { ...r, project_id: projectId };
}

/** "400:msg" style errors thrown by oidc.ts → [status, message] */
function splitErr(e: unknown): [number, string] {
  const s = e instanceof Error ? e.message : String(e);
  const m = /^(\d{3}):(.*)$/.exec(s);
  return m ? [Number(m[1]), m[2]] : [400, s];
}

/** subfolder path normalization (mirrors the app's normalizeSubPath) */
function normalizeSub(p: string): string {
  return p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** the whole-store snapshot the app's Database row exports/imports */
interface ExportBlob {
  version: number;
  users: {
    id: string;
    email: string | null;
    name: string;
    pass: string | null;
    oidc_iss: string | null;
    oidc_sub: string | null;
    created: number;
  }[];
  projects: { id: string; owner: string; name: string; subs?: string[]; created: number }[];
  members: { project_id: string; user_id: string; role: string }[];
  documents: {
    id: string;
    project_id: string;
    name: string;
    folder?: string;
    kind?: string;
    text?: string;
    codes?: string;
    versions?: string;
    updated: number;
  }[];
  catalogs: { project_id: string; data: string; updated: number }[];
  pdfs: { doc_id: string; b64: string }[];
  states: { doc_id: string; b64: string }[];
  meta: { key: string; value: string }[];
}

/** full pre-validation: a broken import writes NOTHING */
function validateImport(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return "import blob must be an object";
  const b = raw as Partial<ExportBlob>;
  if (b.version !== 1) return "unsupported import version";
  const arr = (v: unknown, name: string): string | null => (Array.isArray(v) ? null : `${name} must be an array`);
  for (const [v, name] of [
    [b.users, "users"],
    [b.projects, "projects"],
    [b.members, "members"],
    [b.documents, "documents"],
    [b.catalogs, "catalogs"],
    [b.pdfs, "pdfs"],
    [b.states, "states"],
    [b.meta, "meta"],
  ] as const) {
    const e = arr(v, name);
    if (e) return e;
  }
  const str = (v: unknown): boolean => typeof v === "string";
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  if (b.users!.some((u) => !str(u.id) || !str(u.name) || !num(u.created))) return "bad users row";
  if (b.projects!.some((p) => !str(p.id) || !str(p.owner) || !str(p.name) || !num(p.created)))
    return "bad projects row";
  if (b.members!.some((m) => !str(m.project_id) || !str(m.user_id))) return "bad members row";
  if (b.documents!.some((d) => !str(d.id) || !str(d.project_id) || !str(d.name) || !num(d.updated)))
    return "bad documents row";
  if (b.catalogs!.some((c) => !str(c.project_id) || !str(c.data))) return "bad catalogs row";
  if (b.pdfs!.some((p) => !str(p.doc_id) || !str(p.b64))) return "bad pdfs row";
  if (b.states!.some((s) => !str(s.doc_id) || !str(s.b64))) return "bad states row";
  if (b.meta!.some((m) => !str(m.key) || !str(m.value))) return "bad meta row";
  // every document must belong to a project in the blob (no orphan writes)
  const projectIds = new Set(b.projects!.map((p) => p.id));
  if (b.documents!.some((d) => !projectIds.has(d.project_id))) return "documents reference missing projects";
  return null;
}
