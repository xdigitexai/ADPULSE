export function migrateSocial(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publisher_channels (publisher_id TEXT PRIMARY KEY REFERENCES users(id), website INTEGER NOT NULL DEFAULT 1, creator INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS social_accounts (
      id TEXT PRIMARY KEY,publisher_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,platform_user_id TEXT,username TEXT,display_name TEXT,profile_image_url TEXT,profile_url TEXT NOT NULL,account_type TEXT,followers INTEGER,following INTEGER,total_views INTEGER,avg_views REAL,engagement_rate REAL,country TEXT,language TEXT,category TEXT DEFAULT 'general',quality_score REAL DEFAULT 0,quality_components TEXT DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending_review',verification_method TEXT DEFAULT 'manual',verification_code TEXT,oauth_scopes TEXT DEFAULT '[]',token_encrypted TEXT,refresh_token_encrypted TEXT,token_expires_at TEXT,platform_metadata TEXT DEFAULT '{}',connected_at TEXT,last_sync_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(platform,platform_user_id),UNIQUE(publisher_id,platform,profile_url)
    );
    CREATE TABLE IF NOT EXISTS creator_campaigns (
      id TEXT PRIMARY KEY,advertiser_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,description TEXT NOT NULL,destination_url TEXT NOT NULL,sponsor_logo TEXT,sponsor_media TEXT,pricing_model TEXT NOT NULL,currency TEXT NOT NULL,cpc REAL NOT NULL DEFAULT 0,cpa REAL NOT NULL DEFAULT 0,commission_percent REAL NOT NULL DEFAULT 0,budget_total REAL NOT NULL,budget_daily REAL NOT NULL,spent_total REAL NOT NULL DEFAULT 0,spent_today REAL NOT NULL DEFAULT 0,spend_date TEXT NOT NULL DEFAULT '',target_platforms TEXT DEFAULT '[]',target_countries TEXT DEFAULT '[]',target_categories TEXT DEFAULT '[]',min_followers INTEGER DEFAULT 0,max_followers INTEGER,min_quality_score REAL DEFAULT 0,starts_at TEXT,ends_at TEXT,status TEXT DEFAULT 'pending_review',created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS creator_campaign_assignments (
      id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES creator_campaigns(id),creator_id TEXT NOT NULL REFERENCES social_accounts(id),publisher_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'accepted',accepted_at TEXT DEFAULT CURRENT_TIMESTAMP,submitted_at TEXT,approved_at TEXT,rejected_at TEXT,published_post_url TEXT,platform_post_id TEXT,tracking_code TEXT NOT NULL UNIQUE,tracking_url TEXT NOT NULL,caption TEXT,clicks INTEGER DEFAULT 0,valid_clicks INTEGER DEFAULT 0,conversions INTEGER DEFAULT 0,earnings REAL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(campaign_id,creator_id)
    );
    CREATE TABLE IF NOT EXISTS creator_assets (
      id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES creator_campaign_assignments(id),publisher_id TEXT NOT NULL REFERENCES users(id),source_video_url TEXT,rendered_video_url TEXT,thumbnail_url TEXT,overlay_config_json TEXT DEFAULT '{}',qr_url TEXT,caption TEXT,status TEXT DEFAULT 'queued',created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS creator_events (
      id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES creator_campaign_assignments(id),campaign_id TEXT NOT NULL REFERENCES creator_campaigns(id),creator_id TEXT NOT NULL REFERENCES social_accounts(id),publisher_id TEXT NOT NULL REFERENCES users(id),event_type TEXT NOT NULL,browser_id TEXT,session_id TEXT,ip_hash TEXT,country TEXT,device TEXT,risk_score REAL DEFAULT 0,valid INTEGER DEFAULT 0,bill_amount REAL DEFAULT 0,publisher_amount REAL DEFAULT 0,attribution_id TEXT UNIQUE,external_id TEXT,metadata TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(campaign_id,external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_creator_events_fraud ON creator_events(campaign_id,ip_hash,created_at);
    CREATE TABLE IF NOT EXISTS social_oauth_states (state_hash TEXT PRIMARY KEY,publisher_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,verifier TEXT,expires_at TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS social_jobs (id TEXT PRIMARY KEY,kind TEXT NOT NULL,object_id TEXT NOT NULL,payload TEXT DEFAULT '{}',status TEXT DEFAULT 'queued',progress INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,max_attempts INTEGER DEFAULT 3,available_at TEXT DEFAULT CURRENT_TIMESTAMP,locked_at TEXT,worker_id TEXT,error TEXT,result TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_social_jobs_queue ON social_jobs(status,available_at);
    CREATE TABLE IF NOT EXISTS social_publish_requests (id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES creator_campaign_assignments(id),asset_id TEXT NOT NULL REFERENCES creator_assets(id),publisher_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,status TEXT DEFAULT 'queued',provider_id TEXT,post_url TEXT,options TEXT DEFAULT '{}',error TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS social_audit (id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,object_id TEXT NOT NULL,metadata TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS social_uploads (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),url TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS social_oauth_choices (id TEXT PRIMARY KEY,publisher_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,label TEXT NOT NULL,payload TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_api_health (platform TEXT PRIMARY KEY,last_test_at TEXT,last_error TEXT);
    CREATE TABLE IF NOT EXISTS social_token_locks (account_id TEXT PRIMARY KEY REFERENCES social_accounts(id),nonce TEXT NOT NULL,expires_at TEXT NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(social_publish_requests)').all().some(x=>x.name==='provider_metadata'))db.exec("ALTER TABLE social_publish_requests ADD COLUMN provider_metadata TEXT DEFAULT '{}' ");
  if(!db.prepare('PRAGMA table_info(social_accounts)').all().some(x=>x.name==='metrics_metadata'))db.exec("ALTER TABLE social_accounts ADD COLUMN metrics_metadata TEXT DEFAULT '{}'");
  if(!db.prepare('PRAGMA table_info(creator_campaign_assignments)').all().some(x=>x.name==='submitted_asset_id'))db.exec('ALTER TABLE creator_campaign_assignments ADD COLUMN submitted_asset_id TEXT REFERENCES creator_assets(id)');
}
