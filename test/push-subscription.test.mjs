import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import {pushSubscription} from '../src/push-subscription.mjs';
const key=createECDH('prime256v1');key.generateKeys();const keys={p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};
test('only HTTPS browser push services and valid P-256/auth material can become fetch destinations',async()=>{
  for(const endpoint of ['https://fcm.googleapis.com/fcm/send/test','https://updates.push.services.mozilla.com/wpush/v2/test','https://web.push.apple.com/test','https://wns2.example.notify.windows.com/test'])assert.equal((await pushSubscription({endpoint,keys})).endpoint,endpoint);
  for(const endpoint of ['http://fcm.googleapis.com/a','https://fcm.googleapis.com.evil.test/a','https://127.0.0.1/a','https://example.test/push','https://user:pass@fcm.googleapis.com/a','https://fcm.googleapis.com:444/a'])await assert.rejects(pushSubscription({endpoint,keys}));
  for(const invalid of [{p256dh:'bad',auth:keys.auth},{p256dh:keys.p256dh,auth:'bad'},{p256dh:Buffer.alloc(65).toString('base64url'),auth:keys.auth}])await assert.rejects(pushSubscription({endpoint:'https://fcm.googleapis.com/a',keys:invalid}));
});
