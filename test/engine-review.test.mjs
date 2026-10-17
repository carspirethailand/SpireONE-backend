import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureRequest } from '../src/features-ai.mjs';
import { cleanEngineScan } from '../src/engine-bay.mjs';
import { buildEngineReviewRequest, applyEngineReview, ENGINE_REVIEW_SCHEMA } from '../src/engine-review.mjs';

const scene = { scene: 'engine_bay', quality: 'clear', vehicleKind: 'car', powertrain: 'combustion', view: 'compartment' };
const object = (part = 'battery', extra = {}) => ({ part, box_2d: [100, 100, 400, 500], certainty: 'high', visibility: 'visible', identityCue: 'distinct_structure', identityMarking: '', evidence: 'visible case and terminals', ...extra });
const primary = (items = [object()]) => cleanEngineScan({ ...scene, items }, 'en');
const review = (items = [{ ...object(), candidate: 0 }], extra = {}) => ({ ...scene, items, ...extra });
const input = () => buildFeatureRequest({ tool: 'baylive', scanVersion: 2, question: 'PRIVATE_QUESTION battery', context: { car: { make: 'Toyota', model: 'Hilux', vin: 'PRIVATE_VIN' } }, attachments: [{ mime: 'image/jpeg', b64: 'aGVsbG8=' }] });

test('blind request contains original image and only region indices/boxes, no first answer, context or question', () => {
  const scan = primary();
  scan.items[0].evidence = 'PRIVATE_EVIDENCE';
  scan.items[0].name = 'PRIVATE_NAME';
  const before = JSON.stringify(scan), request = buildEngineReviewRequest(input(), scan);
  const contents = JSON.stringify(request.contents);
  assert.equal(request.contents[0].parts.length, 2);
  assert.equal(request.contents[0].parts[1].inlineData.data, 'aGVsbG8=');
  assert.ok(!/PRIVATE_|Hilux|Toyota|certainty|identityCue|"part"/.test(contents));
  const regionText = request.contents[0].parts[0].text;
  assert.deepEqual(JSON.parse(regionText.slice(regionText.indexOf('['))), [{ candidate: 0, box_2d: [100, 100, 400, 500] }]);
  assert.equal(JSON.stringify(scan), before);
  assert.ok(request.system.length < 8000);
  assert.equal(request.search, false);
  assert.ok(!/minItems|maxItems/.test(JSON.stringify(ENGINE_REVIEW_SCHEMA)));
});

test('blind request rejects invalid input or unbounded regions rather than accepting an arbitrary image', () => {
  for (const scan of [null, { scanVersion: 1, items: [] }, { scanVersion: 2, items: Array(25).fill({ box: [0, 0, 100, 100] }) }, { scanVersion: 2, items: [{ box: [0, NaN, 2, 3] }] }]) assert.throws(() => buildEngineReviewRequest(input(), scan));
  for (const media of [[], [{ inlineData: { mimeType: 'audio/webm', data: 'aGVsbG8=' } }], Array(2).fill(input().contents[0].parts[1])]) assert.throws(() => buildEngineReviewRequest({ contents: [{ parts: media }] }, primary()));
});

test('agreement only retains the original safety-owned item and does not leak reviewer text', () => {
  const scan = primary(), before = JSON.stringify(scan);
  const result = applyEngineReview(scan, JSON.stringify(review([{ ...object('battery', { evidence: 'PRIVATE_RAW_AI', identityMarking: 'PRIVATE_MARKING', box_2d: [105, 105, 395, 495] }), candidate: 0 }])), 'en');
  assert.deepEqual(result.items, scan.items);
  assert.equal(JSON.stringify(scan), before);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(result.review, { mode: 'blind_second_pass', status: 'completed', submitted: 1, retained: 1, withheld: 0, independentlyValidated: false });
});

test('blind disagreement with an air-box/fuse-box label withholds, never silently relabels', () => {
  const scan = primary([object('fuse_box')]);
  const result = applyEngineReview(scan, review([{ ...object('air_box'), candidate: 0 }]));
  assert.equal(result.items.length, 0); assert.equal(result.uncertain, 1); assert.equal(result.review.withheld, 1);
});

test('washer-tank versus filler disagreement withholds', () => {
  assert.equal(applyEngineReview(primary([object('washer_tank')]), review([{ ...object('washer_filler'), candidate: 0 }])).items.length, 0);
});

test('duplicate, missing, unrelated and unresolved candidate answers cannot pass', () => {
  for (const items of [[], [{ ...object(), candidate: 1 }], [{ ...object(), candidate: 0 }, { ...object(), candidate: 0 }], [{ ...object('unresolved'), candidate: 0 }], [{ ...object(), candidate: '0' }]]) assert.equal(applyEngineReview(primary(), review(items)).items.length, 0);
});

test('matching label in a different location cannot pass, enlarge or move original box', () => {
  for (const box of [[500, 500, 900, 900], [0, 0, 1000, 1000], [100, 100, 101, 101], [-1, 100, 400, 500]]) assert.equal(applyEngineReview(primary(), review([{ ...object('battery', { box_2d: box }), candidate: 0 }])).items.length, 0);
});

test('low certainty, partial/hidden visibility and unclear identity abstain despite matching name', () => {
  for (const extra of [{ certainty: 'medium' }, { certainty: 'low' }, { visibility: 'partial' }, { visibility: 'hidden' }, { identityCue: 'unclear' }]) assert.equal(applyEngineReview(primary(), review([{ ...object('battery', extra), candidate: 0 }])).items.length, 0);
});

test('reservoir/polarity safeguards run again and cannot be bypassed by second-pass agreement', () => {
  const scan = primary([object('coolant_tank', { identityCue: 'marking', identityMarking: 'COOLANT' })]);
  assert.equal(scan.items[0].part, 'coolant_tank');
  assert.equal(applyEngineReview(scan, review([{ ...object('coolant_tank', { identityCue: 'traced_connection' }), candidate: 0 }])).items.length, 0);
  const positive = primary([object('battery_positive', { identityCue: 'marking', identityMarking: '+' })]);
  assert.equal(applyEngineReview(positive, review([{ ...object('battery_positive'), candidate: 0 }])).items.length, 0);
});

test('scene, quality and known powertrain/vehicle/view conflicts fail closed', () => {
  for (const extra of [{ scene: 'car_other' }, { scene: 'not_car' }, { quality: 'blurred' }, { quality: 'dark' }, { quality: 'blocked' }, { powertrain: 'electric' }, { vehicleKind: 'motorcycle' }, { view: 'exposed_internal' }]) assert.equal(applyEngineReview(primary(), review(undefined, extra)).items.length, 0);
});

test('rejection removes unsupported cover claims and always leaves covers fitted', () => {
  const result = applyEngineReview(primary([object('engine_cover')]), review([]));
  assert.equal(result.coverGuidance.coverVisible, false);
  assert.equal(result.coverGuidance.maySuggestRemoval, false);
  assert.equal(result.coverGuidance.action, 'leave_on');
});

test('malformed/oversized reviewer answers never fail open', () => {
  for (const raw of [null, [], 'not JSON', '{}', 'x'.repeat(64001), review(Array(49).fill({ candidate: 0 })), review([], { scene: 'invented' })]) assert.throws(() => applyEngineReview(primary(), raw));
});

test('empty primary scan remains empty; all review results are model agreement, not certification', () => {
  const result = applyEngineReview(primary([]), review([]));
  assert.deepEqual(result.items, []); assert.equal(result.review.submitted, 0); assert.equal(result.review.independentlyValidated, false);
});
