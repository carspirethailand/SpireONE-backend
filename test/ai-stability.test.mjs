import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fastAnswer,unpark,badState,geminiScope,thinkingFor,levelFor,RACE} from '../src/fastai.js';

/* แชตเสถียร: ยิงสำรองคู่ขนาน · จำรุ่นที่ล่มร่วมกัน · เขียนต่อเมื่อถูกตัด · ทางสำรองยิงครั้งเดียว — Gemini/Groq ในเทสต์เป็นของปลอมทั้งหมด */
const sse=(...chunks)=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const say=(text,finishReason)=>({candidates:[{content:{parts:[{text}]},...(finishReason?{finishReason}:{})}]});
const modelOf=url=>String(url).split('/models/')[1]?.split(':')[0];
const env=(over={})=>({GEMINI_KEY:'fixture-only',GEMINI_MODEL:'gemini-3.5-flash-lite',GEMINI_SEARCH_MODEL:'gemini-3.5-flash-lite',...over});
const base=(over={})=>({contents:[{role:'user',parts:[{text:'แอร์ไม่เย็น'}]}],question:'แอร์ไม่เย็น',search:false,level:'low',...over});
async function withFetch(fn,body){const original=globalThis.fetch;globalThis.fetch=fn;unpark();try{return await body()}finally{globalThis.fetch=original;unpark()}}

test('a slow first model gets a parallel backup; the first to write wins and the slow one is cancelled',async()=>{
  const old={...RACE};RACE.HEDGE_MS=30;
  const seen=[],aborted=[],text=[],phases=[];
  try{await withFetch(async(url,init)=>{const m=modelOf(url);seen.push(m);
      if(m==='gemini-3.5-flash-lite')return new Promise((_,rej)=>init.signal.addEventListener('abort',()=>{aborted.push(m);rej(Object.assign(Error('aborted'),{name:'AbortError'}))}));
      return sse(say('คำตอบจากตัวสำรอง','STOP'))},
    async()=>{const r=await fastAnswer(env(),base({onText:d=>text.push(d),onPhase:(n,i)=>phases.push([n,i.model])}));
      assert.equal(r.text,'คำตอบจากตัวสำรอง');assert.equal(r.model,'gemini-3.1-flash-lite');assert.equal(text.join(''),r.text,'only the winner streams to the user');
      assert.deepEqual(seen.slice(0,2),['gemini-3.5-flash-lite','gemini-3.1-flash-lite']);assert.deepEqual(aborted,['gemini-3.5-flash-lite']);
      assert.ok(phases.some(p=>p[0]==='hedge'));assert.ok(phases.some(p=>p[0]==='first'&&p[1]==='gemini-3.1-flash-lite'));});
  }finally{Object.assign(RACE,old)}
});

test('a busy (503) model is skipped immediately, parked, and not retried on the next message',async()=>{
  const seen=[];
  await withFetch(async url=>{const m=modelOf(url);seen.push(m);return m==='gemini-3.5-flash-lite'?new Response('overloaded',{status:503}):sse(say('ok','STOP'))},async()=>{
    const t0=Date.now();const r=await fastAnswer(env(),base());assert.equal(r.model,'gemini-3.1-flash-lite');assert.ok(Date.now()-t0<2000,'no waiting out a timeout after a fast 503');
    const scope=await geminiScope(env());assert.ok(badState(scope).some(p=>p.model==='gemini-3.5-flash-lite'),'busy model is parked');
    seen.length=0;await fastAnswer(env(),base());assert.deepEqual(seen,['gemini-3.1-flash-lite'],'next message goes straight to a healthy model');
  });
});

test('parking is shared through D1 so other machines skip the broken model too',async()=>{
  const rows=new Map();
  const DB={prepare:sql=>({bind:(...a)=>({run:async()=>{if(/^INSERT INTO ai_health/.test(sql))rows.set(a[0],{k:a[0],until:a[1]});if(/^DELETE FROM ai_health WHERE/.test(sql))rows.delete(a[0])},
      all:async()=>({results:[...rows.values()].filter(r=>r.until>a[0])})}),run:async()=>{}})};
  await withFetch(async url=>modelOf(url)==='gemini-3.5-flash-lite'?new Response('overloaded',{status:503}):sse(say('ok','STOP')),async()=>{
    await fastAnswer(env({DB}),base());const scope=await geminiScope(env());assert.ok(rows.has(scope+'|gemini-3.5-flash-lite'));
    unpark();/* อีกเครื่องหนึ่ง: ความจำในเครื่องว่าง แต่ฐานข้อมูลบอกว่ารุ่นนี้ล่ม */
  });
  const seen=[];
  await withFetch(async url=>{seen.push(modelOf(url));return sse(say('ok','STOP'))},async()=>{
    const {syncHealth}=await import('../src/fastai.js');await syncHealth(env({DB}),true);
    await fastAnswer(env({DB}),base());assert.deepEqual(seen,['gemini-3.1-flash-lite']);
  });
});

test('an answer cut by the token limit is continued once, seamlessly, instead of ending short',async()=>{
  const bodies=[],text=[];
  await withFetch(async(url,init)=>{const b=JSON.parse(init.body);bodies.push(b);
      return bodies.length===1?sse(say('ส่วนแรกของคำตอบ ','MAX_TOKENS')):sse(say('ส่วนที่เขียนต่อ','STOP'))},async()=>{
    const r=await fastAnswer(env(),base({onText:d=>text.push(d)}));
    assert.equal(r.text,'ส่วนแรกของคำตอบ ส่วนที่เขียนต่อ');assert.equal(r.partial,false);assert.equal(text.join(''),r.text);
    const last=bodies[1].contents;assert.equal(last.at(-2).role,'model');assert.match(last.at(-1).parts[0].text,/เขียนต่อจากจุดที่ค้าง/);
  });
});

test('a stream that breaks mid-answer is continued; if continuing fails the answer is flagged as cut, never passed off as complete',async()=>{
  let n=0;
  await withFetch(async()=>{n++;if(n===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(say('ครึ่งแรก'))+'\n\n'));setTimeout(()=>c.error(Error('connection reset')),20)}}));
      return new Response('overloaded',{status:503})},async()=>{
    const r=await fastAnswer(env(),base());assert.equal(r.text,'ครึ่งแรก');assert.equal(r.partial,true);
  });
});

test('when every Gemini model fails, one streamed fallback call answers using the search already done (no second search, no multi-step agent)',async()=>{
  const calls=[];let searches=0;const text=[];
  await withFetch(async(url,init)=>{calls.push(String(url));
      if(/generativelanguage/.test(url))return new Response('overloaded',{status:503});
      const b=JSON.parse(init.body);assert.match(b.messages.at(-1).content,/ผลค้น fixture/,'search result rides along to the fallback');
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:'คำตอบสำรอง'}}]})+'\n\ndata: [DONE]\n\n')},async()=>{
    const r=await fastAnswer(env({GROQ_API_KEY:'fixture-only'}),base({search:true,question:'ราคาแบตเตอรี่วันนี้',executeSearch:async()=>{searches++;return '[1] ผลค้น fixture'},onText:d=>text.push(d)}));
    assert.equal(r.text,'คำตอบสำรอง');assert.equal(r.fallback,true);assert.equal(searches,1);
    const groq=calls.filter(u=>/groq/.test(u));assert.equal(groq.length,1,'a single fallback call');assert.equal(text.join(''),'คำตอบสำรอง');
  });
});

test('thinking depth: everyday car questions think "low" (not medium); files/skills or the deep setting think medium',()=>{
  assert.equal(thinkingFor('แอร์ไม่เย็น มีเสียงดังตอนเปิด',false),'low');
  assert.equal(thinkingFor('รถผมรุ่นอะไร',false),'minimal');
  assert.equal(thinkingFor('ดูรูปนี้',true),'medium');
  assert.equal(levelFor(2,'แอร์ไม่เย็น',false),'medium');
});
