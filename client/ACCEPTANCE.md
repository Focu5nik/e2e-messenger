# V4 client-core refactor acceptance

Verification date: 2026-09-14.

The boundary cleanup and automated acceptance checks are complete. Manual browser
acceptance remains pending: the UI tool returned no connected apps/browsers, and
opening the in-app browser failed with `Browser is not available: iab`. No manual
browser scenario is claimed as passed. Automated component tests use jsdom and
mocked HTTP/realtime dependencies; they do not prove real-browser cookie behavior,
layout, or end-to-end transport integration.

## Automated results

| Check | Result |
| --- | --- |
| `npm run typecheck:core` | Pass: ES2023-only compilation and independent core import boundary |
| `npm run test:core` | 71 passed, none skipped; includes public package import without DOM types, Node runtime import, compiled export/documentation parity, session/chat workflows and messaging guarantees |
| `npm run test:frontend` | 91 passed, none skipped; web/test TypeScript compilation and Vite production build passed |
| `npm run lint --workspace client/web` | Pass, including architecture checks |
| `npx tsc --project client/web/tsconfig.test.json` | Pass |
| `npm run check:architecture` | Pass: no core-to-web imports, private core imports, compatibility re-exports, UI-to-API imports or import cycles (including type dependencies) |
| `npm run test:backend` with isolated `TEST_DATABASE_URL` | 60 passed, none skipped, including PostgreSQL locking/concurrency and existing migration regression coverage |

Total: 222 tests passed. The first frontend build exposed a missing declaration
for the new architecture checker; adding its declaration resolved the error and
the frontend suite/build were rerun successfully. tsx required execution outside
the sandbox because Windows user-profile lookup failed inside it.

## Manual checklist and automated coverage

Every manual result below is **not run: browser unavailable**. These steps can be
completed with two disposable accounts and separate browser profiles against an
isolated local database. Use only synthetic test messages.

| Scenario / manual acceptance step | Passing automated evidence |
| --- | --- |
| Restore: reload while signed in; confirm account and last chat return. Reload without a refresh cookie and confirm anonymous state. | Web components: restoration/loading, anonymous restore, last-chat restore; API cookie refresh tests; core session/preferences tests |
| Register/login: register a test account, sign out/in, then submit invalid credentials. | Web registration/login/retry components; core session sequencing; backend authentication tests |
| Logout: sign out with a chat open; verify account/chat state is cleared and realtime stops. | Web lifecycle/logout-warning tests; core stale-result and disposal tests; API late-login/refresh invalidation |
| Device revocation: revoke another test profile's device, then the current device; verify current revocation signs out and subsequent login replaces the revoked identity once. | Web current/remote/cancelled/failed revocation and recovery tests; core identity/session tests; backend device authorization tests |
| User search: search for the second test account and open its direct chat. | Web people-search/direct-chat rendering; core search races; backend direct-chat tests |
| Chat selection: switch between two test chats, reload, and confirm the correct last chat is restored. | Web stale selection, deleted/missing last chat and per-user preference tests; core selection generation tests |
| HTTP fallback send: block only `/ws` with browser request blocking while HTTP stays available; send a test message and confirm `POST /messages` succeeds and the recipient mailbox contains it. | Web HTTP send failure/retry/draft tests; core transport selection, envelope and mailbox tests; backend HTTP-to-live-delivery test |
| Realtime send/receive: with two connected test profiles, exchange messages both ways; confirm one displayed copy per message. | Web realtime send/receive/live-echo tests; core merge/live-mailbox races; adapter handshake/correlation tests; backend bidirectional delivery tests |
| Reconnect: interrupt the socket, restore connectivity, and confirm reconnection plus mailbox catch-up without duplicate sends. | WebSocket backoff/restart/timeout tests; core reload coalescing and no-HTTP-replay-after-ambiguous-send tests |
| Session expiry: invalidate only the test session server-side, trigger refresh or an authenticated request, and confirm sign-in returns with cleared chat state; sign in again. | Web refresh rejection/repeated-401 expiry components; core expiry/stale-result tests; backend revoked/expired-session tests |

## Scope and environment

Step 13 removed web messaging/identity shims, API domain/protocol re-exports, the
RealtimeTransport/MessagingApi aliases, and the unused API barrel/error-text helper.
Remaining consumers import the core package or the owning web adapter directly.
Architecture rules and their regression tests enforce the final dependency direction.
The [core README](packages/client-core/README.md) documents all public exports,
ownership and every future native port implementation.

No backend source, migrations, endpoint/schema contracts, codec, crypto, dependency
versions, or environment files were changed by steps 13–14. Existing uncommitted
repository relocation and backend environment-loading changes were preserved.
The temporary database `messenger_v4_final_verify_20260914` was created and migrated
with existing migrations solely for verification, then dropped. The PostgreSQL
service started for verification was stopped; the existing volume was preserved.

The final task changes were reviewed. The repository-wide `git diff --check`
reports pre-existing trailing whitespace in `.gitignore:14`; that unrelated file
was left unchanged. Checks for the edited tracked files pass. The client tree is
already untracked in the user's working tree and was reviewed directly. No commit,
push, or staging was performed. The plan in ignored `dev-docs/V4_REF_PLAN.md` was
updated; this acceptance record lives in the non-ignored client tree.
