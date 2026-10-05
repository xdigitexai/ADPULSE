# Official social integrations

Manual ownership review and media export work without any OAuth keys. Missing credentials
are shown as not configured, not successful or approved. No credentials are provided with
the source, and no provider accounts/posts are created by implementation tests.

## Shared security and configuration

Set `SOCIAL_TOKEN_ENCRYPTION_KEY` to a unique 32-byte base64 key or 64 hex characters.
Generate securely with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Back up this key separately; rotation requires token re-encryption or account reconnection.
AES-256-GCM stores version, IV, authentication tag and ciphertext, never plaintext tokens.
API responses omit access/refresh tokens and encrypted selection payloads; errors are sanitized.

Connect endpoints return official consent URLs to an authenticated publisher. Random OAuth
state is persisted hashed, expires after ten minutes, binds to an HttpOnly SameSite cookie
and publisher identity, and is consumed exactly once. YouTube uses S256 PKCE. Token
exchange/refresh occurs on the server. Revocation is attempted on disconnect; local tokens
are always cleared, with a notice if provider permissions must also be removed manually.
Revoked/expired authorization cannot post; failed refresh requires reconnection.

Routes for each platform (`tiktok`, `instagram`, `facebook`, `youtube`):
`GET /api/social/:platform/connect`, `GET /api/social/:platform/callback`,
`POST /api/social/:platform/disconnect`, `POST /api/social/:platform/sync`.
GET connect uses the normal Bearer token; callback uses its bound state, not a token in URL.
Multi-page/channel choices are encrypted, expire after ten minutes and require the owner.

Provider modules implement connect URL, token exchange/refresh, disconnect, permitted
profile/metrics retrieval, publishing and status. Capabilities require both configured app
approval flags and actually granted account scopes. App approval flags are operator
attestations, not proof of external provider approval; admin shows API-test evidence separately.

## TikTok

Configure `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` and
`TIKTOK_SCOPES` (initially `user.info.basic`). Basic permission returns open ID, display
name and avatar; username/profile link needs `user.info.profile`, followers needs
`user.info.stats`. These additional scopes require approval and explicit user consent.
Do not substitute open ID for a public username or invent statistics. With approved
`video.list`, average views and engagement use the latest returned public videos (up to 20),
with recorded sample metadata; that sample is not misreported as lifetime views.

Enable `video.publish` only after Content Posting API approval and set
`TIKTOK_PUBLISH_APPROVED=true`. `TIKTOK_API_VERIFIED=true` records the audit status.
Unaudited clients are restricted to `SELF_ONLY`. Publishing queries latest creator info,
validates privacy/duration and respects creator-disabled interaction settings. It uploads
through the official FILE_UPLOAD init endpoint and polls the publish receipt.
The current adapter supports a single upload chunk ≤64MB; larger renders use manual export.
`video.upload` can be configured for future upload-to-inbox support, but the current UI
does not advertise that unsupported flow as ready.

Official references: [Login Kit](https://developers.tiktok.com/docs/en/login-kit-web),
[scopes](https://developers.tiktok.com/docs/en/scopes-overview),
[direct posting](https://developers.tiktok.com/docs/en/content-posting-api-get-started).

## Instagram and Facebook

Configure `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` (Facebook callback),
`META_GRAPH_VERSION` (an active version from the app dashboard) and
`INSTAGRAM_REDIRECT_URI` (Instagram callback). If the Instagram product has a different
client ID/secret, use `INSTAGRAM_CLIENT_ID`/`INSTAGRAM_CLIENT_SECRET` overrides.
No obsolete Graph version is assumed.

- `INSTAGRAM_LOGIN_MODE=instagram`: professional Instagram Login; default scope
  `instagram_business_basic`, optional approved `instagram_business_content_publish`.
- `INSTAGRAM_LOGIN_MODE=facebook`: linked professional account via Facebook Login;
  default `pages_show_list,pages_read_engagement,instagram_basic`, optional approved
  `instagram_content_publish`. Personal/consumer profiles are unsupported.
- Facebook Page mode: `FACEBOOK_SCOPES=pages_show_list,pages_read_engagement`, optional
  `pages_manage_posts` after review. Only returned managed Pages with content privileges
  are selectable. Page tokens are encrypted. Reels upload uses official start/upload/finish
  endpoints; the supported adapter validates the documented 4–60-second Reel range.

Set `INSTAGRAM_PUBLISH_APPROVED`, `FACEBOOK_PUBLISH_APPROVED` and `META_API_VERIFIED`
only to reflect the actual app permissions/review. Instagram uses a publicly reachable HTTPS
render URL, creates a REELS container, polls processing, publishes it and retrieves the actual
media permalink. Metrics appear only when returned by the authorized professional profile.
Meta permission and token lifetime differences may require reconnection rather than refresh.

Official references: [Meta Instagram collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api),
[Meta Facebook Reels](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api).
Meta's corresponding developer pages may require an authenticated developer account.

## YouTube

Configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`,
`YOUTUBE_SCOPES` (initially `https://www.googleapis.com/auth/youtube.readonly`). Channel
information is fetched from authorized `channels.list`; hidden subscribers remain unavailable.
For uploads also request `https://www.googleapis.com/auth/youtube.upload`, obtain review,
and set `YOUTUBE_PUBLISH_APPROVED=true`. `YOUTUBE_API_VERIFIED=true` records audit status.
Unverified API projects can upload only private videos. Creators explicitly choose title,
description, privacy, category/tags and made-for-kids status; disclosure/tracking are required.
The adapter initializes a resumable upload session and sends the rendered file, then checks
actual processing status. An interrupted session is stored for manual provider reconciliation;
it is not automatically initialized again, which would risk duplicate posting.

Official references: [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert),
[resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).

## External steps before live integration

Register provider applications and exact HTTPS callbacks. Complete required business/app
reviews, request only necessary scopes, configure credentials/key securely and test with
authorized developer/test accounts. Set approval attestations only after acceptance.
Real provider consent, publishing and metric availability cannot be proven by local mocks.
The admin integration view distinguishes configured capabilities, approval attestations,
last recorded API test and errors. No fake buttons or credentials bypass missing approval.
