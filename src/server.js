import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { z } from 'zod';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { config } from './config.js';
import { db, id, one, all, run, balanceFor, addLedger, ensureAdmin } from './db.js';
import { register, login, auth } from './auth.js';
import { makeAdRequest, recordEvent, resetDailySpendIfNeeded } from './ad-engine.js';

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

app.get('/api/health',(req,res)=>res.json({ok:true,service:'adpulse',version:'0.1.0'}));

app.post('/api/auth/register',wrap(async(req,res)=>res.status(201).json(await register(req.body))));
app.post('/api/auth/login',wrap(async(req,res)=>res.json(await login(req.body.email,req.body.password))));
app.get('/api/me',auth(),(req,res)=>res.json({user:req.user,balance:balanceFor(req.user.id)}));

app.get('/api/dashboard',auth(),(req,res)=>{
  const u=req.user;
  if(u.role==='publisher'){
    return res.json({
      balance:balanceFor(u.id),
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

app.post('/api/publisher/sites',auth('publisher'),(req,res)=>{
  const schema=z.object({domain:z.string().min(3),category:z.string().default('general'),language:z.string().default('en')});
  const d=schema.parse(req.body), domain=normalizeDomain(d.domain);
  if(one('SELECT id FROM sites WHERE domain=?',[domain])) return res.status(409).json({error:'Domain already registered'});
  const site={id:id('site'),token:`ap_${crypto.randomBytes(12).toString('hex')}`};
  run('INSERT INTO sites(id,publisher_id,domain,verification_token,category,language) VALUES(?,?,?,?,?,?)',[site.id,req.user.id,domain,site.token,d.category,d.language]);
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
    }else{
      return res.status(400).json({error:'DNS verification is reserved for the production DNS resolver; use meta or file in this MVP'});
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

app.post('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>{
  const schema=z.object({
    name:z.string().min(2),destinationUrl:z.string().url(),headline:z.string().min(2).max(120),description:z.string().max(240).optional().default(''),imageUrl:z.string().url().optional().or(z.literal('')),
    model:z.enum(['CPM','CPC','HYBRID']),cpm:z.number().min(0).default(0),cpc:z.number().min(0).default(0),budgetTotal:z.number().positive(),budgetDaily:z.number().positive(),
    countries:z.array(z.string()).default([]),categories:z.array(z.string()).default([]),devices:z.array(z.string()).default([])
  });
  const d=schema.parse(req.body);
  if(d.model!=='CPC' && d.cpm<=0) return res.status(400).json({error:'CPM must be greater than zero'});
  if(d.model!=='CPM' && d.cpc<=0) return res.status(400).json({error:'CPC must be greater than zero'});
  const cid=id('cmp');
  run(`INSERT INTO campaigns(id,advertiser_id,name,destination_url,headline,description,image_url,model,cpm,cpc,budget_total,budget_daily,target_countries,target_categories,target_devices,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review')`,
    [cid,req.user.id,d.name,d.destinationUrl,d.headline,d.description,d.imageUrl||null,d.model,d.cpm,d.cpc,d.budgetTotal,d.budgetDaily,JSON.stringify(d.countries),JSON.stringify(d.categories),JSON.stringify(d.devices)]);
  res.status(201).json(one('SELECT * FROM campaigns WHERE id=?',[cid]));
});

app.get('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>res.json(all('SELECT * FROM campaigns WHERE advertiser_id=? ORDER BY created_at DESC',[req.user.id])));

app.post('/api/advertiser/demo-fund',auth('advertiser'),(req,res)=>{
  if(!config.demoMode) return res.status(404).json({error:'Not available'});
  const amount=Math.min(1000,Math.max(1,Number(req.body.amount||100)));
  addLedger({userId:req.user.id,type:'DEMO_DEPOSIT',amount,note:'Development-only demo funding'});
  res.json({balance:balanceFor(req.user.id)});
});

app.get('/api/ledger',auth(),(req,res)=>res.json({balance:balanceFor(req.user.id),entries:all('SELECT * FROM ledger_entries WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id])}));

app.get('/serve', (req,res)=>{
  const result=makeAdRequest({zoneKey:String(req.query.zone||''),ip:req.ip,userAgent:req.get('user-agent')||'',country:req.get('cf-ipcountry')||''});
  res.set('Cache-Control','no-store').json(result);
});

app.post('/events', (req,res)=>{
  const schema=z.object({token:z.string(),type:z.enum(['render','view','click','conversion']),metadata:z.record(z.any()).optional().default({})});
  const d=schema.parse(req.body);
  const result=recordEvent({token:d.token,eventType:d.type,ip:req.ip,userAgent:req.get('user-agent')||'',metadata:d.metadata});
  res.json(result);
});

app.get('/r/click',wrap(async(req,res)=>{
  const token=String(req.query.t||'');
  const result=recordEvent({token,eventType:'click',ip:req.ip,userAgent:req.get('user-agent')||'',metadata:{redirect:true}});
  const payload=await import('jsonwebtoken').then(m=>m.default.verify(token,config.eventSecret));
  const campaign=one('SELECT destination_url FROM campaigns WHERE id=?',[payload.campaignId]);
  if(!campaign) return res.status(404).send('Campaign unavailable');
  res.redirect(302,campaign.destination_url);
}));

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
