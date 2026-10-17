# Garage validation and feedback release

- No schema migration, new provider, paid service or automatic customer write is introduced.
- Private routes require the current user and check car ownership, including deletion markers. A foreign car in a forged local garage list cannot authorize a write.
- New log appends use a request ID and compare-and-swap. Concurrent appends preserve each other; repeating the same request ID is idempotent. An uncertain response followed by a new request ID is not guaranteed exactly-once.
- Changed log, maintenance, symptom, trip and calendar-price fields are validated server-side. Unchanged historical values are preserved. Readability checks reject obvious keyboard mashing, not all possible nonsense or fraud.
- `GET /api/garage/context?car=ID` reads the saved sourced specification library; it does not start a new paid/model lookup. Unknown facts remain unknown.
- `POST /api/garage/log` takes `carId`, `kind` (`services`, `fuel`, `trips`), `entry`, and `requestId`. `baseLog` imports a valid local-only log when no remote log exists. The response contains the acknowledged `entry` and merged `log`.

## Model-year cost limits

Default `basis=heuristic` means a preliminary tier/service sanity cap, **not a sourced valuation or an exact repair quote**. No complete model-year price database is supplied in this release.

An authenticated admin can submit `garageCostReferences` to the existing `POST /api/admin/config`. This replaces the reference list and records an audit event. Each reviewed record requires `make`, `model`, `year`, `valueThb`, `asOf` (YYYY-MM-DD), `source` (HTTPS), and optional `maxByJob`. Jobs use the existing maintenance keys. Duplicate model-years, invalid dates/amounts, and unknown jobs are rejected. Limits are not automatically populated by AI. Only a unique exact make/model/year match less than two years old is applied; otherwise the result remains explicitly heuristic. The source is recorded for review and is not fetched by this endpoint.

## Notifications and mileage

The existing 18:00 Bangkok reminder remains opt-in. It sends both LINE and device push when each channel is configured and enabled, with a daily atomic reservation preventing concurrent cron duplicates. Failed delivery is not repeatedly retried that day. Users already supplying a reading that day are skipped. This does not grant browser notification permission or bypass LINE opt-in.

Phone GPS is an estimate and cannot prove which car or driver is present. Tracking is bound to the explicitly selected car and signed-in owner. GPS trip distance is never silently added to a confirmed dashboard odometer. Background tracking/calls depend on browser/OS lifecycle; native or vehicle hardware integration would be a separate project.
