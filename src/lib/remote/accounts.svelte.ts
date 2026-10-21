import { getContext, setContext } from "svelte";
import { RemoteApi } from "./api";
import { ensureLocalSession, LOCAL_BASE, localFetch } from "$lib/local/worker-client";
import type { RemoteUser } from "./types";

/**
 * The account layer of the collaboration feature.
 *
 * The app always has exactly one **local account** (id "local": the SAME server code
 * the remote accounts use, running in a Web Worker on sqlite-wasm/OPFS — auto-provisioned
 * session, no login) plus any number of **remote accounts**, each with its own server
 * URL and session (access token + refresh token, minted by username/password login or by
 * the OIDC authorization-code + PKCE flow — the server does the protocol, this store only
 * keeps the resulting session). Accounts are persisted to localStorage; tokens live there
 * too (the same trust level the app already gives localStorage for documents).
 */

const STORE_KEY = "luci-accounts";
const CONTEXT_KEY = "accounts";
/** the OIDC flow's pending context, kept across the IdP redirect */
export const OIDC_PENDING_KEY = "luci-oidc-pending";

export const LOCAL_ACCOUNT_ID = "local";

export interface LocalAccount {
  id: typeof LOCAL_ACCOUNT_ID;
  kind: "local";
  label: string;
}

export interface RemoteAccount {
  id: string;
  kind: "remote";
  label: string;
  serverUrl: string;
  token: string | null;
  refresh: string | null;
  user: RemoteUser | null;
}

export type AnyAccount = LocalAccount | RemoteAccount;

export const LOCAL_ACCOUNT: LocalAccount = { id: LOCAL_ACCOUNT_ID, kind: "local", label: "Local" };

function load(): RemoteAccount[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as unknown[];
    if (!Array.isArray(raw)) return [];
    const out: RemoteAccount[] = [];
    for (const v of raw) {
      const a = v as Partial<RemoteAccount>;
      if (a.kind !== "remote" || typeof a.id !== "string" || typeof a.serverUrl !== "string") continue;
      out.push({
        id: a.id,
        kind: "remote",
        label: typeof a.label === "string" && a.label !== "" ? a.label : new URL(a.serverUrl).host,
        serverUrl: a.serverUrl,
        token: typeof a.token === "string" ? a.token : null,
        refresh: typeof a.refresh === "string" ? a.refresh : null,
        user:
          a.user && typeof a.user.id === "string"
            ? { id: a.user.id, name: typeof a.user.name === "string" ? a.user.name : "", email: a.user.email ?? null }
            : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export class AccountStore {
  /** every remote account (the local account is virtual — always present, never stored) */
  accounts = $state<RemoteAccount[]>(load());

  /** the Local account's auto-provisioned session (worker-minted, per browser profile) */
  localToken = $state<string | null>(null);
  localUser = $state<RemoteUser | null>(null);
  private localPromise: Promise<string> | null = null;

  private readonly apis = new Map<string, RemoteApi>();

  constructor() {
    // persistence is registered by `persist()`, which `provideAccounts()` calls
    // in component context — a bare `new AccountStore()` (specs) stays inert
  }

  /** mirror `accounts` into localStorage (call during component init) */
  persist(): void {
    if (typeof localStorage === "undefined") return;
    $effect(() => {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.accounts));
    });
  }

  /** local first, then remotes in connect order */
  get all(): AnyAccount[] {
    return [LOCAL_ACCOUNT, ...this.accounts];
  }

  byId(id: string): AnyAccount | undefined {
    return id === LOCAL_ACCOUNT_ID ? LOCAL_ACCOUNT : this.accounts.find((a) => a.id === id);
  }

  /** the REST client for any account: local routes into the worker, remotes over HTTP */
  api(account: AnyAccount): RemoteApi {
    const key = account.kind === "local" ? LOCAL_BASE : account.serverUrl;
    let api = this.apis.get(key);
    if (!api) {
      api = account.kind === "local" ? new RemoteApi(LOCAL_BASE, localFetch) : new RemoteApi(account.serverUrl);
      this.apis.set(key, api);
    }
    return api;
  }

  /** the bearer token for an account (local: the auto-provisioned session, minted on demand) */
  tokenOf(id: string): string | null {
    const a = this.byId(id);
    if (!a) return null;
    return a.kind === "local" ? this.localToken : a.token;
  }

  /** ensure the Local account's session exists (idempotent, coalescing) */
  async ensureLocalToken(): Promise<string> {
    if (this.localToken !== null) return this.localToken;
    if (!this.localPromise) {
      this.localPromise = ensureLocalSession()
        .then((s) => {
          this.localToken = s.token;
          this.localUser = s.user;
          return s.token;
        })
        .catch(() => {
          this.localPromise = null;
          return "";
        });
    }
    return this.localPromise;
  }

  /** username/password login (signup=true registers first) */
  async addPassword(
    label: string,
    serverUrl: string,
    email: string,
    password: string,
    signup: boolean,
  ): Promise<RemoteAccount> {
    const api = new RemoteApi(serverUrl);
    this.apis.set(serverUrl, api);
    if (signup) await api.register(email, password, label);
    const res = await api.login(email, password);
    return this.adopt(serverUrl, label, res);
  }

  /** OIDC step 1: ask the server for the authorization URL, remember the flow, redirect */
  async beginOidc(label: string, serverUrl: string, iss: string, clientId: string): Promise<void> {
    const api = new RemoteApi(serverUrl);
    this.apis.set(serverUrl, api);
    const redirectUri = oidcRedirectUri();
    const { state, url } = await api.oidcBegin(iss, clientId, redirectUri);
    sessionStorage.setItem(OIDC_PENDING_KEY, JSON.stringify({ state, label, serverUrl }));
    location.href = url;
  }

  /** OIDC step 2 (on /auth/callback): exchange the code, adopt the account */
  async completeOidc(state: string, code: string): Promise<RemoteAccount> {
    const raw = sessionStorage.getItem(OIDC_PENDING_KEY);
    if (!raw) throw new Error("no login attempt is pending — start the sign-in again");
    sessionStorage.removeItem(OIDC_PENDING_KEY);
    const pending = JSON.parse(raw) as { state: string; label: string; serverUrl: string };
    if (pending.state !== state) throw new Error("this callback does not match the pending login");
    const api = new RemoteApi(pending.serverUrl);
    this.apis.set(pending.serverUrl, api);
    const res = await api.oidcExchange(state, code, oidcRedirectUri());
    return this.adopt(pending.serverUrl, pending.label, res);
  }

  /** renew an expired access token with the refresh token */
  async refresh(accountId: string): Promise<boolean> {
    const a = this.byId(accountId);
    if (!a || a.kind !== "remote" || a.refresh === null) return false;
    try {
      const res = await this.api(a).refresh(a.refresh);
      a.token = res.token;
      a.refresh = res.refresh;
      a.user = res.user;
      return true;
    } catch {
      a.token = null;
      return false;
    }
  }

  remove(accountId: string): void {
    const a = this.byId(accountId);
    if (a && a.kind === "remote" && a.refresh !== null) {
      // best-effort server-side session drop; the local removal stands regardless
      void this.api(a)
        .logout(a.refresh)
        .catch(() => undefined);
    }
    this.accounts = this.accounts.filter((x) => x.id !== accountId);
  }

  private adopt(
    serverUrl: string,
    label: string,
    res: { token: string; refresh: string; user: RemoteUser },
  ): RemoteAccount {
    const account: RemoteAccount = {
      id: crypto.randomUUID(),
      kind: "remote",
      label: label.trim() === "" ? serverHost(serverUrl) : label.trim(),
      serverUrl,
      token: res.token,
      refresh: res.refresh,
      user: res.user,
    };
    this.accounts = [...this.accounts, account];
    return account;
  }
}

export function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** the app's OIDC callback URL (base-path aware, same origin as the app) */
export function oidcRedirectUri(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return `${location.origin}${base === "/" ? "" : base.replace(/\/$/, "")}/auth/callback`;
}

/** ws:// + /api/realtime room endpoint for a remote account's server */
export function realtimeBase(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return `${u.origin}/api/realtime`;
}

export function provideAccounts(): AccountStore {
  const store = new AccountStore();
  store.persist();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useAccounts(): AccountStore | null {
  return getContext<AccountStore>(CONTEXT_KEY) ?? null;
}
