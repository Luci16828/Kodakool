import { z } from "zod";
import {
  authResponseSchema,
  oidcBeginSchema,
  remoteDocSchema,
  remoteDocSummarySchema,
  remoteProjectSchema,
  remoteUserSchema,
  remoteVersionSchema,
  type RemoteDoc,
  type RemoteDocSummary,
  type RemoteProject,
  type RemoteUser,
  type RemoteVersion,
} from "./types";
import type { Instructions } from "$lib/coding/instructions";
import type { CodeEntry } from "$lib/coding/types";

/** server failure: HTTP status + the server's `error` message */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * REST client for the optional collaboration server. One instance per server URL;
 * the bearer token is passed per call (accounts are independent sessions).
 */
export class RemoteApi {
  constructor(
    readonly base: string,
    /** transport override: the Local account routes into the in-worker server */
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async call<T>(
    path: string,
    schema: z.ZodType<T>,
    opts: { token?: string; method?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new ApiError(0, `server unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j.error === "string" && j.error !== "") message = j.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return schema.parse(await res.json());
  }

  /* ----- auth ----- */

  register(
    email: string,
    password: string,
    name: string,
  ): Promise<{ token: string; refresh: string; user: RemoteUser }> {
    return this.call("/api/auth/register", authResponseSchema, { method: "POST", body: { email, password, name } });
  }

  login(email: string, password: string): Promise<{ token: string; refresh: string; user: RemoteUser }> {
    return this.call("/api/auth/login", authResponseSchema, { method: "POST", body: { email, password } });
  }

  oidcBegin(iss: string, clientId: string, redirectUri: string): Promise<{ state: string; url: string }> {
    return this.call("/api/auth/oidc/begin", oidcBeginSchema, { method: "POST", body: { iss, clientId, redirectUri } });
  }

  oidcExchange(
    state: string,
    code: string,
    redirectUri: string,
  ): Promise<{ token: string; refresh: string; user: RemoteUser }> {
    return this.call("/api/auth/oidc/exchange", authResponseSchema, {
      method: "POST",
      body: { state, code, redirectUri },
    });
  }

  refresh(refresh: string): Promise<{ token: string; refresh: string; user: RemoteUser }> {
    return this.call("/api/auth/refresh", authResponseSchema, { method: "POST", body: { refresh } });
  }

  logout(refresh: string): Promise<void> {
    return this.call("/api/auth/logout", z.never(), { method: "POST", body: { refresh } });
  }

  me(token: string): Promise<{ user: RemoteUser }> {
    return this.call("/api/me", z.object({ user: remoteUserSchema }), { token });
  }

  /* ----- projects + documents ----- */

  projects(token: string): Promise<RemoteProject[]> {
    return this.call("/api/projects", z.object({ projects: z.array(remoteProjectSchema) }), { token }).then(
      (r) => r.projects,
    );
  }

  createProject(token: string, name: string): Promise<RemoteProject> {
    return this.call("/api/projects", remoteProjectSchema, { method: "POST", body: { name }, token });
  }

  deleteProject(token: string, projectId: string): Promise<void> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}`, z.never(), { method: "DELETE", token });
  }

  docs(token: string, projectId: string): Promise<RemoteDocSummary[]> {
    return this.call(
      `/api/projects/${encodeURIComponent(projectId)}/docs`,
      z.object({ docs: z.array(remoteDocSummarySchema) }),
      {
        token,
      },
    ).then((r) => r.docs);
  }

  createDoc(token: string, projectId: string, name: string, text = "", folder = ""): Promise<RemoteDocSummary> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}/docs`, remoteDocSummarySchema, {
      method: "POST",
      body: { name, text, folder },
      token,
    });
  }

  doc(token: string, docId: string): Promise<RemoteDoc> {
    return this.call(`/api/docs/${encodeURIComponent(docId)}`, remoteDocSchema, { token });
  }

  patchDoc(
    token: string,
    docId: string,
    patch: {
      name?: string;
      folder?: string;
      text?: string;
      codes?: CodeEntry[];
      versions?: unknown[];
      project?: string;
    },
  ): Promise<RemoteDoc> {
    return this.call(`/api/docs/${encodeURIComponent(docId)}`, remoteDocSchema, { method: "PUT", body: patch, token });
  }

  createDocKind(
    token: string,
    projectId: string,
    name: string,
    kind: "text" | "pdf",
    text = "",
    folder = "",
  ): Promise<RemoteDocSummary> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}/docs`, remoteDocSummarySchema, {
      method: "POST",
      body: { name, text, folder, kind },
      token,
    });
  }

  /* ----- pdf bytes + subfolders + whole-store ----- */

  async savePdf(token: string, docId: string, bytes: Uint8Array): Promise<void> {
    const res = await this.fetchFn(`${this.base}/api/docs/${encodeURIComponent(docId)}/pdf`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: bytes as BodyInit,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (typeof j.error === "string" && j.error !== "") message = j.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message);
    }
  }

  async pdfBytes(token: string, docId: string): Promise<Uint8Array | null> {
    const res = await this.fetchFn(`${this.base}/api/docs/${encodeURIComponent(docId)}/pdf`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, "pdf fetch failed");
    return new Uint8Array(await res.arrayBuffer());
  }

  setSubs(token: string, projectId: string, subs: string[]): Promise<string[]> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}/subs`, z.object({ subs: z.array(z.string()) }), {
      method: "PUT",
      body: { subs },
      token,
    }).then((r) => r.subs);
  }

  exportDb(token: string): Promise<unknown> {
    return this.call("/api/export", z.unknown(), { token });
  }

  importDb(token: string, blob: unknown): Promise<void> {
    return this.call("/api/import", z.unknown(), { method: "POST", body: blob, token }).then(() => undefined);
  }

  deleteDoc(token: string, docId: string): Promise<void> {
    return this.call(`/api/docs/${encodeURIComponent(docId)}`, z.never(), { method: "DELETE", token });
  }

  addVersion(
    token: string,
    docId: string,
    body: { text: string; codes: CodeEntry[]; label?: string; parent?: string | null },
  ): Promise<RemoteVersion[]> {
    return this.call(
      `/api/docs/${encodeURIComponent(docId)}/versions`,
      z.object({ versions: z.array(remoteVersionSchema) }),
      {
        method: "POST",
        body,
        token,
      },
    ).then((r) => r.versions);
  }

  setVersionLabel(token: string, docId: string, versionId: string, label: string): Promise<RemoteVersion[]> {
    return this.call(
      `/api/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/label`,
      z.object({ versions: z.array(remoteVersionSchema) }),
      { method: "PUT", body: { label }, token },
    ).then((r) => r.versions);
  }

  /* ----- catalog + sharing ----- */

  catalog(token: string, projectId: string): Promise<Instructions | null> {
    return this.call(
      `/api/projects/${encodeURIComponent(projectId)}/catalog`,
      z.object({ data: z.unknown().nullable() }),
      {
        token,
      },
    ).then((r) => (r.data === null ? null : (r.data as Instructions)));
  }

  saveCatalog(token: string, projectId: string, data: Instructions | null): Promise<void> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}/catalog`, z.unknown(), {
      method: "PUT",
      body: { data },
      token,
    }).then(() => undefined);
  }

  share(token: string, projectId: string, email: string): Promise<{ shared: RemoteUser }> {
    return this.call(`/api/projects/${encodeURIComponent(projectId)}/share`, z.object({ shared: remoteUserSchema }), {
      method: "POST",
      body: { email },
      token,
    });
  }
}
