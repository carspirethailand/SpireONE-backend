# Powertrain catalogue v3 — 17 October 2026

This is prompt/schema/catalogue engineering, NOT model training or fine-tuning.
There are 131 bilingual component concepts, 129 released locator IDs and a
24-object cap per frame. More labels do not establish greater accuracy.

## Thai daily-use priorities

The runtime prompt now explicitly covers these examples without treating a
model name, logo, saved garage car or normal component location as evidence:

| Group | Examples to cover | Important negative case |
| --- | --- | --- |
| Underbone | Wave 110i/125i, Dream, Super Cub, Yamaha Finn | A chain guard is not a visible chain; not every Wave variant uses the same transmission |
| Small scooter | Scoopy / Scoopy i, Click, Fino, Fazzio, Grand Filano | Closed CVT and fairings do not reveal belts, variators or clutch shoes |
| Larger scooter | PCX, ADV, Forza, Aerox, NMAX | Model/year/cooling system cannot be established from body shape alone |
| Modern / classic Vespa | Primavera, Sprint, GTS versus PX | Do not assign CVT to every Vespa; body covers can conceal the entire powertrain |
| Geared motorcycle | MSX, CB/CBR, R15/MT, Kawasaki families | Hidden sprockets, clutch plates and spark plugs must not receive boxes |
| Electric / assist | Electric scooters; Fazzio/Grand Filano badging | A Hybrid badge does not establish high voltage, battery chemistry or an exposed battery |

These are coverage targets, not a claim that every listed model/year has been
tested. Owner manuals are used for distinctions, not as image-training assets:

- [Honda Thailand Wave 110i 2021 manual](https://2rom-prd-data.hondamotopub.com/om/THM/WAVE110i/2021/OM-WAVE110I-K2JC000-APH.pdf)
- [Honda Thailand Scoopy 2021 manual](https://2rom-prd-data.hondamotopub.com/om/THM/SCOOPY/2021/OM-SCOOPY-K2FB020-TH.pdf)
- [Honda Click 125 2023 manual (Cambodia; not proof of a Thai variant)](https://2rom-prd-data.hondamotopub.com/om/NCXCAE/CLICK125/2023/23CLICK125_4PK2VD00_EN.pdf)
- [Yamaha Thailand owner manuals](https://www.yamaha-motor.co.th/dealer-services/owners-manual?cate=automatic)
- [Vespa official 2022 range brochure](https://www.vespa.com/wlassets/vespa/master/brochure/EICMA/EN-DIGITAL-Vespa-Range-11-2022/original/EN-DIGITAL-Vespa%2BRange-11-2022.pdf)

## Real-inference development spot checks

Real existing Gemini Flash Lite inference via authenticated Wrangler remote
development; no production DB writes, billing changes, new provider or model
weights. Reference images are private ignored QA inputs, not repository assets.
No raw model text, image/base64 or personal identifiers are stored in app logs.

| Reference | Observation | Limitation / action |
| --- | --- | --- |
| User Audi engine photo | Returned battery cover and washer filler, rather than an unseen battery/tank | Development input, not held-out ground truth |
| Carbureted motorcycle close-up | Carburetor, plug cap and head returned | Some cable/box boundaries still need expert review |
| Already-open scooter CVT | Actual renderer shows belt, variator and clutch bell as separate red boxes | Cover was already absent; never ask owners to remove it |
| Already-open horizontal single | Earlier run overclaimed crankshaft from a shaft end | Tightened required visual cues; next run omitted crankshaft |
| Wave 125 S 2007 | Carburetor, cooling fins, plug cap and external castings returned | First request timed out; a later response confused footrest/brake/starting controls. Kick-start and gear-shift IDs are excluded from provider enum AND rejected server-side pending independent validation |
| Scoopy 110 2010, closed | Only visible CVT enclosure returned, not belt/clutch internals | One static view, not all Thai Scoopy generations |
| Vespa Primavera 125, closed | Visible CVT enclosure, no hidden transmission parts | One static view; not coverage of classic PX |
| Super Soco covered side | Service panel/motor enclosure/shock returned; no hidden battery | Electrical identity and boundaries still need expert review |
| BMW boxer top view | Two visible finned cylinder areas returned | Rotated low-resolution reference, not a precision benchmark |

Observed successful calls were roughly 2.6–4.8 seconds, plus one 18-second
timeout. These are a few local development observations, not a latency SLA.
Provider quotas and timeouts remain possible. No accuracy percentage is claimed.

## Rights / provenance of public QA references

Originals are not committed. Follow the linked license before redistributing
images or annotated derivatives. Sources are uploader metadata, not vehicle
equipment certification. UI proof can use the public-domain CVT reference.

| Reference source | Creator | License |
| --- | --- | --- |
| [Bike engine 01](https://commons.wikimedia.org/wiki/File:Bike_engine_01.jpg) | See original attribution before redistribution | CC BY-SA 3.0 |
| [Horizontal single](https://commons.wikimedia.org/wiki/File:Engine_of_HERO_HONDA_DOWN_97cm%5E2_CC.jpg) | Katerc.1778 | CC BY-SA 4.0 |
| [Open scooter CVT](https://commons.wikimedia.org/wiki/File:Skutr_variator.jpg) | Hpridal | Public domain |
| [BMW boxer](https://commons.wikimedia.org/wiki/File:R75-boxer.jpg) | Jeff Dean | CC BY-SA 2.5 |
| [Super Soco cover](https://commons.wikimedia.org/wiki/File:Super_Soco_TS1200R_engine_and_cover.jpg) | Bengt Nyman | CC BY-SA 2.0 |
| [Wave 125 S engine](https://commons.wikimedia.org/wiki/File:Honda_Wave_125_S_2007_Engine.jpg) | Khaosaming | CC BY-SA 3.0 |
| [Scoopy 110](https://commons.wikimedia.org/wiki/File:2010_Honda_Scoopy_110_(20201109).jpg) | オーバードライブ83 | CC BY-SA 4.0 |
| [Vespa Prima 125b](https://commons.wikimedia.org/wiki/File:Vespa_Prima_125b.jpg) | Adrian Michael | Public domain |

## Before making accuracy or training claims

Get diverse rights-cleared owner images in Thailand, actual model/year/market,
and independent mechanic annotations of visible identities and boxes. Keep
all frames from one physical vehicle in one split. Development references
above must not become the held-out test set. Include closed covers, partial
occlusion, night/blur, scooters with hidden engines, EVs, unrelated objects and
different views on both phone orientations. Do not require disassembly.

Measure class-correct box precision/recall and IoU against human annotations;
separately review wrong polarity, fluid reservoir, HV and foot-control labels.
Re-run repeated inference for nondeterminism and record abstentions/timeouts.
Open a withheld locator type only after independent review. Real-device camera
tracking and voice-call tests on iOS/Android remain outstanding.
