/// <reference lib="webworker" />
/**
 * The collaboration server running INSIDE a Web Worker — the Local account's store.
 *
 * This is the same `createApp` the networked server runs, on the same REST routes,
 * the same auth flows, the same realtime rooms. Only the environment adapters differ:
 * sqlite-wasm/OPFS storage, WebCrypto, and MessagePort connections in place of
 * WebSockets. "Works locally, breaks on the server" is structurally impossible here:
 * the code path is literally shared.
 *
/**
 * Protocol (postMessage):
 *  - {type:"init", proxyUrl}            → configure the OPFS async-proxy worker URL
 *  - {type:"fetch", id, url, method, headers, body}      → app.fetch → {type:"fetch", id, status, ...}
 *  - {type:"ensure-local", id}                           → seed the local user + session
 *  - {type:"room", docId, token, port}                   → attach a MessagePort to the doc's room
 *
 * Runs as a SharedWorker (one instance per profile: shared OPFS handle + shared rooms,
 * so tabs collaborate live) with a dedicated-worker fallback for browsers without it.
 */
import { createApp } from "./app.ts";
import { webCrypto } from "./auth-web.ts";
import { openSqlJsDb } from "./sqljs.ts";
import { RoomManager } from "./realtime.ts";
import { storeEvents } from "./events.ts";
import { issueSession, verifyAccessToken } from "./auth.ts";
import { docAccess } from "./access.ts";
import { userByEmail } from "./db.ts";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";

/** MessagePort → the room's `RoomConn` surface (the ws adapter's worker twin) */
class PortConn {
  readyState = 1;
  private readonly port: MessagePort;
  private readonly cbs: {
    message?: (d: Uint8Array) => void;
    close?: () => void;
    error?: () => void;
  } = {};

  constructor(port: MessagePort) {
    this.port = port;
    port.onmessage = (ev: MessageEvent) => this.cbs.message?.(new Uint8Array(ev.data as ArrayBuffer));
    port.addEventListener("close", () => {
      this.readyState = 2;
      this.cbs.close?.();
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState === 1) this.port.postMessage(data, [data.buffer]);
  }

  on(event: "message", cb: (data: Uint8Array) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  on(event: "message" | "close" | "error", cb: ((d: Uint8Array) => void) | (() => void)): void {
    (this.cbs as Record<string, ((d: Uint8Array) => void) | (() => void) | undefined>)[event] = cb;
  }
}

const LOCAL_EMAIL = "local@kodakool.local";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let secret: Uint8Array | undefined;
let dbRef: Db | undefined;
let appPromise: Promise<ReturnType<typeof createApp>> | undefined;
let rooms: RoomManager | undefined;

/** every page currently connected to this worker (shared mode: the ports; dedicated: `dedicated`) */
type OutPort = { postMessage(msg: unknown, transfer?: Transferable[]): void };
const peers = new Set<OutPort>();
let dedicated: OutPort | null = null;

/**
 * Tell EVERY connected tab that the store moved. Two sources: successful non-GET
 * bridge requests (the fetch case below) and the app's own store-events bus — the
 * bus is what the realtime rooms use: a room persist materializes text + entries
 * into the documents row WITHOUT any REST request, so marking from another tab
 * (or this tab's own coding) would otherwise leave every tree count stale.
 */
function broadcastMutated(): void {
  for (const p of peers) p.postMessage({ type: "mutated" });
  dedicated?.postMessage({ type: "mutated" });
}
storeEvents.subscribe(broadcastMutated);

/** the JWT signing key lives in the store itself (stable across reloads, per profile) */
function loadSecret(db: Db): Uint8Array {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'secret'").get() as { value: string } | undefined;
  if (row && /^[0-9a-f]{64}$/.test(row.value)) return fromHex(row.value);
  const buf = crypto.getRandomValues(new Uint8Array(32));
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(toHex(buf));
  return buf;
}

function appReady(): Promise<ReturnType<typeof createApp>> {
  if (!appPromise) {
    appPromise = openSqlJsDb().then((db) => {
      dbRef = db;
      secret = loadSecret(db);
      rooms = new RoomManager(db);
      const cfg: Config = {
        port: 0,
        host: "local",
        dataDir: "opfs",
        secret,
        allowRegister: true,
        oidcAllow: null,
        oidcIssuer: null, // the Local store never signs anyone in: no OIDC provider
        oidcClientId: null,
      };
      return createApp({ cfg, db, kdf: webCrypto });
    });
  }
  return appPromise;
}

/** the Local account's auto-provisioned user: no password, always connected */
async function ensureLocal(): Promise<unknown> {
  await appReady();
  const db = dbRef as Db;
  let user = userByEmail(db, LOCAL_EMAIL);
  if (!user) {
    db.prepare(
      "INSERT INTO users (id, email, name, pass, oidc_iss, oidc_sub, created) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
    ).run(crypto.randomUUID(), LOCAL_EMAIL, "Local", null, Date.now());
    user = userByEmail(db, LOCAL_EMAIL);
  }
  return issueSession(db, webCrypto, secret as Uint8Array, user as NonNullable<typeof user>);
}

async function handle(msg: any, port: { postMessage(msg: unknown, transfer?: Transferable[]): void }): Promise<void> {
  switch (msg?.type) {
    case "init": {
      // kept for protocol compatibility: the store needs no external configuration
      void appReady();
      return;
    }
    case "fetch": {
      const app = await appReady();
      const method = String(msg.method ?? "GET").toUpperCase();
      const req = new Request(msg.url, {
        method: msg.method ?? "GET",
        headers: msg.headers as [string, string][],
        body: msg.body && msg.body.length ? msg.body : undefined,
      });
      const res = await app.fetch(req);
      const body = new Uint8Array(await res.arrayBuffer());
      port.postMessage({
        type: "fetch",
        id: msg.id,
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body,
      });
      // the store moved — tell EVERY connected tab (cross-tab tree/catalog sync;
      // the sender's own refetch stays, this just keeps the other tabs current)
      if (res.status < 400 && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        broadcastMutated();
      }
      return;
    }
    case "ensure-local": {
      const result = await ensureLocal();
      port.postMessage({ type: "ensure-local", id: msg.id, result });
      return;
    }
    case "room": {
      await appReady();
      const verified = await verifyAccessToken(secret as Uint8Array, msg.token ?? "");
      if (!verified || !docAccess(dbRef as Db, msg.docId, verified.sub)) {
        port.postMessage({ type: "room-reject", docId: msg.docId });
        return;
      }
      (rooms as RoomManager).room(msg.docId).attach(new PortConn(msg.port));
      return;
    }
  }
}

const scope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage?: ((e: MessageEvent) => void) | null;
  onconnect?: ((e: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

const route = (port: { postMessage(msg: unknown, transfer?: Transferable[]): void }) => (e: MessageEvent) => {
  void handle(e.data, port).catch((err) => {
    console.error("kodakool worker:", err);
    // surface the failure to the caller: a hung request is worse than a visible error
    const m = e.data as { type?: string; id?: number };
    if ((m?.type === "fetch" || m?.type === "ensure-local") && m.id !== undefined) {
      port.postMessage({ type: m.type, id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
};

if ("onconnect" in scope) {
  // SharedWorker (the normal mode): ONE server instance per browser profile, so every
  // tab shares the same OPFS handle, the same rooms and the same JWT secret —
  // two tabs on one document collaborate in one room, exactly like two browsers on a
  // networked server. A dedicated worker would give each tab its own server.
  // (onconnect starts as null on the shared scope — hence the `in` check, not typeof)
  scope.onconnect = (e) => {
    const port = e.ports[0];
    port.onmessage = route(port);
    port.start();
    peers.add(port);
    port.addEventListener("close", () => peers.delete(port));
  };
} else {
  // dedicated-worker fallback (browsers without SharedWorker): per-page server
  dedicated = scope;
  scope.onmessage = route(scope);
}
