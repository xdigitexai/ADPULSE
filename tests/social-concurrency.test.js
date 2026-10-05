import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Database from 'better-sqlite3';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'creator-race-'));process.env.DB_PATH=path.join(tmp,'test.db');
const {db,run,addLedger}=await import('../src/db.js');
test('independent processes racing for final campaign funds charge the wallet only once',async t=>{
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  for(const [id,role] of [['p','publisher'],['a','advertiser']])run("INSERT INTO users(id,email,password_hash,role,name,status) VALUES(?,?,'test',?,?,'active')",[id,id+'@example.test',role,id]);
  run("INSERT INTO social_accounts(id,publisher_id,platform,profile_url,status) VALUES('s','p','youtube','https://www.youtube.com/channel/test','verified')");
  run("INSERT INTO creator_campaigns(id,advertiser_id,name,description,destination_url,pricing_model,currency,cpc,budget_total,budget_daily,status) VALUES('c','a','Race','Isolated concurrency test','https://shop.example.test','CPC','USD',2,2,2,'active')");
  run("INSERT INTO creator_campaign_assignments(id,campaign_id,creator_id,publisher_id,status,tracking_code,tracking_url,published_post_url) VALUES('assign','c','s','p','approved','abcdefghijklmnopqrstuvwx','https://ads.example.test/c/abcdefghijklmnopqrstuvwx','https://www.youtube.com/watch?v=test')");
  addLedger({userId:'a',type:'DEPOSIT',amount:2,currency:'USD'});await new Promise(r=>setImmediate(r));db.close();
  const module=new URL('../src/social/core.js',import.meta.url).href,exec=promisify(execFile);
  const results=await Promise.all(Array.from({length:6},(_,i)=>exec(process.execPath,['--input-type=module','-e',`const {recordCreatorClick}=await import(${JSON.stringify(module)});const r=recordCreatorClick('abcdefghijklmnopqrstuvwx',{ip:'203.0.113.${i+1}',userAgent:'Mozilla/5.0 Chrome/140',browserId:'browser${i}',sessionId:'session${i}',country:'KE'});console.log(JSON.stringify({bill:r.billAmount}));`],{env:{...process.env,DB_PATH:process.env.DB_PATH},windowsHide:true,timeout:30000})));
  assert.equal(results.map(r=>JSON.parse(r.stdout).bill).reduce((n,b)=>n+b,0),2);
  const check=new Database(process.env.DB_PATH);try{assert.equal(check.prepare("SELECT SUM(amount) balance FROM ledger_entries WHERE user_id='a' AND status='finalized'").get().balance,0);assert.equal(check.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id='a' AND type='AD_CHARGE'").get().n,1);assert.equal(check.prepare('SELECT COUNT(*) n FROM creator_events').get().n,6);}finally{check.close();}
});
