import 'dotenv/config';

const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export const config = {
  port: num(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  eventSecret: process.env.EVENT_SECRET || 'dev-event-secret-change-me',
  dbPath: process.env.DB_PATH || './data/adpulse.db',
  publisherRevenueShare: Math.min(.9, Math.max(.5, num(process.env.PUBLISHER_REVENUE_SHARE, .75))),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@adpulse.local',
  adminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  demoMode: String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
  xdigitexPayBaseUrl: process.env.XDIGITEX_PAY_BASE_URL || 'https://pay.xdigitex.space/api',
  xdigitexPayApiKey: process.env.XDIGITEX_PAY_API_KEY || '',
  kycRequired: String(process.env.KYC_REQUIRED || 'true').toLowerCase() === 'true',
  sellerDomain: process.env.ADPULSE_SELLER_DOMAIN || new URL(process.env.APP_URL || 'http://localhost:3000').hostname,
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: String(process.env.DATABASE_SSL || 'false').toLowerCase()==='true',
  redisUrl: process.env.REDIS_URL || '',
  clickhouseUrl: process.env.CLICKHOUSE_URL || '',
  clickhouseUser: process.env.CLICKHOUSE_USER || 'adpulse',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD || '',
  ipinfoToken: process.env.IPINFO_TOKEN || '',
  aiContextUrl: process.env.AI_CONTEXT_API_URL || '',
  aiContextKey: process.env.AI_CONTEXT_API_KEY || '',
  aiContextModel: process.env.AI_CONTEXT_MODEL || '',
  supportEmail: process.env.SUPPORT_EMAIL || 'sales@adpulse.example',
  supportWhatsapp: process.env.SUPPORT_WHATSAPP || '',
  supportChatEnabled: String(process.env.SUPPORT_CHAT_ENABLED || 'true').toLowerCase()==='true'
};

if (config.env === 'production' && (config.jwtSecret.includes('change-me') || config.jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET must be a strong random value in production');
}
