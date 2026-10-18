# Vehicle evidence release — 2026-10-18

This release adds 11 narrowly scoped manufacturer-document summaries to the existing typed-chat, call web-search and dedicated sound-analysis paths. Sources and applicability are in `src/vehicle-issues.mjs`.

This is factual retrieval (RAG), **not acoustic model training**. No audio file was downloaded, no training job ran, no weights were updated, and no real-world sound accuracy was measured. The separate corpus admission register records the primary/secondary evidence and blockers; all candidates remain unadmitted.

## Behaviour

- Dedicated audio uses only the vehicle explicitly confirmed for that recording. A Garage selection or a previous assistant guess cannot select an issue record.
- Exact model and model-year matching is conservative. Engine-family documents require a matching engine. Explicit conflicting markets, engines, kinds and years exclude records.
- Missing optional engine or market information does not block audio observations. Any remaining document candidate is marked `scope_check_required`, not applicable or diagnosed.
- All initial documents are from US-market manufacturer communications. They do not prove Thai-market applicability, recall eligibility or current warranty coverage.
- A documented condition is not evidence that a defect is common, that the user's vehicle has it, or that a short recording matches a reference sound. Motorcycle recalls lacking acoustic evidence are explicitly marked `soundEvidence=false`.
- Curated evidence is separately dated and survives live-search failures. It is never labelled as a live page read. The UI separates curated links from live/unread results.
- No recordings, transcripts, VINs, plates or other applicants' data are retained in the corpus. No new provider, billing, secret or database migration is introduced.

## Remaining limits

There is still no admitted, licensed workshop-confirmed training corpus for exact-model sound recognition or fault classification. In particular, this release does not claim validated diagnosis for the user's Wave 110i 2023 or Fortuner 2013 3.0 D-4D. No complete all-model coverage is claimed. Absence of a record does not imply the model has no faults.

Unit, route, browser and deployment checks test software behaviour only; they are not clinical/mechanical diagnostic accuracy benchmarks.
