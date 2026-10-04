import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { all, one, run, id, addLedger, db, balanceFor } from './db.js';
import { hashIp, deviceFromUA, scoreEvent } from './fraud.js';
import { getFrequency, cacheFrequency, writeAdEvent } from './production-store.js';
import { enrichIp } from './ip-intelligence.js';

const json = (s) => { try{return JSON.parse(s||'[]')}catch{return []} };
const today = () => new Date().toISOString().slice(0,10);

export async function chooseCampaign({zone,country='',device='desktop',ipHash='',contextCategory=''}) {
  const site=one('SELECT * FROM sites WHERE id=?',[zone.site_id]);
  const rows=all("SELECT c.* FROM campaigns c WHERE c.status='active' AND c.spent_total < c.budget_total");
  const effectiveCategory=contextCategory||site.category;
  const eligible=[];
  for(const c of rows){
    if(c.budget_daily>0 && c.spent_today>=c.budget_daily) continue;
    const now=new Date();
    if(c.starts_at && new Date(c.starts_at)>now) continue;
    if(c.ends_at && new Date(c.ends_at)<now) continue;
    if(ipHash && c.frequency_cap_daily>0){
      const redisCount=await getFrequency({campaignId:c.id,ipHash});
      if(redisCount!==null){
        if(redisCount>=Number(c.frequency_cap_daily)) continue;
      }else{
        const seen=one("SELECT COUNT(*) n FROM ad_events WHERE campaign_id=? AND ip_hash=? AND event_type='view' AND valid=1 AND created_at>=datetime('now','-1 day')",[c.id,ipHash]);
        if(Number(seen?.n||0)>=Number(c.frequency_cap_daily)) continue;
      }
    }
    const countries=json(c.target_countries), cats=json(c.target_categories), devices=json(c.target_devices);
    if(countries.length && country && !countries.includes(country)) continue;
    if(cats.length && !cats.includes(effectiveCategory)) continue;
    if(devices.length && !devices.includes(device)) continue;
    if(c.model!=='CPC' && c.cpm < Number(zone.floor_cpm||0)) continue;
    const bal=balanceFor(c.advertiser_id,c.currency||'USD');
    if(bal<=0) continue;
    eligible.push(c);
  }
  if(!eligible.length) return null;
  const scored=eligible.map(c=>{
    const categoryBoost=json(c.target_categories).includes(effectiveCategory)?1.25:1;
    const bid=(c.model==='CPC'?c.cpc*10:c.cpm) || .01;
    return {c,score:bid*categoryBoost*(.8+Math.random()*.4)};
  }).sort((a,b)=>b.score-a.score);
  return scored[0].c;
}

export function signEvent(payload){ return jwt.sign(payload,config.eventSecret,{expiresIn:'30m'}); }
export function verifyEvent(token){ return jwt.verify(token,config.eventSecret); }

export async function makeAdRequest({zoneKey,ip,userAgent,country,contextToken=''}) {
  const zone=one("SELECT * FROM zones WHERE public_key=? AND status='active'",[zoneKey]);
  if(!zone) return {noFill:true,reason:'invalid_zone'};
  const site=one("SELECT * FROM sites WHERE id=? AND status='approved'",[zone.site_id]);
  if(!site) return {noFill:true,reason:'site_not_approved'};
  const device=deviceFromUA(userAgent);
  if(device==='bot') return {noFill:true,reason:'bot'};
  let context={category:'',brandSafety:'standard',topics:[]};
  if(contextToken){try{const parsed=verifyEvent(contextToken);if(parsed.type==='context'&&parsed.siteId===site.id)context={category:parsed.category||'',brandSafety:parsed.brandSafety||'standard',topics:parsed.topics||[]}}catch{}}
  if(context.brandSafety==='restricted') return {noFill:true,reason:'brand_safety'};
  const requestId=id('req'), eventId=id('evt'), ipHash=hashIp(ip);
  const campaign=await chooseCampaign({zone,country,device,ipHash,contextCategory:context.category});
  run("INSERT INTO ad_events(id,request_id,event_type,campaign_id,publisher_id,site_id,zone_id,ip_hash,user_agent,country,device,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    [eventId,requestId,'request',campaign?.id||null,zone.publisher_id,zone.site_id,zone.id,ipHash,userAgent,country||null,device,JSON.stringify({context})]);
  void writeAdEvent({id:eventId,request_id:requestId,event_type:'request',campaign_id:campaign?.id||'',publisher_id:zone.publisher_id,site_id:zone.site_id,zone_id:zone.id,ip_hash:ipHash,country:country||'',device,risk_score:0,valid:1,bill_amount:0,publisher_amount:0}).catch(()=>{});
  if(!campaign) return {noFill:true,reason:'no_campaign',requestId};
  const token=signEvent({requestId,campaignId:campaign.id,publisherId:zone.publisher_id,siteId:zone.site_id,zoneId:zone.id,ipHash});
  return {
    noFill:false,requestId,token,
    creative:{headline:campaign.headline,description:campaign.description,imageUrl:campaign.image_url,videoUrl:campaign.video_url,creativeType:campaign.creative_type||'display',destinationUrl:campaign.destination_url,width:zone.width,height:zone.height,format:zone.format},
    campaign:{id:campaign.id,model:campaign.model,currency:campaign.currency}
  };
}

export async function recordEvent({token,eventType,ip,userAgent,metadata={}}){
  const signed=verifyEvent(token);
  const ipHash=hashIp(ip);
  const intel=await enrichIp(ip);
  const browserId=String(metadata.browserId||'').slice(0,128), sessionId=String(metadata.sessionId||'').slice(0,128);
  const fraud=scoreEvent({ipHash,userAgent,eventType,requestId:signed.requestId,publisherId:signed.publisherId,campaignId:signed.campaignId,browserId,sessionId,metadata});
  fraud.score+=Number(intel.risk||0); fraud.reasons.push(...(intel.reasons||[])); fraud.valid=fraud.score<80;
  const campaign=one('SELECT * FROM campaigns WHERE id=?',[signed.campaignId]);
  if(!campaign) throw Object.assign(new Error('Campaign unavailable'),{status:404});
  let bill=0;
  if(eventType==='view' && ['CPM','HYBRID'].includes(campaign.model)) bill=Number(campaign.cpm)/1000;
  if(eventType==='click' && ['CPC','HYBRID'].includes(campaign.model)) bill=Number(campaign.cpc);
  bill=Math.max(0,bill);
  const currency=campaign.currency||'USD';
  const advertiserBalance=balanceFor(campaign.advertiser_id,currency);
  const valid=fraud.valid && (bill===0 || advertiserBalance>=bill) && (campaign.spent_total+bill<=campaign.budget_total);
  const publisherAmount=valid?bill*config.publisherRevenueShare:0;
  const eventId=id('evt');

  const tx=db.transaction(()=>{
    run("INSERT INTO ad_events(id,request_id,event_type,campaign_id,publisher_id,site_id,zone_id,ip_hash,user_agent,browser_id,session_id,risk_score,valid,bill_amount,publisher_amount,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [eventId,signed.requestId,eventType,signed.campaignId,signed.publisherId,signed.siteId,signed.zoneId,ipHash,userAgent,browserId||null,sessionId||null,fraud.score,valid?1:0,valid?bill:0,publisherAmount,JSON.stringify({...metadata,fraudReasons:fraud.reasons,network:{source:intel.source,asn:intel.asn,asnName:intel.asnName,asnType:intel.asnType,vpn:intel.vpn,proxy:intel.proxy,tor:intel.tor,hosting:intel.hosting,relay:intel.relay}})]);
    if(valid && bill>0){
      run('UPDATE campaigns SET spent_total=spent_total+?, spent_today=spent_today+? WHERE id=?',[bill,bill,campaign.id]);
      addLedger({userId:campaign.advertiser_id,eventId,type:'AD_CHARGE',amount:-bill,currency,note:`${eventType} charge`});
      addLedger({userId:signed.publisherId,eventId,type:'PUBLISHER_EARNING',amount:publisherAmount,currency,status:'pending',note:`${eventType} earning — 24h fraud review`});
    }
  });
  tx();
  if(valid && eventType==='view') void cacheFrequency({campaignId:campaign.id,ipHash}).catch(()=>{});
  void writeAdEvent({id:eventId,request_id:signed.requestId,event_type:eventType,campaign_id:signed.campaignId,publisher_id:signed.publisherId,site_id:signed.siteId,zone_id:signed.zoneId,ip_hash:ipHash,country:metadata.country||'',device:deviceFromUA(userAgent),risk_score:fraud.score,valid:valid?1:0,bill_amount:valid?bill:0,publisher_amount:publisherAmount}).catch(()=>{});
  return {eventId,valid,riskScore:fraud.score,reasons:fraud.reasons,network:intel,billAmount:valid?bill:0,publisherAmount};
}

export function resetDailySpendIfNeeded(){
  const current=today();
  const marker=one("SELECT value FROM system_settings WHERE key='daily_spend_date'");
  if(marker?.value===current) return;
  const tx=db.transaction(()=>{
    run('UPDATE campaigns SET spent_today=0');
    run("INSERT INTO system_settings(key,value,updated_at) VALUES('daily_spend_date',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",[current]);
  });
  tx();
}
