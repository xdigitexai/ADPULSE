import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('advertiser','publisher','admin')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
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
  model TEXT NOT NULL CHECK(model IN ('CPM','CPC','HYBRID')),
  cpm REAL NOT NULL DEFAULT 0,
  cpc REAL NOT NULL DEFAULT 0,
  budget_total REAL NOT NULL,
  budget_daily REAL NOT NULL,
  spent_total REAL NOT NULL DEFAULT 0,
  spent_today REAL NOT NULL DEFAULT 0,
  target_countries TEXT NOT NULL DEFAULT '[]',
  target_categories TEXT NOT NULL DEFAULT '[]',
  target_devices TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at TEXT,
  ends_at TEXT,
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

export function id(prefix='id') { return `${prefix}_${nanoid(16)}`; }
export function one(sql, params=[]) { return db.prepare(sql).get(...params); }
export function all(sql, params=[]) { return db.prepare(sql).all(...params); }
export function run(sql, params=[]) { return db.prepare(sql).run(...params); }

export function balanceFor(userId) {
  return Number(one('SELECT COALESCE(SUM(amount),0) AS balance FROM ledger_entries WHERE user_id=? AND status IN ("finalized","available")',[userId]).balance || 0);
}

export function addLedger({userId,eventId=null,type,amount,currency='USD',status='finalized',note=null}) {
  const entry = { id:id('led'), userId, eventId, type, amount:Number(amount), currency, status, note };
  run('INSERT INTO ledger_entries(id,user_id,event_id,type,amount,currency,status,note) VALUES(?,?,?,?,?,?,?,?)',
    [entry.id,entry.userId,entry.eventId,entry.type,entry.amount,entry.currency,entry.status,entry.note]);
  return entry;
}

export async function ensureAdmin() {
  const existing = one('SELECT id FROM users WHERE email=?',[config.adminEmail.toLowerCase()]);
  if (existing) return;
  const hash = await bcrypt.hash(config.adminPassword, 12);
  run('INSERT INTO users(id,email,password_hash,role,name,status) VALUES(?,?,?,?,?,?)',
    [id('usr'),config.adminEmail.toLowerCase(),hash,'admin','ADPulse Admin','active']);
}
