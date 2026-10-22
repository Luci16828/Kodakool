# kodakool-server

The **optional collaboration server** for Kodakool. The web app is fully usable
without it — the "Local" account runs this exact code inside a SharedWorker
(`src/worker.ts`, sql.js + IndexedDB). Running it as a network service is what
adds accounts, shared projects and cross-device real-time editing.

Same code, three runtimes: REST + rooms run on `node:sqlite` (this server),
`sql.js` (the SharedWorker "Local" account) and `@sqlite.org/sqlite-wasm`
(the Node test shim). The shared API suite (`src/api.suite.ts`) proves the
REST surface on **all three engines**.

## Run it

```bash
cp .env.example .env       # set at least SECRET (>= 32 chars)
pnpm install
pnpm dev                   # watch mode, http://0.0.0.0:8787
pnpm start                 # production
pnpm test                  # 56 tests across the 3 SQLite engines
pnpm check                 # tsc
```

Requires Node >= 22.6 (`--experimental-strip-types --experimental-sqlite`).

## Configuration (environment)

| Var              | Default   | Meaning                                                        |
| ---------------- | --------- | -------------------------------------------------------------- |
| `SECRET`         | —         | session JWT signing key, **min 32 chars** (required)           |
| `PORT`           | `8787`    | listen port                                                    |
| `HOST`           | `0.0.0.0` | bind address                                                   |
| `DATA_DIR`       | `./data`  | directory of the SQLite file (+ room state)                    |
| `ALLOW_REGISTER` | `1`       | `0` disables open username/password registration (invite-only) |
| `OIDC_ALLOW`     | —         | comma-separated issuer allow-list; empty = any `https` issuer  |

## API surface

- **Auth** — `POST /api/auth/register|login|refresh|logout` (username + password,
  PBKDF2 through WebCrypto `pbkdf2$` in the worker and `node:crypto` on the
  server — both schemes verify), and OIDC Authorization Code + **PKCE**:
  `POST /api/auth/oidc/begin` (returns the provider URL + verifier state) →
  user signs in at the provider → `POST /api/auth/oidc/exchange`.
  `GET /api/me` returns the session user.
- **Projects** — list/create/delete, subfolder registry
  (`PUT /api/projects/:id/subs`), per-project catalog JSON
  (`GET`/`PUT /api/projects/:id/catalog`), sharing
  (`POST /api/projects/:id/share`, `DELETE …/share/:userId`); delete cascades
  documents, entries, PDF bytes and the catalog.
- **Documents** — CRUD under `/api/projects/:id/docs` + `/api/docs/:id`
  (name/text/folder/project moves, `codes` = coding entries, `versions` =
  snapshot DAG), original PDF bytes (`GET`/`PUT /api/docs/:id/pdf`, binary),
  snapshot helper (`POST /api/docs/:id/versions`, label rename).
- **Whole-database export/import** — `GET /api/export` / `POST /api/import`
  (version 1 blob: users, projects, members, documents, catalogs, pdfs, room
  states, meta; import is validated fully **before** writing anything).
- **Realtime** — WebSocket at `/api/realtime/<docId>?token=<access token>`:
  the token and the project access are verified **before the upgrade**, then
  the Yjs document room runs the standard y-protocols sync
  (SyncStep1/2, updates, awareness). Every debounced room update is persisted
  as the Yjs binary state **and materialized** (text + entries) into the
  documents row, so REST reads always reflect the live room.
- **Store events (SSE)** — `GET /api/events?token=<access token>` streams every
  structural store change (`docs`, `project`, `catalog`, `subs` + periodic
  `ping`; opens with a `hello` frame). Mutating routes and room materializations
  emit here; clients react by refetching their tree/catalog through the normal
  authorized endpoints (the events carry ids only). `requireAuth` accepts the
  `?token=` fallback on every protected route because EventSource cannot send
  an Authorization header.

## Docker

```bash
docker build -t kodakool-server server/
docker run -p 8787:8787 -e SECRET=... -v kodakool-data:/app/data kodakool-server
```
