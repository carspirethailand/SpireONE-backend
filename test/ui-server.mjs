// Isolated UI integration server. Local memory only; NEVER deploy this file.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {marketplace} from '../src/techs-api.mjs';
const root=resolve(fileURLToPath(new URL('../../Cendon-Beta/',import.meta.url)));
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../migrations/0014_marketplace.sql',import.meta.url),'utf8'));
const DB={prepare(sql){let v=[];return {bind(...values){v=values;return this},async first(){return sqlite.prepare(sql).get(...v)||null},async all(){return {results:sqlite.prepare(sql).all(...v)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...v).changes)}}}}},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:4174');
    if(url.pathname.startsWith('/api/tech')){
      let raw='';for await(const chunk of req)raw+=chunk;
      const request=new Request(url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});
      const result=await marketplace(request,{DB},async()=>{
        if(req.headers.authorization!=='Bearer local-test-admin')throw Object.assign(new Error('Local login required'),{status:401});
        return {uid:'local-admin',admin:true,name:'Local integration admin'};
      });
      res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await result.text());return;
    }
    const path=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(root+sep)||!['.html','.css','.js','.png'].includes(extname(path)))throw new Error('not found');
    let content=await readFile(path);
    if(url.pathname==='/techs.html'){
      content=content.toString().replace(/<script defer src="https:\/\/www.gstatic.com\/firebasejs\/[^\"]+"><\/script>/g,'');
      const setup=`<script>
        window.TECH_API_URL=location.origin;
        const testAuth={currentUser:{uid:'local-admin',getIdToken:async()=> 'local-test-admin'},setPersistence:async()=>{},onAuthStateChanged:fn=>setTimeout(()=>fn(testAuth.currentUser),0)};
        const testAuthFactory=()=>testAuth;testAuthFactory.Auth={Persistence:{LOCAL:'local'}};
        window.firebase={initializeApp:()=>{},auth:testAuthFactory};
      </script>`;
      content=content.replace('<head>','<head>'+setup).replace('<body>','<body><div style="padding:8px;text-align:center;background:#f5c46b;color:#211600;font:12px system-ui">LOCAL INTEGRATION TEST · memory only · no real accounts or appointments</div>');
    }
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[extname(path)],'Cache-Control':'no-store'});res.end(content);
  }catch(e){res.writeHead(500);res.end('Local test error: '+e.message);}
}).listen(4174,'127.0.0.1',()=>console.log('Local UI integration: http://127.0.0.1:4174/techs.html'));
