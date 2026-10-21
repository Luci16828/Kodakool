import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.ts";
import { openDb } from "./db-node.ts";
import { createApp } from "./app.ts";
import { nodeCrypto } from "./auth-node.ts";
import { RoomManager } from "./realtime.ts";
import { attachUpgrade } from "./realtime-node.ts";

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const rooms = new RoomManager(db);

const app = createApp({ cfg, db, kdf: nodeCrypto });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  console.log(`kodakool-server listening on http://${cfg.host}:${info.port} (data: ${cfg.dataDir})`);
});
server.on("upgrade", attachUpgrade(db, cfg, wss, rooms));
