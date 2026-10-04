import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

function isPublicIp(value){
  try{
    const addr=ipaddr.parse(value);
    const range=addr.range();
    return ['unicast'].includes(range);
  }catch{return false}
}
async function assertPublicHost(hostname){
  const rows=await dns.lookup(hostname,{all:true,verbatim:true});
  if(!rows.length) throw Object.assign(new Error('Domain did not resolve'),{status:400});
  if(rows.some(x=>!isPublicIp(x.address))) throw Object.assign(new Error('Private or reserved network destinations are not allowed'),{status:400});
}
export async function safeFetchUrl(input,{timeoutMs=8000,headers={},maxRedirects=3}={}){
  let url=new URL(input);
  if(!['http:','https:'].includes(url.protocol)) throw Object.assign(new Error('Only HTTP/HTTPS URLs are allowed'),{status:400});
  for(let i=0;i<=maxRedirects;i++){
    await assertPublicHost(url.hostname);
    const r=await fetch(url,{headers,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
    if([301,302,303,307,308].includes(r.status)){
      const location=r.headers.get('location');
      if(!location) return r;
      url=new URL(location,url);
      if(!['http:','https:'].includes(url.protocol)) throw Object.assign(new Error('Unsafe redirect protocol'),{status:400});
      continue;
    }
    return r;
  }
  throw Object.assign(new Error('Too many redirects'),{status:400});
}
export async function fetchPublisherPath(domain,path='/',options={}){
  let last;
  for(const scheme of ['https','http']){
    try{return await safeFetchUrl(`${scheme}://${domain}${path}`,options)}catch(err){last=err}
  }
  throw last||new Error('Publisher site is unreachable');
}
