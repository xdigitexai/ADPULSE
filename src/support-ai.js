import { config } from './config.js';

const FAQ=[
  {keys:['verify','site','domain'],answer:'To verify a publisher site, ADPulse supports a meta tag, a root verification file, or a DNS TXT record. After ownership verification, the site enters admin review before live ad zones can serve paid campaigns.'},
  {keys:['withdraw','payout','money'],answer:'Publisher withdrawals require verified KYC and use supported Xdigitex Pay mobile-money rails. Available balances remain separated by currency.'},
  {keys:['campaign','advert'],answer:'Advertisers can create CPM, CPC or hybrid campaigns, set targeting, budgets, schedules, frequency caps and conversion attribution windows.'},
  {keys:['ads.txt','seller'],answer:'Approved publishers receive a seller ID and an exact ads.txt line. ADPulse also exposes sellers.json for supply-chain transparency.'}
];

export async function answerSupport(message,context={}){
  const text=String(message||'').slice(0,4000);
  if(config.aiContextUrl && config.aiContextKey && config.aiContextModel){
    try{
      const r=await fetch(config.aiContextUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${config.aiContextKey}`},body:JSON.stringify({
        model:config.aiContextModel,
        messages:[
          {role:'system',content:'You are ADPulse Support. Help publishers and advertisers use the platform. Be concise, do not invent account-specific facts, and direct billing/KYC/security disputes to a human agent.'},
          {role:'user',content:`ROLE: ${context.role||'guest'}\nQUESTION: ${text}`}
        ],
        temperature:.2
      })});
      if(r.ok){
        const data=await r.json();
        const answer=data?.choices?.[0]?.message?.content;
        if(answer) return {answer,provider:'ai'};
      }
    }catch{}
  }
  const lower=text.toLowerCase();
  const hit=FAQ.map(x=>({...x,score:x.keys.filter(k=>lower.includes(k)).length})).sort((a,b)=>b.score-a.score)[0];
  return {answer:hit?.score?hit.answer:'I can help with site verification, ad zones, campaigns, payments, KYC, analytics and ads.txt. For account-specific billing or policy reviews, use Live Chat or Contact Sales so a human can take over.',provider:'faq'};
}
