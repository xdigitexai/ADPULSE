import crypto from 'node:crypto';

export const currencies=['USD','KES','UGX','CDF','XOF','XAF','RWF','ZMW','SLE'];
const RATE_KEY='account_currency_rates';
export function currencyCode(value){const code=String(value||'').toUpperCase();if(!currencies.includes(code))throw Object.assign(Error('Choose a supported account currency'),{status:400});return code;}
export function migrateCurrency(db){
  if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='currency'))db.exec('ALTER TABLE users ADD COLUMN currency TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS currency_settlements(ledger_id TEXT PRIMARY KEY REFERENCES ledger_entries(id),source_currency TEXT NOT NULL,source_amount REAL NOT NULL,target_currency TEXT NOT NULL,target_amount REAL NOT NULL,rate REAL NOT NULL,rate_date TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS currency_quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),currency TEXT NOT NULL,snapshot TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
}
export function rateSnapshot(db){const row=db.prepare('SELECT value FROM system_settings WHERE key=?').get(RATE_KEY);if(!row)return null;try{return JSON.parse(row.value)}catch{return null}}
export function convertCurrency(db,amount,from,to,snapshot=rateSnapshot(db)){
  from=currencyCode(from);to=currencyCode(to);
  if(from===to)return {amount:Number(amount),rate:1,date:'same-currency'};
  if(Number(amount)===0)return {amount:0,rate:null,date:'zero-amount'};
  const age=Date.now()-Number(snapshot?.timestamp)*1000;
  if(!snapshot||age>48*3600000||age< -300000||!(snapshot.rates?.[from]>0)||!(snapshot.rates?.[to]>0))throw Object.assign(Error('A current exchange rate is unavailable. No currency conversion was performed.'),{status:503});
  const rate=snapshot.rates[to]/snapshot.rates[from];return {amount:Number((Number(amount)*rate).toFixed(6)),rate,date:new Date(snapshot.timestamp*1000).toISOString()};
}
let refreshing;
export async function refreshCurrencyRates(db,fetcher=fetch){
  const current=rateSnapshot(db);
  if(current&&Date.now()/1000<Number(current.nextUpdate))return current;
  if(refreshing)return refreshing;
  refreshing=(async()=>{const response=await fetcher('https://open.er-api.com/v6/latest/USD',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Exchange-rate provider unavailable');const data=await response.json();if(data.result!=='success'||data.base_code!=='USD'||data.rates?.USD!==1||!Number.isFinite(data.time_last_update_unix)||!Number.isFinite(data.time_next_update_unix)||data.time_next_update_unix<=data.time_last_update_unix||currencies.some(c=>!Number.isFinite(data.rates?.[c])||data.rates[c]<=0)||data.time_last_update_unix>Date.now()/1000+300||Math.abs(Date.now()/1000-data.time_last_update_unix)>172800)throw Error('Invalid or outdated exchange rates');const snapshot={timestamp:data.time_last_update_unix,nextUpdate:Math.min(data.time_next_update_unix,Date.now()/1000+86400),rates:Object.fromEntries(currencies.map(c=>[c,data.rates[c]])),provider:'https://www.exchangerate-api.com'};db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(RATE_KEY,JSON.stringify(snapshot));return snapshot;})().finally(()=>{refreshing=null});
  return refreshing;
}
export function currencyFingerprint(rows){return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
