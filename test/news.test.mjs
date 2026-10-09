import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';
import {parseFeed, pick, refreshNews, newsAI} from '../src/news.js';

/* นิตยสาร: รวมข่าวจากฟีดจริง + Gemini แยกจากแชต — เว็บข่าวและ AI ในเทสต์เป็นของปลอมทั้งหมด */
const NOW=Date.UTC(2026,9,9,6,0,0);
const rss=(items)=>`<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel>${items.join('')}</channel></rss>`;
const wpItem=(n,{img=true,ago=1}={})=>`<item><title><![CDATA[ข่าวรถที่ ${n} &amp; สเปก]]></title><link>https://th.example/news-${n}</link>
  <pubDate>${new Date(NOW-ago*3600000).toUTCString()}</pubDate><description><![CDATA[สรุปสั้น ${n}]]></description>
  <content:encoded><![CDATA[${img?`<p><img src="https://img.example/${n}.jpg" width="800"></p>`:''}<p>Toyota เปิดตัวรุ่นใหม่ ${n} ราคา 799,000 บาท</p>]]></content:encoded></item>`;

test('feeds: WordPress, Atom, media:content and Google News are all read correctly',()=>{
  const wp=parseFeed(rss([wpItem(1)]),{name:'Thai A',lang:'th'},NOW)[0];
  assert.equal(wp.title,'ข่าวรถที่ 1 & สเปก');assert.equal(wp.url,'https://th.example/news-1');assert.equal(wp.image,'https://img.example/1.jpg');
  assert.match(wp.text,/ราคา 799,000 บาท/);assert.doesNotMatch(wp.text,/<p>|<img/);assert.equal(wp.at,NOW-3600000);
  const mc=parseFeed(rss([`<item><title>EV range</title><link>https://en.example/a</link><media:content url="http://cdn.example/a.jpg" medium="image"/><description>&lt;p&gt;Battery &lt;b&gt;up&lt;/b&gt;&lt;/p&gt;</description></item>`]),{name:'Motor1',lang:'en'},NOW)[0];
  assert.equal(mc.image,'https://cdn.example/a.jpg','http images are upgraded to https');assert.equal(mc.text,'Battery up');
  const atom=parseFeed(`<feed><entry><title>Atom story</title><link rel="alternate" href="https://atom.example/1"/><updated>2026-10-09T05:00:00Z</updated><summary>Short</summary></entry></feed>`,{name:'Atom',lang:'en'},NOW)[0];
  assert.equal(atom.url,'https://atom.example/1');assert.equal(atom.at,Date.parse('2026-10-09T05:00:00Z'));
  const g=parseFeed(rss([`<item><title>BYD ลดราคา Atto 3 - ไทยรัฐ</title><link>https://news.google.com/rss/articles/abc</link><source url="https://thairath.co.th">ไทยรัฐ</source><description>&lt;a href="x"&gt;BYD&lt;/a&gt;</description></item>`]),{name:'Google News',lang:'th',google:true},NOW)[0];
  assert.equal(g.title,'BYD ลดราคา Atto 3');assert.equal(g.source,'ไทยรัฐ');assert.equal(g.text,'');
});

test('pick: fresh, no duplicates, at most 6 per source, Thai first with some world news',()=>{
  const items=[];
  for(let k=0;k<10;k++)items.push({title:'ข่าว A '+k,source:'A',lang:'th',at:NOW-k*3600000});
  items.push({title:'ข่าว A 0',source:'B',lang:'th',at:NOW},{title:'old',source:'C',lang:'th',at:NOW-6*86400000});
  for(let k=0;k<15;k++)items.push({title:'World '+k,source:'W'+k,lang:'en',at:NOW-k*60000});
  const p=pick(items,NOW);
  assert.equal(p.filter(x=>x.source==='A').length,6);assert.ok(!p.some(x=>x.source==='B'),'same headline from another site is a duplicate');
  assert.ok(!p.some(x=>x.title==='old'));assert.equal(p.filter(x=>x.lang==='en').length,10);assert.equal(p[0].lang,'th');
});

function setup(env={},{feedsFail=false,aiFail=false}={}){
  const f=fixture({GEMINI_KEY:'chat-key-test-only',...env});
  f.sqlite.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE magazine (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, short_description TEXT, full_description TEXT, type TEXT, created_at INTEGER NOT NULL,
      source TEXT, url TEXT, image TEXT, published_at INTEGER, origin TEXT, points TEXT, sort INTEGER);
    INSERT INTO magazine (title, created_at, origin, sort) VALUES ('บทความทีมงาน',1,'manual',0),('ข่าวรอบก่อน',1,'feed',1);`);
  const ai=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);ai.push({u,key:init.headers['x-goog-api-key'],body});
      if(aiFail)return new Response('quota',{status:429});
      if(body.tools){return Response.json({candidates:[{content:{parts:[{text:JSON.stringify([{title:'ข่าวจากการค้นเว็บ',summary:'ส',points:['a'],body:'b',category:'EV',score:4,source:'สำนักข่าว'}])}]}}]});}
      const list=JSON.parse(body.contents[0].parts[0].text.split('ข่าว:\n')[1]);
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(list.map(x=>({i:x.i,keep:!/โฆษณา/.test(x.title),title:'พาดหัว '+x.title,summary:'สรุป',points:['ราคา 799,000 บาท'],body:'ย่อหน้า 1\n\nย่อหน้า 2',category:x.i===0?'รถใหม่':'ไม่มีหมวดนี้',score:x.i===3?5:2})))}]}}]});}
    if(feedsFail)throw Error('blocked');
    if(u==='https://www.headlightmag.com/feed/')return new Response(rss([...[1,2,3,4].map(n=>wpItem(n,{img:n!==4,ago:n})),wpItem('โฆษณา')]));
    if(u==='https://www.motor1.com/rss/news/all/')return new Response(rss([`<item><title>New EV</title><link>https://en.example/ev</link><pubDate>${new Date(NOW-1800000).toUTCString()}</pubDate><description>Range 600 km</description></item>`,
      `<item><title>Hybrid SUV</title><link>https://en.example/suv</link><pubDate>${new Date(NOW-2400000).toUTCString()}</pubDate><description>New SUV</description></item>`]));
    if(u==='https://th.example/news-4'||u==='https://en.example/ev')return new Response('<html><head><meta property="og:image" content="https://img.example/og.jpg"></head></html>');
    return new Response('nope',{status:404});};
  return {f,ai};
}

test('refresh: real headlines become Thai stories with images, links and order; team articles stay',async()=>{
  const {f,ai}=setup();
  const st=await refreshNews(f.env,{force:true});
  assert.equal(st.error,'');assert.equal(st.mode,'feeds',JSON.stringify(st));
  assert.equal(st.feeds.find(x=>x.name==='Headlightmag').n,5);assert.ok(st.feeds.find(x=>x.name==='Electrek').err,'a broken feed is reported, not fatal');
  const rows=f.sqlite.prepare("SELECT * FROM magazine ORDER BY CASE WHEN origin='manual' THEN 0 ELSE 1 END, sort").all();
  assert.equal(rows[0].title,'บทความทีมงาน');assert.ok(!rows.some(r=>r.title==='ข่าวรอบก่อน'),'last round is replaced');
  assert.ok(!rows.some(r=>/โฆษณา/.test(r.title)),'AI drops what is not car news');
  const top=rows[1];assert.match(top.title,/^พาดหัว /);assert.ok(top.url.startsWith('https://'));assert.ok(top.image.startsWith('https://'));
  assert.deepEqual(JSON.parse(top.points),['ราคา 799,000 บาท']);assert.equal(top.origin,'feed');
  assert.ok(rows.some(r=>r.type==='รถใหม่'));assert.ok(!rows.some(r=>r.type==='ไม่มีหมวดนี้'),'unknown categories fall back');
  assert.equal(rows.find(r=>r.url==='https://th.example/news-4').image,'https://img.example/og.jpg','missing image comes from the article page');
  assert.ok(ai.every(c=>!/flash-lite/.test(c.u)),'without its own key, news avoids the models chat uses first');
  assert.ok(ai.every(c=>c.key==='chat-key-test-only'));
});

test('refresh: a separate news key keeps news off the chat quota entirely',async()=>{
  const {f,ai}=setup({GEMINI_NEWS_KEY:'news-key-test-only'});
  assert.equal(newsAI(f.env).own,true);
  await refreshNews(f.env,{force:true});
  assert.ok(ai.length>0&&ai.every(c=>c.key==='news-key-test-only'));
});

test('refresh: no feeds reachable → AI searches the web; AI down → old stories stay and the error is recorded',async()=>{
  let {f,ai}=setup({},{feedsFail:true});
  let st=await refreshNews(f.env,{force:true});
  assert.equal(st.mode,'ai');assert.ok(ai[0].body.tools,'uses web search');
  assert.equal(f.sqlite.prepare("SELECT origin FROM magazine WHERE title='ข่าวจากการค้นเว็บ'").get().origin,'ai');
  ({f}=setup({},{aiFail:true}));
  st=await refreshNews(f.env,{force:true});
  assert.match(st.error,/AI สรุปข่าวไม่สำเร็จ/);
  assert.ok(f.sqlite.prepare("SELECT 1 FROM magazine WHERE title='ข่าวรอบก่อน'").get(),'nothing is deleted when the round fails');
  assert.ok(JSON.parse(f.sqlite.prepare("SELECT value FROM config WHERE key='news_status'").get().value).error);
});

test('magazine API: team articles first, then the order the round chose',async()=>{
  const {f}=setup();
  f.sqlite.exec("INSERT INTO magazine (title, created_at, origin, sort) VALUES ('ข่าวอันดับ 2',1,'feed',2),('ข่าวอันดับ 1',1,'feed',1)");
  f.sqlite.exec("DELETE FROM magazine WHERE title='ข่าวรอบก่อน'");
  const r=await worker.fetch(new Request('https://api.unit.test/api/magazine'),f.env,{waitUntil(){}});
  assert.deepEqual((await r.json()).map(x=>x.title),['บทความทีมงาน','ข่าวอันดับ 1','ข่าวอันดับ 2']);
});
