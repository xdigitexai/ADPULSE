import pg from 'pg';
import { createClient } from 'redis';
import { createClient as createClickHouseClient } from '@clickhouse/client';
import { config } from './config.js';

let pgPool=null, redis=null, clickhouse=null;

export async function initProductionStores(){
  if(config.databaseUrl){
    pgPool=new pg.Pool({connectionString:config.databaseUrl,max:20,ssl:config.databaseSsl?{rejectUnauthorized:false}:undefined});
    await pgPool.query('SELECT 1');
  }
  if(config.redisUrl){
    redis=createClient({url:config.redisUrl});
    redis.on('error',err=>console.error('Redis error',err.message));
    await redis.connect();
  }
  if(config.clickhouseUrl){
    clickhouse=createClickHouseClient({url:config.clickhouseUrl,username:config.clickhouseUser,password:config.clickhousePassword,database:'adpulse'});
    await clickhouse.query({query:'SELECT 1'});
  }
  return {postgres:!!pgPool,redis:!!redis,clickhouse:!!clickhouse};
}

export function productionStatus(){ return {postgres:!!pgPool,redis:!!redis?.isReady,clickhouse:!!clickhouse}; }

export async function mirrorLedger(entry){
  if(!pgPool)return;
  await pgPool.query(`INSERT INTO production_ledger_mirror(id,user_id,event_id,type,amount,currency,status,note,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(id) DO NOTHING`,
    [entry.id,entry.userId,entry.eventId,entry.type,entry.amount,entry.currency,entry.status,entry.note]);
}

export async function cacheFrequency({campaignId,ipHash,ttl=86400}){
  if(!redis)return null;
  const key=`freq:${campaignId}:${ipHash}`;
  const value=await redis.incr(key);
  if(value===1) await redis.expire(key,ttl);
  return value;
}
export async function getFrequency({campaignId,ipHash}){
  if(!redis)return null;
  return Number(await redis.get(`freq:${campaignId}:${ipHash}`)||0);
}

export async function writeAdEvent(row){
  if(!clickhouse)return;
  await clickhouse.insert({table:'ad_events',values:[{
    event_id:row.id,request_id:row.request_id||'',event_type:row.event_type||'',
    campaign_id:row.campaign_id||'',publisher_id:row.publisher_id||'',site_id:row.site_id||'',zone_id:row.zone_id||'',
    ip_hash:row.ip_hash||'',country:row.country||'',device:row.device||'',risk_score:Number(row.risk_score||0),
    valid:row.valid?1:0,bill_amount:String(row.bill_amount||0),publisher_amount:String(row.publisher_amount||0),
    created_at:new Date().toISOString().replace('T',' ').replace('Z','')
  }],format:'JSONEachRow'});
}

export async function writeConversion(row){
  if(!clickhouse)return;
  await clickhouse.insert({table:'conversions',values:[{
    conversion_id:row.id,campaign_id:row.campaign_id,advertiser_id:row.advertiser_id,request_id:row.request_id||'',
    event_name:row.event_name,value:String(row.value||0),currency:row.currency,external_id:row.external_id||'',
    created_at:new Date().toISOString().replace('T',' ').replace('Z','')
  }],format:'JSONEachRow'});
}
