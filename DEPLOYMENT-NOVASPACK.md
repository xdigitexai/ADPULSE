# ADPulse on ads.novaspack.com

This deployment uses the existing ADPulse app, not a replacement. Nginx forwards HTTPS to 127.0.0.1:3008; Docker listens on port 3000 inside the app container. Other websites and services are separate.

## Configuration

Keep production credentials in `/var/www/adpulse/.env` with mode 600. Never commit it. Set NODE_ENV=production, DEMO_MODE=false, KYC_REQUIRED=true, PRODUCTION_STORES_REQUIRED=true and APP_URL=https://ads.novaspack.com. Generate separate strong JWT, event, PostgreSQL, Redis and ClickHouse secrets. Match POSTGRES_PASSWORD to DATABASE_URL and REDIS_PASSWORD to REDIS_URL. Set the Google client ID and server-side Xdigitex Pay key.

Support: support@xdigitex.space; WhatsApp: +254748571920.

Google uses Identity Services JavaScript popup callback mode. Authorize `https://ads.novaspack.com` as a JavaScript origin. There is no OAuth redirect callback to register for this flow. `/api/auth/google` receives the ID credential and verifies it server-side. Successful Google sign-in still needs an interactive account test.

Payment return URL: https://ads.novaspack.com/payment-return
Payment webhook: https://ads.novaspack.com/webhooks/xdigitex-pay
The webhook verifies payment status with the provider before crediting the wallet.

## Deploy and validate

```sh
cd /var/www/adpulse
docker compose -p adpulse-prod -f docker-compose.production.yml config --quiet
docker compose -p adpulse-prod -f docker-compose.production.yml up -d --build
docker compose -p adpulse-prod -f docker-compose.production.yml ps
curl --fail https://ads.novaspack.com/api/health
```

Run isolated tests, without production volumes or real provider credentials:

```sh
docker run --rm --network none -e NODE_ENV=test -e DB_PATH=/tmp/adpulse-unit-tests.sqlite adpulse-prod-app sh -c 'npm run check && npm test'
```

Deployment smoke tests use a temporary SQLite database, disposable test accounts, a loopback mock payment provider and synthetic ad traffic. They do not contact the real payment provider or charge customers. SDK tests use a simulated browser environment; the separate browser deployment checks cover desktop/mobile layouts and video playback.

## Storage and operations

Named volumes persist SQLite operational data (`app_data`), creatives (`upload_data`), PostgreSQL, Redis AOF and ClickHouse. SQLite is the current app's authoritative operational store; PostgreSQL mirrors ledger/context data, Redis handles frequency counts and ClickHouse stores analytics. Do not use `docker compose down -v`: that deletes data volumes. Back up SQLite using its backup API and back up uploads and production-store volumes before upgrades. No off-server backup destination is configured by this deployment.

Database ports are internal only. Redis requires authentication. App ports bind to loopback. Memory/CPU caps protect the shared server. Install the separate Nginx vhost in `infra/nginx-ads.novaspack.com.conf`, validate with `nginx -t`, then reload. The certificate is maintained by Certbot; reload Nginx after certificate renewal.

## Acceptance limits

The real payment key was accepted by the provider's read-only gateway endpoint. This does not prove a completed real deposit or payout. Payment success/failure, duplicate callbacks and withdrawal reversal are tested against a mock provider. Google account login/linking requires interactive verification; DNS ownership requires a publisher TXT record. IPinfo enrichment needs an IPINFO_TOKEN. External AI classification needs AI_CONTEXT_API_URL, AI_CONTEXT_API_KEY and AI_CONTEXT_MODEL; deterministic classification and support fallback operate without them. WordPress helper files are included; installation in a real WordPress site is a separate integration check.

## First-party promotional placements

Owner-authorized house promotions can fill the selected tdctech.org and deploy.makamesco-tech.co.ke zones when no paid campaign is eligible. The `is_house` and `house_site_ids` fields are managed server-side; the ordinary advertiser creation API cannot enable house status. House campaigns are explicitly restricted to approved site IDs and the matching creative format. They bypass wallet funding only for these own-site promotions. Every house view/click has zero advertiser charge and zero publisher earning, so these are not demo deposits or payouts. Paid campaigns retain priority and their existing accounting.

Live placements use display and native slots, original SVG promo creatives, tracked campaign links, and 45-second viewability/activity-aware display refresh (maximum 3). Campaigns are named `HOUSE: ...` in the admin campaign list. Ownership meta tags and root files remain installed. Publisher templates were backed up before edits. Their ad sections use the anchor `#network-promotions`.
