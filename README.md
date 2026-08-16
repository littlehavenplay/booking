# Little Haven Play Studio — booking platform

Deployed on Netlify from this repo. Netlify reads `netlify.toml`:

- `publish = "public"`  -> only files inside `public/` are served as the website
- `functions = "netlify/functions"` -> only files here become `/api/*` endpoints

**Anything placed at the repo root is ignored by Netlify.** Files must go inside
`public/` or `netlify/functions/` or they will not deploy.

## Structure

```
netlify.toml              build config
package.json              dependency: @netlify/blobs
public/                   the website (HTML, assets, icons, photos)
netlify/functions/        all /api/* endpoints + lib-* shared helpers
```

## Secrets

No credentials are stored in this repo. Everything comes from Netlify
environment variables (Site configuration -> Environment variables):

ADMIN_KEY, STAFF_PIN, SQUARE_ACCESS_TOKEN, SQUARE_APPLICATION_ID,
SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT, RESEND_API_KEY, EMAIL_FROM,
SITE_URL, STUDIO_EMAIL, STUDIO_NAME, WAIVER_URL, GIFTCARD_URL,
plus the PRICE_* / CAPACITY / CLOSED_* settings.

If `EMAIL_FROM` is ever unset, every email silently falls back to
`onboarding@resend.dev`, which Resend only delivers to your own address.
Customers would stop receiving confirmations. Keep it set.

## Square dashboard settings (not controlled by this code)

Birthday-party deposits use Square Payment Links. To enable wallets:
Square Dashboard -> Payments & orders -> Payment links -> Settings ->
General -> Payments -> turn ON Apple Pay and Google Pay, and turn OFF Cash App Pay
(the studio stopped accepting Cash App Pay in August 2026).

Gift-card sales use Square's hosted eGift checkout; its options are
controlled by Square, not by this code.

## Apple Pay domain verification

`public/.well-known/apple-developer-merchantid-domain-association` and the
duplicate copy at `public/apple-developer-merchantid-domain-association` are
both intentional. `public/_redirects` and `public/_headers` reference both
paths so verification survives GitHub's handling of dot-folders.
Do not delete either copy.

## Scheduled functions

| Function | Schedule (UTC) | Purpose |
|---|---|---|
| birthday-cron.js | 0 15 * * * | birthday gift email, 1 week ahead |
| credit-reminder-cron.js | 0 16 * * * | store-credit expiry reminders |
| newsletter-cron.js | */15 * * * * | queued newsletter sends |
| noshow-cron.js | */15 * * * * | no-show handling |
| refill-campaign.js | 0 17 * * 1 | Monday punch-card refill emails |
| reminders.js | 0 * * * * | booking reminders |

## Rolling back a bad deploy

Netlify -> Deploys -> pick the last known-good deploy -> Publish deploy.
This is instant and does not require touching GitHub.
