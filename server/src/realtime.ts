import type { Db } from "./db.ts";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * Real-time document rooms: the y-websocket wire protocol (sync + awareness relay)
 * implemented directly on `y-protocols` — the same protocol library the official
 * y-websocket server uses, without its leveldb dependency.
 *
 * A document's Y.Doc carries:
 *   - `text`    (Y.Text)  — the collaborative body
 *   - `entries` (Y.Map)   — entryId → CodeEntry JSON
 * Every debounced update is persisted as the Yjs binary state AND materialized into the
 * `documents` row (text + codes), so REST reads (analysis, downloads, tree counts)
 * always see the live collaborative state.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PERSIST_DEBOUNCE_MS = 400;
const WS_OPEN = 1;

/** the connection surface the room needs (ws.WebSocket satisfies it; tests use a fake;
 *  the worker bridges a MessagePort through the same shape) */
export interface RoomConn {
  readonly readyState: number;
  send(data: Uint8Array): void;
  on(event: "message", cb: (data: Uint8Array) => void): void;
  on(event: "close" | "error", cb: () => void): void;
}

const send = (conn: RoomConn, message: Uint8Array): void => {
  if (conn.readyState === WS_OPEN) conn.send(message);
};

/** clientIds carried by an encoded awareness update (so a disconnect can clear them) */
function awarenessClientIds(update: Uint8Array): number[] {
  const dec = decoding.createDecoder(update);
  const ids: number[] = [];
  const count = decoding.readVarUint(dec);
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(dec));
    decoding.readVarUint8Array(dec);
  }
  return ids;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<RoomConn>();
  private readonly connIds = new Map<RoomConn, Set<number>>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly db: Db;
  readonly name: string;

  constructor(name: string, db: Db) {
    this.name = name;
    this.db = db;
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = encoding.encode((enc) => {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeUpdate(enc, update);
      });
      for (const conn of this.conns) if (conn !== origin) send(conn, message);
      this.schedulePersist();
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = added.concat(updated, removed);
        const message = encoding.encode((enc) => {
          encoding.writeVarUint(enc, MSG_AWARENESS);
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        });
        for (const conn of this.conns) send(conn, message);
      },
    );
  }

  /** load the persisted state (called once at room creation) */
  load(): void {
    const row = this.db.prepare("SELECT state FROM doc_states WHERE doc_id = ?").get(this.name) as
      { state: Uint8Array } | undefined;
    if (row) {
      // a corrupt persisted state must not kill the room: start empty and let sync rebuild it
      try {
        Y.applyUpdate(this.doc, new Uint8Array(row.state));
      } catch (e) {
        console.warn("realtime: corrupt persisted state, starting empty:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  attach(conn: RoomConn): void {
    this.conns.add(conn);
    this.connIds.set(conn, new Set());
    // sync handshake: server state vector first (the client answers with its diff)
    send(
      conn,
      encoding.encode((enc) => {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, this.doc);
      }),
    );
    // the full awareness map so late joiners see everyone immediately
    send(
      conn,
      encoding.encode((enc) => {
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      }),
    );

    conn.on("message", (data: Uint8Array) => {
      // a malformed/truncated frame must never take down the room (or the server):
      // lib0 decoding throws on bad input, so every frame is handled defensively
      try {
        this.onMessage(conn, data);
      } catch (e) {
        console.warn("realtime: dropped malformed frame:", e instanceof Error ? e.message : String(e));
      }
    });
    conn.on("close", () => this.detach(conn));
    conn.on("error", () => this.detach(conn));
  }

  private detach(conn: RoomConn): void {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    const ids = this.connIds.get(conn);
    this.connIds.delete(conn);
    if (ids && ids.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], "client disconnected");
    this.persist();
  }

  private onMessage(conn: RoomConn, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    while (decoding.hasContent(decoder)) {
      switch (decoding.readVarUint(decoder)) {
        case MSG_SYNC:
          readSync(this.doc, decoder, conn);
          break;
        case MSG_AWARENESS: {
          const update = decoding.readVarUint8Array(decoder);
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn);
          const ids = this.connIds.get(conn);
          for (const id of awarenessClientIds(update)) ids?.add(id);
          break;
        }
        default:
          return;
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** write the binary state + materialize text/codes into the documents row */
  persist(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.db
      .prepare(
        "INSERT INTO doc_states (doc_id, state, updated) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET state = excluded.state, updated = excluded.updated",
      )
      .run(this.name, Y.encodeStateAsUpdate(this.doc), Date.now());
    materialize(this.db, this.name, this.doc);
  }
}

function readSync(doc: Y.Doc, decoder: decoding.Decoder, conn: RoomConn): void {
  // readSyncMessage dispatches step1/step2/update and writes the reply (if any) into the encoder;
  // the reply rides the wire wrapped in the same MSG_SYNC frame the clients send
  const reply = encoding.encode((enc) => {
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.readSyncMessage(decoder, enc, doc, conn);
  });
  if (reply.length > 1) send(conn, reply);
}

/** write the Y.Doc's live text + entries into the documents row (REST reads consume this) */
export function materialize(db: Db, docId: string, ydoc: Y.Doc): void {
  const text = ydoc.getText("text").toString();
  const codes: unknown[] = [];
  // clients store entry OBJECTS in the map; REST-seeded states carry JSON strings — accept both
  ydoc.getMap<unknown>("entries").forEach((v) => {
    try {
      codes.push(typeof v === "string" ? JSON.parse(v) : v);
    } catch {
      /* a poisoned entry is skipped on materialize — the client re-validates on write */
    }
  });
  db.prepare("UPDATE documents SET text = ?, codes = ?, updated = ? WHERE id = ?").run(
    text,
    JSON.stringify(codes),
    Date.now(),
    docId,
  );
}

/** rooms are created lazily per document and kept warm (state loaded once) */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  room(docId: string): Room {
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Room(docId, this.db);
      room.load();
      this.rooms.set(docId, room);
    }
    return room;
  }
}
