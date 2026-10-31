# Studio stability release

The realtime channel is `/api/tech/events`, not `/api/tech/live` (the latter remains the existing public roaming-location API). `CendonStudioLive` is an additive SQLite Durable Object class, bound as `STUDIO_LIVE`. The existing CHAT_JOBS migration, D1 binding and all stored accounts/services remain intact.

Sockets require a verified Firebase token, allowed browser Origin and the `cendon-studio.v1` subprotocol. User identity comes from authentication, never a query parameter. Invalidation carries only allowed topics and a random revision; normal authorized APIs still supply the actual records. No tokens in URLs, persistent attachments, event bodies or diagnostic output. Failed publication is recoverable through the existing pulse/reconnect path and does not fail an already saved job.

Audited source paths include authentication/routing/schema startup; own membership and inventory; direct/grouped jobs and revisions; nearby post visibility; offer/accept/cancel races; conversation/read receipts; driving/roaming location; profile edits, services and quotas; shop statistics/advice; and staff-target refresh hints. Existing identity/moderation, photos, proof, archive and persistence suites remain required. No moderation or ownership decision is changed by this release.

Fixes include one-query opaque pulse tokens, metadata-only per-recipient wake-ups, atomic creation/quota checks, duplicate-request idempotency, one winner per quote group, guarded post closure/offer writes, sparse JSON updates preserving concurrent unrelated settings, service edit conflicts instead of silent overwrites, and provider credentials moved from advice URLs into a header. Driving GPS packets do not invalidate all lists.

Verification:

- `node --test 'test/*.test.mjs'` — backend assertions, including new Studio race/privacy tests and existing mechanic data-persistence checks.
- `node test/studio-live-runtime.mjs` — actual workerd SQLite DO, RPC invalidation, real WebSockets, heartbeat, reconnection, lease and socket limits, per-user isolation.
- With installed Playwright configured in `CENDON_NODE_PACKAGES`, `node test/studio-realtime-browser.mjs ../frontend` — actual backend/D1/DO into production Studio controller code in Chrome, with synthetic accounts and a minimal render adapter. Covers urgent posts, repeated direct jobs while inbox is stalled, retained form input and account switch. Local runs were below 200 ms; this is not a production-network guarantee.
- Wrangler package dry-run; full frontend unit/browser/source checks; read-only `tools/mechanic-release-guard.mjs capture` before and `check` after production deployment. Private artifacts must never be published. Never automatically restore production on a mismatch.

Publish backend before frontend. Preserve remote vars/secrets (`--keep-vars` and reviewed remote variable values), the existing database ID, other bindings, and paid-routing-off state. No paid plan activation. Browsers suspended/offline by the OS catch up when visible; LINE/Web Push delivery remains permission/network/OS dependent.
