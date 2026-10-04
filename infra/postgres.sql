CREATE TABLE IF NOT EXISTS production_ledger_mirror (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT,
  type TEXT NOT NULL,
  amount NUMERIC(20,8) NOT NULL,
  currency VARCHAR(8) NOT NULL,
  status VARCHAR(32) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_ledger_user ON production_ledger_mirror(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS production_campaign_state (
  campaign_id TEXT PRIMARY KEY,
  spent_total NUMERIC(20,8) NOT NULL DEFAULT 0,
  spent_today NUMERIC(20,8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_site_context (
  site_id TEXT PRIMARY KEY,
  category TEXT,
  language TEXT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_safety VARCHAR(32) NOT NULL DEFAULT 'standard',
  ai_summary TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
