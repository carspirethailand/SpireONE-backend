# Five-make engine recognition: experimental v4 — 17 October 2026

## Release decision: DRAFT, not production

No model weights have been trained or fine-tuned. All 82 existing Cendon model
choices for Mitsubishi, Toyota, Isuzu, Ford and Honda are now inventoried and
receive bounded manufacturer-reference cautions where an exact model matches.
This is NOT 82 validated models, all worldwide models, all generations, or all
engine variants. No engine code, year-specific layout, fuel specification or
component location is assigned from a model name.

Real development inference still exposed naming errors. Keep this version as a
draft until qualified review and a held-out image set support a release decision.
The previously released v3 stays on production; this document does not deploy v4.

## Concrete implementation

- Reference inventory: `src/engine-references.mjs`, 82 exact make/model targets
  plus make-scoped aliases. Every record remains `target_not_validated`,
  `generationVerified:false`, `layoutVerified:false`.
- The vision request receives only the relevant short caution block, not all 82
  names. System text stays below the actual 8,000-character limit in both
  languages. With the default configuration there is no added web/model call,
  provider, secret or billing change. An explicitly enabled experimental review
  mode adds a second image observation as described below.
- Catalogue v4: 136 concepts / 134 released-in-experiment locator IDs. New concepts
  are fuel water separator, fuel primer, AC condenser, brake master cylinder and
  explicitly unidentified fluid reservoir. Existing vacuum pump/intercooler
  concepts are reused, not double-counted.
- `identityCue` and `identityMarking` are model observations, NOT independent
  proof. Polarity/jump labels require a literal marking from a narrow allowlist.
  Reservoir subtypes without a legible system-specific name become
  `reservoir_unknown`. MIN/MAX, DOT grade, colour and claimed plumbing alone do
  not establish the fluid. No generated repair instructions are emitted.
- Pure electric observations cannot gain invented combustion components.
  Motorcycle, already-exposed internal, hidden-part and no-disassembly guards
  remain. Medium/low/unclear or geometrically invalid items do not get boxes.
- Auth, quotas, role checks, image-size limits, 18-second provider-attempt budget
  and 3,600 output-token cap per observation are retained. No original photo, raw AI text,
  marking or base64 is added to app persistence/logs by this change.

## Automatic blind second-pass experiment (not enabled in production)

The app can identify parts automatically; a mechanic is needed to establish a
development/held-out reference set, NOT approve every customer scan. Model
self-review cannot establish independent correctness or replace that benchmark.

`src/engine-review.mjs` is connected to the authenticated scan route, but only
the exact server environment value `ENGINE_SCAN_BLIND_REVIEW=1` enables it.
The repository's deployment configuration deliberately does NOT set this flag.
Client request flags cannot enable or bypass it. Do not enable for production
until recall, precision, latency and quota impact have been independently reviewed.

When enabled, the first observation gets up to 10 seconds. One batch second
observation receives the SAME image plus numbered boxes only: no first-pass
names, confidence, evidence, garage context, user question or previous chat.
It independently names each visible object or abstains. The server only retains
an original item if the class agrees, the reviewer reports clear visibility and
high certainty, all existing safety checks pass again, and whole-image box IoU
is at least 0.65. Duplicate/missing candidate indices, scene conflicts, uncertain
identities and mismatches withhold the box. It never promotes/relabels/moves a
box or emits reviewer prose, markings or diagnoses to the app.

Both observations/fallback attempts share the original 18-second total provider
budget. Both token totals are charged through the existing meter, including
completed inference on review failure. No extra per-image provider or paid model
was introduced. Existing provider fallbacks stay within their shared budget.
On timeout, quota failure or malformed review there is NO fallback to the first
unreviewed boxes. The route returns the existing safe scan error plus
`stage:review`. An empty first answer needs no second call and reports
`status:not_required`, not a fabricated completed review. The extra model call
still uses quota and normally increases latency; this is not a speed improvement.

Three real development photos were rerun end-to-end on 17 October 2026:

| Development image | First-pass boxes | Retained after blind agreement | End-to-end time |
| --- | ---: | ---: | ---: |
| Corolla Cross hybrid | 8 | 6 | 6.097 s |
| CR-V hybrid | 5 | 4 | 4.834 s |
| Honda R20A-labelled user photo | 11 | 6 | 6.818 s |

In that Corolla run the previously observed air-box/fuse-box confusion was
withheld. This is a useful rejection observation, NOT an accuracy score: some
plausible correct Honda parts (including alternator) were also withheld. The
CR-V first pass already chose washer_filler in this rerun, so this does NOT prove
the reviewer fixes the earlier washer-tank error. Independent mechanic labels:
still zero. The same model can agree with itself on a wrong identity. Therefore
this feature stays experimental and disabled; no production update was made.

## All app inventory targets (not a validation checklist marked complete)

Snapshot: frontend 0ff7aed6d5427b83acc3222e0c9025df8d49188e; app.js blob f391933aa1195ce818a387393a5eebbdca5b03c1.
Dates/body styles in the app catalogue are not treated as verified engine data.
A new model or generation requires a new reviewed inventory/evaluation entry.

| Make | Target choices | Independently validated models |
| --- | ---: | ---: |
| Mitsubishi | 12 | 0 |
| Toyota | 35 | 0 |
| Isuzu | 5 | 0 |
| Ford | 11 | 0 |
| Honda | 19 | 0 |
| Total | 82 | 0 |

### Mitsubishi

Mirage, Attrage, Lancer, Lancer EX, Triton, Pajero Sport, Outlander, Outlander PHEV, Xpander, Xpander Cross, Xforce, Space Wagon.

### Toyota

Corolla, Corolla Altis, Corolla Cross, Camry, Vios, Yaris, Yaris Ativ, Yaris Cross, C-HR, Fortuner, Hilux, Hilux Revo, Hilux Champ, Innova, Innova Zenix, Veloz, Avanza, Sienta, Alphard, Vellfire, Majesty, Commuter, Granvia, Supra, GR86, GR Yaris, Prius, bZ4X, Land Cruiser, Land Cruiser Prado, Rush, Raize, Crown, Wish, 86.

### Isuzu

D-Max, D-Max V-Cross, D-Max Spark, MU-X, MU-7.

### Ford

Ranger, Ranger Raptor, Everest, Mustang, Mustang Mach-E, Focus, Fiesta, EcoSport, Territory, Escape, Explorer.

### Honda

City, City Hatchback, Civic, Civic Type R, Accord, Jazz, Fit, HR-V, CR-V, BR-V, WR-V, e:N1, Mobilio, Freed, Odyssey, StepWGN, Brio, Elysion, Stream.

## Real image development checks, not a measured accuracy score

Seven physical reference images; eight final calls including one deliberately
wrong garage selection. All eight final provider calls returned HTTP 200, about
2.9–4.0 seconds in this small run. This is not an SLA. Photos cover combustion
and hybrid layouts, not every engine/generation.

| Reference | Development observation | Unresolved / conservative action |
| --- | --- | --- |
| User Triton-labelled photo | Cover, battery, filter housing and unknown reservoir | Generation/engine not independently established; plate area cropped out before inference |
| User Toyota photo | Cover, intake housing, battery, fuse box, washer filler and unknown reservoir | Actual model not established; garage Hilux context is not ground truth |
| User Isuzu photo | Cover, battery, air box, ducts and radiator-area observations | Year/engine and boundaries need mechanic review |
| User Mustang-labelled photo | Cover, intake, fuse box, strut mounts, fluid containers | Unverified fluid subtypes become unknown containers |
| User Honda R20A-labelled photo | Battery, intake, valve-cover area, alternator and other external objects | Earlier run mislabelled brake reservoir as coolant despite a claimed traced connection; new guard omits/downgrades unsupported reservoir types |
| Public Corolla Cross hybrid | Hybrid metadata and visible external objects | One run labelled the air-box area as a fuse box; this remains an unresolved visual error, not a passed accuracy case |
| Public CR-V hybrid | Hybrid metadata and visible external objects | One run labelled the washer filler cap as the tank; this remains unresolved |
| Honda photo + garage bZ4X | Image still classified combustion rather than inventing an EV layout | Same Honda image, not an additional independent vehicle |

The source filenames/captions and selected garage model are not independently
verified make/year/engine labels. These images are development inputs and must
not be reused as the held-out accuracy set. Model self-confidence is not truth.

## Offline evaluator and next data requirement

`tools/engine-eval.mjs` is a complete offline evaluator, not a trainer. Run:

```sh
node tools/engine-eval.mjs /absolute/path/to/reviewed-manifest.json
```

Manifest version 1 contains `cases`. Each case needs a bounded slug `id`,
pseudonymous `vehicleGroup`, `split:development|holdout`, `vehicle:{make,model}`,
`review:{status:approved,role:mechanic}`, visible `labels:[{part,box}]` and
`prediction:{status:ok,items:[{part,box}]}`. Failed predictions use a non-ok status.
Coordinates are [ymin,xmin,ymax,xmax] over 0–1000. No photo/base64, plate, VIN or
personal reviewer name is needed in the manifest.

Only mechanic-reviewed hold-out cases contribute metrics. A physical vehicle
present in development is excluded from hold-out. One-to-one class-correct IoU
matching counts duplicate/wrong-class boxes, failed requests and missing parts;
wrong fluids/polarity/HV identities are separately flagged. Unreviewed or empty
sets return null accuracy metrics, never 100%. Review flags are caller-supplied,
not authenticated certification. The evaluator always requires a human release
decision; representing a model does not validate every variant.

Before claiming all variants: obtain rights-cleared Thai-market images across
model years/engines, stock and modified intake/LPG configurations, left/right
steering, wide/close/occluded views, dark/blurred negatives, hybrids/EVs and covers.
A qualified mechanic must approve visible identities and boxes; keep each
physical vehicle entirely within one split. Actual weight training then needs a
separate model/dataset/compute/serving decision. None has been purchased or run.

## Verification

- Backend full suite: 405 tests after blind-review integration (see current run).
- Frontend existing scanner suite: 14 tests pass; no frontend modification needed.
- All 134 locator IDs pass the actual backend-cleaner to existing client-reader
  transport check using synthetic data. This is NOT 134 vision-accuracy tests.
- Wrangler dry run compiles. Real inference accepts the expanded portable schema.
- Blind-review tests cover label/context isolation, disagreement, duplicate/missing
  answers, geometry/scene conflicts, repeated fluid/polarity safeguards, failed
  review, exact server-only gating, shared deadline and combined token metering.
- Independent mechanic-approved held-out cases: zero. Real mobile camera tests
  and comprehensive image accuracy evaluation remain outstanding.

## Source limits and image rights

Manufacturer references are deliberately scoped in `ENGINE_REFERENCE_SOURCES`.
A manual for one edition/market is not a location map for all 82 targets.

- [Mitsubishi Thailand manual index](https://www.mitsubishi-motors.co.th/en/after-sales/promotion-and-other-services/owner-manual)
- [Mitsubishi 2020 UK Outlander PHEV manual](https://mitsubishi-motors.co.uk/wp-content/uploads/2021/06/20MY-Outlander-PHEV-Owners-Manual.pdf)
- [Toyota 2025 US Camry hybrid compartment](https://www.toyota.com/owners/warranty-owners-manuals/digital/article/camry-hv/2025/om06266u/ch06se030404/)
- [Toyota 2026 US bZ compartment](https://www.toyota.com/owners/warranty-owners-manuals/digital/article/bz/2026/om42j21u/ch07se030404/)
- [Isuzu Thailand edition-specific manuals](https://www.isuzu-tis.com/service/owners-manual)
- [Ford 2018 ASEAN Ranger manual](https://www.fordservicecontent.com/Ford_Content/Catalog/owner_information/P375_Ranger_English_2018_TKD_OM_ASEAN_JB3B19A321CKA.v1.pdf)
- [Honda Thailand catalogue](https://www.honda.co.th/en/cataloghub)
- [Honda 2025 US Civic hybrid HV coolant](https://techinfo.honda.com/rjanisis/pubs/OM/AH/AT542525IOM/enu/details/131266047-386530.html)

Original photos and private derived crops/results are not committed. Public
hybrid image originals are cached privately, not redistributed in this repo:

- [Corolla Cross hybrid](https://commons.wikimedia.org/wiki/File:2020_Toyota_Corolla_Cross_-_Engine_2.jpg), Areaseven, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- [CR-V hybrid](https://commons.wikimedia.org/wiki/File:Honda_CR-V_Hybrid_IMG_20200403_144431.jpg), Alexander Migl, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Respect attribution/share-alike requirements before redistributing image
derivatives. No manufacturer diagrams were republished as training images.

