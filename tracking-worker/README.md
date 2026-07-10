# Open-tracking service (Cloudflare Worker)

One tiny, free, shared endpoint that records email opens for every Cold Outreach
Command Center install. It stores only opaque tokens + timestamps — never
recipient emails or message content.

## Deploy (about 5 minutes, one time)

1. Install the CLI and sign in:
   ```
   npm i -g wrangler
   wrangler login
   ```
2. Create the KV store and copy the printed `id` into `wrangler.toml`
   (replace `PASTE_KV_NAMESPACE_ID_HERE`):
   ```
   cd tracking-worker
   wrangler kv namespace create OPENS
   ```
3. Deploy:
   ```
   wrangler deploy
   ```
   Wrangler prints your URL, e.g. `https://open-tracking.<your-subdomain>.workers.dev`.
4. Test it:
   ```
   curl https://open-tracking.<your-subdomain>.workers.dev/health
   # -> {"ok":true,"service":"open-tracking"}
   ```

## Point the app at it

Put that base URL into the app in ONE of two ways:

- **Shipped for all users (recommended):** set `SHARED_TRACKING_URL` in
  `lib/tracking.ts` to your Worker URL, then rebuild the bundle. Every install
  then tracks opens by default.
- **Per install:** open the app → **Accounts → Open tracking** and paste the URL.

The app appends `/o/<token>.gif` for the pixel and polls `/opens?ik=<installId>`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /o/<token>.gif` | Records an open for `<token>`; returns a 1×1 GIF. |
| `GET /opens?ik=<installId>&since=<ms>` | Returns this install's opens for polling. |
| `GET /health` | Liveness check. |

## Notes

- Free tier (100k reads + 1k writes/day on KV) far exceeds 80 emails/day/user.
- Keys expire after 120 days.
- `installId` is a high-entropy random string embedded in the pixel URL. Anyone
  who inspects a sent email could read that install's aggregate open counts (not
  recipients). If you want stronger isolation later, add a separate read secret.
