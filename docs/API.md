# ADPulse API and integration guide

## Authentication

Dashboard/account APIs use:

```
Authorization: Bearer <JWT>
```

Public serving, contextual, conversion, support and programmatic endpoints use signed/public integration identifiers instead of dashboard JWTs.

## Account

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/dashboard`

## Publisher verification

- `POST /api/publisher/sites`
- `GET /api/publisher/sites`
- `POST /api/publisher/sites/:id/verify`
- `POST /api/publisher/sites/:id/analyze`
- `POST /api/publisher/sites/:id/verify-ads-txt`

Verification methods accepted by `verify`:

```json
{"method":"meta"}
{"method":"file"}
{"method":"dns"}
```

WordPress helper:

`integrations/wordpress/adpulse-publisher.php`

It publishes the ADPulse verification meta tag and provides an `[adpulse zone="..."]` shortcode.

## Ad zones

- `POST /api/publisher/zones`
- `GET /api/publisher/zones`

Supported formats:

- responsive
- 300x250
- 336x280
- 728x90
- 970x250
- 320x50
- 320x100
- 300x600
- 160x600
- native
- video (640x360 default)

Embed:

```html
<div class="adpulse-ad" data-zone="ZONE_PUBLIC_KEY"></div>
<script async src="https://YOUR-ADPULSE-DOMAIN/adpulse.js"></script>
```

## Contextual classification

`GET /context?zone=ZONE_PUBLIC_KEY&url=https%3A%2F%2Fpublisher.example%2Farticle`

The requested page must belong to the verified site. ADPulse fetches pages through its public-network-only crawler, classifies the page, caches the result and returns a short-lived signed context token.

The normal ADPulse SDK handles this automatically.

## Campaigns

- `POST /api/advertiser/campaigns`
- `GET /api/advertiser/campaigns`

Creative types:

- display
- native
- video

Campaign controls include:
- CPM / CPC / hybrid
- currency
- total/daily budgets
- country/category/device targeting
- start/end schedule
- daily frequency cap
- conversion attribution window

## Direct serving

`GET /serve?zone=ZONE_PUBLIC_KEY&ctx=SIGNED_CONTEXT_TOKEN`

Response contains the selected creative and an event token.

## Event collection

`POST /events`

Types:
- render
- view
- click
- conversion

Publisher SDK automatically records render and valid view events.

Tracked click redirect:

`GET /r/click?t=SIGNED_EVENT_TOKEN`

## Conversion pixel

Install on the advertiser site:

```html
<script src="https://YOUR-ADPULSE-DOMAIN/pixel.js"
        data-campaign="CAMPAIGN_PUBLIC_KEY"></script>
<script>
ADPulse.track("purchase", {
  value: 2500,
  currency: "KES",
  externalId: "ORDER-123"
});
</script>
```

Public collector:

`POST /collect/conversion`

Authenticated server-to-server alternative:

`POST /api/conversions`

## OpenRTB

`POST /openrtb2/auction`

Use the ADPulse zone public key as either:

```json
{
  "imp": [{
    "id": "1",
    "tagid": "z_xxx",
    "banner": {"w": 300, "h": 250}
  }]
}
```

or:

```json
{
  "imp": [{
    "id": "1",
    "ext": {"adpulse_zone": "z_xxx"},
    "video": {
      "w": 640,
      "h": 360,
      "mimes": ["video/mp4"]
    }
  }]
}
```

No bid returns HTTP 204.

## Prebid.js

Adapter source:

`integrations/prebid/adpulseBidAdapter.js`

The adapter translates Prebid bid requests into the ADPulse OpenRTB endpoint and supports display/video response parsing.

## VAST

Video campaigns expose VAST 4.3 tags:

`GET /vast?t=SIGNED_EVENT_TOKEN`

VAST impression/click tracking feeds the same ADPulse event/fraud/accounting pipeline.

## Supply-chain transparency

- `GET /sellers.json`
- Publisher `/ads.txt` line generated from the seller ID
- ads.txt verification in the publisher dashboard

## Analytics

Publisher:
- `GET /api/analytics/publisher`

Advertiser:
- `GET /api/analytics/advertiser`

## Xdigitex Pay

- `GET /api/payments/gateways`
- `POST /api/payments/initiate`
- `GET /api/payments/:reference/status`
- `GET /api/payments`
- `POST /webhooks/xdigitex-pay`
- `POST /api/publisher/withdrawals`

Payment-completion webhooks are not trusted blindly. ADPulse re-queries Xdigitex Pay before crediting the ledger.

## KYC

- `POST /api/profile/kyc`
- `GET /api/admin/kyc`
- `POST /api/admin/kyc/:id/status`

## Support

Public:
- `GET /api/support/config`
- `POST /api/support/ai`
- `POST /api/support/conversations`
- `GET /api/support/conversations/:id?token=...`
- `POST /api/support/conversations/:id/messages`

Admin:
- `GET /api/admin/support`
- `GET /api/admin/support/:id`
- `POST /api/admin/support/:id/reply`
- `GET /api/admin/support/settings`
- `POST /api/admin/support/settings`

## Admin fraud and finance

- `GET /api/admin/fraud`
- `GET /api/admin/fraud/events`
- `GET /api/admin/finance`
- `POST /api/admin/finance/reconcile`

## Health

`GET /api/health`

Returns the application version and connection state for PostgreSQL, Redis and ClickHouse.

For production use `PRODUCTION_STORES_REQUIRED=true`.
