# ADPulse Social / Creator Network

This is an additive publisher channel. Website publishers, zones, ad SDKs, deposits,
withdrawals, identity checks, authentication and existing billing contracts remain in place.
One publisher can enable websites, creator channels or both at Social Accounts.
The feature is source-only until explicitly deployed.

## Working without social API credentials

1. Register/sign in as a publisher using existing authentication. Select Social Creator
   (and optionally Website Publisher) under Social Accounts.
2. Add platform, username, public profile URL, country, language and category.
3. Place the generated cryptographic `ADPULSE-…` code in your public bio or a verification post.
4. Submit the public evidence URL. Admin reviews the actual public code and approves
   ownership. No automated login scraping, CAPTCHA bypass or password collection occurs.
   Metrics not returned by approved APIs remain unavailable, not zero or fabricated.
5. An advertiser funds the existing wallet, creates a creator campaign and submits it
   for admin review. Review covers destination, brief, brand media and category restrictions.
6. Browse the marketplace and accept with an eligible verified account. Eligibility is
   checked again in an immediate database transaction. Each assignment gets a random link.
7. Upload an original MP4/MOV to Content Studio. Configure branding, disclosure, CTA
   and QR. A persistent worker renders downloadable H.264/AAC video, thumbnail and QR.
8. Download, publish manually and submit the actual public post URL, rendered asset and
   caption containing sponsorship disclosure and the tracking link. Advertiser/admin reviews.
9. Approved published content can attribute valid clicks and authenticated conversions.
   Earnings use the existing 24-hour pending → available publisher ledger.
10. Withdraw through the existing supported payment flow. Existing payout/provider
    and eligibility controls are unchanged.

For an approved API integration, submit the rendered asset and caption without a post URL,
obtain content approval, then select privacy/consent and publish. The server restricts publishing
to the exact reviewed asset. A provider receipt is not evidence that a post is published;
status polling must confirm completion. Interrupted uploads require reconciliation, never
blind resubmission. Manual export always remains available.

## Data and migrations

`src/social/schema.js` runs additive, idempotent SQLite migrations from `src/db.js`.
New tables: `publisher_channels`, `social_accounts`, `creator_campaigns`,
`creator_campaign_assignments`, `creator_assets`, `creator_events`, `social_jobs`,
`social_oauth_states`, `social_oauth_choices`, `social_publish_requests`,
`social_uploads`, `social_audit`, `social_api_health`, `social_token_locks`. Reviewed asset references and
provider metadata are additive columns. No existing balances, websites, bots, files or
payment history are migrated or charged retroactively.

SQLite remains the authoritative operational store, as in the existing application.
Financial entries reuse `ledger_entries` and its PostgreSQL mirror. Creator operations
use a dedicated SQLite job queue sharing persistent data/upload volumes, not a second
wallet. Redis, PostgreSQL and ClickHouse services remain intact. SQLite immediate
transactions serialize acceptance, click/conversion charging and idempotent reversals.

## Roles and operations

- Publisher: accounts, eligibility, assignments, own media, render/download, captions,
  tracking and social analytics; existing withdrawal/ledger screens.
- Advertiser: own creator campaigns, pause/resume after moderation, assignment/content
  review, authenticated conversions and attribution analytics.
- Admin: ownership approval/rejection/suspension, campaign moderation, assignment/content
  review, tracking/fraud events, audited earning reversals, shared ledger, worker status,
  integration configuration, API test timestamp and sanitized errors.
- Support impersonation is read-only for all creator mutation routes. It cannot connect
  OAuth accounts, render or post as a user, change channels or charge conversions.

Analytics refresh every five seconds while the social analytics page is mounted. Recent
event detail is explicitly capped at 5,000 events; assignment counters retain lifetime totals.
Currency values are grouped separately, never added across currencies. CTR is unavailable
without approved impression data; conversion rate, CPA and ROAS use recorded valid events
and confirmed conversion values. Missing country/API metrics display as unavailable.

Quality components are shown to admin. Verified ownership, valid-traffic ratio, content approval, campaign completion
and confirmed conversion rate determine the score, with neutral weighting for new creators. Unavailable platform
metrics are excluded, never treated as zero. Scores update on traffic, conversion, moderation and authorized metric sync.
Creator rankings use recorded valid activity, never invented follower counts.
Campaigns requiring follower metrics cannot accept an account whose metric is unavailable.
Sensitive categories use existing sensitive-interest checks and are excluded from automatic
eligibility; a future specialized policy must explicitly support them before enabling them.

## Validation and release

Run `npm install`, `npm run check`, `npm test`, `npm run build`, and
`docker compose -f docker-compose.production.yml config` with a local environment file.
Tests use isolated databases and mocked provider responses. Real rendering requires FFmpeg,
FFprobe and a font; production Docker installs them. No real account posts, deposits or
withdrawals are needed for CI. See the other social docs for environment/approval details.
Back up the database, encryption key and upload volumes before an explicitly authorized release.
Do not delete volumes or replace the running production stack to test this feature.
