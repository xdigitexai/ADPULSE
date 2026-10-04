import { config } from './config.js';

const cache=new Map();
const ttl=15*60*1000;

export async function enrichIp(ip){
  if(!ip || !config.ipinfoToken) return {source:'none',asn:null,asnType:null,vpn:false,proxy:false,tor:false,hosting:false,risk:0,reasons:[]};
  const hit=cache.get(ip); if(hit && Date.now()-hit.ts<ttl) return hit.value;
  const reasons=[]; let risk=0;
  try{
    const [coreR,privacyR]=await Promise.all([
      fetch(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(config.ipinfoToken)}`),
      fetch(`https://api.ipinfo.io/privacy/${encodeURIComponent(ip)}?token=${encodeURIComponent(config.ipinfoToken)}`)
    ]);
    const core=coreR.ok?await coreR.json():{};
    const privacy=privacyR.ok?await privacyR.json():{};
    const vpn=!!privacy.vpn, proxy=!!privacy.proxy, tor=!!privacy.tor, hosting=!!privacy.hosting, relay=!!privacy.relay;
    if(vpn){risk+=25;reasons.push('vpn');}
    if(proxy){risk+=35;reasons.push('proxy');}
    if(tor){risk+=70;reasons.push('tor');}
    if(hosting){risk+=35;reasons.push('hosting_network');}
    if(relay){risk+=15;reasons.push('relay');}
    const value={source:'ipinfo',asn:core.asn||core.as_name||null,asnName:core.as_name||null,asnDomain:core.as_domain||null,asnType:core.as_type||null,vpn,proxy,tor,hosting,relay,risk,reasons};
    cache.set(ip,{ts:Date.now(),value}); return value;
  }catch{
    return {source:'error',asn:null,vpn:false,proxy:false,tor:false,hosting:false,risk:0,reasons:['ip_intel_unavailable']};
  }
}
