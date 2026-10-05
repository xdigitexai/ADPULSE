import {db,one,all,run,id,addLedger,balanceFor,finalizeMaturePublisherEarnings} from './db.js';
import {currencyCode,convertCurrency,rateSnapshot,refreshCurrencyRates,currencyFingerprint,currencies} from './currency-rates.js';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status})};
function holdings(userId){return all("SELECT currency,status,SUM(amount) amount FROM ledger_entries WHERE user_id=? AND status IN ('finalized','available','pending') GROUP BY currency,status ORDER BY currency,status",[userId]);}
export function accountCurrency(userId){return one('SELECT currency FROM users WHERE id=?',[userId])?.currency||null;}
export function assertAccountCurrency(user,currency){const code=currencyCode(currency);if(user.currency&&code!==user.currency)fail('Use your account currency: '+user.currency,400);return code;}
export function preferredBalances(userId){const currency=accountCurrency(userId);return currency?[{currency,balance:balanceFor(userId,currency)}]:all("SELECT currency,SUM(amount) balance FROM ledger_entries WHERE user_id=? AND status IN ('available','finalized') GROUP BY currency",[userId]);}
export function reportAmount(currency,rows){let total=0;try{for(const row of rows){if(Number(row.amount))total+=convertCurrency(db,row.amount,row.currency||'USD',currency||'USD').amount;}return Number(total.toFixed(6));}catch{return null;}}
export async function createCurrencyQuote(user,currency){
  if(user.supportSession)fail('Currency changes are disabled in support sessions',403);
  currency=currencyCode(currency);if(accountCurrency(user.id))fail('Your account currency is already selected');
  if(one("SELECT id FROM payment_transactions WHERE user_id=? AND kind='withdrawal' AND status IN ('pending','processing')",[user.id]))fail('Wait for your current withdrawal to finish before selecting currency');
  finalizeMaturePublisherEarnings();const rows=holdings(user.id);if(rows.some(r=>r.currency!==currency&&r.amount)||one("SELECT id FROM ledger_entries WHERE user_id=? AND type='PUBLISHER_EARNING' AND status='available' AND currency<>? LIMIT 1",[user.id,currency]))await refreshCurrencyRates(db);
  const snapshot=rateSnapshot(db),quoteRows=rows.map(r=>({...r,...convertCurrency(db,r.amount,r.currency,currency,snapshot)}));
  const quote={currency,rows:rows.map((r,i)=>({...r,convertedAmount:quoteRows[i].amount,rate:quoteRows[i].rate,rateDate:quoteRows[i].date})),fingerprint:currencyFingerprint(rows),rates:snapshot,available:Number(quoteRows.filter(r=>r.status!=='pending').reduce((n,r)=>n+r.amount,0).toFixed(6)),pending:Number(quoteRows.filter(r=>r.status==='pending').reduce((n,r)=>n+r.amount,0).toFixed(6)),fee:0};
  const quoteId=id('fxq'),expiresAt=new Date(Date.now()+300000).toISOString();run('INSERT INTO currency_quotes(id,user_id,currency,snapshot,expires_at) VALUES(?,?,?,?,?)',[quoteId,user.id,currency,JSON.stringify(quote),expiresAt]);return {quoteId,expiresAt,...quote,rates:undefined,fingerprint:undefined};
}
export function confirmCurrencyQuote(user,quoteId){return db.transaction(()=>{
  if(user.supportSession)fail('Currency changes are disabled in support sessions',403);
  const record=one('SELECT * FROM currency_quotes WHERE id=? AND user_id=?',[quoteId,user.id]);if(!record||record.used_at||record.expires_at<new Date().toISOString())fail('Currency quote expired or already used');
  if(accountCurrency(user.id))fail('Your account currency is already selected');
  if(one("SELECT id FROM payment_transactions WHERE user_id=? AND kind='withdrawal' AND status IN ('pending','processing')",[user.id]))fail('A withdrawal is in progress');
  const quote=JSON.parse(record.snapshot);if(currencyFingerprint(holdings(user.id))!==quote.fingerprint)fail('Your balance changed. Review a new currency quote.');
  for(const row of quote.rows.filter(r=>r.status!=='pending'&&r.currency!==quote.currency&&r.amount)){
    addLedger({deferMirror:true,userId:user.id,eventId:quoteId,type:'FX_TRANSFER_OUT',amount:-row.amount,currency:row.currency,note:'Account currency selection'});
    const credit=addLedger({deferMirror:true,userId:user.id,eventId:quoteId,type:'FX_TRANSFER_IN',amount:row.convertedAmount,currency:quote.currency,note:'Account currency selection; zero exchange fee'});
    run('INSERT INTO currency_settlements(ledger_id,source_currency,source_amount,target_currency,target_amount,rate,rate_date) VALUES(?,?,?,?,?,?,?)',[credit.id,row.currency,row.amount,quote.currency,row.convertedAmount,row.rate,row.rateDate]);
  }
  for(const pending of all("SELECT * FROM ledger_entries WHERE user_id=? AND status='pending' AND currency<>?",[user.id,quote.currency])){
    if(pending.type!=='PUBLISHER_EARNING')fail('A pending financial hold requires review before conversion');
    const converted=convertCurrency(db,pending.amount,pending.currency,quote.currency,quote.rates);run("UPDATE ledger_entries SET status='converted' WHERE id=?",[pending.id]);
    const credit=addLedger({deferMirror:true,userId:user.id,eventId:pending.event_id,type:pending.type,amount:converted.amount,currency:quote.currency,status:'pending',note:'Converted pending earning; original '+pending.id});run('UPDATE ledger_entries SET created_at=? WHERE id=?',[pending.created_at,credit.id]);
    if(pending.amount!==0)run('INSERT INTO currency_settlements(ledger_id,source_currency,source_amount,target_currency,target_amount,rate,rate_date) VALUES(?,?,?,?,?,?,?)',[credit.id,pending.currency,pending.amount,quote.currency,converted.amount,converted.rate,converted.date]);
  }
  // Preserve the accepted rate for historical reporting and any later fraud reversal.
  for(const earning of all("SELECT * FROM ledger_entries WHERE user_id=? AND type='PUBLISHER_EARNING' AND status='available' AND currency<>?",[user.id,quote.currency])){
    const settled=convertCurrency(db,earning.amount,earning.currency,quote.currency,quote.rates);
    run('INSERT OR IGNORE INTO currency_settlements(ledger_id,source_currency,source_amount,target_currency,target_amount,rate,rate_date) VALUES(?,?,?,?,?,?,?)',[earning.id,earning.currency,earning.amount,quote.currency,settled.amount,settled.rate,settled.date]);
  }
  run('UPDATE users SET currency=? WHERE id=?',[quote.currency,user.id]);run('UPDATE currency_quotes SET used_at=CURRENT_TIMESTAMP WHERE id=?',[quoteId]);
  for(const assignment of all('SELECT a.id,a.earnings,c.currency FROM creator_campaign_assignments a JOIN creator_campaigns c ON c.id=a.campaign_id WHERE a.publisher_id=?',[user.id])){
    const earning=convertCurrency(db,assignment.earnings,assignment.currency,quote.currency,quote.rates);run('UPDATE creator_campaign_assignments SET earnings=? WHERE id=?',[earning.amount,assignment.id]);
  }
  run("UPDATE campaigns SET status='paused' WHERE advertiser_id=? AND currency<>? AND status='active' AND is_house=0",[user.id,quote.currency]);
  run("UPDATE creator_campaigns SET status='paused' WHERE advertiser_id=? AND currency<>? AND status='active'",[user.id,quote.currency]);
  return {currency:quote.currency,balance:balanceFor(user.id,quote.currency),pending:quote.pending};
}).immediate();}
export function registerCurrency(app,{auth,wrap}){
  app.get('/api/account/currency',auth(),(req,res)=>res.json({currency:req.user.currency||null,choices:currencies,balances:preferredBalances(req.user.id),rateProvider:'https://www.exchangerate-api.com'}));
  app.post('/api/account/currency/quote',auth(),wrap(async(req,res)=>res.json(await createCurrencyQuote(req.user,req.body.currency))));
  app.post('/api/account/currency/confirm',auth(),wrap(async(req,res)=>res.json(confirmCurrencyQuote(req.user,String(req.body.quoteId||'')))));
}
