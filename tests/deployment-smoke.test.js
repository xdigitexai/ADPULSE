import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';

test('production deployment smoke: boot, uploads, accounts, accounting and provider retries',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'adpulse-smoke-'));
  const payments=new Map(), withdrawals=[];
  let nextPayment=0, nextWithdrawal=0;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const data=raw?JSON.parse(raw):{};
    res.setHeader('content-type','application/json');
    if(req.url==='/payments/initiate'){
      const reference='mock-'+(++nextPayment);
      payments.set(reference,{reference,status:'pending',amount:data.amount,net_amount:data.amount,currency:data.currency});
      return res.end(JSON.stringify(payments.get(reference)));
    }
    if(req.url.startsWith('/payments/'))return res.end(JSON.stringify(payments.get(req.url.split('/')[2])));
    if(req.url==='/withdrawals'&&req.method==='POST'){
      const row={reference:'mock-w-'+(++nextWithdrawal),status:'processing',amount:data.amount,fee:data.amount*.03};
      withdrawals.push(row);return res.end(JSON.stringify(row));
    }
    if(req.url==='/withdrawals')return res.end(JSON.stringify({data:withdrawals}));
    res.end(JSON.stringify({success:true,data:[]}));
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  Object.assign(process.env,{NODE_ENV:'test',PORT:String(port),DB_PATH:path.join(tmp,'db.sqlite'),UPLOAD_DIR:path.join(tmp,'uploads'),APP_URL:`http://127.0.0.1:${port}`,ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:'Smoke-password-2026!',JWT_SECRET:'smoke-only-jwt-secret-with-more-than-32-chars',EVENT_SECRET:'smoke-only-event-secret-with-more-than-32-chars',DEMO_MODE:'false',PRODUCTION_STORES_REQUIRED:'false',DATABASE_URL:'',REDIS_URL:'',CLICKHOUSE_URL:'',IPINFO_TOKEN:'',AI_CONTEXT_API_URL:'',AI_CONTEXT_API_KEY:'',GOOGLE_CLIENT_ID:'',XDIGITEX_PAY_API_KEY:'mock-key',XDIGITEX_PAY_BASE_URL:`http://127.0.0.1:${provider.address().port}`});
  const {db,run,one,addLedger,balanceFor}=await import('../src/db.js');
  let logs='';const app=spawn(process.execPath,['src/server.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',s=>logs+=s);app.stderr.on('data',s=>logs+=s);
  t.after(async()=>{app.kill();await new Promise(r=>app.exitCode!==null?r():app.once('exit',r));await new Promise(r=>provider.close(r));db.close();fs.rmSync(tmp,{recursive:true,force:true});});
  const base=process.env.APP_URL;
  const api=async(url,{token,body,status=200,headers={},...options}={})=>{
    const response=await fetch(base+url,{...options,method:options.method||(body?'POST':'GET'),headers:{'user-agent':'Mozilla/5.0 DeploymentSmoke',...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const text=await response.text();assert.equal(response.status,status,url+' '+text);return text?JSON.parse(text):null;
  };
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Application did not boot: '+logs);
  const admin=(await api('/api/auth/login',{body:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}})).token;
  const accounts={};
  for(const role of ['advertiser','publisher'])accounts[role]=await api('/api/auth/register',{body:{role,email:role+'@example.test',name:'Smoke '+role,password:'Smoke-password-2026!'},status:201});
  const adv=accounts.advertiser, pub=accounts.publisher;
  await t.test('password login, role enforcement and demo funding disabled',async()=>{
    await api('/api/auth/login',{body:{email:'advertiser@example.test',password:'Smoke-password-2026!'}});
    await api('/api/admin/sites',{token:adv.token,status:403});
    await api('/api/advertiser/demo-fund',{token:adv.token,body:{amount:10},status:404});
  });
  await t.test('all supported creative uploads and unsafe file rejection',async()=>{
    for(const [mime,ext] of [['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif'],['video/mp4','mp4'],['video/webm','webm']]){
      const form=new FormData();form.set('file',new Blob(['smoke fixture'],{type:mime}),'creative.'+ext);
      const r=await fetch(base+'/api/advertiser/uploads',{method:'POST',headers:{authorization:'Bearer '+adv.token},body:form});
      assert.equal(r.status,201);const file=await r.json();assert.equal(file.mime,mime);assert.ok(fs.existsSync(path.join(tmp,'uploads',path.basename(file.path))));
    }
    const form=new FormData();form.set('file',new Blob(['<script>'],{type:'text/html'}),'bad.html');
    assert.equal((await fetch(base+'/api/advertiser/uploads',{method:'POST',headers:{authorization:'Bearer '+adv.token},body:form})).status,400);
  });
  const site=await api('/api/publisher/sites',{token:pub.token,body:{domain:'publisher.example.test'},status:201});
  await api('/api/publisher/zones',{token:pub.token,body:{siteId:site.id,name:'Unapproved'},status:400});
  await api('/api/admin/sites/'+site.id+'/status',{token:admin,body:{status:'approved'}});
  const zones={};
  await t.test('all eleven zones, native/video refresh disabled, production embed',async()=>{
    for(const format of ['responsive','300x250','336x280','728x90','970x250','320x50','320x100','300x600','160x600','native','video']){
      zones[format]=await api('/api/publisher/zones',{token:pub.token,body:{siteId:site.id,name:'Smoke '+format,format,refreshEnabled:true,refreshIntervalSeconds:45,refreshMax:3},status:201});
      assert.ok(zones[format].embed.includes(base+'/adpulse.js'));
      if(['native','video'].includes(format))assert.equal(one('SELECT refresh_enabled FROM zones WHERE id=?',[zones[format].id]).refresh_enabled,0);
    }
  });
  const campaigns={};
  addLedger({userId:adv.user.id,type:'TEST_FIXTURE',amount:100,currency:'USD'});
  for(const [model,creativeType] of [['CPM','display'],['CPC','native'],['HYBRID','video']]){
    campaigns[model]=await api('/api/advertiser/campaigns',{token:adv.token,body:{name:'Smoke '+model,destinationUrl:'https://example.com/landing',headline:'Smoke campaign',creativeType,imageUrl:'https://example.com/test.png',videoUrl:'https://example.com/test.mp4',model,cpm:2,cpc:.2,budgetTotal:50,budgetDaily:10,frequencyCapDaily:50},status:201});
    await api('/api/advertiser/campaigns/'+campaigns[model].id+'/status',{token:adv.token,body:{status:'active'},status:400});
  }
  let ipCounter=10;
  const serve=async(model,format='300x250',ip)=>{
    run("UPDATE campaigns SET status='paused'");run("UPDATE campaigns SET status='active' WHERE id=?",[campaigns[model].id]);
    const headers={'x-forwarded-for':ip||'198.51.100.'+(ipCounter++)};
    const result=await api('/serve?zone='+zones[format].publicKey,{headers});assert.equal(result.noFill,false);return {result,headers};
  };
  await t.test('CPM, CPC, hybrid charges, 75% held earnings and destination redirects',async()=>{
    for(const model of Object.keys(campaigns)){
      const {result,headers}=await serve(model,model==='HYBRID'?'video':model==='CPC'?'native':'300x250');
      const view=await api('/events',{headers,body:{token:result.token,type:'view',metadata:{visibilityPercent:100,visibleMs:2000,browserId:'browser-'+model}}});
      assert.equal(view.valid,true);assert.equal(view.billAmount,model==='CPC'?0:.002);
      const response=await fetch(base+'/r/click?t='+encodeURIComponent(result.token)+'&bid=browser-'+model,{headers:{...headers,'user-agent':'Mozilla/5.0 DeploymentSmoke'},redirect:'manual'});
      assert.equal(response.status,302);assert.equal(new URL(response.headers.get('location')).origin,'https://example.com');
      const click=one("SELECT * FROM ad_events WHERE request_id=? AND event_type='click'",[result.requestId]);assert.equal(click.valid,1);assert.equal(click.bill_amount,model==='CPM'?0:.2);
      assert.equal(click.publisher_amount,click.bill_amount*.75);
      if(click.bill_amount)assert.equal(one("SELECT status FROM ledger_entries WHERE event_id=? AND type='PUBLISHER_EARNING'",[click.id]).status,'pending');
      const dup=await api('/events',{headers,body:{token:result.token,type:'click'}});assert.equal(dup.valid,false);assert.equal(dup.billAmount,0);
      if(model==='HYBRID'){
        const vast=await fetch(base+'/vast?t='+encodeURIComponent(result.token));assert.equal(vast.status,200);assert.match(await vast.text(),/<ClickThrough>.*\/r\/click\?t=/);
      }
    }
  });
  await t.test('fraud: click without view, repeat browser/IP, self click, bot',async()=>{
    let {result,headers}=await serve('CPC');
    const noView=await api('/events',{headers,body:{token:result.token,type:'click'}});assert.equal(noView.billAmount,0);assert.ok(noView.reasons.includes('click_without_valid_view'));
    for(let i=0;i<3;i++){
      ({result,headers}=await serve('CPC','native','198.51.100.200'));
      await api('/events',{headers,body:{token:result.token,type:'view',metadata:{visibleMs:2000,visibilityPercent:100}}});
      const click=await api('/events',{headers,body:{token:result.token,type:'click',metadata:{browserId:i===1?'repeat-browser':'repeat-browser'}}});
      if(i===1)assert.ok(click.reasons.includes('repeat_browser_campaign_click'));
    }
    for(let i=0;i<3;i++){
      ({result,headers}=await serve('CPC','native','198.51.100.201'));
      await api('/events',{headers,body:{token:result.token,type:'view',metadata:{visibleMs:2000,visibilityPercent:100}}});
      const click=await api('/events',{headers,body:{token:result.token,type:'click',metadata:{browserId:'ip-test-browser-'+i}}});
      if(i===2){assert.equal(click.valid,false);assert.ok(click.reasons.includes('repeat_ip_campaign_click'));}
    }
    ({result,headers}=await serve('CPC'));
    run('INSERT INTO account_ip_history(id,user_id,ip_hash) VALUES(?,?,?)',['self-test',pub.user.id,(await import('../src/fraud.js')).hashIp(headers['x-forwarded-for'])]);
    await api('/events',{headers,body:{token:result.token,type:'view',metadata:{visibleMs:2000,visibilityPercent:100}}});
    assert.ok((await api('/events',{headers,body:{token:result.token,type:'click'}})).reasons.includes('publisher_self_click_ip'));
    assert.equal((await api('/serve?zone='+zones.native.publicKey,{headers:{'user-agent':'HeadlessChrome'}})).reason,'bot');
  });
  await t.test('pause/resume, budget changes preserve spend, OpenRTB fill/no-fill',async()=>{
    await api('/api/publisher/zones/'+zones.native.id+'/status',{token:pub.token,body:{status:'paused'}});
    assert.equal((await api('/serve?zone='+zones.native.publicKey)).noFill,true);
    await api('/api/publisher/zones/'+zones.native.id+'/status',{token:pub.token,body:{status:'active'}});
    const spent=one('SELECT spent_total FROM campaigns WHERE id=?',[campaigns.CPC.id]).spent_total;
    await api('/api/advertiser/campaigns/'+campaigns.CPC.id+'/budget',{token:adv.token,body:{increaseBy:10,dailyBudget:20}});
    assert.equal(one('SELECT spent_total FROM campaigns WHERE id=?',[campaigns.CPC.id]).spent_total,spent);
    for(const model of ['CPM','HYBRID']){
      await serve(model);
      const bid=await api('/openrtb2/auction',{body:{id:'bid-test',imp:[{id:'1',tagid:zones[model==='CPM'?'300x250':'video'].publicKey,banner:{w:300,h:250}}]}});assert.ok(bid.seatbid[0].bid[0].adm);
    }
    run("UPDATE campaigns SET status='paused'");
    await api('/openrtb2/auction',{body:{id:'no-fill',imp:[{id:'1',tagid:zones.native.publicKey}]},status:204});
  });
  await t.test('campaign schedule, targeting, frequency and exhausted budgets; attributable conversions',async()=>{
    await serve('CPC');
    const cid=campaigns.CPC.id,zone=zones.native.publicKey;
    for(const [sql,params] of [
      ["UPDATE campaigns SET starts_at=datetime('now','+1 day') WHERE id=?",[cid]],
      ["UPDATE campaigns SET starts_at=NULL,ends_at=datetime('now','-1 day') WHERE id=?",[cid]],
      ["UPDATE campaigns SET ends_at=NULL,target_devices='[\"mobile\"]' WHERE id=?",[cid]],
      ["UPDATE campaigns SET target_devices='[]',spent_today=budget_daily WHERE id=?",[cid]],
      ["UPDATE campaigns SET spent_today=0,spent_total=budget_total WHERE id=?",[cid]]
    ]){run(sql,params);assert.equal((await api('/serve?zone='+zone)).noFill,true);}
    run("UPDATE campaigns SET spent_total=.2,frequency_cap_daily=1 WHERE id=?",[cid]);
    const served=await api('/serve?zone='+zone,{headers:{'x-forwarded-for':'198.51.100.222'}});
    await api('/events',{headers:{'x-forwarded-for':'198.51.100.222'},body:{token:served.token,type:'view',metadata:{visibilityPercent:100,visibleMs:2000}}});
    assert.equal((await api('/serve?zone='+zone,{headers:{'x-forwarded-for':'198.51.100.222'}})).noFill,true);
    const click=one("SELECT request_id FROM ad_events WHERE campaign_id=? AND event_type='click' AND valid=1 LIMIT 1",[cid]);
    const body={campaignKey:campaigns.CPC.public_key,requestId:click.request_id,eventName:'purchase',value:3,externalId:'smoke-conversion'};
    await api('/collect/conversion',{body,status:201});await api('/collect/conversion',{body,status:409});
    const pending=one("SELECT id,user_id,currency FROM ledger_entries WHERE type='PUBLISHER_EARNING' AND status='pending' LIMIT 1");
    run("UPDATE ledger_entries SET created_at=datetime('now','-25 hours') WHERE id=?",[pending.id]);
    await api('/api/ledger',{token:pub.token});assert.equal(one('SELECT status FROM ledger_entries WHERE id=?',[pending.id]).status,'available');
  });
  await t.test('mock provider: pending/failed/success deposit, duplicate callback and withdrawal reversal',async()=>{
    const payment=await api('/api/payments/initiate',{token:adv.token,body:{amount:20,currency:'KES',gateway:'card'},status:201});
    let result=await api('/api/payments/'+payment.reference+'/status',{token:adv.token});assert.equal(result.credited,false);
    payments.get(payment.reference).status='failed';result=await api('/api/payments/'+payment.reference+'/status',{token:adv.token});assert.equal(result.credited,false);
    payments.get(payment.reference).status='completed';result=await api('/api/payments/'+payment.reference+'/status',{token:adv.token});assert.equal(result.credited,true);
    await api('/webhooks/xdigitex-pay',{body:{reference:payment.reference}});assert.equal(balanceFor(adv.user.id,'KES'),20);
    await api('/api/publisher/withdrawals',{token:pub.token,body:{amount:500,currency:'KES',accountNumber:'254700000000'},status:403});
    await api('/api/admin/kyc/'+pub.user.id+'/status',{token:admin,body:{status:'verified'}});
    await api('/api/publisher/withdrawals',{token:pub.token,body:{amount:499,currency:'KES',accountNumber:'254700000000'},status:400});
    addLedger({userId:pub.user.id,type:'TEST_FIXTURE',amount:2000,currency:'KES'});
    await api('/api/publisher/withdrawals',{token:pub.token,body:{amount:500,currency:'KES',accountNumber:'254700000000'},status:201});
    assert.equal(balanceFor(pub.user.id,'KES'),1485);
    withdrawals[0].status='failed';await api('/api/admin/finance/reconcile',{token:admin,body:{}});assert.equal(balanceFor(pub.user.id,'KES'),2000);
    await api('/api/admin/finance/reconcile',{token:admin,body:{}});assert.equal(balanceFor(pub.user.id,'KES'),2000);
    await api('/api/publisher/withdrawals',{token:pub.token,body:{amount:500,currency:'KES',accountNumber:'254700000000'},status:201});withdrawals[1].status='completed';await api('/api/admin/finance/reconcile',{token:admin,body:{}});assert.equal(balanceFor(pub.user.id,'KES'),1485);
  });
  await t.test('live support reply, deterministic AI fallback and analytics endpoints',async()=>{
    const chat=await api('/api/support/conversations',{body:{name:'Smoke Visitor',email:'visitor@example.test',message:'Help with setup'},status:201});
    await api('/api/admin/support/'+chat.conversationId+'/reply',{token:admin,body:{message:'We can help'},status:201});
    assert.ok((await api('/api/support/conversations/'+chat.conversationId+'?token='+chat.accessToken)).messages.some(x=>x.body==='We can help'));
    assert.ok(await api('/api/support/ai',{body:{message:'How do I advertise?'}}));
    const context=await (await import('../src/context-ai.js')).classifyPage({title:'Technology software cloud',text:'Learn about computers'});assert.equal(context.provider,'heuristic');
    assert.ok((await api('/api/analytics/advertiser',{token:adv.token})).totals.spend>0);
    assert.ok((await api('/api/analytics/publisher',{token:pub.token})).totals.revenue>0);
  });
  await t.test('strict production startup fails when required stores are unavailable',()=>{
    const failed=spawnSync(process.execPath,['src/server.js'],{env:{...process.env,PRODUCTION_STORES_REQUIRED:'true'},encoding:'utf8',timeout:10000});
    assert.notEqual(failed.status,0);assert.match(failed.stderr,/one or more production stores are unavailable/);
  });
  await t.test('owner house ads are restricted to selected sites and never move money',async()=>{
    const house=await api('/api/advertiser/campaigns',{token:admin,body:{name:'House promotion',destinationUrl:'https://example.com/house',headline:'Our sites',creativeType:'display',model:'CPM',cpm:2,budgetTotal:1,budgetDaily:1},status:201});
    run("UPDATE campaigns SET status='paused'");
    run("UPDATE campaigns SET status='active',is_house=1,cpm=0,house_site_ids=? WHERE id=?",[JSON.stringify([site.id]),house.id]);
    const before=one('SELECT COUNT(*) n FROM ledger_entries').n;
    const headers={'x-forwarded-for':'198.51.100.230'};
    const served=await api('/serve?zone='+zones['300x250'].publicKey,{headers});assert.equal(served.noFill,false);
    for(const type of ['view','click']){const e=await api('/events',{headers,body:{token:served.token,type,metadata:{visibleMs:2000,visibilityPercent:100}}});assert.equal(e.billAmount,0);assert.equal(e.publisherAmount,0);}
    assert.equal(one('SELECT COUNT(*) n FROM ledger_entries').n,before);
    await api('/api/publisher/zones/'+zones.native.id+'/display-settings',{token:pub.token,body:{displayMode:'inline'}});
    assert.equal((await api('/serve?zone='+zones.native.publicKey,{headers})).noFill,true);
    const config=await api('/zone-config?zone='+zones['300x250'].publicKey);assert.equal(config.settings.maxAdsPerSession,2);
    await api('/api/publisher/zones/'+zones['300x250'].id+'/display-settings',{token:adv.token,body:{pauseAds:true},status:403});
    await api('/api/publisher/zones/'+zones['300x250'].id+'/display-settings',{token:pub.token,body:{maxAdsPerSession:10},status:400});
    await api('/api/publisher/zones/'+zones['300x250'].id+'/display-settings',{token:pub.token,body:{minPopupDelaySeconds:35,maxPopupDelaySeconds:12},status:400});
    for(const type of ['dismiss','timeout_close','rotation']){const e=await api('/events',{headers,body:{token:served.token,type}});assert.equal(e.billAmount,0);assert.equal((await api('/events',{headers,body:{token:served.token,type}})).duplicate,true);}
    assert.equal(one('SELECT COUNT(*) n FROM ledger_entries').n,before);
    assert.equal((await api('/api/publisher/ux-analytics',{token:pub.token})).length,3);
    assert.equal((await api('/serve?zone='+zones['300x250'].publicKey+'&exclude='+house.id,{headers})).noFill,true);
    await api('/api/publisher/zones/'+zones['300x250'].id+'/display-settings',{token:pub.token,body:{pauseAds:true}});
    assert.equal((await api('/zone-config?zone='+zones['300x250'].publicKey)).enabled,false);
    assert.equal((await api('/serve?zone='+zones['300x250'].publicKey,{headers})).noFill,true);
    await api('/api/publisher/zones/'+zones['300x250'].id+'/display-settings',{token:pub.token,body:{pauseAds:false}});
    run('UPDATE campaigns SET house_site_ids=? WHERE id=?',['[]',house.id]);
    assert.equal((await api('/serve?zone='+zones['300x250'].publicKey,{headers})).noFill,true);
  });
});
