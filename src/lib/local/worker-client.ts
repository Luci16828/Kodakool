/**
 * The browser-side host for the Local account's in-worker server.
 *
 * The worker runs the SAME server code as a remote collaboration server (REST routes,
 * auth, Yjs rooms) on sqlite-wasm/OPFS. This module owns the worker channel and
 * exposes it as (1) a `fetch` transport for `RemoteApi` and (2) MessagePort rooms for
 * the Yjs provider — so the local account flows through the exact same client code
 * paths as a remote account. The worker is a SharedWorker: one server instance per
 * browser profile, shared by every tab (shared OPFS store + shared rooms).
 */
// vite's worker import API: ?sharedworker / ?worker imports are factories that
// construct the (module-type) worker from the correctly bundled/served script URL
import LocalSharedWorker from "../../../server/src/worker.ts?sharedworker";
import LocalWorker from "../../../server/src/worker.ts?worker";

/** pseudo-origin for local API calls: the worker routes by pathname only */
export const LOCAL_BASE = "https://local.kodakool.local";

/** the message channel to the server worker: a SharedWorker port (normal) or a Worker */
interface Chan {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((e: any) => void) | null;
}

let chan: Chan | null = null;
let seq = 0;
const pending = new Map<number, (m: any) => void>();
const roomRejects = new Map<string, () => void>();

/**
 * Local store-change listeners: the worker broadcasts `{type:"mutated"}` to EVERY
 * connected tab after each successful REST mutation, so a tab's tree/catalog follows
 * changes made in other tabs (and the networked server's SSE feed, for remote
 * accounts, is the exact analogue).
 */
const mutatedListeners = new Set<() => void>();
export function onLocalMutated(cb: () => void): () => void {
  mutatedListeners.add(cb);
  return () => mutatedListeners.delete(cb);
}

function ensureWorker(): Chan {
  if (chan) return chan;
  const sw = typeof SharedWorker !== "undefined" ? new LocalSharedWorker({ name: "kodakool-server" }) : null;
  if (sw) {
    // SharedWorker script/load errors surface on the worker object, never on the port
    sw.onerror = (e: { message?: string; filename?: string; lineno?: number }) => {
      console.error("kodakool shared worker error:", e.message, e.filename ?? "", e.lineno ?? "");
    };
  }
  const c: Chan = sw ? (sw.port as unknown as Chan) : new LocalWorker();
  c.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: string; id?: number; docId?: string };
    if (m?.type === "fetch" || m?.type === "ensure-local") {
      const cb = m.id === undefined ? undefined : pending.get(m.id);
      if (cb && m.id !== undefined) {
        pending.delete(m.id);
        cb(m);
      }
    } else if (m?.type === "room-reject" && typeof m.docId === "string") {
      const cb = roomRejects.get(m.docId);
      if (cb) {
        roomRejects.delete(m.docId);
        cb();
      }
    } else if (m?.type === "mutated") {
      for (const l of [...mutatedListeners]) l();
    }
  };
  c.onerror = (e) => {
    console.error("kodakool worker error:", e.message, e.filename ?? "", e.lineno ?? "");
  };
  // warm the worker up (opens the store); the init message carries no config now
  c.postMessage({ type: "init" });
  chan = c;
  return c;
}

function call(msg: Record<string, unknown>): Promise<any> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolvePromise) => {
    // a dead worker must not hang the caller forever: 20s and it's an error
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolvePromise({ type: "timeout" });
    }, 20_000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolvePromise(m);
    });
    w.postMessage({ ...msg, id });
  });
}

/** `fetch`-compatible transport routed into the worker's Hono app */
export async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
  const m = await call({
    type: "fetch",
    url: req.url,
    method: req.method,
    headers: [...req.headers.entries()],
    body,
  });
  if (m?.type === "timeout") throw new Error("the local store did not answer in time");
  if (m?.error) throw new Error(String(m.error));
  // 204/205/304 are null-body statuses: the reconstructed Response must carry null body
  const nullBody = m.status === 204 || m.status === 205 || m.status === 304;
  return new Response(nullBody ? null : m.body, { status: m.status, statusText: m.statusText, headers: m.headers });
}

export interface LocalSession {
  token: string;
  refresh: string;
  user: { id: string; name: string; email: string | null };
}

/** seed (idempotently) the local user + a fresh session — the Local account's login */
export async function ensureLocalSession(): Promise<LocalSession> {
  const m = await call({ type: "ensure-local" });
  if (m?.type === "timeout") throw new Error("the local store did not answer in time");
  if (m?.error) throw new Error(String(m.error));
  return m.result as LocalSession;
}

/** open a Yjs room connection to the worker: the port IS the websocket replacement */
export function openRoomPort(docId: string, token: string): { port: MessagePort; onReject: (cb: () => void) => void } {
  const w = ensureWorker();
  const ch = new MessageChannel();
  w.postMessage({ type: "room", docId, token, port: ch.port2 }, [ch.port2]);
  return {
    port: ch.port1,
    onReject: (cb) => {
      roomRejects.set(docId, cb);
    },
  };
}
