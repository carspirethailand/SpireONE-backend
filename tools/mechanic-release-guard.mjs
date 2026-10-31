/* Read-only deployment guard. Snapshots contain hashes/bookmarks, not user data.
   Never restore automatically: legitimate live edits also require inspection. */
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const EXPECTED_DB='bf9b1815-2ef6-4463-8b35-6b97717b5d9a';
// Wrangler writes stdout JSON to its debug file even when the parent only keeps
// hashes. Disable that file sink before any database/metadata request is made.
export const releaseGuardEnvironment=(env=process.env)=>({...env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_SANITIZE:'true'});
export const fingerprintRows=rows=>rows.map(r=>({key:hash(String(r.id??r.uid)),digest:hash(JSON.stringify(r))})).sort((a,b)=>a.key.localeCompare(b.key));
const hash=s=>createHash('sha256').update(s).digest('hex');
export function compareSnapshots(before,after){
  if(before.version!==1||after.version!==1||before.database!==EXPECTED_DB||after.database!==EXPECTED_DB)throw Error('Invalid deployment snapshot');
  const problems=[];
  for(const table of Object.keys(before.tables)){
    const current=new Map((after.tables[table]||[]).map(x=>[x.key,x.digest]));
    const missing=before.tables[table].filter(x=>!current.has(x.key)).length,changed=before.tables[table].filter(x=>current.has(x.key)&&current.get(x.key)!==x.digest).length;
    if(missing||changed)problems.push({table,missing,changed});
  }return problems;
}
const queries={
  jobs:'SELECT * FROM tech_jobs ORDER BY id LIMIT 10001',
  messages:'SELECT * FROM tech_messages ORDER BY id LIMIT 10001',
  profiles:'SELECT id,uid,phone,data,verified,test,suspended,id_hold,jobs,rating_sum,review_count,created_at FROM tech_profiles ORDER BY id LIMIT 10001',
  services:'SELECT id,uid,tech_id,kind,title,body,price,cats,brands,photos,active,created_at FROM tech_gigs ORDER BY id LIMIT 10001',
  applications:'SELECT uid,status,test,revision,created_at FROM tech_applications ORDER BY uid LIMIT 10001',
  photos:"SELECT id,uid,kind,mime,length(data) AS bytes,created_at FROM tech_docs WHERE kind IN ('shop','work','gig','review') ORDER BY id LIMIT 10001",
};
async function main(){
  const [mode,snapshotPath,...rest]=process.argv.slice(2),cli=rest[0]==='--wrangler'?rest[1]:null,root=resolve(import.meta.dirname,'..');
  if(!['capture','check'].includes(mode)||!snapshotPath||!cli)throw Error('Usage: capture|check .qa/mechanic-release/<file>.json --wrangler <installed-wrangler.js>');
  const file=resolve(root,snapshotPath),rel=relative(resolve(root,'.qa/mechanic-release'),file);
  if(isAbsolute(rel)||rel.startsWith('..')||!rel.endsWith('.json'))throw Error('Snapshot must be inside .qa/mechanic-release');
  const cfg=await readFile(resolve(root,'wrangler.jsonc'),'utf8');if(!cfg.includes('"database_id": "'+EXPECTED_DB+'"'))throw Error('Production database binding changed; manual migration review required');
  const run=args=>{const r=spawnSync(process.execPath,[resolve(cli),...args],{cwd:root,env:releaseGuardEnvironment(),encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw Error('Read-only Cloudflare check failed; inspect CLI access without sharing secrets');return JSON.parse(r.stdout)};
  const tables={};for(const [name,sql] of Object.entries(queries)){
    const result=run(['d1','execute','spireone','--remote','--json','--command',sql]);const rows=result.flatMap(x=>x.results||[]);
    if(rows.length>10000)throw Error('Snapshot row limit exceeded; add pagination before release');tables[name]=fingerprintRows(rows);
  }
  const snapshot={version:1,database:EXPECTED_DB,capturedAt:new Date().toISOString(),tables};
  if(mode==='capture'){
    const info=run(['d1','time-travel','info','spireone','--json']);
    const bookmark=JSON.stringify(info).match(/\b[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}\b/i)?.[0];
    if(!bookmark)throw Error('Could not capture a Time Travel bookmark; no release snapshot written');snapshot.bookmark=bookmark;
    await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(snapshot,null,2),{flag:'wx'});
    console.log(JSON.stringify({ok:true,mode,snapshot:file,bookmarkCaptured:true,counts:Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]))}));
  }else{
    const before=JSON.parse(await readFile(file,'utf8')),problems=compareSnapshots(before,snapshot);
    console.log(JSON.stringify({ok:!problems.length,mode,problems,automaticRestore:false}));if(problems.length)process.exitCode=1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))main().catch(()=>{console.error('Mechanic release guard failed. No data was changed or restored.');process.exitCode=1});
