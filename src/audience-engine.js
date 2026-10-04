import { one, all, run, db } from './db.js';

export const SENSITIVE_INTERESTS=new Set([
  'gambling','betting','casino','health','medical','politics','political','religion',
  'sexuality','sexual_orientation','financial_hardship','debt','addiction','forex','trading','investment','investing','loan','credit','crypto'
]);

const clamp=n=>Math.max(0,Math.min(1,Number(n)||0));
const normalize=t=>String(t||'').trim().toLowerCase().replace(/[^a-z0-9_ -]/g,'').replace(/\s+/g,'_').slice(0,64);

export function isSensitiveInterest(topic){return SENSITIVE_INTERESTS.has(normalize(topic));}

function decayScore(score,updatedAt,halfLifeDays=21){
  const ageDays=Math.max(0,(Date.now()-new Date(updatedAt+'Z').getTime())/86400000);
  return clamp(Number(score||0)*Math.pow(.5,ageDays/halfLifeDays));
}

export function updateAudienceSignal({browserId,sessionId,topics=[],category='',personalizationAllowed=false,weight=.12}){
  const clean=[category,...topics].map(normalize).filter(Boolean);
  const unique=[...new Set(clean)];
  const now=new Date().toISOString().replace('T',' ').replace('Z','');
  const tx=db.transaction(()=>{
    if(browserId){
      run(`INSERT INTO audience_privacy(browser_id,personalization_allowed,measurement_allowed,storage_allowed,updated_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(browser_id) DO UPDATE SET personalization_allowed=excluded.personalization_allowed,storage_allowed=excluded.storage_allowed,updated_at=CURRENT_TIMESTAMP`,
        [browserId,personalizationAllowed?1:0,1,personalizationAllowed?1:0]);
      if(!personalizationAllowed) run('DELETE FROM audience_interests WHERE browser_id=?',[browserId]);
    }
    for(const topic of unique){
      if(sessionId){
        const existing=one('SELECT * FROM session_interests WHERE session_id=? AND topic=?',[sessionId,topic]);
        const next=clamp((existing?decayScore(existing.score,existing.updated_at,1):0)+weight);
        run(`INSERT INTO session_interests(session_id,topic,score,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(session_id,topic) DO UPDATE SET score=excluded.score,updated_at=excluded.updated_at`,
          [sessionId,topic,next,now]);
      }
      if(browserId && personalizationAllowed && !isSensitiveInterest(topic)){
        const existing=one('SELECT * FROM audience_interests WHERE browser_id=? AND topic=?',[browserId,topic]);
        const next=clamp((existing?decayScore(existing.score,existing.updated_at,21):0)+weight);
        run(`INSERT INTO audience_interests(browser_id,topic,score,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(browser_id,topic) DO UPDATE SET score=excluded.score,updated_at=excluded.updated_at`,
          [browserId,topic,next,now]);
      }
    }
    run("DELETE FROM session_interests WHERE updated_at<datetime('now','-1 day')");
    run("DELETE FROM audience_interests WHERE updated_at<datetime('now','-90 day')");
  });
  tx();
}

export function audienceFor({browserId='',sessionId='',personalizationAllowed=false}){
  const session=sessionId?all('SELECT topic,score,updated_at FROM session_interests WHERE session_id=? ORDER BY score DESC LIMIT 20',[sessionId]).map(x=>({topic:x.topic,score:decayScore(x.score,x.updated_at,1),source:'session'})):[];
  const persistent=(browserId&&personalizationAllowed)?all('SELECT topic,score,updated_at FROM audience_interests WHERE browser_id=? ORDER BY score DESC LIMIT 20',[browserId]).map(x=>({topic:x.topic,score:decayScore(x.score,x.updated_at,21),source:'persistent'})):[];
  const merged=new Map();
  for(const row of [...persistent,...session]) merged.set(row.topic,Math.max(merged.get(row.topic)||0,row.score));
  return [...merged.entries()].map(([topic,score])=>({topic,score})).sort((a,b)=>b.score-a.score).slice(0,20);
}

export function interestMatchScore(targets=[],excludes=[],audience=[]){
  const map=new Map(audience.map(x=>[normalize(x.topic),Number(x.score||0)]));
  if(excludes.some(x=>(map.get(normalize(x))||0)>=.25)) return {blocked:true,score:0};
  if(!targets.length) return {blocked:false,score:1};
  let best=0;
  for(const t of targets) best=Math.max(best,map.get(normalize(t))||0);
  return {blocked:false,score:best>0?1+best:0.55};
}
