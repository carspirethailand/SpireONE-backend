#!/usr/bin/env node
/* เทียบผู้ให้บริการค้นเว็บของ Cendon AI (Tavily · Exa · Firecrawl) ด้วยชุดคำค้นเรื่องรถในไทยชุดเดียวกับหน้าแอดมิน
   ใช้คีย์จากตัวแปรสภาพแวดล้อมเท่านั้น (TAVILY_API_KEY · EXA_API_KEY · FIRECRAWL_API_KEY) ไม่พิมพ์คีย์ออกมา
   ใช้:  node tools/search-bench.mjs [--mode=balanced|deep] [--limit=12] [--providers=tavily,exa] [--json=out.json]
   หนึ่งรอบเต็ม (12 คำค้น × 3 เจ้า แบบ balanced) ใช้ราว 12 เครดิต Tavily + 12 คำขอ Exa + 24 เครดิต Firecrawl */
import { writeFileSync } from 'node:fs';
import { benchSearch, configuredProviders, BENCH_QUERIES } from '../src/web-search.mjs';

const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('=');
const env = { TAVILY_API_KEY: process.env.TAVILY_API_KEY, EXA_API_KEY: process.env.EXA_API_KEY, FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY };
if (!configuredProviders(env).length) { console.error('ไม่พบคีย์: ตั้ง TAVILY_API_KEY / EXA_API_KEY / FIRECRAWL_API_KEY เป็นตัวแปรสภาพแวดล้อมก่อน'); process.exit(1) }
const limit = Math.min(BENCH_QUERIES.length, Math.max(1, +arg('limit') || BENCH_QUERIES.length));
const mode = arg('mode') === 'deep' ? 'deep' : 'balanced';
const providers = arg('providers') ? arg('providers').split(',') : undefined;

const out = await benchSearch(env, { queries: BENCH_QUERIES.slice(0, limit), mode, providers });
const cols = ['successRate', 'p50ms', 'p95ms', 'avgResults', 'avgRelevant', 'expectedHostHit', 'avgThai', 'avgTrusted', 'avgWithDate', 'avgContentChars', 'totalUsd'];
console.log(`\nโหมด ${out.mode} · ${out.queries} คำค้น · ${out.at}\n`);
console.log('| เจ้า | ' + cols.join(' | ') + ' |\n|' + '---|'.repeat(cols.length + 1));
for (const p of out.providers) console.log('| ' + p + ' | ' + cols.map(c => out.summary[p][c] ?? '–').join(' | ') + ' |');
console.log('\nผลซ้ำระหว่างเจ้า (Jaccard):', out.overlap);
for (const p of out.providers) if (out.summary[p].errors.length) console.log('ข้อผิดพลาด', p, out.summary[p].errors.join(', '));
console.log('\nรายคำค้น (relevant · ms):');
for (const r of out.rows) console.log('-', r.kind.padEnd(13), out.providers.map(p => `${p}:${r.per[p].ok ? r.per[p].relevant + '·' + r.per[p].ms : r.per[p].error}`).join('  '), '|', r.q);
if (arg('json')) { writeFileSync(arg('json'), JSON.stringify(out, null, 2)); console.log('\nบันทึก', arg('json')) }
