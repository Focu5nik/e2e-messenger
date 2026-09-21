# Secure Messenger

V6 monorepo with a FastAPI backend, React frontend, PostgreSQL, JWT authentication,
account-scoped device identity, one-to-one chats, WebSocket message delivery, and
an IndexedDB-backed durable local inbox, offline mailbox synchronization, and
durable delivery acknowledgements with per-device server payload purge.

## Local setup

Requirements: Docker, Node.js/npm, and [uv](https://docs.astral.sh/uv/).

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item client/web/.env.example client/web/.env
Copy-Item infra/.env.example infra/.env
npm run infra:up
uv sync --project backend --dev
npm install
npm run migrate
```

Run npm installs from the repository root. The root `package-lock.json` is the
canonical lockfile for the `client/web` and `client/packages/*` workspaces; use `npm ci`
for a clean, reproducible install. The frontend depends on the local
`@secure-messenger/client-core` package in `client/packages/client-core`. Its TypeScript
entry point exports the shared session/chat stores, messaging and identity services,
domain models, protocol contracts, and platform ports. See the
[client architecture](client/packages/client-core/README.md) for ownership, the public
API, and future native adapter requirements, and the
[acceptance results](client/ACCEPTANCE.md) for final refactor verification.

Before starting the backend, replace the example `JWT_SECRET` in `backend/.env` with a unique random
value of at least 32 characters. Never reuse the example value outside local
development.

Docker publishes the project database on host port `5433` by default, while
PostgreSQL continues to use port `5432` inside the container. Override
`POSTGRES_PORT` in `infra/.env` and the matching port in `DATABASE_URL` in
`backend/.env` together if needed. Database names and credentials must also match.

`npm run infra:down` stops the Compose services and preserves the database volume.
Direct Docker commands use `docker compose --env-file infra/.env -f infra/compose.yaml`.
The Compose project name remains `messenger`, preserving `messenger_postgres_data`.

Run the backend and frontend in separate terminals:

```powershell
npm run dev:backend
npm run dev:frontend
```

Open the URL configured by `FRONTEND_ORIGIN` in `client/web/.env`. Vite uses it
for its host and port and exits if that port is already occupied. Keep
`FRONTEND_ORIGIN` in `backend/.env` equal to that web origin for HTTP and WebSocket
authorization. `VITE_API_URL` in `client/web/.env` points to the backend. The backend
starts at `127.0.0.1:8000` by default; use Uvicorn's `--host` and `--port` flags
when overriding it. You can register, sign in on the persistent browser device, find
active users, open a unique direct chat, switch chats, inspect account devices,
revoke a device, exchange messages in real time, and sign out.

## HTTP API

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /me`
- `GET /devices`
- `DELETE /devices/{id}`
- `GET /users?search={username}`
- `POST /chats/direct/{user_id}`
- `GET /chats`
- `GET /chats/{chat_id}`
- `GET /chats/{chat_id}/destination-devices`
- `POST /messages`
- `GET /messages/by-client-id/{client_message_id}`
- `POST /messages/envelopes/{envelope_id}/ack`
- `GET /messages/mailbox?after_seq=0&limit=100`

Access tokens are short-lived JWTs returned in response bodies. Refresh tokens are
sent only in host-only `Secure; HttpOnly; SameSite=Strict` cookies, rotated after
every refresh, and stored by the backend only as SHA-256 hashes. Reuse of any
rotated token revokes its authentication session. Login, refresh, and logout require
an `Origin` header that exactly matches `FRONTEND_ORIGIN`.

Migration `20260901_0004` revokes sessions created by the previous browser-storage
flow and marks new sessions as cookie-bound, so older backend instances cannot
create refreshable legacy sessions during a rolling deployment. Users sign in once
after upgrading, and the frontend removes the legacy refresh-token value from
`localStorage` without reading it.

Production must serve the API over HTTPS and keep the frontend and API on the same
site; browsers will not send a `SameSite=Strict` refresh cookie across unrelated sites.

Direct-chat creation canonicalizes the two user IDs and is idempotent in either
participant order. The database unique constraint resolves concurrent creation, and
the losing transaction returns the winning chat without leaving an orphan. Chat list
and detail access require the requester to be both a pair endpoint and one of exactly
two matching membership rows. Direct-chat responses contain `id`, `type`,
`created_at`, and the `other_user`.

## WebSocket delivery

Connect to `/ws` on the API host using `ws://` for local HTTP development or `wss://`
for HTTPS. The handshake requires the configured `FRONTEND_ORIGIN`. Send the access
token in the first JSON frame, never in the URL:

```json
{"type":"auth","access_token":"<access token>"}
```

After `{"type":"auth.ok"}`, use these JSON events:

| Direction | Event | Fields |
| --- | --- | --- |
| Client → server | `message.send` | `request_id`, `data`: the same command as `POST /messages` |
| Server → sender | `message.accepted` | `request_id`, `data`: the HTTP message response |
| Server → recipient device | `message.new` | `data`: one mailbox envelope with message metadata |
| Client → server | `sync.request` | `request_id`, `data`: `{after_seq, limit}` (defaults: `0`, `100`; limit: `1..100`) |
| Server → client | `sync.response` | `request_id`, `data`: `{envelopes, next_seq, has_more}` matching the HTTP mailbox response |
| Client → server | `message.delivered` | `request_id`, `data`: `{envelope_id}` after durable local receipt |
| Server → acknowledging device | `message.delivered` | `request_id`, `data`: the envelope metadata with delivery/purge timestamps and null payload |
| Server → sending device | `message.delivered` | No `request_id`; `data`: the same per-envelope delivery receipt |
| Server → client | `error` | Optional `request_id`, `error`: `{code, message, status}` |

The send command contains `chat_id`, `client_message_id`, and the client-built
`envelopes` array. HTTP and WebSocket sends share validation, authorization,
idempotency, and the database transaction. Acceptance and live delivery happen only
after commit. The backend routes each opaque envelope only to its destination
device; the existing protocol-0 codec encodes and decodes content on the client.
Protocol 0 is the pre-E2EE development format, not encrypted messaging.

One application-level `WebSocketManager` owns authentication, reconnection, and
event routing. Connections are device-scoped; a newer connection replaces the old
one with close code `4001`. Authentication failures use `4401`, and disallowed
origins are rejected with `4403` before the connection is accepted.

V6 uses an in-memory event bus and supports a single backend process. Socket delivery
alone remains a best-effort attempt. After the recipient commits an envelope and
cursor to IndexedDB, its explicit ACK atomically sets `delivered_at`, clears only
that device's payload, and sets `payload_purged_at`. ACK retries preserve the first
timestamps. Other devices retain their payload until their own ACK or the existing
45-day expiry. Envelope/message rows, receipts, routing, cursors, and idempotency
metadata remain available. `sync.request` includes metadata-only tombstones.

The shared `SyncManager` coordinates realtime ingestion and mailbox paging through
the browser's `DurableInbox` adapter. Each ordered page and its cursor commit in one
IndexedDB transaction; gaps and failed transactions cannot advance the cursor.
Reload reconstructs messages from stored opaque envelopes and outgoing commands.
Outgoing commands retain their original client message ID and envelope bytes; an
ambiguous WebSocket send is never automatically replayed over HTTP.
Recovery first looks up the original client message ID for the authenticated sender
device. Only a confirmed missing result permits resending the exact durable command.
Outgoing messages display pending and accepted states; a single-destination message
becomes delivered on its device receipt. Multi-device receipts are retained separately;
their aggregate UI semantics belong to V7. Pending commands can be retried from the UI.

Locally committed envelopes without a confirmed receipt are ACKed again after sync
or reload. A server purge never deletes the recipient's local payload. No database
migration is required for V6; the existing envelope columns hold delivery metadata.

IndexedDB owns the device identity and local-store generation. Upgrading from V4
rotates the old localStorage identity and requires signing in to register the new
device. Clearing or losing IndexedDB likewise requires a fresh device; a surviving
cookie for the old mailbox cannot start messaging. Local backup/restore is out of
scope. Protocol 0 remains the existing development format; V6 adds delivery
reliability without changing cryptography.

## Repository layout

```text
client/
  web/                    # React web app, Vite/TypeScript config, public env settings
  packages/client-core/   # Shared client package; future mobile app goes in client/mobile
backend/                  # Python app, tests, migrations, backend env settings
infra/                    # PostgreSQL Compose configuration and container env settings
package.json              # npm workspaces and repository commands
package-lock.json         # Canonical npm lockfile
```

Each application loads its own `.env`; there is no root `.env`. The backend resolves
its file relative to `backend/app/config.py`, so launching from the root or backend
directory uses the same settings. Real `.env` files are ignored by Git; commit only
the `.env.example` templates. Browser-exposed `VITE_*` settings must contain no secrets.

## Backend layout

```text
backend/app/
  main.py       # FastAPI assembly and shared middleware
  config.py     # Environment-backed settings
  database.py   # SQLAlchemy engine, sessions, and declarative base
  auth/         # V1 authentication and device-identity feature
  chats/        # V2 user discovery and direct-chat feature
  messages/     # Device-scoped envelope persistence and mailbox APIs
  realtime/     # V4 WebSocket protocol, connection registry, and local event bus
```

New roadmap features should be added as sibling feature packages such as `chats/`,
`messages/`, and `realtime/`. Do not create empty packages before their version is
implemented.

## Checks

```powershell
npm test
npm run lint --workspace client/web
node client/scripts/verify-v6-browser.mjs
```

To check only the JavaScript/TypeScript workspaces:

```powershell
npm run typecheck:core
npm run test:core
npm run test:frontend
```

To include PostgreSQL locking and concurrency tests, migrate an isolated test
database, then set `TEST_DATABASE_URL` before running `npm test`. These tests are
skipped when that variable is unset.

The V6 browser check uses an installed Chromium browser with a temporary, isolated
profile and real IndexedDB. Set `CHROMIUM_PATH` if Chrome/Edge is installed elsewhere.
