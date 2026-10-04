CREATE TABLE IF NOT EXISTS adpulse.ad_events
(
  event_id String,
  request_id String,
  event_type LowCardinality(String),
  campaign_id String,
  publisher_id String,
  site_id String,
  zone_id String,
  ip_hash String,
  country LowCardinality(String),
  device LowCardinality(String),
  risk_score Float32,
  valid UInt8,
  bill_amount Decimal(18,8),
  publisher_amount Decimal(18,8),
  created_at DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (created_at, campaign_id, publisher_id, event_type);

CREATE TABLE IF NOT EXISTS adpulse.conversions
(
  conversion_id String,
  campaign_id String,
  advertiser_id String,
  request_id String,
  event_name LowCardinality(String),
  value Decimal(18,8),
  currency LowCardinality(String),
  external_id String,
  created_at DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (created_at, campaign_id, event_name);
