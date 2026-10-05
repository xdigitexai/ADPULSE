# Social / Creator Network build report

Completed 2026-10-05. Source implementation only; **not deployed**. No live social posts,
customer charges, deposits or withdrawals were performed during development.

## Features and accounting

Publishers can use websites, social channels or both with the existing account and wallet.
Manual ownership verification works without provider credentials: generated bio/post code,
public evidence and admin approval. Advertisers fund their existing wallet, submit a creator
campaign for moderation, and receive eligible assignments and reviewed content. Creators
accept a campaign, render sponsored media, publish manually or through an approved integration,
submit its public URL, and earn from valid attributed activity. Existing withdrawals remain intact.

Random per-assignment links redirect to validated advertiser destinations. CPC, CPA,
revenue-share and hybrid billing reuse the existing ledger and pending-earning maturity.
Immediate SQLite transactions protect concurrent charges; authenticated conversion IDs prevent
duplicate charging. Audited reversals cascade from invalid clicks to attributed conversions.
Refunds do not reopen campaign spend caps. Self-clicks, repeat traffic, automation, unavailable
configured network intelligence and budget/funding failures earn nothing. Quality scores use
recorded evidence, with neutral weighting for new creators and unavailable API metrics excluded.

Content Studio renders five 1080x1920 H.264/AAC formats: lower third, mid-card, end card,
short sponsor insert and QR CTA. It preserves source audio, creates a thumbnail and QR exports,
and enforces sponsorship disclosure. Persistent jobs expose progress, serialize claims and
recover stale render leases. Uncertain publication results require reconciliation rather than
blind reposting. Publisher, advertiser and admin pages expose ownership, moderation,
assignments, content, tracking, fraud, earnings, analytics and integration health.

## Files and schema

New backend modules under `src/social/`: `schema.js`, `core.js`, `token-store.js`, `jobs.js`,
`studio.js`, `renderer.js`, `SocialProvider.js`, `tiktok.js`, `instagram.js`, `facebook.js`,
`youtube.js`, `creator-sync.js`, `publishing.js`, `worker.js`, `routes.js`.
New frontend: `public/social-workspace.js`. Existing navigation/workspace integration:
`public/app.js`, `public/workspace.js`. Existing backend hooks: `src/server.js`, `src/db.js`,
`src/ip-intelligence.js`.

Additive, repeatable tables: `publisher_channels`, `social_accounts`, `creator_campaigns`,
`creator_campaign_assignments`, `creator_assets`, `creator_events`, `social_jobs`,
`social_oauth_states`, `social_oauth_choices`, `social_publish_requests`, `social_uploads`,
`social_audit`, `social_api_health`, `social_token_locks`. Additive columns store reviewed
asset references, provider receipts and metric sample metadata. Existing balances and history
are preserved; no retroactive charges or second wallet. SQLite remains authoritative and
committed financial entries use the existing best-effort PostgreSQL ledger mirror.

Packaging/configuration: `.env.example`, `.gitignore`, `package.json`, `package-lock.json`,
`Dockerfile`, `docker-compose.production.yml`, `.github/workflows/ci.yml`,
`scripts/build-frontend.js`, `scripts/check-social.js`. Docker adds FFmpeg/font dependencies
and a worker sharing the persistent database and upload volumes.

Tests: `tests/social-core.test.js`, `social-flow.test.js`, `social-providers.test.js`,
`social-concurrency.test.js`, `social-render.test.js`. The existing `sdk-render.test.js`
DOM fixture gained `querySelector` support for its existing video SDK; production SDK untouched.
Documentation: this report, `SOCIAL-CREATORS.md`, `SOCIAL-OAUTH.md`, `CREATOR-TRACKING.md`,
`CONTENT-STUDIO.md`, and the README documentation link.

## Provider status and external requirements

| Platform | Implemented official adapter | Required before live publishing |
| --- | --- | --- |
| TikTok | OAuth, permission-gated profile/video metrics, direct FILE_UPLOAD posting and status polling | App credentials, registered callback, approved scopes and Content Posting review. Unaudited clients are private-only. Single-chunk upload limited to 64 MB; larger media uses manual export. Inbox `video.upload` is not implemented. |
| Instagram | Instagram Login or linked professional account, REELS container/upload/publish/poll/permalink | Product-specific credentials, approved scopes, professional account, current Graph API version and public HTTPS media. |
| Facebook | Managed Page selection, page token refresh, resumable Reel upload/finish/status/permalink | App credentials, current Graph API version, approved Page scopes, eligible Page privileges. Personal profiles unsupported. |
| YouTube | OAuth with PKCE, channel profile, resumable video upload and status polling | Google OAuth client/callback, required scopes, verification/audit for public publishing. Unverified clients are private-only. |

AES-GCM encrypts tokens, channel-choice payloads and interrupted upload sessions. State is
expiring, owner-bound and single-use. Token rotation is serialized; revoked authorization
requires reconnect. Provider receipts alone never mark publication successful. Configured
credentials and operator approval declarations are separate from actual test evidence.
Manual download/publishing stays available on every platform. No live provider credentials
or platform approvals were provisioned or verified in this build.

## Verification evidence and limits

- `npm install`: successful; audit reported zero vulnerabilities.
- `npm run check`: passed, including all new modules. `npm run build`: passed.
- `npm test`: **56 passed, zero failed, zero skipped** using Node 20.20.2, FFmpeg/FFprobe
  9.0.2 and DejaVu Sans. Every studio format was actually encoded and probed; decoded
  audio contained the source signal. Invalid input and unsafe text cases were exercised.
- Isolated HTTP flow tests cover ownership/moderation, campaigns, render queuing, post URL
  validation, attribution redirect, conversion idempotency and read-only support sessions.
- Six concurrent independent processes against one SQLite wallet produced one final funded
  charge. Repeat migrations preserve preexisting users, ledger and assignments.
- Mocked official-provider tests exercise OAuth lifecycle, scopes, encryption/rotation,
  privacy limits and publishing/polling. These are not live provider posting tests.
- Existing website, payment, Google callback, withdrawal and fraud suites pass.
- Production Compose configuration validates with test environment values. A container image
  build was not verified because the local Docker daemon was unavailable; no deployment ran.
- Local browser checks verified channel selection, account creation, missing-provider states,
  mobile layout without page overflow, navigation and Content Studio's sponsorship prerequisite.

Before an authorized release: back up database/key/upload volumes, configure a stable encryption
key and HTTPS origin, register official callbacks and obtain provider approvals, build the image,
start the worker, and run live consent/publishing tests using approved test accounts. Preserve all
existing volumes. Provider delivery/publication and payment-provider outcomes require their own
live evidence; this build does not represent them as verified.
