# Official shop search — release 2026-10-23

The adapters are implemented and tested against synthetic protocol responses.
No provider credentials were configured in production at release preparation.
Do not describe these tests as approval by, or a live connection to, any platform.
There is no scraper, AI-generated stock, invented price, or paid-service activation.

## Required server secrets

| Provider | Secrets | Access needed |
| --- | --- | --- |
| Shopee Thailand | `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` | Approved Affiliate Open API account; confirm its current GraphQL schema in the approved portal before activation |
| Amazon | `AMAZON_CREATOR_ID`, `AMAZON_CREATOR_SECRET`, `AMAZON_PARTNER_TAG` | Approved Associates / Creators API credentials, not old PA API AWS keys |
| AliExpress | `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_TRACKING_ID` | Approved Affiliate API / TOP application |
| eBay | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | Production Buy Browse access |
| Google Maps | `GOOGLE_MAPS_API_KEY` | Places API (New), restricted to Places, plus separate operator authorization for any billing |

Install secrets only through Cloudflare's secret settings or an interactive local CLI.
Never paste them in chat, frontend source, query strings, screenshots or Git.
`AMAZON_CREATOR_REGION` can be `NA` (default), `EU` or `FE`.
`AMAZON_MARKETPLACE` defaults to `www.amazon.com` and must match the approved tag/region.

Google Maps remains disabled unless `SHOP_GOOGLE_MAPS_ENABLED=1` is explicitly set.
Do not set it merely because a key exists. Before activation, approve costs, update
the public Terms / Privacy with Google's required terms and provider disclosure,
and finish attribution review against the official Places policy. No Places data
is persisted by this search feature. Device coordinates are sent only after the
user presses the location button; plain text area search does not need GPS.

## Activation checklist

1. Obtain approved production access without enabling paid services automatically.
2. Verify one harmless public parts query per provider with the real account.
3. Confirm product destination, numeric price, native currency, source attribution,
   affiliate disclosure where required, and current regional API schema/terms.
4. Verify an empty result and upstream outage; failures must say unavailable,
   not pretend zero inventory. Validate redirects and malicious URLs are rejected.
5. Enable only the validated provider. Search status currently means credentials
   are present, not that the vendor has approved the application or passed testing.

Anonymous calls are rejected. Searches are private/no-store and bounded per user
to 15 units/minute (Maps costs 3 units). Provider credentials stay server-side;
provider errors are reduced to an unavailable state. Search links shown while an
API is unconfigured open the platform itself and are explicitly not API results.
Product fit is never marked confirmed based only on a text match.

Official references: [Shopee](https://affiliate.shopee.co.th/open_api),
[Amazon Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/get-started/using-curl),
[AliExpress](https://developer.alibaba.com/docs/api.htm?apiId=45803),
[eBay Browse](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search),
[Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies).
