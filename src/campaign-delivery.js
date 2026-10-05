import {all,one,balanceFor} from './db.js';
import {zoneDisplaySettings} from './display-settings.js';
const parse=s=>{try{return JSON.parse(s||'[]')}catch{return []}};
export function unitCharge(c){return Math.max(c.model==='CPC'?0:Number(c.cpm)/1000,c.model==='CPM'?0:Number(c.cpc));}
export function campaignDelivery(c){
 const reasons=[],now=Date.now(),balance=balanceFor(c.advertiser_id,c.currency),charge=unitCharge(c);
 if(c.status!=='active')reasons.push(c.status==='pending_review'?'Awaiting admin review':'Campaign '+c.status);
 if(!c.is_house&&balance<charge)reasons.push('Add funds to your '+c.currency+' wallet');
 if(Number(c.spent_total)+charge>Number(c.budget_total))reasons.push('Total budget exhausted');
 const dailyMarker=one("SELECT value FROM system_settings WHERE key='daily_spend_date'")?.value,spentToday=dailyMarker===new Date().toISOString().slice(0,10)?Number(c.spent_today):0;
 if(c.budget_daily>0&&spentToday+charge>Number(c.budget_daily))reasons.push('Daily budget reached; resumes next UTC day');
 if(c.starts_at&&new Date(c.starts_at).getTime()>now)reasons.push('Scheduled start has not arrived');
 if(c.ends_at&&new Date(c.ends_at).getTime()<=now)reasons.push('Campaign has ended');
 const categories=parse(c.target_categories),houseSites=parse(c.house_site_ids);
 const inventory=all("SELECT z.*,s.category FROM zones z JOIN sites s ON s.id=z.site_id WHERE z.status='active' AND s.status='approved'").filter(z=>!zoneDisplaySettings(z).pauseAds&&(!categories.length||categories.includes(z.category))&&(!c.is_house||houseSites.includes('*')||houseSites.includes(z.site_id))&&(c.is_house||c.model==='CPC'||Number(c.cpm)>=Number(z.floor_cpm)));
 if(!inventory.length)reasons.push('No matching active placement on an approved website');
 const counts=one("SELECT COUNT(DISTINCT CASE WHEN event_type='render' THEN request_id END) ads_shown,COUNT(DISTINCT CASE WHEN event_type='view' AND valid=1 THEN request_id END) impressions FROM ad_events WHERE campaign_id=?",[c.id]);
 return {ready:reasons.length===0,reasons,balance,currency:c.currency,matchingSites:new Set(inventory.map(z=>z.site_id)).size,devices:parse(c.target_devices),countries:parse(c.target_countries),...counts};
}
