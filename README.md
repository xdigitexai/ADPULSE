# ADPulse

ADPulse is an independent advertising network for advertisers and verified publishers. It can serve display, native and video ads directly on approved publisher sites, measure viewable impressions and clicks, attribute conversions, apply fraud/risk controls, handle advertiser funding and publisher payouts through Xdigitex Pay, and expose programmatic interfaces through OpenRTB, Prebid and VAST.

## What is included

- Advertiser, publisher and admin workspaces
- Site ownership verification: meta tag, root verification file, DNS TXT, plus a WordPress helper plugin
- ads.txt + sellers.json supply-chain support
- Standard display sizes, responsive, native and video inventory
- CPM, CPC and hybrid campaigns
- Country, device and contextual category targeting
- Campaign schedules, budgets and frequency caps
- Page-level contextual classification and brand-safety scoring
- Viewability-aware impression accounting
- Conversion pixel + click attribution
- IP/ASN/VPN/proxy/Tor/hosting intelligence through IPinfo when configured
- Immutable multi-currency ledger
- Xdigitex Pay deposits and mobile-money withdrawals
- KYC workflow and admin finance reconciliation
- AI Support, live human chat, sales email and WhatsApp channels
- OpenRTB auction endpoint, Prebid adapter and VAST 4.3 video delivery
- PostgreSQL/Redis/ClickHouse production services with strict health enforcement
- SQLite WAL local fallback for development and single-node recovery

## Quick start

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run dev
```

Open http://localhost:3000

## Production stack

```bash
cp .env.example .env
# set strong secrets and provider keys
docker compose -f docker-compose.production.yml up -d --build
```

For production set:

```env
NODE_ENV=production
PRODUCTION_STORES_REQUIRED=true
JWT_SECRET=<strong random secret>
EVENT_SECRET=<different strong random secret>
XDIGITEX_PAY_API_KEY=<server-side key>
ADPULSE_SELLER_DOMAIN=<your ad network domain>
DATABASE_URL=postgres://...
REDIS_URL=redis://...
CLICKHOUSE_URL=http://...
IPINFO_TOKEN=<optional but required for network reputation enrichment>
AI_CONTEXT_API_URL=<OpenAI-compatible endpoint or internal classifier>
AI_CONTEXT_API_KEY=<key>
AI_CONTEXT_MODEL=<model>
```

When `PRODUCTION_STORES_REQUIRED=true`, ADPulse refuses to start unless PostgreSQL, Redis and ClickHouse are reachable.

## Publisher embed

```html
<div class="adpulse-ad" data-zone="ZONE_PUBLIC_KEY"></div>
<script async src="https://YOUR-ADPULSE-DOMAIN/adpulse.js"></script>
```

The SDK requests a signed page-context classification, asks the decision engine for eligible demand, renders the matching creative, and records a billable view only after at least 50% of the slot is visible for one continuous second.

## Programmatic

- OpenRTB: `POST /openrtb2/auction`
- VAST 4.3: `GET /vast?t=...`
- Prebid adapter: `integrations/prebid/adpulseBidAdapter.js`
- sellers.json: `GET /sellers.json`
- ads.txt verification: publisher dashboard

See `docs/ARCHITECTURE.md` and `docs/API.md`.

The additive Social / Creator Network is documented in [SOCIAL-CREATORS.md](docs/SOCIAL-CREATORS.md),
with implementation and verification details in [SOCIAL-BUILD-REPORT.md](docs/SOCIAL-BUILD-REPORT.md).

Account currency selection and audited settlement are documented in [ACCOUNT-CURRENCY.md](docs/ACCOUNT-CURRENCY.md).
