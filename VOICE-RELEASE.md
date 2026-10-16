# Shared voice agent tools — 16 October 2026

Based on main 766e1b9. No database/schema/config/billing/secret changes.

Boolean agent:true on /api/ai/live-token opts into four fixed read/prepare functions. Existing tools:true still provides listen_engine and scan_engine_bay; both sets coexist in the constrained ephemeral setup. Old clients remain compatible. Unsupported-model fallback disables both sets and returns agent:false rather than claiming support.

- get_my_car: user-saved name/year/mileage, not verified specifications.
- find_mechanics: real approved, non-test shops through the existing endpoint.
- show_mechanic: previously searched ID only.
- prepare_urgent_request: draft only, never auto-submit, contact, book, dispatch or pay.

The frontend executes the allowlist and returns toolResponse.functionResponses, with cancellation, a bounded result cache, a timeout and session checks. Results are untrusted data, not instructions. No arbitrary execution/URL schema, private contact export or applicant-document processing is introduced.

Preserved: authentication/quota guard, model discovery, resumption handle validation, low speech-start sensitivity, thinking limits, existing engine tools and fallback. Keys stay in backend headers.

Checks: node --test test/*.test.mjs; project-local Wrangler deploy --dry-run (compile only, no upload). Paired frontend release is needed. Real authenticated Gemini calls/physical microphones/cameras still need device smoke testing; tests use fixtures, not production accounts.

GitHub publication is not Cloudflare deployment. Keep existing privacy/release gates for unrelated local work and never upload Backyard or a whole dirty checkout.

References: [Live function calling](https://ai.google.dev/gemini-api/docs/live-api/tools), [session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).
