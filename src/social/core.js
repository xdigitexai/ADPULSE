import crypto from 'node:crypto';
import {db,id,one,all,run,balanceFor,addLedger,earningInCurrency,settledEarning} from '../db.js';
import {config} from '../config.js';
import {hashIp,deviceFromUA} from '../fraud.js';
import {isSensitiveInterest} from '../audience-engine.js';

export const platforms=['tiktok','instagram','facebook','youtube'];
export const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const json=x=>{try{return JSON.parse(x||'[]');}catch{return [];}};
export function audit(actor,action,object,metadata={}){run('INSERT INTO social_audit(id,actor_id,action,object_id,metadata) VALUES(?,?,?,?,?)',[id('sau'),actor,action,object,JSON.stringify(metadata)]);}
export function own(table,rowId,user,field='publisher_id') {const row=one(`SELECT * FROM ${table} WHERE id=?`,[rowId]);if(!row||(row[field]!==user.id&&user.role!=='admin'))fail('Not found',404);return row;}
export function socialUrl(platform,raw,{profile=false}={}){
  let u;try{u=new URL(raw);}catch{fail('Use a valid public HTTPS social URL');}
  const allowed={tiktok:['tiktok.com','www.tiktok.com'],instagram:['instagram.com','www.instagram.com'],facebook:['facebook.com','www.facebook.com'],youtube:['youtube.com','www.youtube.com','youtu.be']}[platform];
  if(!allowed||u.protocol!=='https:'||u.username||u.password||u.port||!allowed.includes(u.hostname)||u.pathname==='/')fail('URL must belong to the selected social platform');
  if(!profile&&!({tiktok:/\/@[^/]+\/video\/\d+/,instagram:/\/(reel|p)\/[^/]+/,facebook:/\/(reel|videos|watch|posts)\b|\/[^/]+\/posts\//,youtube:/\/(watch|shorts)\b/}[platform].test(u.pathname)||platform==='youtube'&&u.hostname==='youtu.be'&&u.pathname.length>1))fail('Enter a published video or post URL');
  u.hash='';return u.href;
}
export function publicAccount(a){const {token_encrypted,refresh_token_encrypted,platform_metadata,...safe}=a;let metadata={};try{metadata=JSON.parse(platform_metadata||'{}')}catch{}return {...safe,verification_evidence:metadata.verificationEvidence||null,oauth_scopes:json(a.oauth_scopes),quality_components:JSON.parse(a.quality_components||'{}')};}
export function campaignAvailable(c){const now=new Date().toISOString();return c.status==='active'&&(!c.starts_at||c.starts_at<=now)&&(!c.ends_at||c.ends_at>now)&&c.spent_total<c.budget_total&&balanceFor(c.advertiser_id,c.currency)>0;}
export function eligibility(c,a){
  const reasons=[];try{earningInCurrency(a.publisher_id,1,c.currency);}catch{reasons.push('Currency rate unavailable');}if(a.status!=='verified')reasons.push('Account ownership must be verified');if(!campaignAvailable(c))reasons.push('Campaign unavailable or unfunded');
  for(const [key,val] of [['target_platforms',a.platform],['target_countries',a.country],['target_categories',a.category]]){const values=json(c[key]);if(values.length&&!values.includes(val))reasons.push(key.replace('target_','')+' does not match');}
  if(c.min_followers>0&&(a.followers==null||a.followers<c.min_followers))reasons.push('Approved follower metric below minimum or unavailable');
  if(c.max_followers!=null&&(a.followers==null||a.followers>c.max_followers))reasons.push('Follower maximum not satisfied');
  if(a.quality_score<c.min_quality_score)reasons.push('Quality threshold not met');
  if(isSensitiveInterest(a.category)||json(c.target_categories).some(isSensitiveInterest))reasons.push('Restricted category requires separate policy review');
  if(one('SELECT id FROM creator_campaign_assignments WHERE campaign_id=? AND creator_id=?',[c.id,a.id]))reasons.push('Already accepted');
  return {eligible:reasons.length===0,reasons};
}
export function acceptCampaign(campaignId,accountId,user){return db.transaction(()=>{
  const c=one('SELECT * FROM creator_campaigns WHERE id=?',[campaignId]);if(!c)fail('Campaign not found',404);const a=own('social_accounts',accountId,user);const e=eligibility(c,a);if(!e.eligible)fail(e.reasons.join('; '),409);
  const code=crypto.randomBytes(18).toString('base64url'),assignment=id('cas'),url=(process.env.SOCIAL_PUBLIC_URL||config.appUrl).replace(/\/$/,'')+'/c/'+code;
  run('INSERT INTO creator_campaign_assignments(id,campaign_id,creator_id,publisher_id,tracking_code,tracking_url) VALUES(?,?,?,?,?,?)',[assignment,c.id,a.id,a.publisher_id,code,url]);audit(user.id,'assignment.accepted',assignment);return one('SELECT * FROM creator_campaign_assignments WHERE id=?',[assignment]);
}).immediate();}
export function quality(a){const e=one("SELECT COUNT(*) n,COALESCE(SUM(valid),0) valid FROM creator_events WHERE creator_id=? AND event_type='click'",[a.id]);const history=one("SELECT COUNT(*) n,SUM(CASE WHEN status IN ('approved','published','completed') THEN 1 ELSE 0 END) approved,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM creator_campaign_assignments WHERE creator_id=? AND status IN ('approved','published','rejected','completed')",[a.id]);const conversions=one("SELECT COUNT(*) n FROM creator_events WHERE creator_id=? AND event_type='conversion' AND valid=1",[a.id]);const verified=a.status==='verified';const components={ownership:verified?35:0,validTraffic:verified?(e.n?25*e.valid/e.n:15):0,contentApproval:verified?(history.n?20*history.approved/history.n:15):0,campaignCompletion:verified?(history.completed?15*history.completed/history.n:15):0,conversionQuality:verified?(e.valid?5*Math.min(1,conversions.n/e.valid/.1):5):0};return {score:Math.round(Object.values(components).reduce((s,n)=>s+n,0)),components};}
export function updateQuality(accountId){const account=one('SELECT * FROM social_accounts WHERE id=?',[accountId]);if(!account)return;const q=quality(account);run('UPDATE social_accounts SET quality_score=?,quality_components=? WHERE id=?',[q.score,JSON.stringify(q.components),account.id]);}
export function fraudForClick(a,c,{ip,userAgent,browserId,sessionId,country},intel={}){
  const ipHash=hashIp(ip),reasons=[...(intel.reasons||[])];let risk=Number(intel.risk||0);
  const flag=(condition,reason,score=100)=>{if(condition){reasons.push(reason);risk+=score;}};
  flag(one('SELECT id FROM account_ip_history WHERE user_id=? AND ip_hash=?',[a.publisher_id,ipHash]),'creator_self_click');
  flag(!userAgent||/bot|crawler|headless|spider|selenium/i.test(userAgent),'automation_signature');
  flag(!browserId||!sessionId,'missing_browser_session');
  flag(one("SELECT id FROM creator_events WHERE campaign_id=? AND browser_id=? AND event_type='click' AND created_at>=datetime('now','-1 day')",[c.id,browserId]),'creator_repeat_browser');
  flag(one("SELECT id FROM creator_events WHERE campaign_id=? AND ip_hash=? AND event_type='click' AND created_at>=datetime('now','-1 day')",[c.id,ipHash]),'creator_repeat_ip');
  flag(one("SELECT COUNT(*) n FROM creator_events WHERE ip_hash=? AND event_type='click' AND created_at>=datetime('now','-10 minutes')",[ipHash]).n>=5,'creator_click_velocity');
  flag(one("SELECT COUNT(*) n FROM ad_events WHERE ip_hash=? AND event_type='click' AND created_at>=datetime('now','-10 minutes')",[ipHash]).n>=10,'shared_shield_click_velocity');
  flag(json(c.target_countries).length&&(!country||!json(c.target_countries).includes(country)),'geo_mismatch');
  flag(intel.source==='error','ip_intelligence_unavailable');
  flag(intel.source==='ipinfo'&&intel.privacyAvailable===false,'ip_privacy_intelligence_unavailable');
  return {ipHash,risk:Math.min(100,risk),valid:risk<80,reasons};
}
function budget(c,bill){
  const day=new Date().toISOString().slice(0,10);if(c.spend_date!==day){run('UPDATE creator_campaigns SET spend_date=?,spent_today=0 WHERE id=?',[day,c.id]);c.spent_today=0;}
  return campaignAvailable(c)&&c.spent_today+bill<=c.budget_daily+1e-9&&c.spent_total+bill<=c.budget_total+1e-9&&balanceFor(c.advertiser_id,c.currency)+1e-9>=bill;
}
function charge(c,a,eventId,bill){const sourceEarning=Number((bill*config.publisherRevenueShare).toFixed(6));const earning=bill>0?earningInCurrency(a.publisher_id,sourceEarning,c.currency).amount:0;if(bill>0){
  addLedger({deferMirror:true,userId:c.advertiser_id,eventId,type:'AD_CHARGE',amount:-bill,currency:c.currency,note:'Creator sponsorship charge'});
  addLedger({deferMirror:true,userId:a.publisher_id,eventId,type:'PUBLISHER_EARNING',amount:sourceEarning,currency:c.currency,status:'pending',note:'Creator earning — 24h fraud review'});
  run('UPDATE creator_campaigns SET spent_total=spent_total+?,spent_today=spent_today+? WHERE id=?',[bill,bill,c.id]);run('UPDATE creator_campaign_assignments SET earnings=earnings+? WHERE id=?',[earning,a.id]);
}return earning;}
export function recordCreatorClick(code,visitor,intel={}){return db.transaction(()=>{
  const a=one('SELECT * FROM creator_campaign_assignments WHERE tracking_code=?',[code]);if(!a)fail('Tracking link not found',404);const c=one('SELECT * FROM creator_campaigns WHERE id=?',[a.campaign_id]);const account=one('SELECT * FROM social_accounts WHERE id=?',[a.creator_id]);
  if(!['approved','published'].includes(a.status)||account.status!=='verified'||!a.published_post_url)fail('Published sponsorship is not approved',410);
  const f=fraudForClick(a,c,visitor,intel);let bill=['CPC','HYBRID'].includes(c.pricing_model)?c.cpc:0;
  try{if(bill>0)earningInCurrency(a.publisher_id,bill*config.publisherRevenueShare,c.currency);}catch{f.valid=false;f.reasons.push('currency_rate_unavailable');}
  if(!budget(c,bill)){f.valid=false;f.reasons.push('campaign_budget_or_wallet_unavailable');}
  if(!f.valid)bill=0;const eventId=id('cev'),attribution=crypto.randomBytes(24).toString('base64url');const earning=charge(c,a,eventId,bill);
  run('INSERT INTO creator_events(id,assignment_id,campaign_id,creator_id,publisher_id,event_type,browser_id,session_id,ip_hash,country,device,risk_score,valid,bill_amount,publisher_amount,attribution_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[eventId,a.id,c.id,a.creator_id,a.publisher_id,'click',visitor.browserId,visitor.sessionId,f.ipHash,visitor.country||null,deviceFromUA(visitor.userAgent),f.risk,f.valid?1:0,bill,earning,attribution,JSON.stringify({publisherCurrency:one('SELECT currency FROM users WHERE id=?',[a.publisher_id])?.currency||c.currency,fraudReasons:f.reasons,network:{source:intel.source,asn:intel.asn,vpn:intel.vpn,proxy:intel.proxy,tor:intel.tor,hosting:intel.hosting}})]);
  run('UPDATE creator_campaign_assignments SET clicks=clicks+1,valid_clicks=valid_clicks+? WHERE id=?',[f.valid?1:0,a.id]);
  updateQuality(a.creator_id);
  const url=new URL(c.destination_url);url.searchParams.set('adpulse_creator',attribution);url.searchParams.set('utm_source',account.platform);url.searchParams.set('utm_medium','creator');url.searchParams.set('utm_campaign',c.name);url.searchParams.set('utm_content',code);
  return {url:url.href,eventId,valid:f.valid,billAmount:bill,publisherAmount:earning,attribution};
}).immediate();}
export function recordCreatorConversion(user,data){return db.transaction(()=>{
  const c=one('SELECT * FROM creator_campaigns WHERE id=?',[data.campaignId]);if(!c||c.advertiser_id!==user.id)fail('Campaign not found',404);
  const existing=one("SELECT * FROM creator_events WHERE campaign_id=? AND external_id=?",[c.id,data.externalId]);if(existing)return {id:existing.id,duplicate:true};
  const click=one("SELECT * FROM creator_events WHERE attribution_id=? AND campaign_id=? AND event_type='click' AND valid=1 AND created_at>=datetime('now','-7 days')",[data.attributionId,c.id]);if(!click)fail('No valid recent creator attribution');
  const a=one('SELECT * FROM creator_campaign_assignments WHERE id=?',[click.assignment_id]);const account=one('SELECT * FROM social_accounts WHERE id=?',[a.creator_id]);if(account.status!=='verified'||!['approved','published'].includes(a.status))fail('Creator sponsorship is unavailable');
  if(data.currency!==c.currency)fail('Conversion currency must match campaign currency');
  const bill=Number((c.pricing_model==='REVSHARE'?data.value*c.commission_percent/100:['CPA','HYBRID'].includes(c.pricing_model)?c.cpa:0).toFixed(6));if(!budget(c,bill))fail('Insufficient campaign budget or wallet',409);
  if(one("SELECT COUNT(*) n FROM creator_events WHERE assignment_id=? AND event_type='conversion' AND created_at>=datetime('now','-1 hour')",[a.id]).n>=100)fail('creator_conversion_anomaly',409);
  const eventId=id('cev'),earning=charge(c,a,eventId,bill);run("INSERT INTO creator_events(id,assignment_id,campaign_id,creator_id,publisher_id,event_type,valid,bill_amount,publisher_amount,external_id,metadata) VALUES(?,?,?,?,?,'conversion',1,?,?,?,?)",[eventId,a.id,c.id,a.creator_id,a.publisher_id,bill,earning,data.externalId,JSON.stringify({publisherCurrency:one('SELECT currency FROM users WHERE id=?',[a.publisher_id])?.currency||c.currency,clickId:click.id,value:data.value,currency:data.currency,eventName:data.eventName})]);run('UPDATE creator_campaign_assignments SET conversions=conversions+1 WHERE id=?',[a.id]);updateQuality(a.creator_id);return {id:eventId,billAmount:bill,publisherAmount:earning};
}).immediate();}
export function reverseCreatorEvent(actor,eventId,reason){return db.transaction(()=>{
  const e=one('SELECT * FROM creator_events WHERE id=?',[eventId]);if(!e)fail('Event not found',404);if(!e.valid)return {reversed:false};
  if(e.event_type==='click')for(const child of all("SELECT id FROM creator_events WHERE event_type='conversion' AND valid=1 AND json_extract(metadata,'$.clickId')=?",[e.id]))reverseCreatorEvent(actor,child.id,reason);
  const c=one('SELECT * FROM creator_campaigns WHERE id=?',[e.campaign_id]);const earning=one("SELECT * FROM ledger_entries WHERE event_id=? AND type='PUBLISHER_EARNING' AND status<>'converted' ORDER BY created_at DESC LIMIT 1",[e.id]);
  if(earning?.status==='pending')run("UPDATE ledger_entries SET status='reversed' WHERE id=?",[earning.id]);else if(earning){const settled=settledEarning(earning);addLedger({deferMirror:true,userId:e.publisher_id,eventId:e.id,type:'FRAUD_REVERSAL',amount:-settled.amount,currency:settled.currency,note:reason});}
  if(e.bill_amount)addLedger({deferMirror:true,userId:c.advertiser_id,eventId:e.id,type:'AD_REFUND',amount:e.bill_amount,currency:c.currency,note:reason});
  const reversedEarning=earning?settledEarning(earning).amount:e.publisher_amount;
  run('UPDATE creator_events SET valid=0,metadata=? WHERE id=?',[JSON.stringify({...JSON.parse(e.metadata),reversalReason:reason}),e.id]);run('UPDATE creator_campaign_assignments SET earnings=MAX(0,earnings-?),valid_clicks=MAX(0,valid_clicks-?),conversions=MAX(0,conversions-?) WHERE id=?',[reversedEarning,e.event_type==='click'?1:0,e.event_type==='conversion'?1:0,e.assignment_id]);updateQuality(e.creator_id);audit(actor,'earning.reversed',e.id,{reason});return {reversed:true};
}).immediate();}
