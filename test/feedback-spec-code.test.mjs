import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../src/garage-rules.mjs';
test('factory engine code shape rejects keyboard/random data without erasing unchanged legacy records',()=>{
 for(const code of ['1KD-FTV','K20C1','N63B44','OM656','PE-VPS','CDAA','EA888','2JZ-GTE','4JJ3-TCX','R20A','M177.980'])assert.doesNotThrow(()=>rules.infoPatch({engine_code:code}),code);
 for(const code of ['qwdfwfwdsvew','engine1234567890123','ASDF123','111111111','abcd123456','AAAA123','N63<script>','random text9'])assert.throws(()=>rules.infoPatch({engine_code:code}),e=>e.field==='engine_code',code);
 const previous={engine_code:'old-invalid-code',trim:'Legacy trim'};assert.deepEqual({...rules.infoPatch(previous,previous)},previous);
 for(const [field,value] of Object.entries({trim:'asdfgh',model_year:'1234321',engine:'fsfastdsxz',tax_due:'2099-01-01'}))assert.throws(()=>rules.infoPatch({[field]:value}),e=>e.field===field,field);
});
