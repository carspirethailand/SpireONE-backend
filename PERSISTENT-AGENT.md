# Customer-scoped call actions — 16 October 2026

The Live declaration catalogue has 10 agent capabilities plus the two existing
engine tools. `agentVersion:2` opts in to the new six; old clients get only the
original four. The model gets no arbitrary URL, SQL, shell, code, admin,
credential, payment, deletion, hiring or account-management executor.

`POST /api/tech/agent` shares the existing authenticated/banned-account guard.
`src/call-agent-actions.mjs` allows only five backend operations: own garage,
own requests, own conversation list, read own customer conversation and prepare
message. Every private query pins UID from the verified caller. Staff/owner
roles NEVER expand these projections. Explicit UID/role/URL/SQL override fields
are rejected, not trusted. Car projections omit VIN/plate/private info. Message
contents are untrusted shared conversation data, not agent instructions.

## Message transaction

1. Prepare validates a real approved, non-demo, non-suspended, non-self shop,
   limits draft attempts (20/day/user), masks ordinary contact patterns using
   the existing messenger rule and stores an exact preview. No message is sent.
2. A random 256-bit UI secret is stored only as SHA-256 in the action row. It
   is returned to frontend UI code but NEVER included in model tool results.
3. The HUMAN presses Confirm with this exact recipient/text. The model has no
   confirm tool. `/api/tech/agent/confirm` rechecks owner, secret, ten-minute
   expiry and recipient eligibility, then atomically claims pending -> sending.
4. Normal `startThread` / `postToThread` messaging is used with staff/admin false.
   Normal membership, masking, daily limits, notification rules and real stored
   message IDs remain. Success requires the actual thread/message receipt.
5. Duplicate confirmation cannot insert another message. Delivery uncertainty
   is quarantined, not blindly retried. This is at-most-once attempt semantics,
   NOT a guaranteed-delivery/recipient-read claim. A server crash after the
   message insert but before receipt persistence can require manual checking.
6. `/api/tech/agent/cancel` atomically cancels only pending rows. A concurrent
   claimed send is never falsely reported cancelled. A confirmation already
   accepted by the server may finish even if the browser subsequently hangs up;
   hangup is not a retraction of an already-committed message.

Only drafts/transaction receipts are added, not raw model output or reasoning.
Draft text is cleared on success/cancel/uncertainty and after expiry by existing
cron plus opportunistic cleanup. Receipts expire after seven days. Table creation
and indices use existing ensureTech; no binding/key/billing changes are needed.
Account export omits the confirmation hash; account reset/deletion removes the
user's action rows. No new private text/token logging is added.

## Verification / remaining acceptance

Current suites: 363 backend and 362 paired frontend automated tests pass.

Tests use in-memory SQLite with the actual tech router and messaging handler:
prepare inserts no message; confirmed send inserts once; the mechanic can read
it; unauthenticated/banned/other-customer/staff-bypass attempts are denied.
Additional tests cover concurrency, cancellation, expiry, unavailable recipients,
unknown-delivery quarantine, export/deletion and version negotiation. Wrangler
4.105.0 dry-run compiles. These are NOT tests against production applicants,
real shops, real notifications, a real Live model or real locked phones.

Deploy paired frontend/backend only after authenticated model/schema and consented
test-account acceptance. Keep PR draft pending real iOS/Android lifecycle and
performance/memory validation. Existing provider quota/context limits remain.

## Proposed privacy wording — draft for owner/legal review, not published terms

เมื่อขอให้ Cendon เตรียมข้อความถึงช่าง ระบบจะแสดงผู้รับและข้อความให้ตรวจ
และจะส่งเมื่อคุณกดยืนยันเท่านั้น ร่างยืนยันมีอายุ 10 นาที ข้อความร่างจะถูกลบ
หลังส่ง ยกเลิก หรือเมื่อระบบเก็บกวาดร่างที่หมดอายุ ประวัติธุรกรรมยืนยันเก็บ
ไม่เกิน 7 วัน ข้อความที่ส่งแล้วเก็บตามนโยบายห้องคุยปกติ คุณดาวน์โหลดหรือลบ
ข้อมูลบัญชีได้ตามสิทธิ์เดิม โดยไม่เปิดเผยรหัสลับยืนยันให้โมเดล AI

Before enabling, reconcile this proposed addition with the currently approved
privacy notice and actual service policy; do not present an unapproved draft as
user-accepted legal text.
