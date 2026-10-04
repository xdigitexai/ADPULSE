# ADPulse production architecture

## Delivery path

1. A publisher verifies domain ownership through meta tag, verification file, DNS TXT, or the WordPress helper.
2. Admin approves the property and the publisher adds the assigned ADPulse seller ID to ads.txt.
3. Publisher creates one or more ad zones: responsive, standard IAB-style display sizes, native or video.
4. `adpulse.js` requests a page-level contextual classification and receives a short-lived signed context token.
5. The ad decision engine evaluates:
   - campaign status and schedule
   - total/daily budget
   - wallet currency and available funds
   - geography/device targeting
   - contextual category
   - publisher CPM floor
   - frequency cap
   - site/page brand-safety state
6. The winning creative is rendered.
7. Fraud Shield evaluates browser behavior plus IPinfo ASN/privacy intelligence when configured.
8. Valid CPM/CPC events debit advertiser funds and credit publisher revenue according to the configured revenue share.
9. Ad events and conversions are mirrored to ClickHouse for scalable analytics; Redis holds hot frequency state; PostgreSQL receives durable financial/context/campaign mirrors.
10. Xdigitex Pay handles advertiser deposits and publisher withdrawals; admin reconciliation verifies provider state.

## Data roles

### SQLite local control/fallback
The current application keeps a local WAL database as a synchronous control-plane and recovery fallback. This keeps the single-process app simple and permits local development without external services.

### PostgreSQL
Production durability layer for:
- immutable ledger mirror
- campaign spend-state mirror
- publisher contextual classification mirror

The repository is structured so the remaining control-plane tables can be cut over to PostgreSQL without changing public APIs. Set `PRODUCTION_STORES_REQUIRED=true` to ensure the production services cannot silently disappear.

### Redis
Hot state for:
- per-campaign visitor frequency caps
- future pacing counters / distributed locks

### ClickHouse
High-volume append analytics for:
- requests
- impressions
- clicks
- fraud scores
- publisher earnings
- advertiser charges
- conversions

## Traffic intelligence

Raw IP is used transiently. Event storage keeps a one-way IP hash. When `IPINFO_TOKEN` is configured, ADPulse enriches events with:
- ASN / network owner
- ASN type
- VPN
- proxy
- Tor
- hosting/datacenter
- relay

These signals contribute to the fraud score and are visible in Admin > Fraud.

## Contextual AI

ADPulse can use an OpenAI-compatible classification endpoint configured through `AI_CONTEXT_*` variables. If unavailable, a deterministic classifier remains active.

The classifier returns:
- category
- topics
- language
- brand-safety state
- risk flags
- short summary

Page classifications are cached for 24 hours and represented to the serving engine by signed context tokens. Restricted pages return no-fill.

## Programmatic layer

ADPulse supports:
- direct publisher JavaScript serving
- OpenRTB 2.x style bid requests through `/openrtb2/auction`
- Prebid.js adapter source
- display, native and video creative types
- VAST 4.3 video tags
- ads.txt / sellers.json supply-chain transparency

The internal advertiser pool functions as ADPulse demand, while publisher inventory functions as supply. External DSP/SSP commercial partnerships can be attached to the same OpenRTB boundary without changing publisher tags.

## Money

Never calculate a user wallet from a mutable balance field. Balances are derived from finalized/available ledger rows per currency.

Advertiser deposit flow:
Xdigitex Pay -> provider verification -> idempotent transaction -> ledger credit.

Publisher payout flow:
KYC -> balance check -> withdrawal hold -> Xdigitex Pay -> provider status -> settlement or automatic reversal.

## Security

- JWT role-based sessions
- signed event and context tokens
- rate limiting
- payment status re-verification
- idempotent deposit crediting
- private/reserved-network SSRF protection for publisher crawlers
- hashed IP storage
- admin moderation / KYC / finance / fraud audit surfaces
