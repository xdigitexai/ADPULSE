# ADPulse architecture

## Transaction path
1. Publisher adds and verifies a domain.
2. Admin approves the property.
3. Publisher creates an ad zone and installs `adpulse.js`.
4. Advertiser funds a wallet and submits a CPM/CPC/HYBRID campaign.
5. Admin approves the campaign.
6. `GET /serve` selects eligible demand using status, budget, targeting, floor price and wallet balance.
7. Browser renders the creative.
8. A view is monetized only after the slot is at least 50% visible for at least one continuous second.
9. Fraud Shield scores the event before billing.
10. A valid billable event debits the advertiser ledger and credits the publisher ledger using the configured revenue share.

## Current MVP
- Node.js + Express API
- SQLite WAL storage for a single-node pilot
- JWT role-based access for advertiser, publisher and admin
- Immutable wallet ledger
- Meta/file site verification
- Publisher zones and embeddable JavaScript
- CPM, CPC and HYBRID campaigns
- Country/category/device targeting
- Publisher CPM floors
- Total/daily budget enforcement
- Duplicate-event and automation checks
- Admin moderation and fraud overview

## Scale path
For larger traffic move control data to PostgreSQL, hot eligibility/pacing to Redis, analytics events to ClickHouse, event transport to Redpanda/Kafka, and the ad decision endpoint to a low-latency Go/Rust service behind a CDN/edge layer.

Financial balances should remain derived from finalized ledger entries rather than a mutable balance field.
