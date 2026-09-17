# Messenger web client

React and Vite application consuming `@secure-messenger/client-core`.
Run commands from the repository root with the canonical workspace lockfile:

```sh
npm ci
npm run dev:frontend
npm run test:frontend
npm run lint --workspace client/web
```

Configure `client/web/.env` using `.env.example`; see the root README for backend
and database setup. `main.tsx` assembles core stores/services and web adapters.
The application provider owns lifecycle effects; components consume state through
`useSessionStore` and `useChatStore` and invoke store actions.

Shared business rules and types must be imported directly from the core package.
HTTP/cookie mechanics, WebSocket transport, localStorage, device descriptions,
encoding, React and DOM interaction stay here. See the
[architecture and native adapter contract](../packages/client-core/README.md) and
[final acceptance results](../ACCEPTANCE.md).
