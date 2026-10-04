# API overview

## Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`

## Publisher
- `POST /api/publisher/sites`
- `POST /api/publisher/sites/:id/verify`
- `GET /api/publisher/sites`
- `POST /api/publisher/zones`
- `GET /api/publisher/zones`

Embed:
```html
<div class="adpulse-ad" data-zone="ZONE_PUBLIC_KEY"></div>
<script async src="https://YOUR-ADPULSE-DOMAIN/adpulse.js"></script>
```

## Advertiser
- `POST /api/advertiser/campaigns`
- `GET /api/advertiser/campaigns`
- `POST /api/advertiser/demo-fund` (development only)

## Delivery
- `GET /serve?zone=...`
- `POST /events`
- `GET /r/click?t=...`

## Admin
- `GET /api/admin/sites`
- `POST /api/admin/sites/:id/status`
- `POST /api/admin/campaigns/:id/status`
- `GET /api/admin/fraud`

Before production, set strong `JWT_SECRET` and `EVENT_SECRET`, disable `DEMO_MODE`, use TLS, and replace demo funding with idempotent payment webhooks.
