import { getContext, setContext } from "svelte";
import type { RemoteApi } from "./api";
import type { RemoteDoc, RemoteDocSummary, RemoteProject } from "./types";
import type { Instructions } from "$lib/coding/instructions";

/**
 * Reactive per-account caches of the server's projects/documents/catalogs.
 * The tree sidebar and the remote coding page read these; every mutation goes
 * through the server and refreshes the affected slice.
 */
export class RemoteCache {
  projects = $state<RemoteProject[]>([]);
  /** project id → documents (loaded on demand) */
  docs = $state<Record<string, RemoteDocSummary[]>>({});
  /** project id → catalog (loaded on demand) */
  catalogs = $state<Record<string, Instructions | null>>({});
  loading = $state(false);
  error = $state("");

  async refreshProjects(api: RemoteApi, token: string): Promise<void> {
    this.loading = true;
    try {
      this.projects = await api.projects(token);
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async refreshDocs(api: RemoteApi, token: string, projectId: string): Promise<void> {
    try {
      this.docs = { ...this.docs, [projectId]: await api.docs(token, projectId) };
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async createProject(api: RemoteApi, token: string, name: string): Promise<RemoteProject> {
    const p = await api.createProject(token, name);
    this.projects = [...this.projects, p].sort((a, b) => a.name.localeCompare(b.name));
    return p;
  }

  async deleteProject(api: RemoteApi, token: string, projectId: string): Promise<void> {
    await api.deleteProject(token, projectId);
    this.projects = this.projects.filter((p) => p.id !== projectId);
    const { [projectId]: _drop, ...rest } = this.docs;
    this.docs = rest;
  }

  async createDoc(api: RemoteApi, token: string, projectId: string, name: string): Promise<RemoteDocSummary> {
    const d = await api.createDoc(token, projectId, name);
    await this.refreshDocs(api, token, projectId);
    return d;
  }

  async deleteDoc(api: RemoteApi, token: string, projectId: string, docId: string): Promise<void> {
    await api.deleteDoc(token, docId);
    await this.refreshDocs(api, token, projectId);
  }

  async loadDoc(api: RemoteApi, token: string, docId: string): Promise<RemoteDoc> {
    return api.doc(token, docId);
  }

  async getCatalog(api: RemoteApi, token: string, projectId: string): Promise<Instructions | null> {
    const data = await api.catalog(token, projectId);
    this.catalogs = { ...this.catalogs, [projectId]: data };
    return data;
  }

  /**
   * Re-pull every slice this cache currently holds (projects + the loaded projects'
   * docs + catalogs). The live triggers that call this: the account's SSE store-events
   * stream (server push) and the window focus/visibility handler (catch-up after the
   * tab was asleep). Slices are refetched in parallel; a failing slice keeps its data.
   */
  async refreshAll(api: RemoteApi, token: string): Promise<void> {
    const projectIds = Object.keys(this.docs);
    const catalogIds = Object.keys(this.catalogs);
    await this.refreshProjects(api, token);
    const projects = this.projects;
    await Promise.all([
      ...projectIds.map((id) => (projects.some((p) => p.id === id) ? this.refreshDocs(api, token, id) : undefined)),
      ...catalogIds.map((id) =>
        projects.some((p) => p.id === id) ? this.getCatalog(api, token, id).catch(() => undefined) : undefined,
      ),
    ]);
  }

  async saveCatalog(api: RemoteApi, token: string, projectId: string, data: Instructions | null): Promise<void> {
    await api.saveCatalog(token, projectId, data);
    this.catalogs = { ...this.catalogs, [projectId]: data };
  }
}

export class RemoteStore {
  private readonly caches = new Map<string, RemoteCache>();

  cache(accountId: string): RemoteCache {
    let c = this.caches.get(accountId);
    if (!c) {
      c = new RemoteCache();
      this.caches.set(accountId, c);
    }
    return c;
  }
}

const CONTEXT_KEY = "remote";

export function provideRemote(): RemoteStore {
  const store = new RemoteStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useRemote(): RemoteStore {
  return getContext<RemoteStore>(CONTEXT_KEY);
}
