# Content Studio

Start the normal API and `npm run worker`, or use the production Compose worker service
after an authorized release. Both share SQLite and uploaded media volumes. The Docker image
installs Debian FFmpeg/FFprobe and DejaVu fonts. Local development can set `FFMPEG_PATH`,
`FFPROBE_PATH` and `SOCIAL_FONT_PATH` to absolute paths. `SOCIAL_PUBLIC_URL` must be the
externally reachable HTTPS origin for QR links and Instagram hosted video retrieval.

## Rendering pipeline

`POST /api/creator/upload` accepts one MP4/MOV video ≤150MB or PNG/JPEG/WebP brand image.
Files receive random filenames and ownership records. Content Studio binds the creator's
source upload to their assignment; only their media or campaign advertiser's uploaded
branding can be used. Arbitrary external media URLs and local filesystem paths are refused.
FFprobe validates video streams, duration (≤600 seconds) and dimensions (≤8K).
FFmpeg input protocols are limited to local file/pipe, preventing remote playlist fetches.

`POST /api/creator/assignments/:id/render` stores validated overlay configuration and
queues a persistent render job; it never renders in the browser or HTTP handler.
The worker normalizes to 1080×1920, preserves aspect ratio with padding, converts to
30fps H.264/AAC and preserves source audio. A silent audio track is added only when
the original has no audio, so concatenation remains valid. Sponsor inserts retain their
own audio while the remaining creator footage/audio continues.

Formats: lower-third, configurable mid-card overlay, end-card, full sponsor clip insert
(up to five seconds at the chosen point), and QR CTA. Parameters include headline, CTA,
start/duration, end-card duration, brand color, uploaded logo and QR position. Mid-card
overlays cover their configured interval while source audio continues. End cards append
a held final frame with sponsor branding and padded silence; source audio is not removed.
Text is written to text files with expansion disabled, not interpolated into shell commands.
Branding stays below the main image for lower thirds; creators must preview before posting.

Each output includes downloadable MP4, JPEG thumbnail, PNG and SVG QR. QR encodes the
exact assignment tracking URL and uses the same Shield/billing path as a link click.
Generated captions include `Sponsored`, paid-partnership wording, CTA, tracking URL and
`#Ad #Sponsored`. Creators may edit text but submission/posting requires disclosure and
tracking. Generated text never hides sponsorship.

## Jobs and safety

Jobs are atomically claimed, persisted and visible in the studio/admin queue. Rendering
retries at most three times and times out after 15 minutes per media stage. Stale render
leases can recover; publishing mutations are never blindly retried. On graceful shutdown
the worker finishes the active job (Compose grants 16 minutes). Provider status polls
are bounded and can be requested again manually. Temporary render files are cleaned up
in the confined worker directory. Outputs and originals live on the persistent upload volume.

`GET /api/creator/jobs/:id` and authenticated asset download enforce ownership. Random
static media URLs allow platforms to retrieve approved outputs; do not upload confidential
customer footage. Admin reviews the actual rendered video and assignment brief before
direct posting. The reviewed asset is bound to the assignment; unreviewed alternatives
cannot be substituted at publish time. Direct API consent is explicit and recorded.

Typical render request:

```json
{
  "sourceUrl": "/uploads/creators/<your-upload>.mp4",
  "content": "My original video caption",
  "overlay": {
    "format": "lower-third",
    "headline": "Campaign sponsor",
    "cta": "Learn more",
    "start": 2,
    "duration": 5,
    "endCardDuration": 3,
    "color": "#151a35",
    "qr": true,
    "qrPosition": "bottom-right"
  }
}
```
