import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { config } from './config.js';
import {campaignDelivery} from './campaign-delivery.js';
import { zoneDisplaySettings, mergeDisplaySettings } from './display-settings.js';
import { db, id, one, all, run, balanceFor, balancesFor, addLedger, ensureAdmin, finalizeMaturePublisherEarnings } from './db.js';
import { register, login, loginWithGoogle, auth, issueSupportToken } from './auth.js';
import { makeAdRequest, recordEvent, resetDailySpendIfNeeded, verifyEvent } from './ad-engine.js';
import { xdigitexPay, assertCurrency, assertGateway } from './xdigitex-pay.js';
import { initProductionStores, productionStatus, writeConversion, mirrorSiteContext } from './production-store.js';
import { classifyPage } from './context-ai.js';
import { answerSupport } from './support-ai.js';
import { classifyPageForZone } from './page-context.js';
import { hashIp } from './fraud.js';
import { fetchPublisherPath, safeFetchUrl } from './safe-fetch.js';
import { updateAudienceSignal, isSensitiveInterest } from './audience-engine.js';

const storeState=await initProductionStores().catch(err=>{console.error('Production stores unavailable:',err.message);return {postgres:false,redis:false,clickhouse:false}});
if(config.productionStoresRequired && (!storeState.postgres || !storeState.redis || !storeState.clickhouse)) throw new Error('PRODUCTION_STORES_REQUIRED is enabled but one or more production stores are unavailable');
await ensureAdmin();
resetDailySpendIfNeeded();

const app=express();
fs.mkdirSync(config.uploadDir,{recursive:true});
const creativeExtensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm'};
const upload=multer({
  storage:multer.diskStorage({
    destination:config.uploadDir,
    filename:(req,file,cb)=>cb(null,crypto.randomUUID()+creativeExtensions[file.mimetype])
  }),
  limits:{fileSize:100*1024*1024,files:1},
  fileFilter:(req,file,cb)=>creativeExtensions[file.mimetype]
    ?cb(null,true):cb(Object.assign(new Error('Use JPEG, PNG, WebP, GIF, MP4 or WebM creatives'),{status:400}))
});
app.set('trust proxy',1);
app.use(cors());
app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(express.json({limit:'512kb'}));
app.get(['/','/index.html'],(req,res)=>{
  // GIS popup fallback needs its opener to survive cross-origin navigation.
  res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  const canonical=new URL('/',config.appUrl).href.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const html=fs.readFileSync('public/index.html','utf8').replace('</head>',`<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"></head>`);
  res.type('html').send(html);
});
app.use(express.static('public'));

const limiter=new RateLimiterMemory({points:180,duration:60});
app.use('/api',async(req,res,next)=>{try{await limiter.consume(req.ip);next()}catch{res.status(429).json({error:'Rate limit exceeded'})}});

const wrap=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const normalizeDomain=(raw)=>new URL(raw.match(/^https?:\/\//)?raw:`https://${raw}`).hostname.toLowerCase().replace(/^www\./,'');
const requireOwner=(row,userId,field)=>{ if(!row || (row[field]!==userId)) throw Object.assign(new Error('Not found'),{status:404}); };
const AD_FORMATS={responsive:[null,null],'300x250':[300,250],'336x280':[336,280],'728x90':[728,90],'970x250':[970,250],'320x50':[320,50],'320x100':[320,100],'300x600':[300,600],'160x600':[160,600],'native':[null,null],'video':[640,360]};
const xmlEscape=x=>String(x??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));

app.get('/robots.txt',(req,res)=>res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\nSitemap: ${config.appUrl.replace(/\/$/,'')}/sitemap.xml\n`));
app.get('/sitemap.xml',(req,res)=>{
  const base=config.appUrl.replace(/\/$/,'');
  const pages=['/','/policies.html','/privacy.html'];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p=>`<url><loc>${base}${p}</loc><changefreq>${p==='/'?'daily':'monthly'}</changefreq><priority>${p==='/'?'1.0':'0.5'}</priority></url>`).join('')}</urlset>`);
});
app.get('/api/health',(req,res)=>res.json({ok:true,service:'adpulse',version:'0.4.0',stores:productionStatus()}));
app.get('/payment-return',(req,res)=>res.redirect('/?payment=return'));

app.post('/api/auth/register',wrap(async(req,res)=>{const result=await register(req.body);run("INSERT INTO account_ip_history(id,user_id,ip_hash) VALUES(?,?,?) ON CONFLICT(user_id,ip_hash) DO UPDATE SET last_seen=CURRENT_TIMESTAMP",[id('aip'),result.user.id,hashIp(req.ip)]);res.status(201).json(result)}));
app.post('/api/auth/login',wrap(async(req,res)=>{const result=await login(req.body.email,req.body.password);run("INSERT INTO account_ip_history(id,user_id,ip_hash) VALUES(?,?,?) ON CONFLICT(user_id,ip_hash) DO UPDATE SET last_seen=CURRENT_TIMESTAMP",[id('aip'),result.user.id,hashIp(req.ip)]);res.json(result)}));
app.get('/api/auth/google/config',(req,res)=>res.json({clientId:config.googleClientId||null}));
app.post('/api/auth/google',wrap(async(req,res)=>{const role=['advertiser','publisher'].includes(req.body?.role)?req.body.role:null;const result=await loginWithGoogle(req.body?.credential,role);if(result.needsRole)return res.json(result);run("INSERT INTO account_ip_history(id,user_id,ip_hash) VALUES(?,?,?) ON CONFLICT(user_id,ip_hash) DO UPDATE SET last_seen=CURRENT_TIMESTAMP",[id('aip'),result.user.id,hashIp(req.ip)]);res.json(result)}));
app.get('/api/me',auth(),(req,res)=>res.json({user:req.user,balance:balanceFor(req.user.id),balances:balancesFor(req.user.id)}));

app.get('/api/dashboard',auth(),(req,res)=>{
  finalizeMaturePublisherEarnings();
  const u=req.user;
  if(u.role==='publisher'){
    return res.json({
      balance:balanceFor(u.id),
      balances:balancesFor(u.id),
      sites:all("SELECT s.*, (SELECT COUNT(DISTINCT request_id) FROM ad_events WHERE site_id=s.id AND event_type='render') ads_shown,(SELECT COUNT(DISTINCT request_id) FROM ad_events WHERE site_id=s.id AND event_type='view' AND valid=1) impressions FROM sites s WHERE publisher_id=? ORDER BY created_at DESC",[u.id]),
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
      campaigns:all('SELECT * FROM campaigns WHERE advertiser_id=? ORDER BY created_at DESC',[u.id]).map(c=>({...c,delivery:campaignDelivery(c)})),
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

app.get('/context',wrap(async(req,res)=>{
  const result=await classifyPageForZone({zoneKey:String(req.query.zone||''),pageUrl:String(req.query.url||'')});
  res.set('Cache-Control','private, max-age=300').json(result);
}));

app.post('/audience/signal',(req,res)=>{
  const schema=z.object({
    contextToken:z.string(),
    browserId:z.string().max(128).optional().default(''),
    sessionId:z.string().max(128).optional().default(''),
    personalizationAllowed:z.boolean().default(false),
    weight:z.number().min(.01).max(.5).default(.12)
  });
  const d=schema.parse(req.body);
  let ctx;
  try{ctx=verifyEvent(d.contextToken)}catch{return res.status(400).json({error:'Invalid context token'})}
  if(ctx.type!=='context') return res.status(400).json({error:'Invalid context token type'});
  updateAudienceSignal({browserId:d.browserId,sessionId:d.sessionId,topics:ctx.topics||[],category:ctx.category||'',personalizationAllowed:d.personalizationAllowed,weight:d.weight});
  res.status(204).end();
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
  if(method==='meta'){
      const r=await fetchPublisherPath(site.domain,'/',{headers:{'user-agent':'ADPulseVerifier/1.0'}});
      const html=await r.text(); verified=html.includes(site.verification_token); detail='meta';
    }else if(method==='file'){
      const r=await fetchPublisherPath(site.domain,`/adpulse-${site.verification_token}.txt`,{headers:{'user-agent':'ADPulseVerifier/1.0'}});
      verified=(await r.text()).trim()===site.verification_token; detail='file';
    }else if(method==='dns'){
      const records=await dns.resolveTxt(site.domain);
      const flat=records.map(parts=>parts.join(''));
      verified=flat.includes(`adpulse-verification=${site.verification_token}`); detail='dns';
    }else{
      return res.status(400).json({error:'Unsupported verification method'});
    }
  const autoApprove=one("SELECT value FROM system_settings WHERE key='auto_approve_domains'")?.value!=='false';
  const status=verified?(['rejected','suspended'].includes(site.status)?site.status:site.status==='approved'||autoApprove?'approved':'pending_review'):site.status;
  if(verified) run('UPDATE sites SET status=?,verification_method=? WHERE id=?',[status,method,site.id]);
  res.json({verified,status,method:detail});
}));

app.get('/api/publisher/sites',auth('publisher'),(req,res)=>res.json(all("SELECT s.*, (SELECT COUNT(DISTINCT request_id) FROM ad_events WHERE site_id=s.id AND event_type='render') ads_shown,(SELECT COUNT(DISTINCT request_id) FROM ad_events WHERE site_id=s.id AND event_type='view' AND valid=1) impressions,(SELECT COUNT(*) FROM ad_events WHERE site_id=s.id AND event_type='request') ad_requests FROM sites s WHERE publisher_id=? ORDER BY created_at DESC",[req.user.id])));

app.post('/api/publisher/zones',auth('publisher'),(req,res)=>{
  const schema=z.object({siteId:z.string(),name:z.string().min(2),format:z.enum(['responsive','300x250','336x280','728x90','970x250','320x50','320x100','300x600','160x600','native','video']).default('responsive'),floorCpm:z.number().min(0).default(0),refreshEnabled:z.boolean().default(false),refreshIntervalSeconds:z.number().int().min(30).max(300).default(45),refreshMax:z.number().int().min(0).max(10).default(3)});
  const d=schema.parse(req.body), site=one('SELECT * FROM sites WHERE id=?',[d.siteId]); requireOwner(site,req.user.id,'publisher_id');
  if(site.status!=='approved') return res.status(400).json({error:'Site must be approved before creating live zones'});
  const zone={id:id('zone'),publicKey:`z_${crypto.randomBytes(10).toString('hex')}`};
  const [width,height]=AD_FORMATS[d.format];
  const refreshEnabled=['native','video'].includes(d.format)?0:(d.refreshEnabled?1:0);
  run('INSERT INTO zones(id,site_id,publisher_id,name,format,width,height,floor_cpm,refresh_enabled,refresh_interval_seconds,refresh_max,public_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[zone.id,site.id,req.user.id,d.name,d.format,width,height,d.floorCpm,refreshEnabled,d.refreshIntervalSeconds,d.refreshMax,zone.publicKey]);
  res.status(201).json({...zone,embed:`<div class="adpulse-ad" data-zone="${zone.publicKey}"></div><script async src="${config.appUrl}/adpulse.js"></script>`});
});

app.get('/api/publisher/zones',auth('publisher'),(req,res)=>res.json(all('SELECT z.*,s.domain FROM zones z JOIN sites s ON s.id=z.site_id WHERE z.publisher_id=? ORDER BY z.created_at DESC',[req.user.id])));
app.get('/api/publisher/zones/:id/display-settings',auth('publisher'),(req,res)=>{
  const zone=one('SELECT * FROM zones WHERE id=?',[req.params.id]);requireOwner(zone,req.user.id,'publisher_id');res.json(zoneDisplaySettings(zone));
});
app.post('/api/publisher/zones/:id/display-settings',auth('publisher'),(req,res)=>{
  const zone=one('SELECT * FROM zones WHERE id=?',[req.params.id]);requireOwner(zone,req.user.id,'publisher_id');
  const settings=mergeDisplaySettings(zone,req.body);run('UPDATE zones SET display_settings=? WHERE id=?',[JSON.stringify(settings),zone.id]);res.json(settings);
});
app.get('/zone-config',(req,res)=>{
  const zone=one('SELECT z.*,s.status AS site_status FROM zones z JOIN sites s ON s.id=z.site_id WHERE z.public_key=?',[String(req.query.zone||'')]);
  if(!zone)return res.status(404).json({enabled:false});
  const settings=zoneDisplaySettings(zone);res.set('Cache-Control','no-store').json({enabled:zone.status==='active'&&zone.site_status==='approved'&&!settings.pauseAds,settings});
});
app.get('/api/publisher/ux-analytics',auth('publisher'),(req,res)=>res.json(all('SELECT event_type,COUNT(*) AS count FROM ad_ux_events WHERE publisher_id=? GROUP BY event_type',[req.user.id])));
app.get('/api/publisher/payout-minimums',auth('publisher'),(req,res)=>res.json(config.minimumPayouts));
app.post('/api/publisher/zones/:id/status',auth('publisher'),(req,res)=>{
  const zone=one('SELECT * FROM zones WHERE id=?',[req.params.id]); requireOwner(zone,req.user.id,'publisher_id');
  const status=z.enum(['active','paused']).parse(req.body.status);
  run('UPDATE zones SET status=? WHERE id=?',[status,zone.id]);
  res.json({ok:true,status});
});

app.post('/api/publisher/sites/:id/verify-ads-txt',auth('publisher'),wrap(async(req,res)=>{
  const site=one('SELECT * FROM sites WHERE id=?',[req.params.id]); requireOwner(site,req.user.id,'publisher_id');
  if(site.status!=='approved') return res.status(400).json({error:'Site must be approved first'});
  const line=`${config.sellerDomain}, ${site.seller_id}, DIRECT`;
  let found=false;
  const r=await fetchPublisherPath(site.domain,'/ads.txt',{headers:{'user-agent':'ADPulseAdsTxtVerifier/1.0'}});
  const body=await r.text();
  found=body.split(/\r?\n/).map(x=>x.trim()).includes(line);
  run('UPDATE sites SET ads_txt_status=? WHERE id=?',[found?'verified':'missing',site.id]);
  res.json({verified:found,requiredLine:line,status:found?'verified':'missing'});
}));

app.post('/api/publisher/sites/:id/analyze',auth('publisher'),wrap(async(req,res)=>{
  const site=one('SELECT * FROM sites WHERE id=?',[req.params.id]); requireOwner(site,req.user.id,'publisher_id');
  const r=await fetchPublisherPath(site.domain,'/',{headers:{'user-agent':'ADPulseContextBot/1.0'},timeoutMs:8000});
  const html=await r.text();
  const title=(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||site.domain).trim();
  const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,20000);
  const result=await classifyPage({url:`https://${site.domain}/`,title,text});
  run('UPDATE sites SET category=?,language=?,topics=?,brand_safety=? WHERE id=?',[result.category||site.category,result.language||site.language,JSON.stringify(result.topics||[]),result.brandSafety||'standard',site.id]);
  res.json(result);
}));

app.get('/api/support/config',(req,res)=>{
  const email=one("SELECT value FROM system_settings WHERE key='support_email'")?.value||config.supportEmail;
  const whatsapp=one("SELECT value FROM system_settings WHERE key='support_whatsapp'")?.value||config.supportWhatsapp;
  res.json({email,whatsapp,liveChat:config.supportChatEnabled});
});

app.post('/api/support/ai',wrap(async(req,res)=>{
  const schema=z.object({message:z.string().min(1).max(4000),role:z.string().optional()});
  const d=schema.parse(req.body);
  res.json(await answerSupport(d.message,{role:d.role||'guest'}));
}));

app.post('/api/support/conversations',(req,res)=>{
  if(!config.supportChatEnabled) return res.status(503).json({error:'Live chat is currently unavailable'});
  const schema=z.object({name:z.string().min(2).max(100),email:z.string().email(),subject:z.string().max(120).default('Sales & Support'),message:z.string().min(1).max(4000)});
  const d=schema.parse(req.body), cid=id('chat'), token=crypto.randomBytes(18).toString('hex');
  const tx=db.transaction(()=>{
    run('INSERT INTO support_conversations(id,email,name,subject,status,access_token) VALUES(?,?,?,?,?,?)',[cid,d.email,d.name,d.subject,'open',token]);
    run('INSERT INTO support_messages(id,conversation_id,sender_type,body) VALUES(?,?,?,?)',[id('msg'),cid,'user',d.message]);
  }); tx();
  res.status(201).json({conversationId:cid,accessToken:token,status:'open'});
});

app.get('/api/support/conversations/:id',(req,res)=>{
  const conv=one('SELECT * FROM support_conversations WHERE id=?',[req.params.id]);
  if(!conv || conv.access_token!==String(req.query.token||'')) return res.status(404).json({error:'Conversation not found'});
  res.json({conversation:conv,messages:all('SELECT * FROM support_messages WHERE conversation_id=? ORDER BY created_at',[conv.id])});
});

app.post('/api/support/conversations/:id/messages',(req,res)=>{
  const conv=one('SELECT * FROM support_conversations WHERE id=?',[req.params.id]);
  if(!conv || conv.access_token!==String(req.body.token||'')) return res.status(404).json({error:'Conversation not found'});
  const body=z.string().min(1).max(4000).parse(req.body.message);
  run('INSERT INTO support_messages(id,conversation_id,sender_type,body) VALUES(?,?,?,?)',[id('msg'),conv.id,'user',body]);
  run('UPDATE support_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?',[conv.id]);
  res.status(201).json({ok:true});
});

app.post('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>{
  const schema=z.object({
    name:z.string().min(2),destinationUrl:z.string().url(),headline:z.string().min(2).max(120),description:z.string().max(240).optional().default(''),imageUrl:z.string().url().optional().or(z.literal('')),videoUrl:z.string().url().optional().or(z.literal('')),creativeType:z.enum(['display','native','video']).default('display'),
    model:z.enum(['CPM','CPC','HYBRID']),currency:z.enum(['KES','CDF','UGX','XOF','XAF','RWF','ZMW','SLE','USD']).default('USD'),cpm:z.number().min(0).default(0),cpc:z.number().min(0).default(0),budgetTotal:z.number().positive(),budgetDaily:z.number().positive(),frequencyCapDaily:z.number().int().min(1).max(50).default(3),conversionWindowDays:z.number().int().min(1).max(30).default(7),startsAt:z.string().optional(),endsAt:z.string().optional(),
    countries:z.array(z.string()).default([]),categories:z.array(z.string()).default([]),devices:z.array(z.string()).default([]),interests:z.array(z.string()).default([]),excludeInterests:z.array(z.string()).default([])
  });
  const d=schema.parse(req.body);
  if(d.model!=='CPC' && d.cpm<=0) return res.status(400).json({error:'CPM must be greater than zero'});
  if(d.model!=='CPM' && d.cpc<=0) return res.status(400).json({error:'CPC must be greater than zero'});
  if(d.interests.some(isSensitiveInterest)) return res.status(400).json({error:'Sensitive interests cannot be used for persistent audience targeting. Use contextual category targeting instead.'});
  const cid=id('cmp'), publicKey=`cmp_${crypto.randomBytes(12).toString('hex')}`;
  run(`INSERT INTO campaigns(id,advertiser_id,name,destination_url,headline,description,image_url,video_url,creative_type,model,cpm,cpc,budget_total,budget_daily,currency,target_countries,target_categories,target_devices,target_interests,exclude_interests,status,frequency_cap_daily,conversion_window_days,starts_at,ends_at,public_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,?,?,?,?)`,
    [cid,req.user.id,d.name,d.destinationUrl,d.headline,d.description,d.imageUrl||null,d.videoUrl||null,d.creativeType,d.model,d.cpm,d.cpc,d.budgetTotal,d.budgetDaily,d.currency,JSON.stringify(d.countries),JSON.stringify(d.categories),JSON.stringify(d.devices),JSON.stringify(d.interests),JSON.stringify(d.excludeInterests),d.frequencyCapDaily,d.conversionWindowDays,d.startsAt||null,d.endsAt||null,publicKey]);
  res.status(201).json(one('SELECT * FROM campaigns WHERE id=?',[cid]));
});

app.get('/api/advertiser/campaigns',auth('advertiser'),(req,res)=>res.json(all('SELECT * FROM campaigns WHERE advertiser_id=? ORDER BY created_at DESC',[req.user.id]).map(c=>({...c,delivery:campaignDelivery(c)}))));
app.post('/api/advertiser/campaigns/:id/status',auth('advertiser'),(req,res)=>{
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[req.params.id]); requireOwner(campaign,req.user.id,'advertiser_id');
  const status=z.enum(['active','paused']).parse(req.body.status);
  if(status==='active' && !['paused','active'].includes(campaign.status)) return res.status(400).json({error:'Only an active/paused campaign can be resumed. Campaign review may still be required.'});
  run('UPDATE campaigns SET status=? WHERE id=?',[status,campaign.id]);
  res.json({ok:true,status});
});
app.post('/api/advertiser/campaigns/:id/budget',auth('advertiser'),(req,res)=>{
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[req.params.id]); requireOwner(campaign,req.user.id,'advertiser_id');
  const d=z.object({increaseBy:z.number().min(0).default(0),dailyBudget:z.number().positive().optional()}).refine(x=>x.increaseBy>0||x.dailyBudget!==undefined,{message:'Provide increaseBy or dailyBudget'}).parse(req.body);
  const newTotal=Number(campaign.budget_total)+Number(d.increaseBy||0);
  run('UPDATE campaigns SET budget_total=?,budget_daily=? WHERE id=?',[newTotal,d.dailyBudget??campaign.budget_daily,campaign.id]);
  res.json(one('SELECT * FROM campaigns WHERE id=?',[campaign.id]));
});
app.post('/api/advertiser/uploads',auth('advertiser'),upload.single('file'),(req,res)=>{
  if(!req.file) return res.status(400).json({error:'Creative file is required'});
  const isImage=req.file.mimetype.startsWith('image/');
  const max=isImage?10*1024*1024:100*1024*1024;
  if(req.file.size>max){try{fs.unlinkSync(req.file.path)}catch{};return res.status(400).json({error:isImage?'Image must be 10MB or smaller':'Video must be 100MB or smaller'});}
  const relative='/uploads/'+path.basename(req.file.filename);
  res.status(201).json({url:new URL(relative,config.appUrl).toString(),path:relative,mime:req.file.mimetype,size:req.file.size});
});

app.get('/api/payments/gateways',auth(),wrap(async(req,res)=>{const result=await xdigitexPay.gateways();res.json({...result,gateways:(result.gateways||result.data?.gateways||[]).filter(g=>['mobile','card'].includes(g.id)).map(g=>({...g,name:g.id==='mobile'?'Mobile Money Africa':'Card · Visa / Mastercard'}))})}));

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
  if(!['mobile','card'].includes(gateway))return res.status(400).json({error:'Choose Mobile Money Africa or Card'});
  if(gateway==='mobile' && currency==='USD')return res.status(400).json({error:'Mobile money uses your local currency. Use Card for USD funding.'});
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
    [id('pay'),req.user.id,result.reference,'deposit',gateway,Number(result.amount??d.amount),Number(result.fee||0),Number(result.net_amount??0),assertCurrency(result.currency||currency),'pending',JSON.stringify(result)]);
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

let reconcilingDeposits=false;
const depositPoller=setInterval(async()=>{
  if(reconcilingDeposits)return;reconcilingDeposits=true;
  try{for(const tx of all("SELECT reference FROM payment_transactions WHERE kind='deposit' AND status IN ('pending','processing') AND created_at>datetime('now','-7 days') ORDER BY updated_at ASC LIMIT 20")){try{await finalizeDeposit(tx.reference)}catch{console.warn('Pending deposit check temporarily unavailable')}}}finally{reconcilingDeposits=false}
},60000);depositPoller.unref();

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
  finalizeMaturePublisherEarnings();
  // Withdrawals retain balance, maturity and provider checks; no platform KYC gate.
  const schema=z.object({amount:z.number().positive(),currency:z.string(),accountNumber:z.string().min(8).max(30)});
  const d=schema.parse(req.body),currency=assertCurrency(d.currency);
  const minimum=Number(config.minimumPayouts?.[currency]||0);
  if(minimum>0 && d.amount<minimum) return res.status(400).json({error:`Minimum payout for ${currency} is ${minimum}`});
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

app.get('/api/ledger',auth(),(req,res)=>{ finalizeMaturePublisherEarnings(); return res.json({balance:balanceFor(req.user.id),balances:balancesFor(req.user.id),entries:all('SELECT * FROM ledger_entries WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id])}); });

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
  void writeConversion({id:cid,campaign_id:campaign.id,advertiser_id:campaign.advertiser_id,request_id:d.requestId,event_name:d.eventName,value:d.value,currency:d.currency.toUpperCase(),external_id:d.externalId||''}).catch(()=>{});
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
  void writeConversion({id:cid,campaign_id:campaign.id,advertiser_id:req.user.id,request_id:d.requestId||'',event_name:d.eventName,value:d.value,currency:d.currency.toUpperCase(),external_id:d.externalId||''}).catch(()=>{});
  res.status(201).json({id:cid,accepted:true});
});

app.get('/vast',wrap(async(req,res)=>{
  const token=String(req.query.t||'');
  const payload=verifyEvent(token);
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[payload.campaignId]);
  if(!campaign || campaign.creative_type!=='video' || !campaign.video_url) return res.status(404).type('application/xml').send('<VAST version="4.3"></VAST>');
  const impression=`${config.appUrl}/vast/event?t=${encodeURIComponent(token)}&type=view`;
  const click=`${config.appUrl}/r/click?t=${encodeURIComponent(token)}`;
  const xml=`<?xml version="1.0" encoding="UTF-8"?><VAST version="4.3"><Ad id="${xmlEscape(campaign.id)}"><InLine><AdSystem version="1.0">ADPulse</AdSystem><AdTitle>${xmlEscape(campaign.headline)}</AdTitle><Impression><![CDATA[${impression}]]></Impression><Creatives><Creative><Linear><Duration>00:00:30</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4"><![CDATA[${campaign.video_url}]]></MediaFile></MediaFiles><VideoClicks><ClickThrough><![CDATA[${click}]]></ClickThrough></VideoClicks></Linear></Creative></Creatives></InLine></Ad></VAST>`;
  res.type('application/xml').send(xml);
}));

app.get('/vast/event',wrap(async(req,res)=>{
  const token=String(req.query.t||'');
  const type=String(req.query.type||'view')==='click'?'click':'view';
  await recordEvent({token,eventType:type,ip:req.ip,userAgent:req.get('user-agent')||'',metadata:{vast:true,visibilityPercent:100,visibleMs:2000}});
  res.status(204).end();
}));

app.post('/openrtb2/auction',wrap(async(req,res)=>{
  const bid=req.body||{}, imp=Array.isArray(bid.imp)?bid.imp[0]:null;
  if(!bid.id || !imp) return res.status(400).json({error:'Invalid OpenRTB request'});
  const zoneKey=String(imp.tagid||imp?.ext?.adpulse_zone||'');
  if(!zoneKey) return res.status(400).json({error:'imp.tagid or imp.ext.adpulse_zone is required'});
  const result=await makeAdRequest({zoneKey,ip:req.ip,userAgent:req.get('user-agent')||'',country:req.get('cf-ipcountry')||bid?.device?.geo?.country||''});
  if(result.noFill) return res.status(204).end();
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[result.campaign.id]);
  const price=Number(campaign.model==='CPC'?campaign.cpc*10:campaign.cpm||0.01);
  let adm='';
  if(campaign.creative_type==='video'){
    adm=`<?xml version="1.0" encoding="UTF-8"?><VAST version="4.3"><Ad><Wrapper><AdSystem>ADPulse</AdSystem><VASTAdTagURI><![CDATA[${config.appUrl}/vast?t=${encodeURIComponent(result.token)}]]></VASTAdTagURI></Wrapper></Ad></VAST>`;
  }else{
    const img=campaign.image_url?`<img src="${campaign.image_url}" style="max-width:100%;height:auto;border:0" alt="">`:'';
    adm=`<a href="${config.appUrl}/r/click?t=${encodeURIComponent(result.token)}" target="_blank" rel="sponsored noopener">${img}<strong>${campaign.headline}</strong></a><img src="${config.appUrl}/vast/event?t=${encodeURIComponent(result.token)}&type=view" width="1" height="1" style="display:none">`;
  }
  res.json({id:String(bid.id),seatbid:[{seat:'adpulse',bid:[{id:`bid_${crypto.randomBytes(8).toString('hex')}`,impid:String(imp.id||'1'),price,adm,adomain:[new URL(campaign.destination_url).hostname],cid:campaign.id,crid:campaign.id,w:imp?.banner?.w||undefined,h:imp?.banner?.h||undefined,ext:{adpulse:{request_id:result.requestId}}}]}],cur:campaign.currency||'USD'});
}));

app.get('/serve',wrap(async(req,res)=>{
  const result=await makeAdRequest({zoneKey:String(req.query.zone||''),ip:req.ip,userAgent:req.get('user-agent')||'',country:req.get('cf-ipcountry')||'',contextToken:String(req.query.ctx||''),browserId:String(req.query.bid||''),sessionId:String(req.query.sid||''),personalizationAllowed:String(req.query.pa||'0')==='1',previousCampaignId:String(req.query.prev||''),excludedCampaignIds:String(req.query.exclude||'').split(',').filter(Boolean).slice(0,20)});
  res.set('Cache-Control','no-store').json(result);
}));

app.post('/events',wrap(async(req,res)=>{
  const schema=z.object({token:z.string(),type:z.enum(['render','view','click','conversion','dismiss','timeout_close','rotation']),metadata:z.record(z.any()).optional().default({})});
  const d=schema.parse(req.body);
  if(['dismiss','timeout_close','rotation'].includes(d.type)){
    const signed=verifyEvent(d.token);
    const request=one("SELECT id FROM ad_events WHERE request_id=? AND campaign_id=? AND event_type='request'",[signed.requestId,signed.campaignId]);
    if(!request)return res.status(404).json({error:'Ad request unavailable'});
    const result=run('INSERT OR IGNORE INTO ad_ux_events(id,request_id,campaign_id,publisher_id,zone_id,event_type,ip_hash,metadata) VALUES(?,?,?,?,?,?,?,?)',[id('ux'),signed.requestId,signed.campaignId,signed.publisherId,signed.zoneId,d.type,hashIp(req.ip),JSON.stringify(d.metadata).slice(0,4096)]);
    return res.json({ok:true,duplicate:result.changes===0,billAmount:0});
  }
  const result=await recordEvent({token:d.token,eventType:d.type,ip:req.ip,userAgent:req.get('user-agent')||'',metadata:d.metadata});
  res.json(result);
}));

app.get('/r/click',wrap(async(req,res)=>{
  const token=String(req.query.t||'');
  const result=await recordEvent({token,eventType:'click',ip:req.ip,userAgent:req.get('user-agent')||'',metadata:{redirect:true,browserId:String(req.query.bid||''),sessionId:String(req.query.sid||''),personalizationAllowed:String(req.query.pa||'0')==='1'}});
  const payload=await import('jsonwebtoken').then(m=>m.default.verify(token,config.eventSecret));
  const campaign=one('SELECT destination_url FROM campaigns WHERE id=?',[payload.campaignId]);
  if(!campaign) return res.status(404).send('Campaign unavailable');
  const target=new URL(campaign.destination_url); target.searchParams.set('_aprid',payload.requestId);
  res.redirect(302,target.toString());
}));

app.post('/api/admin/users/:id/login-as',auth('admin'),(req,res)=>{
  if(req.user.supportSession)return res.status(403).json({error:'Nested support sessions are not allowed'});
  const user=one('SELECT id,email,name,role,status,kyc_status,phone,country FROM users WHERE id=?',[req.params.id]);
  if(!user||user.role==='admin'||user.status!=='active')return res.status(400).json({error:'Choose an active non-admin account'});
  const sessionId=id('support');run("INSERT INTO admin_support_sessions(id,admin_id,user_id,expires_at) VALUES(?,?,?,datetime('now','+15 minutes'))",[sessionId,req.user.id,user.id]);
  res.json(issueSupportToken(user,req.user,sessionId));
});
app.post('/api/support-session/end',auth(),(req,res)=>{
  if(!req.user.supportSession)return res.status(400).json({error:'No support session'});
  run('UPDATE admin_support_sessions SET ended_at=CURRENT_TIMESTAMP WHERE id=?',[req.user.supportSession.id]);res.json({ok:true});
});

app.get('/api/admin/site-policy',auth('admin'),(req,res)=>res.json({autoApprove:one("SELECT value FROM system_settings WHERE key='auto_approve_domains'")?.value!=='false'}));
app.post('/api/admin/site-policy',auth('admin'),(req,res)=>{const d=z.object({autoApprove:z.boolean()}).parse(req.body);run("INSERT INTO system_settings(key,value,updated_at) VALUES('auto_approve_domains',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",[String(d.autoApprove)]);res.json(d)});

app.get('/api/admin/support/settings',auth('admin'),(req,res)=>{
  res.json({
    email:one("SELECT value FROM system_settings WHERE key='support_email'")?.value||config.supportEmail,
    whatsapp:one("SELECT value FROM system_settings WHERE key='support_whatsapp'")?.value||config.supportWhatsapp
  });
});
app.post('/api/admin/support/settings',auth('admin'),(req,res)=>{
  const schema=z.object({email:z.string().email(),whatsapp:z.string().max(32).optional().default('')});
  const d=schema.parse(req.body);
  const tx=db.transaction(()=>{
    run("INSERT INTO system_settings(key,value,updated_at) VALUES('support_email',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",[d.email]);
    run("INSERT INTO system_settings(key,value,updated_at) VALUES('support_whatsapp',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",[d.whatsapp]);
  }); tx();
  res.json({ok:true,...d});
});

app.get('/api/admin/support',auth('admin'),(req,res)=>res.json(all("SELECT * FROM support_conversations ORDER BY updated_at DESC LIMIT 200")));
app.get('/api/admin/support/:id',auth('admin'),(req,res)=>{
  const conv=one('SELECT * FROM support_conversations WHERE id=?',[req.params.id]);
  if(!conv) return res.status(404).json({error:'Not found'});
  res.json({conversation:conv,messages:all('SELECT * FROM support_messages WHERE conversation_id=? ORDER BY created_at',[conv.id])});
});
app.post('/api/admin/support/:id/reply',auth('admin'),(req,res)=>{
  const conv=one('SELECT * FROM support_conversations WHERE id=?',[req.params.id]);
  if(!conv) return res.status(404).json({error:'Not found'});
  const body=z.string().min(1).max(4000).parse(req.body.message);
  run('INSERT INTO support_messages(id,conversation_id,sender_type,sender_id,body) VALUES(?,?,?,?,?)',[id('msg'),conv.id,'admin',req.user.id,body]);
  run("UPDATE support_conversations SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?",[conv.id]);
  res.status(201).json({ok:true});
});

app.get('/api/admin/kyc',auth('admin'),(req,res)=>res.json(all("SELECT id,email,name,role,phone,country,kyc_status,created_at FROM users WHERE role!='admin' ORDER BY created_at DESC")));
app.post('/api/admin/kyc/:id/status',auth('admin'),(req,res)=>{
  const status=z.enum(['not_started','pending','verified','rejected']).parse(req.body.status);
  const user=one("SELECT id FROM users WHERE id=? AND role!='admin'",[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  run('UPDATE users SET kyc_status=? WHERE id=?',[status,user.id]);
  res.json({ok:true,status});
});

app.get('/api/admin/sites',auth('admin'),(req,res)=>res.json(all("SELECT s.*,u.email publisher_email,(SELECT COUNT(DISTINCT request_id) FROM ad_events WHERE site_id=s.id AND event_type='render') ads_shown FROM sites s JOIN users u ON u.id=s.publisher_id ORDER BY s.created_at DESC")));
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

app.get('/api/admin/fraud/events',auth('admin'),(req,res)=>{
  const rows=all("SELECT id,request_id,event_type,publisher_id,site_id,zone_id,risk_score,valid,metadata,created_at FROM ad_events WHERE risk_score>0 OR valid=0 ORDER BY created_at DESC LIMIT 250");
  res.json(rows.map(r=>{let metadata={};try{metadata=JSON.parse(r.metadata||'{}')}catch{}return {...r,metadata}}));
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
