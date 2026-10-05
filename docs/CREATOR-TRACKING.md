# Creator tracking and billing

`GET /c/:trackingCode` accepts an opaque 144-bit code. It checks the assignment,
verified ownership, published post and moderation status, then enriches network risk,
records a click and redirects to the approved advertiser destination. The server sets
HttpOnly SameSite browser/session fraud cookies scoped to `/c`; production uses Secure.
No browser-supplied country or arbitrary redirect URL is trusted.

The redirect includes `adpulse_creator` (a random 192-bit attribution ID), plus UTM source,
medium, campaign and tracking code. No email or private user identifier is included.
The advertiser stores that attribution alongside its verified registration/order and sends:

```http
POST /api/conversions
Authorization: Bearer <existing advertiser token>
Content-Type: application/json

{
  "campaignId": "ccm_…",
  "attributionId": "<adpulse_creator query parameter>",
  "externalId": "unique-order-123",
  "eventName": "purchase",
  "value": 50,
  "currency": "USD"
}
```

`POST /api/creator/conversions` accepts the same contract. Existing website conversion
requests without `attributionId` still use the original handler. Browser/public pixels are
not sufficient proof of a paid creator conversion; these require authenticated advertiser
server-side confirmation. External IDs are unique per campaign and repeat calls return
the original event with `duplicate:true`. Attribution is limited to a valid click in the
previous seven days, a verified creator and an approved/published assignment.

## Money rules

- CPC: a valid click charges the CPC bid.
- CPA: a confirmed attributed conversion charges the CPA bid; valid clicks cost zero.
- REVSHARE: a confirmed conversion charges its value × commission percentage.
- HYBRID: valid click CPC plus confirmed conversion CPA.
- Currency must match. Funding, total budget, UTC daily budget, active status and
  schedule are enforced inside the same immediate transaction as each charge.
- Zero-charge events cannot fund a wallet or bypass an unfunded campaign.
- Advertiser `AD_CHARGE` and publisher `PUBLISHER_EARNING` reuse the current ledger.
  Publisher revenue share is the existing configured share, default 75%; earnings are
  pending for 24 hours and mature through the existing mechanism.
- Admin reversal refunds the advertiser and reverses pending/available publisher credit
  exactly once. Invalidating a click also invalidates/refunds its dependent conversions.
  Spending caps are not reopened by fraud refunds, preventing repeated refund/spend cycles.

## Shield checks

Shared IP hashing, account login-IP history, device/UA classification and IP intelligence
are reused. Recorded signals include ASN, VPN, proxy, Tor, hosting-network risk, session
and browser identifiers, same-campaign daily browser/IP repeats, creator and global
website click velocity, geo mismatch, automation signatures and conversion anomalies.

Creator self-clicks, repeated browser/IP clicks and high-risk events are invalid and charge
zero. Failed configured IP-intelligence requests fail closed. Targeted country campaigns
cannot bill when trusted country information is unavailable. Configure the existing
`IPINFO_TOKEN` and required service permissions for network/geo enrichment; unknown data
is not fabricated. Plain IPs are not persisted in creator events.

Admin can inspect event validity, risk reasons and network metadata in Creator Operations.
The browser destination never receives credentials or raw IP data. Public conversion
signals cannot create money. Payouts continue to use the existing withdrawal controls.
