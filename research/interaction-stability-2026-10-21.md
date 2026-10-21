# Garage validation hardening — 2026-10-21

Paired frontend branch: `codex/interaction-stability-2026-10-21`.

The shared Garage rules now reject non-finite/out-of-range currency, more than
two decimal places, repeated obvious junk and reverse keyboard runs. Unknown
job names no longer inherit an entire vehicle-tier ceiling: they have a bounded
single-entry ceiling of 500,000 THB times the existing vehicle-tier factor,
further limited by an exact documented vehicle reference when available.

This is a validation guard, not a market valuation or mechanical diagnosis.
Historical unchanged entries are preserved. Existing ownership/deletion guards
and confirmed/idempotent log writes remain in place.

Validation: all 500 backend tests passed, including two new hardening tests and
the existing Garage endpoint, authorization, state-sync and log-write tests.
No production data or schema was changed during testing.
