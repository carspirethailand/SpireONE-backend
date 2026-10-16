/* ย้ายโปรเจกต์ Firebase: รับ token ของโปรเจกต์หลัก + โปรเจกต์เก่าที่ระบุไว้เท่านั้น · โปรเจกต์อื่นหรือ token ปลอมลายเซ็นถูกปฏิเสธ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {verifyFirebaseToken,firebaseProjects} from '../src/auth.js';

test('firebase projects: primary first, legacy list trimmed, bad ids dropped, no duplicates',()=>{
  assert.deepEqual(firebaseProjects({FIREBASE_PROJECT_ID:'cendon-1',FIREBASE_LEGACY_PROJECT_IDS:' sp1p-82396 , cendon-1,BAD ID,'}),['cendon-1','sp1p-82396']);
  assert.deepEqual(firebaseProjects({FIREBASE_PROJECT_ID:'cendon-1'}),['cendon-1']);
  assert.deepEqual(firebaseProjects({}),[]);
});

test('firebase projects: tokens from the new and the legacy project pass; any other project or forged key fails',async t=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256',{modulusLength:2048});
  const forged=await generateKeyPair('RS256',{modulusLength:2048});
  const key={...await exportJWK(publicKey),kid:'unit-only-migration-key',alg:'RS256',use:'sig'};
  t.mock.method(https,'get',()=>{const request=new EventEmitter();request.destroy=()=>{};
    const response=Readable.from([Buffer.from(JSON.stringify({keys:[key]}))]);response.statusCode=200;
    queueMicrotask(()=>request.emit('response',response));return request;});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const sign=(project,k=privateKey,iss=project)=>new SignJWT({email:'a@unit.test',email_verified:true})
    .setProtectedHeader({alg:'RS256',kid:key.kid}).setIssuedAt().setExpirationTime('5m')
    .setIssuer('https://securetoken.google.com/'+iss).setAudience(project).setSubject('same-uid-after-import').sign(k);
  const allowed=['cendon-1','sp1p-82396'];
  assert.equal((await verifyFirebaseToken(await sign('cendon-1'),allowed)).sub,'same-uid-after-import');
  assert.equal((await verifyFirebaseToken(await sign('sp1p-82396'),allowed)).aud,'sp1p-82396');
  await assert.rejects(verifyFirebaseToken(await sign('someone-elses-app'),allowed),/another project/);
  await assert.rejects(verifyFirebaseToken(await sign('cendon-1',forged.privateKey),allowed),'a key Google never published cannot pass');
  await assert.rejects(verifyFirebaseToken(await sign('cendon-1',privateKey,'sp1p-82396'),allowed),'issuer must match the audience project');
  await assert.rejects(verifyFirebaseToken(await sign('sp1p-82396'),['cendon-1']),'after migration the legacy project is refused');
  await assert.rejects(verifyFirebaseToken('not.a.jwt',allowed),/malformed/);
});
