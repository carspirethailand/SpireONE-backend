import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {liveToken} from '../src/live-setup.mjs';
import {LIVE_CALL_TOOLS,LIVE_CALL_AGENT_RULES} from '../src/live-call-tools.mjs';
const setup=o=>liveToken({model:'unit-live',now:0,agentVersion:2,...o}).bidiGenerateContentSetup;
test('opt-in adds only fixed read/prepare tools and keeps existing engine tools',()=>{
  const names=setup({tools:true,agent:true}).tools[0].functionDeclarations.map(t=>t.name);
  assert.deepEqual(names,['listen_engine','scan_engine_bay','get_my_car','find_mechanics','show_mechanic','prepare_urgent_request','get_my_garage','get_my_requests','get_my_conversations','read_my_conversation','prepare_mechanic_message','open_app_page']);
  assert.equal(new Set(names).size,names.length);
  assert.match(LIVE_CALL_AGENT_RULES,/NOT submitted/);assert.match(LIVE_CALL_AGENT_RULES,/untrusted data/);
  assert.equal(LIVE_CALL_TOOLS[0].functionDeclarations.length,10);
});
test('old clients stay voice-only or keep their two engine tools; string truthy is not agent consent',()=>{
  assert.equal(setup({}).tools,undefined);
  assert.equal(setup({agent:'true'}).tools,undefined);
  assert.deepEqual(setup({tools:true}).tools[0].functionDeclarations.map(t=>t.name),['listen_engine','scan_engine_bay']);
  assert.equal(setup({agent:true}).tools[0].functionDeclarations.length,10);
  assert.equal(setup({agent:true,agentVersion:1}).tools[0].functionDeclarations.length,4);
});
test('agent rules are server-owned and resumption and safe speech detection are preserved',()=>{
  const s=setup({agent:true,handle:'resume_12345',system:'x'.repeat(10000)});
  assert.equal(s.sessionResumption.handle,'resume_12345');
  assert.equal(s.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity,'START_SENSITIVITY_LOW');
  assert.ok(s.systemInstruction.parts[0].text.startsWith(LIVE_CALL_AGENT_RULES+'\n'));
  assert.ok(s.systemInstruction.parts[0].text.length<=LIVE_CALL_AGENT_RULES.length+4801);
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
