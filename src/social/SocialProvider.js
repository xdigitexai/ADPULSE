import {fail} from './core.js';
import {encryptionReady} from './token-store.js';
export class SocialProvider {
  constructor(platform,settings,fetcher=globalThis.fetch){this.platform=platform;this.settings=settings;this.fetch=fetcher;}
  configured(){const s=this.settings;return Boolean(s.clientId&&s.clientSecret&&s.redirectUri&&encryptionReady()&&(this.platform!=='facebook'&&this.platform!=='instagram'||s.version));}
  scopes(){return this.settings.scopes;}
  capabilities(granted=[]){const ready=this.configured();return {connect:ready,profile:ready,metrics:ready&&this.metricScopes().some(s=>granted.includes(s)),directPublish:ready&&this.settings.publishApproved&&this.publishScopes().every(s=>granted.includes(s)),upload:ready&&this.settings.publishApproved&&this.publishScopes().every(s=>granted.includes(s)),manualExport:true};}
  metricScopes(){return [];}publishScopes(){return [];}
  async request(url,options={}){let response,data;try{response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});data=await response.json();}catch{throw Object.assign(new Error('Social provider request failed'),{publicMessage:'Social provider connection failed',status:502});}if(!response.ok||data.error&&data.error.code!=='ok')throw Object.assign(new Error('Social provider rejected request'),{publicMessage:'Social provider rejected the request; reconnect or check app permissions',status:502,requiresReconnect:response.status===401||data.error?.code===190||['access_token_invalid','auth_removed'].includes(data.error?.code)});return data;}
  bearer(token){return {Authorization:'Bearer '+token};}
  async getMetrics(token,profile){return Object.fromEntries(['followers','following','total_views','avg_views','engagement_rate'].filter(k=>profile[k]!=null).map(k=>[k,profile[k]]));}
  async disconnect(){return {revoked:false};}
  async refreshToken(){fail('Provider requires reconnection',409);}
  async upload(url,token,file,headers={}){const fs=await import('node:fs');const size=fs.statSync(file).size;const u=new URL(url);if(u.protocol!=='https:'||!this.uploadHosts().some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))fail('Invalid provider upload host');let r;try{r=await this.fetch(u,{method:'PUT',headers:{...this.bearer(token),'Content-Type':'video/mp4','Content-Length':String(size),...headers},body:fs.createReadStream(file),duplex:'half',redirect:'error',signal:AbortSignal.timeout(300000)});}catch{throw Object.assign(new Error('Upload outcome unknown'),{publicMessage:'Upload interrupted; check provider status before retry'});}if(!r.ok)throw Object.assign(new Error('Upload rejected'),{publicMessage:'Provider rejected video upload'});return r;}
  uploadHosts(){return [];}
}
export function envSettings(prefix,defaults={}){const e=process.env,scopes=e[prefix+'_SCOPES']||defaults.scopes||[];return {clientId:e[prefix+'_CLIENT_ID']||e[prefix+'_CLIENT_KEY']||e[prefix+'_APP_ID'],clientSecret:e[prefix+'_CLIENT_SECRET']||e[prefix+'_APP_SECRET'],redirectUri:e[prefix+'_REDIRECT_URI'],publishApproved:e[prefix+'_PUBLISH_APPROVED']==='true',verified:e[prefix+'_API_VERIFIED']==='true',version:e.META_GRAPH_VERSION,...defaults,scopes:Array.isArray(scopes)?scopes:scopes.split(/[ ,]+/).filter(Boolean)};}
export function grantedScopes(value){if(typeof value==='string')return value.split(/[ ,]+/).filter(Boolean);if(Array.isArray(value))return value.filter(x=>typeof x==='string'||x.status==='granted').map(x=>typeof x==='string'?x:x.permission).filter(Boolean);return [];}
