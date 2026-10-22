# Display-only reference rates — 2026-10-22

`GET /api/display-rates` supplies a fixed, whitelisted set of public THB reference rates from Frankfurter v2. It runs before database/schema work and performs no account writes. It does not forward the client's token, headers, identity, IP or amounts to the upstream service. No API key, paid service, mail configuration or personal-data provider was added.

The upstream request has an 8-second deadline, no redirects, a 32 KiB response limit and a maximum of 18 rows. Base, quote, rate and date are validated. Errors return a generic 503 with `no-store`; successful public data can be cached for one hour. Rates up to seven days old permit weekends/holidays; the frontend labels foreign-currency values approximate and displays the reference date in Settings. These are not transaction or payment rates.

Production validation caught a Workers-specific incompatibility that Node's Fetch accepts: `redirect:error`. The implementation uses Workers-supported `manual` and rejects all non-2xx responses, including redirects. A fixed error-phase code is safe to expose without raw provider errors. Regression tests cover redirect rejection. Runtime reference: https://developers.cloudflare.com/workers/runtime-apis/request/#parameters .

Primary documentation: https://frankfurter.dev/ . Read-only upstream and public deployment checks do not submit user amounts or personal data.

This release also tests that repeated mechanic status/schema checks preserve shop ID, UID and moderation flags, that suspended/trial owners retain their own shop, and that another UID cannot inherit it. It does not change public listing filters, unsuspend shops, or approve applications.

Production email OTP remains unconfigured (`emailOtpReady:false`); no numeric OTP delivery has been represented as working. The existing mail paths require secure configuration outside chat before activation.
