# Driving proximity — prepared, billing gate OFF

The owner explicitly chose **prepare only; do not enable additional charges** on 24 October 2026. `SHOP_GOOGLE_ROUTES_ENABLED` must remain `"0"`. Do not turn it on as a routine deployment or fix without new explicit owner approval.

The existing Google Places search keeps its previous field mask while disabled. A client-supplied opt-in cannot enable routing. Tests use synthetic responses only, not billable Google requests.

Prepared activation path, after a future owner approval:

1. Review current Google pricing, project quota/billing and key permissions. `routingSummaries` raises the Places billing SKU; do not promise the free cap prevents every charge.
2. Explicitly change the server-owned flag. End users must also tick the routing consent box and grant location. No route origin is sent before both consents.
3. A single origin and `DRIVE`/`TRAFFIC_UNAWARE` are requested in the existing Places search. The candidate radius remains 15 km **straight-line**, not a guarantee of 15 km by road. Routing uses the consented current origin rather than rounding it onto a different riverbank. Origins are not persisted, returned or logged.
4. Route summaries are aligned to Places by their documented array index. Missing/malformed/misaligned entries remain unknown. Valid results are sorted by driving duration, then driving distance. Unknown routes follow with explicit straight-line labels. No ETA is inferred by multiplying straight-line distance.
5. A detour badge is an app heuristic (at least 2 km extra and 1.8 times the straight-line distance), not proof of a river or a specific obstruction. Ferry avoidance is a preference, not a guarantee. Times do not include live traffic or the latest road closures.
6. Test allowed real routes on both sides of a river before claiming live routing accuracy. Current fixtures demonstrate plumbing/ranking only.

Sources: [Google routing summaries](https://developers.google.com/maps/documentation/places/web-service/routing-summary), [routing parameters](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/RoutingParameters), [billing SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details).
