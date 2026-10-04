import { config } from './config.js';

const BAD_WORDS=['malware','phishing','pirated','hate','terror','porn','adult','weapon','casino','gambling','counterfeit','scam'];
const TOPICS={
  technology:['technology','software','ai','phone','computer','internet','startup','cloud'],
  finance:['bank','finance','investment','loan','money','market','insurance'],
  sports:['football','soccer','basketball','sport','league','match'],
  news:['news','politics','government','election','breaking'],
  entertainment:['music','movie','celebrity','film','entertainment'],
  education:['school','education','university','student','course','learn'],
  travel:['travel','hotel','flight','tourism','destination'],
  automotive:['car','vehicle','motor','automotive','truck']
};

function fallback(text=''){
  const lower=text.toLowerCase();
  const topics=Object.entries(TOPICS).map(([k,words])=>[k,words.filter(w=>lower.includes(w)).length]).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  const flags=BAD_WORDS.filter(w=>lower.includes(w));
  return {category:topics[0]||'general',topics:topics.slice(0,5),language:'unknown',brandSafety:flags.length?'restricted':'standard',flags,summary:text.replace(/\s+/g,' ').slice(0,280),provider:'heuristic'};
}

export async function classifyPage({url,title='',text=''}){
  const input=(title+'\n'+text).slice(0,12000);
  if(!config.aiContextUrl || !config.aiContextKey || !config.aiContextModel) return fallback(input);
  const prompt=`Classify this publisher webpage for an advertising network. Return JSON only with keys category, topics (max 5), language, brandSafety ("strict","standard","restricted"), flags (array), summary (max 240 chars). Never infer sensitive traits about people. URL: ${url}\nCONTENT:\n${input}`;
  try{
    const r=await fetch(config.aiContextUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${config.aiContextKey}`},body:JSON.stringify({model:config.aiContextModel,messages:[{role:'system',content:'You are a contextual advertising and brand-safety classifier.'},{role:'user',content:prompt}],temperature:0,response_format:{type:'json_object'}})});
    if(!r.ok) throw new Error('ai unavailable');
    const out=await r.json();
    const raw=out?.choices?.[0]?.message?.content||'{}';
    const parsed=JSON.parse(raw);
    return {...fallback(input),...parsed,provider:'ai'};
  }catch{return fallback(input);}
}
