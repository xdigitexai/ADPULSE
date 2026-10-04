import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { z } from 'zod';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { config } from './config.js';
import { db, id, one, all, run, balanceFor, balancesFor, addLedger, ensureAdmin } from './db.js';
import { register, login, auth } from './auth.js';
import { makeAdRequest, recordEvent, resetDailySpendIfNeeded } from './ad-engine.js';
import { xdigitexPay, assertCurrency, assertGateway } from './xdigitex-pay.js';
import { initProductionStores, productionStatus, writeConversion } from './production-store.js';
import { classifyPage } from './context-ai.js';

await initProductionStores().catch(err=>console.error('Production stores unavailable, continuing with local fallback:',err.message));
await ensureAdmin();
resetDailySpendIfNeeded();

const app=express();
app.set('trust proxy',1);
app.use(cors());
app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(express.json({limit:'512kb'}));
app.use(express.static('public'));

const limiter=new RateLimiterMemory({points:180,duration:60});
app.use('/api',async(req,res,next)=>{try{await limiter.consume(req.ip);next()}catch{res.status(429).json({error:'Rate limit exceeded'})}});

const wrap=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const normalizeDomain=(raw)=>new URL(raw.match(/^https?:\/\//)?raw:`https://${raw}`).hostname.toLowerCase().replace(/^www\./,'');
const requireOwner=(row,userId,field)=>{ if(!row || (row[field]!==userId)) throw Object.assign(new Error('Not found'),{status:404}); };

app.get('/api/health',(req,res)=>res.json({ok:true,service:'adpulse',version:'0.3.0',stores:productionStatus()}));
app.get('/payment-return',(req,res)=>res.redirect('/?payment=return'));

app.post('/api/auth/register',wrap(async(req,res)=>res.status(201).json(await register(req.body))));
app.post('/api/auth/login',wrap(async(req,res)=>res.json(await login(req.body.email,req.body.password))));
app.get('/api/me',auth(),(req,res)=>res.json({user:req.user,balance:balanceFor(req.user.id),balances:balancesFor(req.user.id)}));

app.get('/api/dashboard',auth(),(req,res)=>{
  const u=req.user;
  if(u.role==='publisher'){
    return res.json({
      balance:balanceFor(u.id),
      balances:balancesFor(u.id),
      sites:all('SELECT * FROM sites WHERE publisher_id=? ORDER BY created_at DESC',[u.id]),
      zones:all('SELECT * FROM zones WHERE publisher_id=? ORDER BY created_at DESC',[u.id]),
      metrics:one(`SELECT COUNT(*) events,
        SUM(CASE WHEN event_type='view' AND valid=1 THEN 1 ELSE 0 END) views,
        SUM(CASE WHEN event_type='click' AND valid=1 THEN 1 ELSE 0 END) clicks,
        COALESCE(SUM(publisher_amount),0) revenue
        FROM ad_events WHERE publisher_id=?`,[u.id])
    });
  }
  if(u.role==='advertiser'){
    return res.json({
      balance:balanceFor(u.id),
      balances:balancesFor(u.id),
      campaigns:all('SELECT * FROM campaigns WHERE advertiser_id=? ORDER BY created_at DESC',[u.id]),
      metrics:one(`SELECT COUNT(*) events,
        SUM(CASE WHEN event_type='view' AND valid=1 THEN 1 ELSE 0 END) views,
        SUM(CASE WHEN event_type='click' AND valid=1 THEN 1 ELSE 0 END) clicks,
        COALESCE(SUM(bill_amount),0) spend
        FROM ad_events WHERE campaign_id IN (SELECT id FROM campaigns WHERE advertiser_id=?)`,[u.id])
    });
  }
  res.json({
    users:one('SELECT COUNT(*) n FROM users').n,
    sites:one('SELECT COUNT(*) n FROM sites').n,
    campaigns:one('SELECT COUNT(*) n FROM campaigns').n,
    spend:one('SELECT COALESCE(SUM(bill_amount),0) n FROM ad_events WHERE valid=1').n,
    pendingSites:all("SELECT s.*,u.email publisher_email FROM sites s JOIN users u ON u.id=s.publisher_id WHERE s.status IN ('pending_review','pending_verification') ORDER BY s.created_at DESC LIMIT 20"),
    pendingCampaigns:all("SELECT c.*,u.email advertiser_email FROM campaigns c JOIN users u ON u.id=c.advertiser_id WHERE c.status='pending_review' ORDER BY c.created_at DESC LIMIT 20")
  });
});

app.get('/sellers.json',(req,res)=>{
  const sellers=all("SELECT DISTINCT u.id,u.name,s.seller_id FROM sites s JOIN users u ON u.id=s.publisher_id WHERE s.status='approved' AND s.seller_id IS NOT NULL");
  res.json({
    sellers:sellers.map(x=>({seller_id:x.seller_id,name:x.name,seller_type:'PUBLISHER',is_confidential:0}))
  });
});

app.get('/ads.txt',(req,res)=>{
  const host=String(req.hostname||'').replace(/^www\./,'');
  const site=one("SELECT seller_id FROM sites WHERE domain=? AND status='approved'",[host]);
  res.type('text/plain').send(site?.seller_id?`${config.sellerDomain}, ${site.seller_id}, DIRECT\n`:'# No authorized ADPulse seller for this host\n');
});

app.post('/api/publisher/sites',auth('publisher'),(req,res)=>{
  const schema=z.object({domain:z.string().min(3),category:z.string().default('general'),language:z.string().default('en')});
  const d=schema.parse(req.body), domain=normalizeDomain(d.domain);
  if(one('SELECT id FROM sites WHERE domain=?',[domain])) return res.status(409).json({error:'Domain already registered'});
  const site={id:id('site'),token:`ap_${crypto.randomBytes(12).toString('hex')}`};
  run('INSERT INTO sites(id,publisher_id,domain,verification_token,category,language,seller_id) VALUES(?,?,?,?,?,?,?)',[site.id,req.user.id,domain,site.token,d.category,d.language,`PUB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`]);
  res.status(201).json({
    id:site.id,domain,verificationToken:site.token,
    methods:{
      meta:`<meta name="adpulse-site-verification" content="${site.token}">`,
      file:{path:`/adpulse-${site.token}.txt`,content:site.token},
      dns:`adpulse-verification=${site.token}`
    }
  });
});

app.post('/api/publisher/sites/:id/verify',auth('publisher'),wrap(async(req,res)=>{
  const site=one('SELECT * FROM sites WHERE id=?',[req.params.id]); requireOwner(site,req.user.id,'publisher_id');
  const method=req.body.method||'meta'; let verified=false, detail='';
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),7000);
  try{
    if(method==='meta'){
      const r=await fetch(`https://${site.domain}/`,{signal:controller.signal,headers:{'user-agent':'ADPulseVerifier/1.0'}});
      const html=await r.text(); verified=html.includes(site.verification_token); detail='meta';
    }else if(method==='file'){
      const r=await fetch(`https://${site.domain}/adpulse-${site.verification_token}.txt`,{signal:controller.signal});
      verified=(await r.text()).trim()===site.verification_token; detail='file';
    }else if(method==='dns'){
      const records=await dns.resolveTxt(site.domain);
      const flat=records.map(parts=>parts.join(''));
      verified=flat.includes(`adpulse-verification=${site.verification_token}`); detail='dns';
    }else{
      return res.status(400).json({error:'Unsupported verification method'});
    }
  } finally { clearTimeout(timeout); }
  if(verified) run("UPDATE sites SET status='pending_review',verification_method=? WHERE id=?",[method,site.id]);
  res.json({verified,status:verified?'pending_review':'pending_verification',method:detail});
}));

app.get('/api/publisher/sites',auth('publisher'),(req,res)=>res.json(all('SELECT * FROM sites WHERE publisher_id=? ORDER BY created_at DESC',[req.user.id])));

app.post('/api/publisher/zones',auth('publisher'),(req,res)=>{
  const schema=z.object({siteId:z.string(),name:z.string().min(2),format:z.string().default('responsive'),width:z.number().int().positive().optional(),height:z.number().int().positive().optional(),floorCpm:z.number().min(0).default(0)});
  const d=schema.parse(req.body), site=one('SELECT * FROM sites WHERE id=?',[d.siteId]); requireOwner(site,req.user.id,'publisher_id');
  if(site.status!=='approved') return res.status(400).json({error:'Site must be approved before creating live zones'});
  const zone={id:id('zone'),publicKey:`z_${crypto.randomBytes(10).toString('hex')}`};
  run('INSERT INTO zones(id,site_id,publisher_id,name,format,width,height,floor_cpm,public_key) VALUES(?,?,?,?,?,?,?,?,?)',[zone.id,site.id,req.user.id,d.name,d.format,d.width||null,d.height||null,d.floorCpm,zone.publicKey]);
  res.status(201).json({...zone,embed:`<div class="adpulse-ad" data-zone="${zone.publicKey}"></div><script async src="${config.appUrl}/adpulse.js"></script>`});
});

app.get('/api/publisher/zones',auth('publisher'),(req,res)=>res.json(all('SELECT z.*,s.domain FROM zones z JOIN sites s ON s.id=z.site_id WHERE z.publisher_id=? ORDER BY z.created_at DESC',[req.user.id])));

app.post('/api/publisher/sites/:id/verify-ads-txt',auth('publisher'),wrap(async(req,res)=>{
  const site=one('SELECT * FROM sites WHERE id=?',[req.params.id]); requireOwner(site,req.user.id,'publisher_id');
  if(site.status!=='approved') return res.status(400).json({error:'Site must be approved first'});
  const line=`${config.sellerDomain}, ${site.seller_id}, DIRECT`;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),7000);
  let found=false;
  try{
    const r=await fetch(`https://${site.domain}/ads.txt`,{signal:controller.signal,headers:{'user-agent':'ADPulseAdsTxtVerifier/1.0'}});
    const body=await r.text();
    found=body.split(/\r?\n/).map(x=>x.trim()).includes(line);
  } finally { clearTimeout(timer); }
  run('UPDATE sites SET ads_txt_status=? WHERE id=?',[found?'verified':'missing',site.id]);
  res.json({verified:found,requiredLine:line,status:found?'verified':'missing'});
}));

app.post('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>{
  const schema=z.object({
    name:z.string().min(2),destinationUrl:z.string().url(),headline:z.string().min(2).max(120),description:z.string().max(240).optional().default(''),imageUrl:z.string().url().optional().or(z.literal('')),
    model:z.enum(['CPM','CPC','HYBRID']),currency:z.enum(['KES','CDF','UGX','XOF','XAF','RWF','ZMW','SLE','USD']).default('USD'),cpm:z.number().min(0).default(0),cpc:z.number().min(0).default(0),budgetTotal:z.number().positive(),budgetDaily:z.number().positive(),frequencyCapDaily:z.number().int().min(1).max(50).default(3),conversionWindowDays:z.number().int().min(1).max(30).default(7),startsAt:z.string().optional(),endsAt:z.string().optional(),
    countries:z.array(z.string()).default([]),categories:z.array(z.string()).default([]),devices:z.array(z.string()).default([])
  });
  const d=schema.parse(req.body);
  if(d.model!=='CPC' && d.cpm<=0) return res.status(400).json({error:'CPM must be greater than zero'});
  if(d.model!=='CPM' && d.cpc<=0) return res.status(400).json({error:'CPC must be greater than zero'});
  const cid=id('cmp'), publicKey=`cmp_${crypto.randomBytes(12).toString('hex')}`;
  run(`INSERT INTO campaigns(id,advertiser_id,name,destination_url,headline,description,image_url,model,cpm,cpc,budget_total,budget_daily,currency,target_countries,target_categories,target_devices,status,frequency_cap_daily,conversion_window_days,starts_at,ends_at,public_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,?,?,?,?)`,
    [cid,req.user.id,d.name,d.destinationUrl,d.headline,d.description,d.imageUrl||null,d.model,d.cpm,d.cpc,d.budgetTotal,d.budgetDaily,d.currency,JSON.stringify(d.countries),JSON.stringify(d.categories),JSON.stringify(d.devices),d.frequencyCapDaily,d.conversionWindowDays,d.startsAt||null,d.endsAt||null,publicKey]);
  res.status(201).json(one('SELECT * FROM campaigns WHERE id=?',[cid]));
});

app.get('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>res.json(all('SELECT * FROM campaigns WHERE advertiser_id=? ORDER BY created_at DESC',[req.user.id])));

app.get('/api/payments/gateways',auth(),wrap(async(req,res)=>res.json(await xdigitexPay.gateways())));

app.post('/api/profile/kyc',auth(),(req,res)=>{
  const schema=z.object({phone:z.string().min(8).max(30),country:z.string().min(2).max(2)});
  const d=schema.parse(req.body);
  run("UPDATE users SET phone=?,country=?,kyc_status=CASE WHEN kyc_status='verified' THEN 'verified' ELSE 'pending' END WHERE id=?",[d.phone,d.country.toUpperCase(),req.user.id]);
  res.json({ok:true,kyc_status:req.user.kyc_status==='verified'?'verified':'pending'});
});

app.post('/api/payments/initiate',auth('advertiser'),wrap(async(req,res)=>{
  const schema=z.object({
    amount:z.number().positive(),
    currency:z.string(),
    gateway:z.string(),
    phone:z.string().optional(),
    firstName:z.string().max(80).optional(),
    lastName:z.string().max(80).optional(),
    description:z.string().max(180).optional()
  });
  const d=schema.parse(req.body), currency=assertCurrency(d.currency), gateway=assertGateway(d.gateway);
  if(gateway==='mobile' && !d.phone) return res.status(400).json({error:'Phone is required for pan-Africa mobile money'});
  const payload={
    amount:d.amount,currency,gateway,email:req.user.email,
    phone:d.phone||req.user.phone||undefined,
    first_name:d.firstName||req.user.name?.split(' ')[0]||'ADPulse',
    last_name:d.lastName||req.user.name?.split(' ').slice(1).join(' ')||'User',
    description:d.description||'ADPulse advertiser wallet deposit',
    callback_url:config.appUrl+'/payment-return',
    webhook_url:config.appUrl+'/webhooks/xdigitex-pay'
  };
  const result=await xdigitexPay.initiatePayment(payload);
  run(`INSERT OR IGNORE INTO payment_transactions(id,user_id,reference,kind,gateway,amount,fee,net_amount,currency,status,provider_payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [id('pay'),req.user.id,result.reference,'deposit',gateway,Number(result.amount??d.amount),Number(result.fee||0),Number(result.net_amount??0),currency,'pending',JSON.stringify(result)]);
  res.status(201).json(result);
}));

async function finalizeDeposit(reference){
  const tx=one("SELECT * FROM payment_transactions WHERE reference=? AND kind='deposit'",[reference]);
  if(!tx) throw Object.assign(new Error('Unknown payment reference'),{status:404});
  const status=await xdigitexPay.paymentStatus(reference);
  if(status.status!=='completed'){
    run('UPDATE payment_transactions SET status=?,provider_payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[status.status||'pending',JSON.stringify(status),tx.id]);
    return {credited:false,status};
  }
  const credit=Number(status.net_amount??status.amount??tx.net_amount??tx.amount);
  const currency=assertCurrency(status.currency||tx.currency);
  const apply=db.transaction(()=>{
    const fresh=one('SELECT * FROM payment_transactions WHERE id=?',[tx.id]);
    if(fresh.status==='completed') return false;
    run("UPDATE payment_transactions SET status='completed',amount=?,fee=?,net_amount=?,currency=?,provider_payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [Number(status.amount??tx.amount),Number(status.fee||0),credit,currency,JSON.stringify(status),tx.id]);
    addLedger({userId:tx.user_id,eventId:tx.id,type:'PAYMENT_DEPOSIT',amount:credit,currency,note:'Xdigitex Pay '+reference});
    return true;
  });
  return {credited:apply(),status};
}

app.get('/api/payments/:reference/status',auth(),wrap(async(req,res)=>{
  const tx=one('SELECT * FROM payment_transactions WHERE reference=?',[req.params.reference]);
  if(!tx || tx.user_id!==req.user.id) return res.status(404).json({error:'Payment not found'});
  res.json(await finalizeDeposit(req.params.reference));
}));

app.get('/api/payments',auth(),(req,res)=>res.json(all('SELECT * FROM payment_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[req.user.id])));

app.post('/webhooks/xdigitex-pay',wrap(async(req,res)=>{
  const reference=String(req.body?.reference||'');
  if(!reference) return res.status(400).json({error:'Missing reference'});
  const tx=one("SELECT * FROM payment_transactions WHERE reference=? AND kind='deposit'",[reference]);
  if(!tx) return res.status(202).json({ok:true,ignored:true});
  await finalizeDeposit(reference);
  res.json({ok:true});
}));

app.post('/api/publisher/withdrawals',auth('publisher'),wrap(async(req,res)=>{
  if(config.kycRequired && req.user.kyc_status!=='verified') return res.status(403).json({error:'KYC verification is required before withdrawal'});
  const schema=z.object({amount:z.number().positive(),currency:z.string(),accountNumber:z.string().min(8).max(30)});
  const d=schema.parse(req.body),currency=assertCurrency(d.currency);
  if(currency==='USD') return res.status(400).json({error:'Mobile-money withdrawal does not support USD on this route'});
  const reserve=Math.round(d.amount*1.03*1000000)/1000000;
  if(balanceFor(req.user.id,currency)<reserve) return res.status(400).json({error:'Insufficient balance including withdrawal fee'});
  const localId=id('wdr');
  addLedger({userId:req.user.id,eventId:localId,type:'WITHDRAWAL_HOLD',amount:-reserve,currency,note:'Withdrawal hold'});
  let result;
  try{
    result=await xdigitexPay.createWithdrawal({amount:d.amount,currency,method:'mobile_money',account_number:d.accountNumber});
  }catch(err){
    addLedger({userId:req.user.id,eventId:localId,type:'WITHDRAWAL_REVERSAL',amount:reserve,currency,note:'Withdrawal provider failure'});
    throw err;
  }
  const actualFee=Number(result.fee||d.amount*.03), actualTotal=d.amount+actualFee, adjustment=reserve-actualTotal;
  const tx=db.transaction(()=>{
    if(Math.abs(adjustment)>0.000001) addLedger({userId:req.user.id,eventId:localId,type:'WITHDRAWAL_FEE_ADJUSTMENT',amount:adjustment,currency,note:'Adjusted to provider fee'});
    run(`INSERT INTO payment_transactions(id,user_id,reference,kind,gateway,amount,fee,net_amount,currency,status,provider_payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [localId,req.user.id,result.reference,'withdrawal','mobile_money',d.amount,actualFee,d.amount,currency,result.status||'processing',JSON.stringify(result)]);
  });
  tx();
  res.status(201).json({...result,balance:balanceFor(req.user.id,currency)});
}));

app.post('/api/advertiser/demo-fund',auth('advertiser'),(req,res)=>{
  if(!config.demoMode) return res.status(404).json({error:'Not available'});
  const amount=Math.min(1000,Math.max(1,Number(req.body.amount||100)));
  addLedger({userId:req.user.id,type:'DEMO_DEPOSIT',amount,note:'Development-only demo funding'});
  res.json({balance:balanceFor(req.user.id)});
});

app.get('/api/ledger',auth(),(req,res)=>res.json({balance:balanceFor(req.user.id),balances:balancesFor(req.user.id),entries:all('SELECT * FROM ledger_entries WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id])}));

app.get('/api/analytics/publisher',auth('publisher'),(req,res)=>{
  const byDay=all(`SELECT substr(created_at,1,10) day,
    SUM(CASE WHEN event_type='request' THEN 1 ELSE 0 END) requests,
    SUM(CASE WHEN event_type='view' AND valid=1 THEN 1 ELSE 0 END) views,
    SUM(CASE WHEN event_type='click' AND valid=1 THEN 1 ELSE 0 END) clicks,
    ROUND(COALESCE(SUM(publisher_amount),0),6) revenue
    FROM ad_events WHERE publisher_id=? AND created_at>=datetime('now','-30 day')
    GROUP BY substr(created_at,1,10) ORDER BY day`,[req.user.id]);
  const totals=one(`SELECT
    SUM(CASE WHEN event_type='request' THEN 1 ELSE 0 END) requests,
    SUM(CASE WHEN event_type='view' AND valid=1 THEN 1 ELSE 0 END) views,
    SUM(CASE WHEN event_type='click' AND valid=1 THEN 1 ELSE 0 END) clicks,
    ROUND(COALESCE(SUM(publisher_amount),0),6) revenue,
    ROUND(100.0*SUM(CASE WHEN event_type='click' AND valid=1 THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN event_type='view' AND valid=1 THEN 1 ELSE 0 END),0),2) ctr
    FROM ad_events WHERE publisher_id=?`,[req.user.id]);
  res.json({totals,byDay});
});

app.get('/api/analytics/advertiser',auth('advertiser'),(req,res)=>{
  const totals=one(`SELECT
    SUM(CASE WHEN e.event_type='view' AND e.valid=1 THEN 1 ELSE 0 END) impressions,
    SUM(CASE WHEN e.event_type='click' AND e.valid=1 THEN 1 ELSE 0 END) clicks,
    ROUND(COALESCE(SUM(e.bill_amount),0),6) spend,
    ROUND(100.0*SUM(CASE WHEN e.event_type='click' AND e.valid=1 THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN e.event_type='view' AND e.valid=1 THEN 1 ELSE 0 END),0),2) ctr
    FROM ad_events e JOIN campaigns c ON c.id=e.campaign_id WHERE c.advertiser_id=?`,[req.user.id]);
  const conv=one('SELECT COUNT(*) conversions,ROUND(COALESCE(SUM(value),0),6) conversion_value FROM conversions WHERE advertiser_id=?',[req.user.id]);
  res.json({totals:{...totals,...conv}});
});

app.post('/collect/conversion',(req,res)=>{
  const schema=z.object({campaignKey:z.string(),requestId:z.string(),eventName:z.string().min(1).max(64),value:z.number().min(0).default(0),currency:z.string().default('USD'),externalId:z.string().max(120).optional(),metadata:z.record(z.any()).optional().default({})});
  const d=schema.parse(req.body);
  const campaign=one('SELECT * FROM campaigns WHERE public_key=?',[d.campaignKey]);
  if(!campaign) return res.status(404).json({error:'Campaign not found'});
  const click=one("SELECT id,created_at FROM ad_events WHERE request_id=? AND campaign_id=? AND event_type='click' AND valid=1 ORDER BY created_at DESC LIMIT 1",[d.requestId,campaign.id]);
  if(!click) return res.status(400).json({error:'No attributable valid click found'});
  const age=(Date.now()-new Date(click.created_at+'Z').getTime())/86400000;
  if(age>Number(campaign.conversion_window_days||7)) return res.status(400).json({error:'Conversion outside attribution window'});
  const cid=id('cnv');
  try{run('INSERT INTO conversions(id,campaign_id,advertiser_id,request_id,click_event_id,event_name,value,currency,external_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[cid,campaign.id,campaign.advertiser_id,d.requestId,click.id,d.eventName,d.value,d.currency.toUpperCase(),d.externalId||null,JSON.stringify(d.metadata)]);}
  catch(err){if(String(err.message).includes('UNIQUE')) return res.status(409).json({error:'Duplicate conversion externalId'});throw err}
  res.status(201).json({accepted:true,id:cid});
});

app.post('/api/conversions',auth('advertiser'),(req,res)=>{
  const schema=z.object({campaignId:z.string(),requestId:z.string().optional(),eventName:z.string().min(1).max(64),value:z.number().min(0).default(0),currency:z.string().default('USD'),externalId:z.string().max(120).optional(),metadata:z.record(z.any()).optional().default({})});
  const d=schema.parse(req.body);
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[d.campaignId]); requireOwner(campaign,req.user.id,'advertiser_id');
  if(d.requestId){
    const click=one("SELECT id,created_at FROM ad_events WHERE request_id=? AND campaign_id=? AND event_type='click' AND valid=1 ORDER BY created_at DESC LIMIT 1",[d.requestId,campaign.id]);
    if(!click) return res.status(400).json({error:'No attributable valid click found'});
    const age=(Date.now()-new Date(click.created_at+'Z').getTime())/86400000;
    if(age>Number(campaign.conversion_window_days||7)) return res.status(400).json({error:'Conversion is outside attribution window'});
  }
  const cid=id('cnv');
  try{
    run('INSERT INTO conversions(id,campaign_id,advertiser_id,request_id,event_name,value,currency,external_id,metadata) VALUES(?,?,?,?,?,?,?,?,?)',[cid,campaign.id,req.user.id,d.requestId||null,d.eventName,d.value,d.currency.toUpperCase(),d.externalId||null,JSON.stringify(d.metadata)]);
  }catch(err){
    if(String(err.message).includes('UNIQUE')) return res.status(409).json({error:'Duplicate conversion externalId'});
    throw err;
  }
  res.status(201).json({id:cid,accepted:true});
});

app.get('/serve',wrap(async(req,res)=>{
  const result=await makeAdRequest({zoneKey:String(req.query.zone||''),ip:req.ip,userAgent:req.get('user-agent')||'',country:req.get('cf-ipcountry')||''});
  res.set('Cache-Control','no-store').json(result);
}));

app.post('/events',wrap(async(req,res)=>{
  const schema=z.object({token:z.string(),type:z.enum(['render','view','click','conversion']),metadata:z.record(z.any()).optional().default({})});
  const d=schema.parse(req.body);
  const result=await recordEvent({token:d.token,eventType:d.type,ip:req.ip,userAgent:req.get('user-agent')||'',metadata:d.metadata});
  res.json(result);
}));

app.get('/r/click',wrap(async(req,res)=>{
  const token=String(req.query.t||'');
  const result=await recordEvent({token,eventType:'click',ip:req.ip,userAgent:req.get('user-agent')||'',metadata:{redirect:true}});
  const payload=await import('jsonwebtoken').then(m=>m.default.verify(token,config.eventSecret));
  const campaign=one('SELECT destination_url FROM campaigns WHERE id=?',[payload.campaignId]);
  if(!campaign) return res.status(404).send('Campaign unavailable');
  const target=new URL(campaign.destination_url); target.searchParams.set('_aprid',payload.requestId);
  res.redirect(302,target.toString());
}));

app.get('/api/admin/kyc',auth('admin'),(req,res)=>res.json(all("SELECT id,email,name,role,phone,country,kyc_status,created_at FROM users WHERE role!='admin' ORDER BY created_at DESC")));
app.post('/api/admin/kyc/:id/status',auth('admin'),(req,res)=>{
  const status=z.enum(['not_started','pending','verified','rejected']).parse(req.body.status);
  const user=one("SELECT id FROM users WHERE id=? AND role!='admin'",[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  run('UPDATE users SET kyc_status=? WHERE id=?',[status,user.id]);
  res.json({ok:true,status});
});

app.get('/api/admin/sites',auth('admin'),(req,res)=>res.json(all('SELECT s.*,u.email publisher_email FROM sites s JOIN users u ON u.id=s.publisher_id ORDER BY s.created_at DESC')));
app.post('/api/admin/sites/:id/status',auth('admin'),(req,res)=>{
  const status=z.enum(['approved','rejected','suspended','pending_review']).parse(req.body.status);
  const site=one('SELECT * FROM sites WHERE id=?',[req.params.id]); if(!site) return res.status(404).json({error:'Not found'});
  run('UPDATE sites SET status=? WHERE id=?',[status,site.id]);
  run('INSERT INTO moderation(id,object_type,object_id,action,admin_id,note) VALUES(?,?,?,?,?,?)',[id('mod'),'site',site.id,status,req.user.id,req.body.note||null]);
  res.json({ok:true,status});
});
app.post('/api/admin/campaigns/:id/status',auth('admin'),(req,res)=>{
  const status=z.enum(['active','rejected','paused','pending_review']).parse(req.body.status);
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[req.params.id]); if(!campaign) return res.status(404).json({error:'Not found'});
  run('UPDATE campaigns SET status=? WHERE id=?',[status,campaign.id]);
  run('INSERT INTO moderation(id,object_type,object_id,action,admin_id,note) VALUES(?,?,?,?,?,?)',[id('mod'),'campaign',campaign.id,status,req.user.id,req.body.note||null]);
  res.json({ok:true,status});
});
app.get('/api/admin/finance',auth('admin'),(req,res)=>{
  const totals=all(`SELECT currency,
    ROUND(SUM(CASE WHEN kind='deposit' AND status='completed' THEN net_amount ELSE 0 END),2) deposits,
    ROUND(SUM(CASE WHEN kind='withdrawal' AND status IN ('processing','completed') THEN amount+fee ELSE 0 END),2) withdrawals
    FROM payment_transactions GROUP BY currency ORDER BY currency`);
  const recent=all('SELECT p.*,u.email FROM payment_transactions p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 200');
  res.json({totals,recent});
});

app.post('/api/admin/finance/reconcile',auth('admin'),wrap(async(req,res)=>{
  const pendingDeposits=all("SELECT reference FROM payment_transactions WHERE kind='deposit' AND status IN ('pending','processing')");
  let depositsChecked=0,withdrawalsChecked=0,reversed=0;
  for(const p of pendingDeposits){ await finalizeDeposit(p.reference); depositsChecked++; }

  const provider=await xdigitexPay.withdrawals();
  const rows=Array.isArray(provider?.data)?provider.data:[];
  for(const remote of rows){
    const local=one("SELECT * FROM payment_transactions WHERE reference=? AND kind='withdrawal'",[remote.reference]);
    if(!local) continue;
    withdrawalsChecked++;
    const next=remote.status||local.status;
    if(next==='failed' && local.status!=='failed'){
      const already=one("SELECT id FROM ledger_entries WHERE event_id=? AND type='WITHDRAWAL_REVERSAL'",[local.id]);
      if(!already){
        addLedger({userId:local.user_id,eventId:local.id,type:'WITHDRAWAL_REVERSAL',amount:Number(local.amount)+Number(local.fee||0),currency:local.currency,note:'Provider withdrawal failed'});
        reversed++;
      }
    }
    run('UPDATE payment_transactions SET status=?,provider_payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[next,JSON.stringify(remote),local.id]);
  }
  res.json({ok:true,depositsChecked,withdrawalsChecked,reversed});
}));

app.get('/api/admin/fraud',auth('admin'),(req,res)=>res.json(all(`SELECT publisher_id,COUNT(*) events,
  SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END) invalid_events,
  ROUND(100.0*SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END)/COUNT(*),2) invalid_rate,
  ROUND(AVG(risk_score),2) avg_risk
  FROM ad_events GROUP BY publisher_id ORDER BY invalid_rate DESC LIMIT 100`)));

app.use((err,req,res,next)=>{
  console.error(err);
  if(err?.name==='ZodError') return res.status(400).json({error:'Validation failed',details:err.issues});
  res.status(err.status||500).json({error:err.status?err.message:'Internal server error'});
});

app.listen(config.port,()=>console.log(`ADPulse listening on :${config.port}`));
