# Client core architecture

`@secure-messenger/client-core` owns session, account, device identity,
chat, messaging, and V5 durable sync rules. It uses ES2023 and `zustand/vanilla`; it has no DOM,
Node, React, React Native, HTTP client, storage, or socket dependency.

## Package boundary

The only package export is `.`. Both its `types` and `import` conditions resolve
to `src/index.ts`. This private workspace ships TypeScript source, not generated
JavaScript or declarations. Consumers need a TypeScript-aware bundler or runtime.
Core typechecking uses `noEmit`; the web production build compiles the same entry
point. Node's type stripping can load the package without a bundler. A future
Metro setup must resolve the workspace and transform its TypeScript sources.

Import shared values and types directly from `@secure-messenger/client-core`.
Do not import internal paths or re-export core through a platform application.
Core modules import each other by relative paths, never through their own barrel.

```text
web main.tsx (composition) -> web adapters + core services/stores
React components -> web store bindings -> core stores
web HTTP/WebSocket/storage adapters -> core contracts/ports
core stores -> core services -> core ports/domain/protocol
core state -> zustand/vanilla
```

Gateway interfaces describe dependencies supplied to core. They do not introduce
imports from core to their platform implementations.

## Public API

This inventory is checked against TypeScript's resolved entry-point exports by
`tests/workspace.test.ts`. Runtime and type-only exports are listed separately.

<!-- public-api:start -->
| Kind / module | Exports |
| --- | --- |
| Runtime: errors | `ClientError` |
| Runtime: identity | `DeviceIdentityService`, `isDeviceIdentity` |
| Runtime: preferences | `ChatPreferencesService` |
| Runtime: stores | `createSessionStore`, `createChatStore` |
| Runtime: messaging | `MessengerService`, `PlaintextMessageCodec`, `SyncManager`, `mergeMessages` |
| Types: domain | `User`, `CurrentUser`, `DeviceIdentity`, `LoginDevice`, `Device`, `DirectChat`, `DestinationDevice`, `SentMessage`, `MailboxPage`, `ReceivedMessage`, `DisplayMessage`, `MessageDeliveryUpdate`, `ChatReadCursor`, `ChatReadState`, `ChatStatesPage`, `SentMessagesPage` |
| Types: errors | `ClientErrorCode` |
| Types: HTTP protocol | `CredentialsRequest`, `LoginRequest`, `TokenResponse`, `UserDto`, `CurrentUserDto`, `DeviceDto`, `DirectChatDto`, `DestinationDeviceDto`, `SentMessageDto`, `MailboxPageDto` |
| Types: message / realtime protocol | `ClientEnvelope`, `SendMessageRequest`, `MessageEnvelope`, `MailboxEnvelope`, `ServerEvent`, `ClientEvent` |
| Types: gateways | `SessionGateway`, `AccountGateway`, `ChatGateway`, `MessagingGateway`, `RealtimeGateway` |
| Types: platform ports | `DeviceIdentityStore`, `ChatPreferencesStore`, `DeviceDescription`, `IdGenerator`, `TextEncoding`, `Scheduler` |
| Types: durable inbox | `DurableDeviceIdentity`, `DurableInbox`, `InboxScope`, `InboxSnapshot`, `ChatHistoryCursor`, `ChatHistoryPage`, `OutgoingCommand` |
| Types: session store | `SessionState`, `SessionStore`, `SessionStoreDependencies` |
| Types: chat store | `ChatHistoryState`, `ChatState`, `ChatStore`, `ChatStoreDependencies` |
| Types: messaging | `MailboxLoadResult`, `IncomingEnvelope`, `MessageCodec` |
<!-- public-api:end -->

Domain models use camelCase and preserve server timestamps as strings. Protocol
DTOs and message envelopes retain backend field names; web mappers validate
unknown responses before returning domain values. Application recovery uses
`ClientError.code`; HTTP status and server error details belong in adapters.

## Ownership

| Location | Responsibility |
| --- | --- |
| `src/auth` | Identity validation and serialized replacement; session restoration, register/login, revoked-device recovery, account/device loading, logout/expiry, stale-result guards |
| `src/chats` | Per-user last-chat policy, race-safe selection/search/creation, mailbox reload coalescing, live chat discovery, message state, sends and lifecycle cleanup |
| `src/messaging` | Envelope construction, stable client IDs, one destination-refresh retry, transport choice, decoding, durable mailbox paging/tombstones, contiguous cursor validation, deduplication and ordering |
| `src/domain`, `src/protocol`, `src/ports` | Domain values, stable errors, wire contracts, injected gateway/platform contracts |
| `client/web/src/shared/api` | URL configuration, fetch/cookies, memory-only access tokens, refresh timers/Web Locks, DTO validation, HTTP error mapping, browser WebSocket authentication/backoff/correlation/timeouts |
| `client/web/src/shared/platform` | Browser UUIDs, strict UTF-8/Base64, device naming, localStorage preferences, IndexedDB identity/generation, atomic inbox/cursor and outgoing-command transactions |
| `client/web/src/shared/application` | React context, thin Zustand selectors, injected health check, session/chat/realtime lifecycle effects |
| `client/web/src/main.tsx` | Single application composition: services, stores and realtime adapter are assembled outside React rendering |
| `client/web/src/app`, `client/web/src/features` | Rendering, credentials/drafts, auth tabs/navigation, confirmations, forms, focus/scrolling, date formatting and CSS |

The web API adapter retains its application singleton. Shared code never imports
it. The removed messaging, identity, API type and realtime compatibility exports
have no replacement aliases: consumers use the public core package directly.

## Future React Native adapter contract

No native adapter is implemented. A native composition root must supply
each port below, then construct the same services and vanilla stores.

| Port | Native implementation requirements |
| --- | --- |
| `SessionGateway` | Implement register, login, restore and logout using existing backend contracts. Own platform HTTP/cookie handling, refresh serialization, memory-only access tokens and stale-response invalidation. Preserve backend Origin and Secure/HttpOnly/SameSite cookie requirements. Emit cleared events whenever credentials are cleared, including replacement, logout and expiry. Emit expired events for expired authentication, excluding explicit logout and anonymous restoration. Both subscriptions return independent cleanup functions. |
| `AccountGateway` | Load current user/devices and revoke the specified device. Validate responses, return camelCase domain values, and map known failures to stable ClientError codes, including device_revoked. |
| `ChatGateway` | Search users, load chat lists/details and create direct chats through existing endpoints. Validate/map responses and encode untrusted path/query values. Leave selection, search races and last-chat policy in core. |
| `MessagingGateway` | Fetch destination devices, submit the unchanged send command and page the mailbox. Preserve envelope fields, nullable tombstones, timestamps and cursors. Return validated domain values. Map delivery_targets_changed accurately; core owns the single retry. |
| `RealtimeGateway` | Own the native socket, auth handshake, token refresh, correlation, timeout and reconnect timers. start/stop must be repeatable; stop releases timers/subscriptions and rejects pending sends. ready means authenticated and open. onReady fires after each successful connection and onMessage delivers validated envelopes; both return cleanup functions. Reject ambiguous sends with delivery_unconfirmed so core never replays them over HTTP. Respect the backend Origin check and send tokens in the auth frame, never the URL. |
| `DeviceIdentityStore` | Asynchronously read decoded, untrusted identity data and await durable writes. Return null for absent/malformed serialized data; propagate storage failures. Core validates identities and serializes restoration/replacement. Store only the device ID/name here, never credentials or key material. |
| `DurableInbox` | Implements the identity port and stores its generation together with opaque envelopes, immutable outgoing commands, accepted metadata, chat cache and per-account/device cursor. Atomically upsert a full page and compare/advance its expected cursor; reject stale generations. Resolve writes only after commit. Preserve received content when server tombstones arrive. Losing this store requires a new registered device; never reuse a legacy identity from another store. |
| `ChatPreferencesStore` | Asynchronously read/write the last chat ID per user. Null removes the preference. Await writes and propagate failures; core owns stale-chat cleanup and operation ordering. |
| `DeviceDescription` | Asynchronously provide a nonblank device name of at most 100 characters without browser globals. |
| `IdGenerator` | Use a platform-supported UUID generator for device/client message IDs. Do not implement custom randomness or cryptography. |
| `TextEncoding`, `Scheduler` | Implement UTF-8 and Base64 byte conversions; reject malformed UTF-8/Base64. Preserve Unicode and empty payload behavior. |

Create DeviceIdentityService using the durable inbox and ChatPreferencesService
using the preference port. Inject that same inbox into SyncManager and pass the
manager to MessengerService alongside messaging, codec, ID and realtime dependencies; then
createSessionStore and createChatStore with their declared dependencies. Subscribe
before calling session.restore(). Start chats for the authenticated user and start
realtime only after authentication and durable inbox activation. Supply
`prepareInbox: user => sync.activate(user)` to the session store and deactivate
sync when credentials are cleared. On session change/unmount, dispose chats and
stop realtime; dispose the session subscription when the application owner exits.
Restoration can reconnect after disposal. React bindings can use Zustand useStore,
but neither React nor native lifecycle APIs belong in core.

V4 retains the existing protocol-0 PlaintextMessageCodec development format. Base64
is not encryption. This refactor changes no codec or cryptography, introduces no
backend plaintext requirement, and implements no E2EE, durable inbox, sync cursor
persistence or acknowledgements. Future cryptographic work must preserve client-side
encryption/decryption and must not log or persist plaintext, keys or secrets.

## Verification

From the repository root:

```sh
npm run typecheck:core
npm run test:core
npm run test:frontend
npm run lint --workspace client/web
npx tsc --project client/web/tsconfig.test.json
```

`npm run check:architecture` checks both source trees for cycles (including type
imports/re-exports), forbids web imports of private core paths and compatibility
re-exports, and keeps UI components away from API adapters. Web lint runs it too.
Core's independent boundary check rejects imports outside core except
zustand/vanilla, platform imports, import.meta and ambient-reference escape hatches.
The ES2023-only compiler and compiler probes reject DOM/Node/React globals. Core
tests run with platform-free fakes; web tests cover browser adapters and React
behavior. See [acceptance results](../../ACCEPTANCE.md) for the final run and limits.
