import crypto from 'node:crypto';
import { all } from './db.js';

export function hashIp(ip='') {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0,32);
}

export function deviceFromUA(ua='') {
  const s=ua.toLowerCase();
  if(/bot|crawler|spider|headless/.test(s)) return 'bot';
  if(/ipad|tablet/.test(s)) return 'tablet';
  if(/mobile|android|iphone/.test(s)) return 'mobile';
  return 'desktop';
}

export function scoreEvent({ipHash,userAgent='',eventType,requestId,publisherId,campaignId='',browserId='',sessionId='',metadata={}}) {
  let score=0; const reasons=[];
  const ua=userAgent.toLowerCase();
  if(!userAgent){score+=25;reasons.push('missing_user_agent');}
  if(/bot|crawler|spider|headless|phantom|selenium/.test(ua)){score+=70;reasons.push('automation_signature');}
  if(metadata.webdriver===true){score+=75;reasons.push('webdriver_flag');}
  if(Number(metadata.screenWidth||0)>0 && Number(metadata.screenWidth)<240){score+=25;reasons.push('implausible_viewport');}
  if(metadata.visibilityPercent !== undefined && Number(metadata.visibilityPercent)<50 && eventType==='view'){score+=80;reasons.push('not_viewable');}
  if(metadata.visibleMs !== undefined && Number(metadata.visibleMs)<1000 && eventType==='view'){score+=80;reasons.push('view_too_short');}
  const recent=all("SELECT event_type,publisher_id,campaign_id,browser_id,created_at FROM ad_events WHERE ip_hash=? AND created_at >= datetime('now','-10 minutes')",[ipHash]);
  const clicks=recent.filter(x=>x.event_type==='click').length;
  const views=recent.filter(x=>x.event_type==='view').length;
  if(views>=120){score+=35;reasons.push('view_velocity');}
  if(eventType==='click' && clicks>=5){score+=45;reasons.push('click_velocity');}
  if(eventType==='click' && campaignId){
    const ipCampaign=all("SELECT id FROM ad_events WHERE ip_hash=? AND campaign_id=? AND event_type='click' AND valid=1 AND created_at>=datetime('now','-1 day')",[ipHash,campaignId]).length;
    if(ipCampaign>=2){score+=100;reasons.push('repeat_ip_campaign_click');}
  }
  if(eventType==='click' && browserId){
    const browserCampaign=all("SELECT id FROM ad_events WHERE browser_id=? AND campaign_id=? AND event_type='click' AND valid=1 AND created_at>=datetime('now','-1 day')",[browserId,campaignId]).length;
    if(browserCampaign>=1){score+=100;reasons.push('repeat_browser_campaign_click');}
    const browserPublisher=all("SELECT id FROM ad_events WHERE browser_id=? AND publisher_id=? AND event_type='click' AND created_at>=datetime('now','-1 day')",[browserId,publisherId]).length;
    if(browserPublisher>=20){score+=100;reasons.push('browser_click_farm_pattern');}
  }
  const sameRequest=all('SELECT event_type FROM ad_events WHERE request_id=?',[requestId]);
  if(eventType==='click' && sameRequest.some(x=>x.event_type==='click')){score+=100;reasons.push('duplicate_click');}
  if(eventType==='click'){
    const validView=all("SELECT id FROM ad_events WHERE request_id=? AND event_type='view' AND valid=1 LIMIT 1",[requestId])[0];
    if(!validView){score+=100;reasons.push('click_without_valid_view');}
    const req=all("SELECT created_at FROM ad_events WHERE request_id=? AND event_type='request' ORDER BY created_at ASC LIMIT 1",[requestId])[0];
    if(req){const ms=Date.now()-new Date(req.created_at+'Z').getTime();if(ms>=0&&ms<300){score+=35;reasons.push('impossibly_fast_click');}}
  }
  if(eventType==='view' && sameRequest.some(x=>x.event_type==='view')){score+=100;reasons.push('duplicate_view');}
  return {score,valid:score<80,reasons};
}
