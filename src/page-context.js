import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { one, run, id } from './db.js';
import { safeFetchUrl } from './safe-fetch.js';
import { classifyPage } from './context-ai.js';
import { mirrorSiteContext } from './production-store.js';
import { config } from './config.js';

export async function classifyPageForZone({zoneKey,pageUrl}){
  const zone=one("SELECT * FROM zones WHERE public_key=? AND status='active'",[zoneKey]);
  if(!zone) throw Object.assign(new Error('Unknown ad zone'),{status:404});
  const site=one("SELECT * FROM sites WHERE id=? AND status='approved'",[zone.site_id]);
  if(!site) throw Object.assign(new Error('Site not approved'),{status:404});
  let page;
  try{page=new URL(pageUrl)}catch{throw Object.assign(new Error('Invalid page URL'),{status:400})}
  const host=page.hostname.toLowerCase().replace(/^www\./,'');
  if(host!==site.domain) throw Object.assign(new Error('Page URL does not belong to this publisher site'),{status:400});
  const urlHash=crypto.createHash('sha256').update(page.toString()).digest('hex');
  let ctx=one("SELECT * FROM page_contexts WHERE site_id=? AND url_hash=? AND updated_at>=datetime('now','-1 day')",[site.id,urlHash]);
  if(!ctx){
    const r=await safeFetchUrl(page.toString(),{headers:{'user-agent':'ADPulseContextBot/1.0'},timeoutMs:8000});
    const html=await r.text();
    const title=(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||page.pathname).trim();
    const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,20000);
    const result=await classifyPage({url:page.toString(),title,text});
    run(`INSERT INTO page_contexts(id,site_id,url_hash,url,category,topics,language,brand_safety,summary,provider,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(site_id,url_hash) DO UPDATE SET category=excluded.category,topics=excluded.topics,language=excluded.language,brand_safety=excluded.brand_safety,summary=excluded.summary,provider=excluded.provider,updated_at=CURRENT_TIMESTAMP`,
      [id('ctx'),site.id,urlHash,page.toString(),result.category||'general',JSON.stringify(result.topics||[]),result.language||null,result.brandSafety||'standard',result.summary||null,result.provider||null]);
    ctx=one('SELECT * FROM page_contexts WHERE site_id=? AND url_hash=?',[site.id,urlHash]);
    void mirrorSiteContext({siteId:site.id,category:ctx.category,language:ctx.language,topics:JSON.parse(ctx.topics||'[]'),brandSafety:ctx.brand_safety,summary:ctx.summary}).catch(()=>{});
  }
  const token=jwt.sign({type:'context',siteId:site.id,category:ctx.category,topics:JSON.parse(ctx.topics||'[]'),brandSafety:ctx.brand_safety},config.eventSecret,{expiresIn:'1h'});
  return {token,siteId:site.id,category:ctx.category,topics:JSON.parse(ctx.topics||'[]'),language:ctx.language,brandSafety:ctx.brand_safety};
}
