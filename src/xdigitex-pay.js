import { config } from './config.js';

const SUPPORTED_CURRENCIES=new Set(['KES','CDF','UGX','XOF','XAF','RWF','ZMW','SLE','USD']);
const SUPPORTED_GATEWAYS=new Set(['card','mobile']);

function requireConfigured(){
  if(!config.xdigitexPayApiKey) throw Object.assign(new Error('Xdigitex Pay is not configured'),{status:503});
}

async function request(path,{method='GET',body}={}){
  requireConfigured();
  const r=await fetch(config.xdigitexPayBaseUrl+path,{
    method,signal:AbortSignal.timeout(15000),
    headers:{'X-API-Key':config.xdigitexPayApiKey,'Content-Type':'application/json','Accept':'application/json'},
    body:body?JSON.stringify(body):undefined
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok || data?.success===false){
    throw Object.assign(new Error(data?.message||data?.error||'Xdigitex Pay request failed'),{status:502,providerStatus:r.status,providerBody:data});
  }
  return data;
}

export function assertCurrency(currency){
  const c=String(currency||'').toUpperCase();
  if(!SUPPORTED_CURRENCIES.has(c)) throw Object.assign(new Error('Unsupported currency'),{status:400});
  return c;
}
export function assertGateway(gateway){
  const g=String(gateway||'');
  if(!SUPPORTED_GATEWAYS.has(g)) throw Object.assign(new Error('Unsupported gateway'),{status:400});
  return g;
}
export const xdigitexPay={
  initiatePayment:payload=>request('/payments/initiate',{method:'POST',body:payload}),
  paymentStatus:reference=>request('/payments/'+encodeURIComponent(reference)+'/status'),
  gateways:()=>request('/gateways'),
  providerBalance:()=>request('/balance'),
  createWithdrawal:payload=>request('/withdrawals',{method:'POST',body:payload}),
  withdrawals:()=>request('/withdrawals')
};
