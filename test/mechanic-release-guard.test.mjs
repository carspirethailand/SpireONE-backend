import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprintRows,compareSnapshots,releaseGuardEnvironment} from '../tools/mechanic-release-guard.mjs';
const snap=rows=>({version:1,database:'bf9b1815-2ef6-4463-8b35-6b97717b5d9a',tables:{profiles:fingerprintRows(rows)}});

test('read-only release queries cannot persist raw D1 JSON through Wrangler debug logs or telemetry',()=>{
  const env=releaseGuardEnvironment({PATH:'fixture-path',CLOUDFLARE_ACCOUNT_ID:'fixture-account',WRANGLER_WRITE_LOGS:'true',WRANGLER_SEND_METRICS:'true',WRANGLER_SEND_ERROR_REPORTS:'true',WRANGLER_LOG_SANITIZE:'false'});
  assert.equal(env.PATH,'fixture-path');assert.equal(env.CLOUDFLARE_ACCOUNT_ID,'fixture-account');
  assert.equal(env.WRANGLER_WRITE_LOGS,'false');assert.equal(env.WRANGLER_SEND_METRICS,'false');assert.equal(env.WRANGLER_SEND_ERROR_REPORTS,'false');assert.equal(env.WRANGLER_LOG_SANITIZE,'true');
});
test('deployment fingerprints expose no profile, UID, phone, email or service contents',()=>{
  const data=fingerprintRows([{id:'private-id',uid:'private-uid',data:'private-name',phone:'0811111111',email:'private@unit.test'}]);
  assert.doesNotMatch(JSON.stringify(data),/private|0811111111|unit\.test/);assert.match(data[0].digest,/^[a-f0-9]{64}$/);
});
test('deployment check stops on missing or changed records but never generates restore commands',()=>{
  const before=snap([{id:'one',data:'original'}]);assert.deepEqual(compareSnapshots(before,snap([{id:'one',data:'original'},{id:'new',data:'new'}])),[]);
  assert.deepEqual(compareSnapshots(before,snap([])),[{table:'profiles',missing:1,changed:0}]);
  assert.deepEqual(compareSnapshots(before,snap([{id:'one',data:'overwritten'}])),[{table:'profiles',missing:0,changed:1}]);
  assert.throws(()=>compareSnapshots(before,{...before,database:'replacement'}));
});
