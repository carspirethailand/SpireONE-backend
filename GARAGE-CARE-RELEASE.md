# Garage check-ins and literal Valet messages — 17 October 2026

## Scope

This release changes application policy, prompts and routing; it does not fine-tune model weights or detect a person's thoughts. No new model, paid service, binding or database migration is required. The experimental engine-family draft is not included.

## Optional Garage conversation

- Only an authenticated owner's selected, non-deleted car is eligible.
- After 60 seconds in a call, at least 25 seconds of quiet and a completed exchange, the client may request one question. It never retries this invitation in the same call.
- No invitation while hidden, muted, reconnecting, speaking/generating, using the camera/tools or waiting for Valet permission/confirmation. Driving, danger, distress or requests for silence suppress invitations for the call.
- The server permits at most one question per account every 7 days, across cars/devices. Atomic policy claims prevent concurrent duplicate questions.
- Eligible fields: mileage (missing or observed unchanged for 30 days) and insurance, compulsory insurance, road tax or inspection dates (missing or within 30 days/past). Renewal questions have a 90-day per-field gap. Existing mileage is first observed as fresh; historical freshness is not invented.
- Skip, disable and enable require an explicit request. No transcript or audio is stored in scheduling metadata. `_garage_care` is server-owned and blocked from generic state reads/writes.
- Answers use the existing Valet draft/read-back and explicit confirmation. No silent saves or guessed facts, units, dates or maintenance intervals. Cloud acknowledgement is required before reporting mileage/date save success. Renewal fields now sync across pages/devices.

## Valet

An explicit supported command such as `ช่วยทักไปหาช่างนนทการช่างและบอกว่า รถมีปัญหา start ไม่ติด รุ่น porsche 911` becomes a literal recipient/message draft before model/search execution. Permission-off uses Allow-and-continue without requiring repetition. Fuzzy/multiple recipients require selection; no match cannot send. Actual contact still requires user confirmation.

Valet grants are scoped to the signed-in UID. Legacy browser-wide grants require explicit permission again once. Voice Garage confirmations reject refusal, unrelated replies and silence. This narrow deterministic message grammar does not claim to resolve every vague natural-language command.

## Rollout and verification

Deploy backend then matching frontend in the same release. New clients enable care only when `/api/ai/live-token` explicitly advertises `garageCare: true`; old clients retain their existing tool schema. Frontend cache: `cendon-v303-garage-care`; versioned call-session r7, call-agent r6, Valet v4, core v5 and garage-care v1. The latest main Garage validation, calm-motion, car-menu and notification changes are retained.

Validation: full offline frontend/backend suites, Worker bundle dry-run, anonymous endpoint denial and public asset checks. No real mechanic was messaged and no customer Garage data was altered for testing. Live microphone behavior on a user's phone still requires a real-device check; passing fixtures is not measured speech-model accuracy.

Rollback: restore the prior Worker deployment and prior Pages deployment together. Internal scheduling metadata can remain; do not delete customer data or reset reminder limits. Existing calls do not need forced termination for rollout.
