# Secure Messenger

Minimal V0 monorepo with a FastAPI backend, React frontend, and PostgreSQL.

## Local setup

Requirements: Docker, Node.js/npm, and [uv](https://docs.astral.sh/uv/).

```powershell
Copy-Item .env.example .env
docker compose up -d postgres
uv sync --project backend --dev
npm install --prefix frontend
npm run migrate
```

Run the backend and frontend in separate terminals:

```powershell
npm run dev:backend
npm run dev:frontend
```

Open http://localhost:5173. The page reports the backend and database health.

## Checks

```powershell
npm test
```

