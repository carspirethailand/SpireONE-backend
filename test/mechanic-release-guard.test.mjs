import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprintRows,compareSnapshots} from '../tools/mechanic-release-guard.mjs';
const snap=rows=>({version:1,database:'bf9b1815-2ef6-4463-8b35-6b97717b5d9a',tables:{profiles:fingerprintRows(rows)}});
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
