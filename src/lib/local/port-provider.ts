import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import { openRoomPort } from "./worker-client";

/**
 * Yjs provider over a MessagePort into the in-worker server room — the local twin of
 * `WebsocketProvider`. Same wire protocol (y-protocols sync + awareness frames), same
 * public surface the coding page uses (`synced`, `awareness`, "status"/"sync" events,
 * `destroy`), so RemoteDoc treats local and remote providers identically.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export class PortProvider extends Observable<string> {
  readonly awareness: awarenessProtocol.Awareness;
  synced = false;
  private readonly port: MessagePort;
  private destroyed = false;

  constructor(
    private readonly doc: Y.Doc,
    docId: string,
    token: string,
  ) {
    super();
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null);

    const { port, onReject } = openRoomPort(docId, token);
    this.port = port;
    onReject(() => {
      if (!this.destroyed) this.emit("status", [{ status: "disconnected" }]);
    });
    this.emit("status", [{ status: "connecting" }]);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.destroyed) return;
      this.send((enc) => {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeUpdate(enc, update);
      });
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if (this.destroyed) return;
        const changed = added.concat(updated, removed);
        this.send((enc) => {
          encoding.writeVarUint(enc, MSG_AWARENESS);
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        });
      },
    );

    this.port.onmessage = (e: MessageEvent) => {
      if (this.destroyed) return;
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      while (decoding.hasContent(dec)) {
        switch (decoding.readVarUint(dec)) {
          case MSG_SYNC: {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MSG_SYNC);
            const syncType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
            if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
              this.synced = true;
              this.emit("sync", [true]);
              this.emit("status", [{ status: "connected" }]);
            }
            // answer the room when readSyncMessage produced a reply (step1 → step2, update → diff)
            if (encoding.length(enc) > 1) {
              const data = encoding.toUint8Array(enc);
              this.port.postMessage(data, [data.buffer]);
            }
            break;
          }
          case MSG_AWARENESS:
            awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
            break;
          default:
            return;
        }
      }
    };

    // y-websocket's onopen handshake: the client announces ITS state vector, and
    // the room answers with the diff it is missing (SyncStep2 → synced). Answering
    // only the room's step1 with a step2 never gives the client the room's content.
    this.send((enc) => {
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
    });
    this.send((enc) => {
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      );
    });
  }

  private send(write: (enc: encoding.Encoder) => void): void {
    const data = encoding.encode(write);
    this.port.postMessage(data, [data.buffer]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "provider destroyed");
    this.port.close();
  }
}
