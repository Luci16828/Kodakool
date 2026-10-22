/**
 * Store-change events for the SSE feed (`GET /api/events`).
 *
 * The realtime rooms sync a document's text + entries live, but the REST surface
 * (projects, the document list, catalogs, subfolders) had no push channel: tabs
 * learned about structural changes only from a mutation they performed themselves.
 * Mutating routes emit here; the SSE endpoint relays to every connected client,
 * which reacts by refetching its tree/catalog (the event carries ids only — the
 * refetch runs through the normal authorized endpoints).
 */

export type StoreEvent = { kind: "docs" | "project" | "catalog" | "subs"; project?: string };

type Listener = (e: StoreEvent) => void;

export class EventBus {
  private readonly ls = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.ls.add(cb);
    return () => this.ls.delete(cb);
  }

  emit(e: StoreEvent): void {
    for (const l of [...this.ls]) l(e);
  }
}

/**
 * One bus per server module instance. Keys never collide across stores because
 * every id in an event is a UUID, and a subscription is scoped to the SSE request
 * that created it — the worker (SharedWorker singleton per profile) and the node
 * server each run one app in their own process/scope anyway.
 */
export const storeEvents = new EventBus();
