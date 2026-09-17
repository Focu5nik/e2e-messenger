# Secure Messenger

V4 monorepo with a FastAPI backend, React frontend, PostgreSQL, JWT authentication,
account-scoped device identity, one-to-one chats, and WebSocket message delivery.

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

V4 uses an in-memory event bus and supports a single backend process. Socket delivery
is a best-effort attempt: it neither marks an envelope delivered nor purges its
payload. The stable protocol reserves `message.delivered` and
`sync.request` / `sync.response`; requests for these deferred capabilities receive
an `unsupported_event` error in V4. Received content remains in memory, with the
existing HTTP mailbox available after reload. Durable local storage, offline sync,
and delivery acknowledgements belong to later versions. Unacknowledged payloads
retain the existing 45-day expiry and metadata-only tombstones.

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
