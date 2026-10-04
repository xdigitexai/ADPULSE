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


## Xdigitex Pay integration

ADPulse uses Xdigitex Pay as its settlement rail. Configure `XDIGITEX_PAY_API_KEY` in the environment; never expose it in browser JavaScript.

### Advertiser deposits
- `GET /api/payments/gateways`
- `POST /api/payments/initiate`
- `GET /api/payments/:reference/status`
- `GET /api/payments`
- `POST /webhooks/xdigitex-pay`

The webhook does not trust the posted completion state. ADPulse re-queries Xdigitex Pay for the reference and only then writes the idempotent deposit credit into its ledger.

Supported funding gateways: `card`, `safaricom`, `airtel`, `mobile`, `crypto`.

Supported wallet/campaign currencies: KES, CDF, UGX, XOF, XAF, RWF, ZMW, SLE and USD. Wallet balances remain separated by currency; there is no implicit FX conversion.

### Publisher payouts
- `POST /api/publisher/withdrawals`

Mobile-money withdrawal is enabled for KES, CDF, UGX, XOF, XAF, RWF, ZMW and SLE. KYC must be verified when `KYC_REQUIRED=true`. A withdrawal hold is written before the provider call and reversed on provider failure.

### KYC
- `POST /api/profile/kyc`
- `GET /api/admin/kyc`
- `POST /api/admin/kyc/:id/status`

The current MVP stores an ADPulse KYC review state. If Xdigitex Pay exposes a customer-level KYC API later, replace/augment the manual admin review with provider verification.
