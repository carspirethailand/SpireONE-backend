import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {liveToken} from '../src/live-setup.mjs';
import {LIVE_CALL_TOOLS,LIVE_CALL_AGENT_RULES} from '../src/live-call-tools.mjs';
import {GARAGE_CARE_RULES} from '../src/garage-care.mjs';
const setup=o=>liveToken({model:'unit-live',now:0,...o}).bidiGenerateContentSetup;
test('opt-in adds only fixed tools (read, prepare, Valet with confirm) and keeps existing engine tools',()=>{
  const names=setup({tools:true,agent:true,garageCare:true}).tools[0].functionDeclarations.map(t=>t.name);
  assert.deepEqual(names,['listen_engine','scan_engine_bay','garage_checkin_control','get_my_car','find_mechanics','show_mechanic','prepare_urgent_request','valet','valet_confirm']);
  assert.equal(new Set(names).size,names.length);
  assert.match(LIVE_CALL_AGENT_RULES,/NOT submitted/);assert.match(LIVE_CALL_AGENT_RULES,/untrusted data/);
  assert.equal(LIVE_CALL_TOOLS[0].functionDeclarations.length,7);
});
test('old clients stay voice-only or keep their two engine tools; string truthy is not agent consent',()=>{
  assert.equal(setup({}).tools,undefined);
  assert.equal(setup({agent:'true'}).tools,undefined);
  assert.deepEqual(setup({tools:true}).tools[0].functionDeclarations.map(t=>t.name),['listen_engine','scan_engine_bay']);
  assert.equal(setup({agent:true}).tools[0].functionDeclarations.length,6);
  assert.equal(setup({agent:true,garageCare:'true'}).tools[0].functionDeclarations.length,6);
});
test('agent rules are server-owned and resumption and safe speech detection are preserved',()=>{
  const s=setup({agent:true,handle:'resume_12345',system:'x'.repeat(10000)});
  assert.equal(s.sessionResumption.handle,'resume_12345');
  assert.equal(s.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity,'START_SENSITIVITY_LOW');
  assert.ok(s.systemInstruction.parts[0].text.startsWith(LIVE_CALL_AGENT_RULES+'\n'));
  assert.ok(s.systemInstruction.parts[0].text.startsWith(LIVE_CALL_AGENT_RULES+'\n'+GARAGE_CARE_RULES+'\n'));
  assert.ok(s.systemInstruction.parts[0].text.length<=LIVE_CALL_AGENT_RULES.length+GARAGE_CARE_RULES.length+4802);
  assert.equal(setup({resume:false}).sessionResumption,undefined);
});
test('token fallback honestly removes both tool groups and never accepts a client schema',async()=>{
  const source=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf("if (url.pathname === '/api/ai/live-token'"),source.indexOf('/* ===== DIAGNOSE (all-Gemini)'));
  assert.match(block,/withAgent = b\.agent === true/);
  assert.match(block,/tools = false; agent = false; resume = false/);
  assert.match(block,/model: liveModel, tools, agent, resume/);
  assert.ok(!block.includes('b.functionDeclarations'));assert.match(block,/x-goog-api-key/);
});
test('voice Valet: confirm step required, no dangerous actions, emergency numbers first',()=>{
  const decl=Object.fromEntries(LIVE_CALL_TOOLS[0].functionDeclarations.map(d=>[d.name,d]));
  const dos=decl.valet.parameters.properties.do.enum;
  assert.deepEqual(dos,['urgent','post_job','book','msg_shop','job','jobs','log','due','go','search','setting','pick_car','cars','threads','add_car','car_km','shop_status']);
  for(const bad of ['delete','pay','password','email','share_location','ads','admin','staff','users','approve'])assert.ok(!dos.includes(bad),bad);
  /* หน้าที่พาไปได้เป็นรายการคงที่ ไม่มีหน้าทีมงาน/แอดมิน */
  const pages=decl.valet.parameters.properties.to.enum;assert.ok(pages.includes('garage')&&pages.includes('studio'));for(const bad of ['admin','handbook','staff'])assert.ok(!pages.includes(bad),bad);
  assert.deepEqual(decl.valet.parameters.properties.value.enum,['light','dark']);
  assert.match(LIVE_CALL_AGENT_RULES,/Never access other people's data or staff\/admin tools/);assert.match(LIVE_CALL_AGENT_RULES,/the call minimizes and keeps going/);
  assert.deepEqual(decl.valet_confirm.parameters.required,['pending_id']);
  assert.match(decl.valet.description,/Nothing is sent yet/);
  assert.match(LIVE_CALL_AGENT_RULES,/only after the user clearly agrees, call valet_confirm/);
  assert.match(LIVE_CALL_AGENT_RULES,/1669 or 191/);assert.match(LIVE_CALL_AGENT_RULES,/do not read full phone numbers aloud/);
  assert.match(LIVE_CALL_AGENT_RULES,/cannot pay, delete data or accounts, change passwords/);
  /* ไม่มีช่องให้โมเดลส่งพิกัดหรือ URL เอง — ตำแหน่งมาจาก GPS ของเครื่องเท่านั้น */
  const props=Object.keys(decl.valet.parameters.properties);
  for(const k of ['lat','lng','url','href','address','techId','uid'])assert.ok(!props.includes(k),k);
});
