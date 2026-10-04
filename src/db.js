import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { mirrorLedger } from './production-store.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const hasColumn=(table,column)=>db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('advertiser','publisher','admin')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  kyc_status TEXT NOT NULL DEFAULT 'not_started',
  phone TEXT,
  country TEXT,
  google_sub TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS account_ip_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ip_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_account_ip_hash ON account_ip_history(ip_hash,user_id);
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES users(id),
  domain TEXT NOT NULL UNIQUE,
  verification_token TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'meta',
  status TEXT NOT NULL DEFAULT 'pending_verification',
  category TEXT DEFAULT 'general',
  language TEXT DEFAULT 'en',
  quality_score REAL NOT NULL DEFAULT 50,
  seller_id TEXT,
  ads_txt_status TEXT NOT NULL DEFAULT 'missing',
  topics TEXT NOT NULL DEFAULT '[]',
  brand_safety TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  publisher_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'responsive',
  width INTEGER,
  height INTEGER,
  floor_cpm REAL NOT NULL DEFAULT 0,
  refresh_enabled INTEGER NOT NULL DEFAULT 0,
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 45,
  refresh_max INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active',
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  headline TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  video_url TEXT,
  creative_type TEXT NOT NULL DEFAULT 'display',
  model TEXT NOT NULL CHECK(model IN ('CPM','CPC','HYBRID')),
  cpm REAL NOT NULL DEFAULT 0,
  cpc REAL NOT NULL DEFAULT 0,
  budget_total REAL NOT NULL,
  budget_daily REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  spent_total REAL NOT NULL DEFAULT 0,
  spent_today REAL NOT NULL DEFAULT 0,
  target_countries TEXT NOT NULL DEFAULT '[]',
  target_categories TEXT NOT NULL DEFAULT '[]',
  target_devices TEXT NOT NULL DEFAULT '[]',
  target_interests TEXT NOT NULL DEFAULT '[]',
  exclude_interests TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at TEXT,
  ends_at TEXT,
  frequency_cap_daily INTEGER NOT NULL DEFAULT 3,
  conversion_window_days INTEGER NOT NULL DEFAULT 7,
  public_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ad_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('request','render','view','click','conversion')),
  campaign_id TEXT REFERENCES campaigns(id),
  publisher_id TEXT REFERENCES users(id),
  site_id TEXT REFERENCES sites(id),
  zone_id TEXT REFERENCES zones(id),
  ip_hash TEXT,
  user_agent TEXT,
  country TEXT,
  device TEXT,
  browser_id TEXT,
  session_id TEXT,
  risk_score REAL NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 1,
  bill_amount REAL NOT NULL DEFAULT 0,
  publisher_amount REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON ad_events(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_publisher ON ad_events(publisher_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_request ON ad_events(request_id);
CREATE INDEX IF NOT EXISTS idx_events_browser ON ad_events(browser_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_ip_campaign ON ad_events(ip_hash, campaign_id, created_at);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'finalized',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id, created_at);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  advertiser_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT,
  click_event_id TEXT,
  event_name TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  external_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(advertiser_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_conversions_campaign ON conversions(campaign_id, created_at);
CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  reference TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('deposit','withdrawal')),
  gateway TEXT,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_user ON payment_transactions(user_id, created_at);
CREATE TABLE IF NOT EXISTS audience_interests (
  browser_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(browser_id,topic)
);
CREATE INDEX IF NOT EXISTS idx_audience_interest_topic ON audience_interests(topic,score);
CREATE TABLE IF NOT EXISTS session_interests (
  session_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(session_id,topic)
);
CREATE INDEX IF NOT EXISTS idx_session_interest_updated ON session_interests(updated_at);
CREATE TABLE IF NOT EXISTS audience_privacy (
  browser_id TEXT PRIMARY KEY,
  personalization_allowed INTEGER NOT NULL DEFAULT 0,
  measurement_allowed INTEGER NOT NULL DEFAULT 1,
  storage_allowed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS page_contexts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  topics TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  brand_safety TEXT NOT NULL DEFAULT 'standard',
  summary TEXT,
  provider TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id,url_hash)
);
CREATE INDEX IF NOT EXISTS idx_page_context_site ON page_contexts(site_id,updated_at);
CREATE TABLE IF NOT EXISTS support_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  email TEXT,
  name TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  access_token TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id),
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user','admin','system')),
  sender_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_conv ON support_messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS moderation (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  action TEXT NOT NULL,
  admin_id TEXT REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

if(!hasColumn('users','kyc_status')) db.exec("ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'not_started'");
if(!hasColumn('users','phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
if(!hasColumn('users','country')) db.exec("ALTER TABLE users ADD COLUMN country TEXT");
if(!hasColumn('campaigns','currency')) db.exec("ALTER TABLE campaigns ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
if(!hasColumn('sites','seller_id')) db.exec("ALTER TABLE sites ADD COLUMN seller_id TEXT");
if(!hasColumn('sites','ads_txt_status')) db.exec("ALTER TABLE sites ADD COLUMN ads_txt_status TEXT NOT NULL DEFAULT 'missing'");
if(!hasColumn('sites','topics')) db.exec("ALTER TABLE sites ADD COLUMN topics TEXT NOT NULL DEFAULT '[]'");
if(!hasColumn('sites','brand_safety')) db.exec("ALTER TABLE sites ADD COLUMN brand_safety TEXT NOT NULL DEFAULT 'standard'");
if(!hasColumn('campaigns','frequency_cap_daily')) db.exec("ALTER TABLE campaigns ADD COLUMN frequency_cap_daily INTEGER NOT NULL DEFAULT 3");
if(!hasColumn('campaigns','conversion_window_days')) db.exec("ALTER TABLE campaigns ADD COLUMN conversion_window_days INTEGER NOT NULL DEFAULT 7");
if(!hasColumn('campaigns','public_key')) db.exec("ALTER TABLE campaigns ADD COLUMN public_key TEXT");
if(!hasColumn('campaigns','video_url')) db.exec("ALTER TABLE campaigns ADD COLUMN video_url TEXT");
if(!hasColumn('campaigns','creative_type')) db.exec("ALTER TABLE campaigns ADD COLUMN creative_type TEXT NOT NULL DEFAULT 'display'");
if(!hasColumn('campaigns','is_house')) db.exec("ALTER TABLE campaigns ADD COLUMN is_house INTEGER NOT NULL DEFAULT 0");
if(!hasColumn('campaigns','house_site_ids')) db.exec("ALTER TABLE campaigns ADD COLUMN house_site_ids TEXT NOT NULL DEFAULT '[]'");
if(!hasColumn('users','google_sub')) db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
if(!hasColumn('zones','refresh_enabled')) db.exec("ALTER TABLE zones ADD COLUMN refresh_enabled INTEGER NOT NULL DEFAULT 0");
if(!hasColumn('zones','refresh_interval_seconds')) db.exec("ALTER TABLE zones ADD COLUMN refresh_interval_seconds INTEGER NOT NULL DEFAULT 45");
if(!hasColumn('zones','refresh_max')) db.exec("ALTER TABLE zones ADD COLUMN refresh_max INTEGER NOT NULL DEFAULT 3");
if(!hasColumn('zones','display_settings')) db.exec("ALTER TABLE zones ADD COLUMN display_settings TEXT NOT NULL DEFAULT '{}'");
db.exec(`CREATE TABLE IF NOT EXISTS ad_ux_events (
  id TEXT PRIMARY KEY,request_id TEXT NOT NULL,campaign_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,zone_id TEXT NOT NULL,event_type TEXT NOT NULL,
  ip_hash TEXT,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id,event_type)
);CREATE INDEX IF NOT EXISTS idx_ux_publisher ON ad_ux_events(publisher_id,created_at);`);
if(!hasColumn('campaigns','target_interests')) db.exec("ALTER TABLE campaigns ADD COLUMN target_interests TEXT NOT NULL DEFAULT '[]'");
if(!hasColumn('campaigns','exclude_interests')) db.exec("ALTER TABLE campaigns ADD COLUMN exclude_interests TEXT NOT NULL DEFAULT '[]'");
if(!hasColumn('ad_events','browser_id')) db.exec("ALTER TABLE ad_events ADD COLUMN browser_id TEXT");
if(!hasColumn('ad_events','session_id')) db.exec("ALTER TABLE ad_events ADD COLUMN session_id TEXT");
if(!hasColumn('support_conversations','access_token')) db.exec("ALTER TABLE support_conversations ADD COLUMN access_token TEXT");

for(const row of db.prepare("SELECT id FROM campaigns WHERE public_key IS NULL OR public_key='' ").all()){
  db.prepare('UPDATE campaigns SET public_key=? WHERE id=?').run(`cmp_${nanoid(24)}`,row.id);
}
for(const row of db.prepare("SELECT id FROM sites WHERE seller_id IS NULL OR seller_id='' ").all()){
  db.prepare('UPDATE sites SET seller_id=? WHERE id=?').run(`PUB-${nanoid(10).toUpperCase()}`,row.id);
}

export function id(prefix='id') { return `${prefix}_${nanoid(16)}`; }
export function one(sql, params=[]) { return db.prepare(sql).get(...params); }
export function all(sql, params=[]) { return db.prepare(sql).all(...params); }
export function run(sql, params=[]) { return db.prepare(sql).run(...params); }

export function balanceFor(userId,currency='USD') {
  return Number(one("SELECT COALESCE(SUM(amount),0) AS balance FROM ledger_entries WHERE user_id=? AND currency=? AND status IN ('finalized','available')",[userId,String(currency).toUpperCase()]).balance || 0);
}

export function balancesFor(userId){
  return all("SELECT currency,ROUND(COALESCE(SUM(amount),0),6) balance FROM ledger_entries WHERE user_id=? AND status IN ('finalized','available') GROUP BY currency ORDER BY currency",[userId]);
}

export function finalizeMaturePublisherEarnings(){
  return run("UPDATE ledger_entries SET status='available' WHERE type='PUBLISHER_EARNING' AND status='pending' AND created_at<=datetime('now','-24 hours')").changes;
}

export function addLedger({userId,eventId=null,type,amount,currency='USD',status='finalized',note=null}) {
  const entry = { id:id('led'), userId, eventId, type, amount:Number(amount), currency, status, note };
  run('INSERT INTO ledger_entries(id,user_id,event_id,type,amount,currency,status,note) VALUES(?,?,?,?,?,?,?,?)',
    [entry.id,entry.userId,entry.eventId,entry.type,entry.amount,entry.currency,entry.status,entry.note]);
  void mirrorLedger(entry).catch(()=>{});
  return entry;
}

export async function ensureAdmin() {
  const existing = one('SELECT id FROM users WHERE email=?',[config.adminEmail.toLowerCase()]);
  if (existing) return;
  const hash = await bcrypt.hash(config.adminPassword, 12);
  run('INSERT INTO users(id,email,password_hash,role,name,status) VALUES(?,?,?,?,?,?)',
    [id('usr'),config.adminEmail.toLowerCase(),hash,'admin','ADPulse Admin','active']);
}
