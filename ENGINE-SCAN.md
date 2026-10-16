# Engine-bay identification v2 — 16 October 2026

## What this is (and is not)

This is a versioned, prompt/schema/catalogue upgrade to the existing Gemini
image-analysis pipeline. No model weights have been trained or fine-tuned.
It does not recognise every possible part, reveal hidden parts, diagnose faults,
establish roadworthiness, or guarantee correct identification.

- 47 server-owned component types, Thai/English names, functions and safety text.
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

`src/cover-policy.mjs` owns optional target-specific cover guidance. Valid
`context.targetPart` and bounded `context.viewAttempts` select `leave_on`,
`change_view`, or `manual_required` after accepted visible detections. None
authorises removal. Missing hardware is not proof it sits under this cover.
Forged approval flags and model-produced removal advice are not accepted.
The prompt distinguishes cosmetic cover, sealed/bolted valve cover, airbox,
battery enclosure, service trim, remote jump terminal and visible filler neck.
The ten supplied photo cases in `test/engine-reference-cases.mjs` are provisional
visual-review notes only, NOT expert labels, training or model-evaluation results.
Original photos, private paths, plates and VINs are not included.

## Reference attachments during the existing voice call

The authenticated feature endpoint also accepts `tool:"call_context"`. Images,
small PDFs or `context.referenceText` are untrusted material, not executable
instructions. Up to three attachments and 6,000,000 aggregate base64 characters
are accepted. Audio is not accepted by this task; legacy feature MIME rules
remain unchanged. A bounded JSON summary and uncertainty list use at most 1,200
output tokens and an 18-second total model-attempt budget. The frontend adds
the summary as a user turn into its existing Live socket; raw files never enter
the Live transport. No new provider, public upload URL, file database or raw
request logging is added. Existing authentication, metering, quotas and the
provider's data-handling terms still apply. This is not a privacy/redaction
guarantee for arbitrary file contents; users should avoid sensitive identifiers.

Deploy this backend BEFORE the paired frontend. A new client receiving an old
contract shows a version error, never guesses a result. No migration, new
secret, billing switch or configuration change is required. Do not deploy the
dirty primary backend checkout or include Backyard files.

## Verification and release gap

- Backend: 351 automated tests pass, including schema/provider transport mocks,
  all affected legacy features, input bounds and filtering adversarial outputs.
- Wrangler 4.105.0 dry run compiles. A dry run does not deploy or prove the remote
  model accepts the schema.
- Frontend companion has synthetic DOM/browser tests. Those show UI behavior,
  not vision accuracy. No real camera, microphone, Google request or applicant
  document was used in these tests.
- No production deployment has been performed. Before production release, run a
  live authenticated model/schema smoke test and an annotated real-image
  evaluation, followed by real iOS Safari and Android Chrome call tests.

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
[structured outputs](https://ai.google.dev/gemini-api/docs/structured-output),
[Live conversation turns](https://ai.google.dev/gemini-api/docs/live-api/capabilities),
[PDF processing](https://ai.google.dev/gemini-api/docs/document-processing).
Safety examples informing the conservative policy, not exact procedures for
the supplied vehicles: [Mercedes owner manual](https://www.mbusa.com/content/dam/mb-nafta/us/owners/manuals/2016/operators/MY16_CLS_Operator.pdf),
[Tesla high-voltage precautions](https://www.tesla.com/ownersmanual/model3/en_gb/GUID-8FA15856-1720-440F-838B-ACFBA8D7D608.html).
