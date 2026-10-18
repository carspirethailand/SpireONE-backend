# Vehicle evidence, mileage integrity and Wrapped — 18 October 2026

This release extends the feedback-stability release. It does not certify every vehicle model/year or replace native background location.

## Delivered
- Separate, shared model/year/market deep-spec cache; base specs stay usable when deep lookup fails.
- Extra document-backed engine, suspension, brakes, tyres, power-unit, performance and dimensional fields. Exact quotations and source scope remain required; PS/kW are not relabelled hp.
- Readable publisher discovery can continue during an encyclopedia outage. Robots rules, allowlisted HTTPS sources and access barriers remain enforced.
- Exact model-year primary Thai original list prices can inform a labelled cost ceiling when present. Original price is not a current used-market valuation. Reviewed references take priority; missing evidence retains explicitly preliminary checks, including per-service caps.
- Foreground GPS estimates require an explicitly selected car and account. Hidden pages/gaps pause sampling; no guessed bridge distance, automatic traffic-light parking or GPS-to-odometer overwrite.
- Per-car/account aggregate-only local drafts (12-hour retention check), explicit resume, protected late callbacks.
- Actual odometer validation: strict integers/dates, chronological history, explicit unusual-jump confirmation, atomic contradiction guard and canonical mileage protection against stale car/color sync.
- Failed readings remain account-bound and editable in Mileage; no silent reassignment to another account or discard on 4xx.
- Wrapped removes perpetual particles/counters/entry effects, isolates the active slide and ignores responses belonging to a closed session. Close restores focus and theme.
- Asset versions and service-worker cache updated.

## Verification and limits
- Frontend regression suite: 428 tests. Backend regression suite: 421 tests.
- Isolated headless Edge QA at 1280px and 390px: Wrapped open/close/reopen and delayed-response race; form save/failure retention; stable chat nodes and no horizontal overflow.
- Worker packaging dry run passed. Tests use synthetic documents, fake model responses and local data; they do not measure manufacturer-source coverage or real AI accuracy for every car.
- Physical Android verification is still needed: open Wrapped repeatedly, change pages, edit a car color then refresh, start a foreground drive, hide/restore, explicitly resume and check that missing distance is marked incomplete.
- Native screen-off tracking is deferred by the user until wrapping the web app. The web does not authenticate driver identity, infer the selected vehicle, or promise continuous background GPS.
- No new paid service, model billing, hardware/OBD integration, real mechanic message or production test-data write was introduced.
- Current Worker traces setting remains disabled; this scoped release does not broaden collection of private request content.

## Deploy order
Publish backend first, then frontend. No new schema migration or secret is required. Keep existing production variables.

