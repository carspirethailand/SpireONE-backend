import {test} from 'node:test';
import assert from 'node:assert/strict';
import {engineScanFailure} from '../src/engine-scan-errors.mjs';
test('scanner maps transient provider capacity separately from user daily quota',()=>{
  assert.deepEqual(engineScanFailure(Error('AI quota exhausted')),{error:'scan_provider_busy',status:503,retryAfter:30});
  for(const name of ['TimeoutError','AbortError'])assert.deepEqual(engineScanFailure({name}),{error:'scan_timeout',status:504});
  assert.deepEqual(engineScanFailure(Error('AI is not configured')),{error:'scan_not_configured',status:503});
});
test('provider details and image contents never enter error projection',()=>{
  for(const message of ['AI upstream error 400: private provider response','data:image/jpeg;base64,private','AIza-unit-test-only']){
    const d=engineScanFailure(Error(message));assert.deepEqual(d,{error:'scan_upstream',status:502});assert.ok(!JSON.stringify(d).includes(message));
  }
});
