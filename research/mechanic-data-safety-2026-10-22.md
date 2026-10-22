# Mechanic persistence and hidden services

## Confirmed root cause

Read-only production inspection of the reported shop found two active package services, both correctly linked to its existing shop ID. Its trial/suspension flags hid the shop from the public directory. The owner-inventory query accidentally reused the public `suspended=0` shop filter, so it returned no services even though the independent quota counted both records. No service recovery, deletion, ownership rewrite or unsuspension was needed.

## Repair

- Authenticated `gigs?mine=1` is scoped to the verified token's UID and returns the owner's active inventory even for a suspended/trial shop. It supplies quota and visibility separately, never reviewer details or another account's services. Unlinked legacy rows remain visible to their owner rather than silently disappearing.
- Public listings retain all moderation filters. Saving a service does not approve a shop. A full quota returns 409/SERVICE_LIMIT rather than a malformed-form 400.
- Hidden shop/work/service images can be fetched with a bearer token and `owner=1` only by their owner. Responses are private/no-store. ID/selfie/certificate kinds are excluded, and no token goes into a URL.
- Production checks also caught an 18.5-second cold image request caused by schema initialization. Existing image reads now skip migrations; cold initialization batches idempotent creates and checks column metadata rather than replaying duplicate ALTER errors. Missing-column migrations retain their original order and are covered by older-schema and unchanged-row tests.
- Frontend owner inventory is independent of the public feed, scoped to the live UID/shop, and reset on account changes. Failed or malformed responses cannot become a fake empty inventory. Original service IDs and photos survive edits and reloads.

## Release protection

The persistence regression simulates two freshly imported Worker modules (cold schema setup) against existing applications, a non-derived legacy shop ID, unknown profile fields, photos and services. It verifies that no initialization resets them, and checks that the deployment still binds the existing production D1 database.

The read-only release guard captures hashes of current profiles/services/applications/public-photo metadata and a D1 Time Travel bookmark. It prints no names, phone numbers, UIDs, documents or image data. After deployment, it stops on missing or changed pre-existing rows. Legitimate live edits can also trigger a stop and must be inspected, never overwritten automatically.

Run the installed Wrangler through:

```
node tools/mechanic-release-guard.mjs capture .qa/mechanic-release/RELEASE.json --wrangler PATH_TO_INSTALLED_WRANGLER_JS
node tools/mechanic-release-guard.mjs check .qa/mechanic-release/RELEASE.json --wrangler PATH_TO_INSTALLED_WRANGLER_JS
```

The `.qa` file is not a raw database backup and must not be published. D1 Time Travel is already enabled by Cloudflare; retention depends on the plan (7 days free, 30 days paid). Restoring the whole database is destructive and is not performed by this tool or this repair. No paid service was enabled.

References: https://developers.cloudflare.com/d1/reference/time-travel/ and https://developers.cloudflare.com/d1/wrangler-commands/ . These safeguards reduce release regressions; they are not an absolute guarantee against all future application mistakes or explicitly requested account deletion.
