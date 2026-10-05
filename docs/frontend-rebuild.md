# Frontend rebuild — 5 October 2026

ADPulse uses static ES modules, with the role workspace loaded on demand. The replacement introduces a charcoal/lavender component system, original marketing site, split authentication page, desktop sidebar and keyboard-managed mobile drawer, profile menu, accessible native dialogs, responsive table cards, searchable/paginated lists and inline mutation feedback.

Advertisers: six-step campaign wizard, browser-local drafts explicitly marked as not serving, upload/hosted creative preview, audience chips, budget/schedule review, campaign detail, pause/resume and budget management, analytics, billing and payment history.

Publishers: property workspaces with permanent meta/file/DNS instructions, downloadable proof, approval checklist, ads.txt, zones and copyable installation snippet, display controls, daily charts, wallet balances, withdrawal review and ledger. KYC navigation and onboarding are removed; backend/provider compliance checks remain enforced.

Admin: actionable review queues, site inventory, campaign review, owned zone controls, transactions/payouts, reconciliation, recorded fraud signals, support inbox, basic role directories and service health. Internal payment-eligibility review remains in Admin System using the existing profile-review API. No unavailable metrics are invented.

Contracts and SDK behavior are preserved. Only the HTML entry response changes server headers to allow Google popup fallback communication; APIs retain their existing headers and authorization. GIS is initialized once with popup/FedCM callback, exchanging the credential through the existing server endpoint. Full external account consent still requires a real interactive Google sign-in; mock callback tests are not proof of that external flow.

Current backend limits: advertiser analytics provides all-time totals but no dated/campaign/geography/device breakdowns; admin has no full account-detail/balance or time-series endpoints; campaign creative/targeting cannot be edited after submission; review history/change requests lack endpoints; verification date is not supplied. The UI uses actual available data and supported mutations. Drafts are browser-local, not backend draft records.

Validation: static production build and syntax checks; 32 isolated backend regressions (including uploads, accounting, provider retries, role checks and scoped Google headers); 180 browser layout cases at 360/390/412/768/1024/1440; campaign payload, proof persistence and all display setting types; Google callback/role/logout/error tests at mobile/desktop. Production read-only checks are recorded separately by deployment tooling.

Digitex Smart Solutions creative: approximately 20-second 1280×720 H.264 MP4, with motion typography and actual public site capture. Owner-house promotion uses the existing non-billable house campaign mechanism on explicitly selected approved properties. Existing campaign bids, balances and popup rules remain unchanged.
