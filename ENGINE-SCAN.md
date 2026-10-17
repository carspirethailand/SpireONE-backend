# Engine-bay identification v2 — 16 October 2026

## Experimental v4 coverage branch — 17 October 2026

See ENGINE-CAR-COVERAGE.md for the full 82-target inventory, evidence gates,
offline evaluator and unresolved real-image errors. This branch is NOT a trained
or fully validated 82-model release. Production remains the previous v3.
V4 adds required provider identityCue/identityMarking and conservatively labels
unverified fluid containers as unidentified; it needs reviewed image evaluation.
The older sections below describe the v3 contract/history, not a v4 accuracy claim.

## 17 October 2026 compatibility fix

Real Cloudflare remote-development inference reproduced HTTP 400 on both configured
Flash Lite models with the original nested enum + array-length schema. Removing
only `minItems`/`maxItems` from the provider schema restored successful results.
Types, required fields and part enums remain. Server validation still requires
exactly four bounded coordinates, evidence, high certainty, valid scenes and
at most 24 accepted objects. No unvalidated JSON/fake-coordinate fallback is used.
Provider failures now return finite safe codes instead of raw provider messages.
Logs contain only an event code and random request reference, never image/text.
Temporary provider capacity is not labelled as the customer's daily allowance.

## What this is (and is not)

This is a versioned, prompt/schema/catalogue upgrade to the existing Gemini
image-analysis pipeline. No model weights have been trained or fine-tuned.
It does not recognise every possible part, reveal hidden parts, diagnose faults,
establish roadworthiness, or guarantee correct identification.

- Catalogue v3: 131 server-owned component concepts, Thai/English names,
  functions and safety text; 129 released locator IDs. Kick-start and shift
  pedals are withheld after real Wave-photo failures (see POWERTRAIN-EVALUATION.md).
- At most 24 distinct visible objects per image. Separate hoses/coils may have
  the same type. Unknown-purpose hoses remain explicitly unidentified.
- The model returns only a known part ID, a tight box, subjective certainty and
  a visible identifying clue. Text in the image is untrusted data.
- Medium/low certainty, missing evidence, bad geometry, unknown types, duplicate
  boxes, blurred/dark/blocked or non-engine scenes do not produce solid boxes.
- “High” is the model's assessment, NOT a calibrated probability or a measured
  accuracy. It may still be wrong. Red means location, not damage.
- No generated repair instructions enter the component card. Server text tells
  the owner to park, switch off, cool down, observe only, and not open caps,
  touch, unplug or repair. High-voltage components need a qualified technician.

## Integration

POST the existing authenticated `/api/features/analyze` endpoint with
`tool:"baylive"`, `scanVersion:2`, `lang:"th"|"en"`, and exactly one JPEG/PNG/WebP
in `attachments:[{mime,b64}]`. The new image limit is 2,000,000 base64 characters.
No public upload URL or new provider is introduced. No images, raw AI text or
evidence are added to a database or logs by this change.

`src/engine-bay.mjs` owns the catalogue, schema, prompt and strict result cleaner.
The caller passes `responseSchema`, minimal thinking, 3,600 output tokens and a
shared 18-second model-attempt budget, with at most 10 seconds per attempt.
Existing auth, quota, role and metering guards remain in force. Old unversioned
scan clients keep the legacy contract.

Catalogue v3 still uses `scanVersion:2` geometry. New required provider fields
are `vehicleKind`, `powertrain`, `view`, and item `visibility`. Hidden items
never get boxes; motorcycle-only types need explicit motorcycle metadata;
internals need an already-exposed assembly view and explicit visible status.
Server-owned `coverGuidance` never authorises disassembly. The companion
frontend displays motorcycle-specific headings and this observe-only guidance.
Saved garage-car context does not override the photographed motorcycle.

Deploy this backend BEFORE the paired frontend. A new client receiving an old
contract shows a version error, never guesses a result. No migration, new
secret, billing switch or configuration change is required. Do not deploy the
dirty primary backend checkout or include Backyard files.

## Verification and remaining release gaps — 17 October 2026

- Backend: 367 automated tests pass, including schema/provider transport mocks,
  all affected legacy features, input bounds and filtering adversarial outputs.
- Wrangler 4.105.0 dry run compiles. A dry run does not deploy or prove the remote
  model accepts the schema.
- Frontend companion: 365 automated tests pass after integrating the team's
  latest recruitment page/cache release. Real model inference on public
  motorcycle references and the actual camera-crop/red-box renderer are also
  exercised, using static reference photos rather than camera/microphone access.
  Unit tests and these spot checks are not a measured vision accuracy score.
- The previous schema fix is already released. This coverage change needs the
  paired backend/frontend release. A mechanic-labelled held-out evaluation and
  real iOS Safari / Android Chrome camera-call tests remain outstanding. No
  applicant documents are used; no model weights have been trained.

## Real-image evaluation before calling it “trained” or “accurate”

Use owners' expressly permitted engine-bay photos, excluding faces, plates,
VINs and documents. Do not put private photos in the public repositories.
An experienced mechanic should annotate part IDs and visible boundaries; keep
held-out cars/photos separate from prompt development.

Include petrol/diesel/EV/hybrid, varied makes, both steering layouts, wide and
close views, partial occlusion, similar reservoirs, two hoses of one type,
blurry/dark frames, an engine cover hiding parts and non-engine negative images.
Measure class-correct box precision/recall and IoU against human labels; review
wrong reservoir/polarity/HV identifications separately. Record provider/model,
catalogue version, image IDs and evaluation date. Do not infer accuracy from the
model's own certainty, from synthetic diagrams or from passing unit tests.

Iterate visual cues against the development set, then rerun the held-out set.
If accuracy is inadequate, narrow the supported types and abstain more often.
A specialist trained detector would require a legitimately sourced, diverse,
human-labelled dataset and a separate training/validation/serving workflow;
that work has not been performed here.

References: [Gemini image understanding/object detection](https://ai.google.dev/gemini-api/docs/image-understanding),
[structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
