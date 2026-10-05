# One account currency

Email signup requires a currency choice in the interface. New Google users choose both
role and currency; subsequent sign-in preserves them. USD and the existing supported
local currencies (KES, UGX, CDF, XOF, XAF, RWF, ZMW, SLE) are available. The compatible
registration API defaults to USD when an older client omits currency.

The account currency is a real settlement currency. New campaign budgets, deposits,
wallet balances, analytics and supported withdrawals use that choice. Server-side checks
reject a different deposit/campaign/payout currency. Website and creator earnings from
another campaign currency are converted when credited, with source amount, target amount,
rate and rate date recorded in `currency_settlements`. Advertiser charges retain the
campaign's currency; a publisher's earnings use their own account currency. Advertising
bids and publisher CPM floors are compared in the publisher currency.

ExchangeRate-API's official open USD endpoint supplies daily reference rates, cached in
the authoritative database and refreshed hourly when due. No customer identifiers are
sent to it. Only supported fiat rates are retained; malformed/future/stale data is rejected.
Cross-currency settlement pauses if no valid rate younger than 48 hours is available;
same-currency settlement keeps working. No exchange markup is added; existing provider
payment and payout fees still apply. Rate attribution appears in the workspace.
These are platform accounting conversions, not evidence of a treasury exchange or a
payment-provider settlement. Local payout liquidity is still required at the provider.

## Existing accounts

The additive migration creates a nullable `users.currency` field. It does **not** choose
a currency, alter balances or replay existing charges for any existing customer. Existing
accounts retain their old currencies until their owner opens Account currency, requests
a quote and confirms it. Admin support impersonation cannot do this.

Quotes last five minutes and are owner-bound, one-use records in `currency_quotes`.
They list available and pending totals, each source amount/rate, zero exchange fee and
the effects on campaigns. Confirmation uses an immediate transaction, rejects a changed
balance or in-progress withdrawal, and prevents a concurrent/replayed second conversion.
Existing ledger rows are retained. Available amounts move through paired audited
`FX_TRANSFER_OUT`/`FX_TRANSFER_IN` entries. Pending earnings receive a converted replacement
with the original event and creation date; their original rows become `converted` and
their original 24-hour maturity date is retained. Historic available earnings retain the
accepted conversion rate for reporting and any subsequent fraud reversal.

Active paid campaigns in a different currency are paused with their history/budgets intact;
create a new campaign in the chosen currency rather than silently repricing an existing one.
The choice is fixed after confirmation to prevent repeated conversion/speculation. Historical
payment and ledger receipts keep their original currencies. Legacy advertiser spend is
translated for reporting using the current cached reference rate; this never changes
historical advertiser charges. Missing reporting rates display unavailable, not a fabricated
currency amount. Monetary arithmetic uses the existing six-decimal ledger precision.

## Payment limitations

USD funding uses Card. The current ADPulse integration exposes mobile-money payouts only;
**USD withdrawals are unavailable** and this is disclosed before signup and on the currency
and withdrawal screens. Local funding/payouts still depend on the provider's supported
currency/rail and the existing minimums, balance, fees and reconciliation rules. A gateway
that cannot handle the selected currency cannot submit a funding request. No external
payment or real customer conversion was executed in development.

## Validation

Tests cover email/Google persistence, wrong-currency rejection, confirmed local deposits
and duplicate callbacks, local withdrawals and failure recovery, quote expiry/replay,
changed balances, preserved pending maturity, support-session rejection, recorded
cross-currency earnings, missing/malformed/stale rates, and reversals in the actual earning
currency. Existing smoke fixtures also exercise pre-upgrade accounts whose currency has
not yet been chosen. The unrelated AES-GCM corruption test now flips an actual byte rather
than occasionally replacing a character with itself.

The full suite passed **64 tests with zero failures and zero skips**, including real
FFmpeg rendering. Syntax and frontend build checks passed. Local browser checks confirmed
the required signup selector and the owner-review page before conversion. The live rate
endpoint returned a current 2026-10-05 snapshot covering all nine supported currencies.

Endpoints: `GET /api/account/currency`, `POST /api/account/currency/quote`,
`POST /api/account/currency/confirm`. Do not edit currency directly in the database to
convert an existing account; the owner-confirmed flow preserves its financial audit trail.
