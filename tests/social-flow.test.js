import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
process.env.DB_PATH=':memory:';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'creator-flow-'));process.env.UPLOAD_DIR=tmp;
const {registerSocial,creatorConversionHook}=await import('../src/social/routes.js');
const {auth,issueToken,issueSupportToken}=await import('../src/auth.js');
const {run,one,addLedger,balanceFor}=await import('../src/db.js');
test('zero-OAuth manual creator workflow, API roles, campaign review, submissions, click redirect and idempotent conversion',async t=>{
  const app=express();app.use(express.json());app.post('/api/conversions',auth('advertiser'),creatorConversionHook,(req,res)=>res.json({websiteFallback:true}));registerSocial(app,{validateDestination:async()=>{}});app.use((err,req,res,next)=>res.status(err.status||400).json({error:err.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});const base='http://127.0.0.1:'+server.address().port;
  const users={};for(const [id,role] of [['publisher','publisher'],['advertiser','advertiser'],['admin','admin'],['stranger','publisher']]){run("INSERT INTO users(id,email,password_hash,role,name,status) VALUES(?,?,'test',?,?,'active')",[id,id+'@example.test',role,id]);users[id]=issueToken({id,role,email:id+'@example.test'}).token;}
  async function request(route,user='publisher',data,options={}){const r=await fetch(base+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+(users[user]||user),'Content-Type':'application/json','User-Agent':'Mozilla/5.0 Chrome/140 Safari/537.36'},body:data?JSON.stringify(data):undefined,...options});return {status:r.status,body:r.headers.get('Content-Type')?.includes('json')?await r.json():await r.text(),headers:r.headers};}
  assert.equal((await request('/api/social/channels','publisher',{website:true,creator:true})).status,200);
  assert.equal((await request('/api/social/accounts','advertiser')).status,403);
  const account=await request('/api/social/accounts','publisher',{platform:'instagram',username:'demo',profileUrl:'https://www.instagram.com/demo/',country:'KE',language:'en',category:'technology'});assert.equal(account.status,201);assert.match(account.body.verification_code,/^ADPULSE-[A-F0-9]{16}$/);const aid=account.body.id;
  assert.equal((await request('/api/social/accounts/'+aid+'/verify','stranger',{evidenceUrl:'https://www.instagram.com/demo/'})).status,404);
  assert.equal((await request('/api/social/accounts/'+aid+'/verify','publisher',{evidenceUrl:'https://www.instagram.com/demo/'})).status,200);
  assert.equal((await request('/api/admin/social/accounts/'+aid+'/status','admin',{status:'verified',reason:'Isolated test evidence reviewed'})).status,200);
  const providerList=await request('/api/social/providers');assert.ok(providerList.body.every(p=>p.capabilities.manualExport&&!p.capabilities.directPublish));assert.equal((await request('/api/social/instagram/connect')).status,503);
  addLedger({userId:'advertiser',type:'DEPOSIT',amount:25,currency:'USD'});
  const campaign=await request('/api/creator/campaigns','advertiser',{name:'Demo sponsor',description:'An isolated sponsor campaign for manual publishing',destinationUrl:'https://shop.example.test/product',pricingModel:'HYBRID',currency:'USD',cpc:2,cpa:5,budgetTotal:25,budgetDaily:25,platforms:['instagram'],categories:['technology']});assert.equal(campaign.status,201);const cid=campaign.body.id;
  assert.equal((await request('/api/creator/campaigns/'+cid+'/status','advertiser',{status:'active'})).status,400);
  assert.equal((await request('/api/admin/social/campaigns/'+cid+'/status','admin',{status:'active',reason:'Isolated creative and destination review'})).status,200);
  const parallel=await Promise.all([request('/api/creator/campaigns/'+cid+'/accept','publisher',{accountId:aid}),request('/api/creator/campaigns/'+cid+'/accept','publisher',{accountId:aid})]);assert.deepEqual(parallel.map(r=>r.status).sort(),[201,409]);const assignment=parallel.find(r=>r.status===201).body;
  const upload=new FormData();upload.append('file',new Blob(['fixture media'],{type:'video/mp4'}),'source.mp4');const uploaded=await fetch(base+'/api/creator/upload',{method:'POST',headers:{Authorization:'Bearer '+users.publisher},body:upload}).then(r=>r.json());assert.ok(uploaded.url?.endsWith('.mp4'));
  const render=await request('/api/creator/assignments/'+assignment.id+'/render','publisher',{sourceUrl:uploaded.url,overlay:{headline:'Demo sponsor'},content:'My original clip'});assert.equal(render.status,202);assert.ok(render.body.caption.includes('Sponsored'));assert.ok(render.body.caption.includes(assignment.tracking_url));assert.equal((await request('/api/creator/jobs/'+render.body.jobId,'stranger')).status,404);
  // Separate real FFmpeg test covers rendering. This fixture tests the review state machine.
  run("UPDATE creator_assets SET status='ready',rendered_video_url=? WHERE id=?",[uploaded.url,render.body.assetId]);
  assert.equal((await request('/api/creator/assignments/'+assignment.id+'/submit','publisher',{assetId:render.body.assetId,postUrl:'https://evil.test/reel/abc',caption:render.body.caption})).status,400);
  assert.equal((await request('/api/creator/assignments/'+assignment.id+'/submit','publisher',{assetId:render.body.assetId,postUrl:'https://www.instagram.com/reel/abcdef/',caption:render.body.caption})).status,200);
  assert.equal((await request('/api/creator/assignments/'+assignment.id+'/review','stranger',{status:'approved',reason:'Wrong owner'})).status,403);
  assert.equal((await request('/api/creator/assignments/'+assignment.id+'/review','advertiser',{status:'approved',reason:'Content conforms to brief'})).status,200);
  const click=await request('/c/'+assignment.tracking_code,'publisher',undefined,{redirect:'manual'});assert.equal(click.status,302);const target=new URL(click.headers.get('location'));const attribution=target.searchParams.get('adpulse_creator');assert.ok(attribution);assert.equal(balanceFor('advertiser'),23);assert.equal(balanceFor('publisher'),0);
  const conversion={campaignId:cid,attributionId:attribution,externalId:'test-order-1',eventName:'purchase',value:20,currency:'USD'};const results=await Promise.all([request('/api/conversions','advertiser',conversion),request('/api/conversions','advertiser',conversion)]);assert.ok(results.every(r=>r.status===201));assert.equal(results.filter(r=>r.body.duplicate).length,1);assert.equal(balanceFor('advertiser'),18);
  assert.equal((await request('/api/conversions','advertiser',{campaignId:'website-campaign'})).body.websiteFallback,true);
  const repeated=await request('/c/'+assignment.tracking_code,'publisher',undefined,{redirect:'manual',headers:{Cookie:click.headers.get('set-cookie'),'User-Agent':'Mozilla/5.0 Chrome/140'}});assert.equal(repeated.status,302);assert.equal(balanceFor('advertiser'),18);
  run("INSERT INTO admin_support_sessions(id,admin_id,user_id,expires_at) VALUES('support-test','admin','publisher',datetime('now','+15 minutes'))");const support=issueSupportToken({id:'publisher',role:'publisher'}, {id:'admin',email:'admin@example.test'},'support-test').token;assert.equal((await request('/api/social/channels',support,{website:true,creator:false})).status,403);
  const admin=await request('/api/admin/social','admin');assert.ok(admin.body.audit.length>=5);assert.ok(admin.body.payouts.some(l=>l.type==='PUBLISHER_EARNING'&&l.status==='pending'));
});
