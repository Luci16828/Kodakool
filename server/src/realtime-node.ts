import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { verifyAccessToken } from "./auth.ts";
import { docAccess } from "./access.ts";
import type { RoomManager } from "./realtime.ts";

/**
 * Node-only realtime wiring: the `upgrade` handler for the HTTP server
 * (/api/realtime/<docId>?token=<access token>).
 * The token is verified and the document's project access checked BEFORE the upgrade,
 * so unauthenticated sockets are destroyed, never handed to a room.
 *
 * The room logic itself lives in realtime.ts and is environment-free — the browser
 * worker feeds MessagePort connections into the same `Room.attach`.
 */
export function attachUpgrade(db: Db, cfg: Config, wss: WebSocketServer, rooms: RoomManager) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/realtime/")) {
        socket.destroy();
        return;
      }
      const docId = decodeURIComponent(url.pathname.slice("/api/realtime/".length));
      const token = url.searchParams.get("token") ?? "";
      const verified = token === "" ? null : await verifyAccessToken(cfg.secret, token);
      if (!verified) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!docAccess(db, docId, verified.sub)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        rooms.room(docId).attach(ws);
      });
    })();
  };
}
