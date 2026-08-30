# Secure Messenger

V1 monorepo with a FastAPI backend, React frontend, PostgreSQL, JWT authentication,
and account-scoped device identity.

## Local setup

Requirements: Docker, Node.js/npm, and [uv](https://docs.astral.sh/uv/).

```powershell
Copy-Item .env.example .env
docker compose up -d postgres
uv sync --project backend --dev
npm install --prefix frontend
npm run migrate
```

Before starting the backend, replace the example `JWT_SECRET` with a unique random
value of at least 32 characters. Never reuse the example value outside local
development.

Docker publishes the project database on host port `5433` by default, while
PostgreSQL continues to use port `5432` inside the container. Override
`POSTGRES_PORT` and the matching port in `DATABASE_URL` together if needed.

Run the backend and frontend in separate terminals:

```powershell
npm run dev:backend
npm run dev:frontend
```

Open the URL configured by `FRONTEND_ORIGIN` in `.env`. Vite uses the same setting
for its host and port and exits if that port is already occupied, preventing a CORS
origin mismatch. You can register, sign in on the persistent browser device,
refresh the session, inspect account devices, revoke a device, and sign out.

## V1 API

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /me`
- `GET /devices`
- `DELETE /devices/{id}`

Access tokens are short-lived JWTs. Refresh tokens are stored by the backend only
as SHA-256 hashes; refresh-token rotation and reuse detection remain deferred to V15.

## Backend layout

```text
backend/app/
  main.py       # FastAPI assembly and shared middleware
  config.py     # Environment-backed settings
  database.py   # SQLAlchemy engine, sessions, and declarative base
  auth/         # V1 authentication and device-identity feature
```

New roadmap features should be added as sibling feature packages such as `chats/`,
`messages/`, and `realtime/`. Do not create empty packages before their version is
implemented.

## Checks

```powershell
npm test
```
