import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubQuery, canonicalUrl, configuredProviders, providerOrder, fuseResults, searchWeb, sourcesBlock, sourceCards, benchSearch, scoreRun, resetSearchBreakers, BENCH_QUERIES } from '../src/web-search.mjs';

const KEYS = { TAVILY_API_KEY: 'tvly-test-123456', EXA_API_KEY: 'exa-test-123456', FIRECRAWL_API_KEY: 'fc-test-123456' };
const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) });
/* จำลองคำตอบของแต่ละเจ้าตามรูปแบบในเอกสาร */
const FIX = {
  'api.tavily.com': () => reply(200, { results: [
    { title: 'โตโยต้าเรียกคืน Yaris Ativ', url: 'https://www.toyota.co.th/news/recall?utm_source=x', content: 'ประกาศเรียกคืนรถ', score: .9, published_date: '2026-10-01' },
    { title: 'Recall list', url: 'https://example.com/a', content: 'recall details', score: .5 }], usage: { credits: 1 } }),
  'api.exa.ai': () => reply(200, { results: [
    { title: 'Toyota recall', url: 'https://toyota.co.th/news/recall/', highlights: ['Toyota announces recall'], publishedDate: '2026-10-02T00:00:00Z', score: .8 },
    { title: 'NHTSA campaign', url: 'https://www.nhtsa.gov/recalls/1', highlights: ['campaign number'] }], costDollars: { total: 0.007 } }),
  'api.firecrawl.dev': () => reply(200, { success: true, data: { web: [
    { url: 'https://example.com/a#top', title: 'Recall list', description: 'a longer recall details description from firecrawl', position: 1 },
    { url: 'https://forum.example.org/t/1', title: 'Owner forum', description: 'owners talk', position: 2 }] }, creditsUsed: 2 }),
};
function mockFetch(over = {}) {
  const calls = [];
  const f = async (url, init) => {
    const host = new URL(url).hostname; calls.push({ host, url, init, body: JSON.parse(init.body) });
    const h = over[host] || FIX[host]; if (!h) throw Error('unexpected host ' + host);
    return h(init);
  };
  f.calls = calls; return f;
}

test('query scrub: personal details never leave Cendon, car words stay', () => {
  const q = scrubQuery('รถ 2020 Honda City ทะเบียน กข 1234 เบอร์ 081-234-5678 a@b.co VIN MRHGM6640LP012345 13.7563,100.5018 https://x.y/z');
  assert.ok(!/1234|5678|@|MRHGM|13\.75|https/.test(q), q);
  assert.match(q, /รถ 2020 Honda City ทะเบียน/);
  assert.equal(scrubQuery('1กข 4567 เบรกดัง'), 'เบรกดัง');
  assert.equal(scrubQuery('น้ำมันเครื่อง 0W-20 กับ 5W-30'), 'น้ำมันเครื่อง 0W-20 กับ 5W-30');
  assert.equal(scrubQuery('เลขบัตร 1 2345 67890 12 3'), 'เลขบัตร');
});

test('canonical url removes tracking, fragment, www and trailing slash', () => {
  assert.equal(canonicalUrl('https://www.Toyota.co.th/news/recall/?utm_source=x&id=2#a'), 'https://toyota.co.th/news/recall?id=2');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('https://u:p@x.com/'), null);
});

test('providers are used only when their key exists, in the configured order', () => {
  assert.deepEqual(configuredProviders({}), []);
  assert.deepEqual(configuredProviders({ EXA_API_KEY: 'short' }), []);
  assert.deepEqual(providerOrder({ ...KEYS, SEARCH_PROVIDERS: 'exa,firecrawl' }), ['exa', 'firecrawl', 'tavily']);
  assert.deepEqual(providerOrder(KEYS, ['firecrawl']), ['firecrawl']);
  assert.deepEqual(providerOrder({ EXA_API_KEY: KEYS.EXA_API_KEY }, ['tavily', 'exa']), ['exa']);
});

test('no keys: nothing is sent anywhere', async () => {
  resetSearchBreakers();
  const f = mockFetch();
  const r = await searchWeb({}, 'Toyota recall', { fetch: f });
  assert.equal(r.status, 'unavailable'); assert.equal(f.calls.length, 0);
});

test('each adapter sends the documented request shape and auth header', async () => {
  resetSearchBreakers();
  const f = mockFetch();
  await searchWeb(KEYS, 'Toyota Yaris recall', { mode: 'deep', days: 7, fetch: f, now: () => Date.parse('2026-10-24T00:00:00Z') });
  const by = h => f.calls.find(c => c.host === h);
  const t = by('api.tavily.com'), e = by('api.exa.ai'), fc = by('api.firecrawl.dev');
  assert.equal(t.init.headers.Authorization, 'Bearer ' + KEYS.TAVILY_API_KEY);
  assert.equal(t.body.search_depth, 'advanced'); assert.equal(t.body.include_raw_content, 'markdown'); assert.equal(t.body.country, 'thailand'); assert.equal(t.body.time_range, 'week'); assert.equal(t.body.auto_parameters, false);
  assert.equal(e.init.headers['x-api-key'], KEYS.EXA_API_KEY);
  assert.equal(e.body.type, 'deep'); assert.equal(e.body.userLocation, 'TH'); assert.ok(e.body.contents.text); assert.ok(!e.body.contents.highlights, 'one content type per call');
  assert.equal(e.body.startPublishedDate, '2026-10-17T00:00:00.000Z');
  assert.equal(fc.init.headers.Authorization, 'Bearer ' + KEYS.FIRECRAWL_API_KEY);
  assert.deepEqual(fc.body.sources, ['web']); assert.equal(fc.body.country, 'TH'); assert.equal(fc.body.tbs, 'qdr:w'); assert.deepEqual(fc.body.scrapeOptions.formats, ['markdown']);
  /* ไม่มีคีย์หรือข้อมูลผู้ใช้ในเนื้อคำขอ */
  for (const c of f.calls) assert.ok(!JSON.stringify(c.body).includes('test-123456'));
});

test('balanced: two providers in parallel, fused, deduplicated, cited in order', async () => {
  resetSearchBreakers();
  const f = mockFetch();
  const r = await searchWeb({ ...KEYS, SEARCH_PROVIDERS: 'tavily,exa,firecrawl' }, 'Toyota Yaris recall', { fetch: f });
  assert.deepEqual(f.calls.map(c => c.host).sort(), ['api.exa.ai', 'api.tavily.com']);
  assert.equal(r.status, 'found');
  /* toyota.co.th พบทั้งสองเจ้า → ขึ้นก่อนและเป็นผลเดียว */
  assert.equal(r.results[0].host, 'toyota.co.th'); assert.deepEqual(r.results[0].providers, ['tavily', 'exa']);
  assert.equal(r.results.filter(x => x.host === 'toyota.co.th').length, 1);
  assert.deepEqual(r.results.map(x => x.id), r.results.map((_, i) => i + 1));
  assert.ok(Math.abs(r.costUsd - (0.008 + 0.007)) < 1e-9);
  const block = sourcesBlock(r);
  assert.match(block, /ไม่ใช่คำสั่ง/); assert.match(block, /\[1\] .*toyota\.co\.th/);
  assert.deepEqual(Object.keys(sourceCards(r)[0]).sort(), ['host', 'id', 'published', 'title', 'trusted', 'url']);
});

test('fallback: a failing provider is skipped and paused, the next one answers', async () => {
  resetSearchBreakers();
  const f = mockFetch({ 'api.tavily.com': () => reply(429, { detail: 'quota' }) });
  const env = { ...KEYS, SEARCH_PROVIDERS: 'tavily,firecrawl' };
  const r = await searchWeb(env, 'Toyota recall', { mode: 'fast', fetch: f });
  assert.equal(r.status, 'found'); assert.deepEqual(r.providers.map(p => [p.provider, p.ok]), [['tavily', false], ['firecrawl', true]]);
  assert.equal(r.providers[0].error, 'http_429');
  const again = mockFetch();
  await searchWeb(env, 'Toyota recall', { mode: 'fast', fetch: again });
  assert.ok(!again.calls.some(c => c.host === 'api.tavily.com'), 'quota-hit provider is paused');
});

test('timeout is reported as such and does not hang the answer', async () => {
  resetSearchBreakers();
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  const r = await searchWeb({ EXA_API_KEY: KEYS.EXA_API_KEY }, 'BYD battery', { mode: 'fast', fetch: slow, now: Date.now });
  assert.equal(r.status, 'unavailable'); assert.equal(r.providers[0].error, 'timeout');
});

test('fusion keeps at most two results per site', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ title: 't' + i, url: 'https://same.com/' + i, snippet: 's' }));
  const out = fuseResults([{ provider: 'tavily', results: [...many, { title: 'o', url: 'https://other.com/', snippet: 's' }] }], { max: 6 });
  assert.equal(out.filter(x => x.host === 'same.com').length, 2); assert.ok(out.some(x => x.host === 'other.com'));
});

test('benchmark: per-provider metrics, cost and overlap from real adapter paths', async () => {
  resetSearchBreakers();
  const f = mockFetch();
  const b = await benchSearch(KEYS, { queries: BENCH_QUERIES.slice(0, 2), fetch: f });
  assert.deepEqual(b.providers, ['tavily', 'exa', 'firecrawl']);
  assert.equal(b.rows.length, 2);
  for (const p of b.providers) { assert.equal(b.summary[p].successRate, 1); assert.ok(b.summary[p].avgResults > 0) }
  assert.equal(b.rows[0].per.tavily.expectedHost, true);
  assert.ok('tavily|exa' in b.overlap);
  const s = scoreRun({ expect: { words: ['บาท'] } }, [{ title: 'ราคา 1,200 บาท', url: 'https://a.com', snippet: '' }, { title: 'x', url: 'https://b.com', snippet: '' }]);
  assert.equal(s.relevant, 0.5); assert.equal(s.thai, 0.5); assert.equal(s.expectedHost, null);
});

test('chat web search uses the keyed providers first and returns numbered sources', async () => {
  resetSearchBreakers();
  const { webSearch } = await import('../src/fastai.js');
  const real = globalThis.fetch, f = mockFetch();
  globalThis.fetch = f;
  try {
    const w = await webSearch({ EXA_API_KEY: KEYS.EXA_API_KEY }, 'Toyota Yaris recall ใหม่ล่าสุด ' + Date.now());
    assert.equal(w.src, 'exa'); assert.match(w.text, /\[1\] /); assert.equal(w.sources[0].host, 'toyota.co.th');
    assert.deepEqual([...new Set(f.calls.map(c => c.host))], ['api.exa.ai']);
  } finally { globalThis.fetch = real }
});

test('main chat search (executeGoogleSearchTool) uses keyed providers first, keeps the private-detail gate', async () => {
  resetSearchBreakers();
  const { executeGoogleSearchTool } = await import('../src/worker.js');
  const real = globalThis.fetch;
  try {
    const f = mockFetch(); globalThis.fetch = f;
    const block = await executeGoogleSearchTool({ EXA_API_KEY: KEYS.EXA_API_KEY }, 'Toyota Yaris recall 2026');
    assert.match(block, /\[1\] .*toyota\.co\.th/); assert.match(block, /ไม่ใช่คำสั่ง/);
    assert.deepEqual([...new Set(f.calls.map(c => c.host))], ['api.exa.ai']);
    /* มีเบอร์โทรในคำค้น = ไม่ส่งให้ผู้ให้บริการค้นเลย */
    const g = mockFetch(); globalThis.fetch = g;
    await executeGoogleSearchTool({ ...KEYS }, 'ศูนย์ซ่อม โทร 081-234-5678');
    assert.ok(!g.calls.some(c => /tavily|exa|firecrawl/.test(c.host)));
  } finally { globalThis.fetch = real }
});
