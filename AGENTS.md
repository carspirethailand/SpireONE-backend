# Mechanic data must survive deployments

- A UI/Worker release is not permission to delete, recreate or reset mechanic accounts, applications, profiles, shops, services, pictures or moderation decisions.
- Preserve the existing `spireone` D1 binding and database ID. A replacement database or ownership migration requires explicit user authorization and a reviewed data-migration plan; never provision an empty replacement just to make deployment pass.
- Schema initialization must be idempotent and additive. Preserve stable shop/service IDs and existing unknown profile fields. Avoid `INSERT OR REPLACE` or blanket deletes for profile initialization. Sparse edits must not overwrite omitted fields with defaults.
- `/api/tech/me` and authenticated owner inventory must not inherit public-directory visibility filters. Suspension/trial status must not erase membership or hide quota-counted services from their owner. Do not unsuspend, verify or publish shops as part of data restoration.
- Never free a quota by deleting old services automatically. Require the owner's explicit edit/delete action. Keep national-ID/selfie/certificate data out of public-image and shop-preview routes.
- Before a production release, run the existing backend suite, especially mechanic-persistence and release-guard tests, and a package dry run. Use `tools/mechanic-release-guard.mjs capture` immediately before deployment and `check` after deployment. Snapshots belong under ignored `.qa/mechanic-release/`; they contain only hashes and a Time Travel bookmark, never raw user records.
- The release guard is read-only and must never restore automatically. A mismatch may be a legitimate live edit: stop and inspect. A full Time Travel restore overwrites the database and requires separate explicit authorization.
- Preserve existing Worker variables/secrets when deploying. Keep raw database records, documents, tokens and personal data out of command output, logs, GitHub and public deploy artifacts.
