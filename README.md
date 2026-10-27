# Garmin MCP Worker

**Ask Claude about your own Garmin data — from your phone or your desktop.**

A read-only remote [MCP](https://modelcontextprotocol.io) server that connects Claude (or any MCP client with remote OAuth support) to your Garmin Connect account through Garmin's **official Personal API**. It runs on **Cloudflare Workers**' free tier and signs you in with OAuth, so it works in the Claude mobile app, not just on a desktop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wesleysui/garmin-mcp-worker)
[![CI](https://github.com/wesleysui/garmin-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/wesleysui/garmin-mcp-worker/actions/workflows/ci.yml)

[中文说明](README.zh-CN.md)

> "Should I do intervals today?" · "How has my HRV trended this month?" · "Compare my last three long runs." · "Did short sleep hurt my next-day runs?"

---

## Why this one

| | Official API | Works on phone | Auth |
|---|---|---|---|
| Local Personal API servers (stdio) | ✅ | ❌ desktop only | none — must not be exposed |
| Cloud servers using Garmin's private login | ❌ breaks when Garmin changes login | ✅ | varies |
| **This project** | ✅ | ✅ | OAuth 2.1 + PKCE |

- **Stable:** Garmin's documented Personal API with a revocable key. No password, no scraping.
- **Free:** fits comfortably in Cloudflare's free tier.
- **Model-friendly:** compact rows, long ranges split for you, bulky sample arrays left out unless asked.
- **Current protocol:** speaks MCP `2026-07-28` (stateless, `server/discover`) and `2025-03-26` … `2025-11-25`.

---

## Tools

| Tool | Returns |
|---|---|
| `garmin_get_recovery_trend` ⭐ | One row per morning: overnight HRV with status and personal baseline, sleep score/stages/need, resting HR, Body Battery, stress, intensity minutes. The best first call for "should I train hard today?" |
| `garmin_get_day` | Everything for one date: summary, sleep, HRV, Body Battery, activities |
| `garmin_get_hrv` · `garmin_get_hrv_summaries` | One night in detail · up to a year of nightly HRV |
| `garmin_get_sleep` | One night: score, sub-scores, stages, overnight vitals |
| `garmin_get_body_battery` | Daily reports and events; optional hourly chunks |
| `garmin_get_daily_summaries` | Raw daily wellness totals |
| `garmin_get_heart_rate` · `garmin_get_stress` | Daily heart rate · daily stress |
| `garmin_search_activities` | Compact activity rows: distance, pace/speed, HR, cadence, power, elevation, training effect, training load |
| `garmin_get_activity` | One activity in full, with splits |
| `garmin_get_profile` | Units, time zone and heart rate zones |
| `garmin_api_get` | Read-only GET on any Personal API path (escape hatch) |

All tools are annotated `readOnlyHint: true`.

---

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a Garmin **Personal API key**: sign in to Garmin Connect on the web, open [Settings → Personal API](https://connect.garmin.com/app/settings/personalApiToken), choose **Create Key** and copy it (it's shown once; pick up to a year of validity).

### Option A — one click

Press **Deploy to Cloudflare** above. Cloudflare copies the repo to your GitHub account, creates the KV namespace, and asks for:

- `GARMIN_API_KEY` — your Personal API key
- `LOGIN_PASSWORD` — a long password you'll type when connecting Claude
- `TIMEZONE` — e.g. `Europe/London` (used for "today")

### Option B — command line

Requires Node.js 20+.

```bash
git clone https://github.com/wesleysui/garmin-mcp-worker && cd garmin-mcp-worker
npm install
npx wrangler login
npx wrangler secret put GARMIN_API_KEY
npx wrangler secret put LOGIN_PASSWORD
npm run deploy            # the KV namespace is created automatically
```

Set your time zone in `wrangler.jsonc` (`vars.TIMEZONE`) before deploying.

---

## Connect Claude

1. In Claude (web), open the connector settings and choose **Add custom connector**.
2. URL: `https://garmin-mcp.<your-subdomain>.workers.dev/mcp`
3. Press **Connect**, enter your `LOGIN_PASSWORD` on the sign-in page, choose **Allow**.
4. Enable the connector in a chat. Connectors added on the web also appear in the mobile apps.

Other MCP clients that support remote servers with OAuth work the same way.

---

## What the Personal API doesn't have

- **Training Readiness, Training Status, race predictions** — not exposed. Use `garmin_get_recovery_trend` and let the model reason from HRV, sleep and resting HR instead.
- **VO2max** — Garmin currently strips it from API data; read it from your watch.
- **Writing anything** — the API is read-only, so no pushing workouts or courses to the watch.
- **Push notifications** — data is pulled on request; new activities appear after your watch syncs.

---

## Security

- OAuth 2.1 with PKCE via Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider); tokens are stored only as hashes.
- The consent page shows which app is asking and where tokens go, can't be framed, and uses a one-time, browser-bound form.
- One owner password, compared in constant time; 5 wrong attempts lock sign-in for 15 minutes.
- The Garmin key lives only in Worker secrets and never appears in responses or logs.
- Only `GET` requests ever reach Garmin; the token endpoint is blocked from the raw reader.

Found a problem? Please open a private security advisory rather than a public issue.

---

## Maintenance

- **Key expiry:** Garmin emails you about a week before. Create a new key and run `npx wrangler secret put GARMIN_API_KEY` — no need to reconnect Claude.
- **Staying signed in:** Claude refreshes its access automatically; after 30 idle days you'll be asked for the password again.
- **Logs:** `npx wrangler tail`

---

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values for local runs
npm run dev                      # http://localhost:8787
npm run typecheck
npm test                         # needs Bun; end-to-end with a fake Garmin API, no account needed
```

The test walks the whole path a client takes: discovery → dynamic client registration → consent page → password → token exchange → MCP calls in both protocol eras.

**Layout:** `src/index.ts` wiring · `src/auth.ts` sign-in and consent · `src/mcp.ts` protocol · `src/tools.ts` tools · `src/garmin.ts` API client · `src/dates.ts` date ranges.

Garmin's response shapes are only partly documented. If a field comes back empty for your device, open an issue with the tool name and (redacted) response.

---

## Credits

Built on ideas and endpoint knowledge from [garmin/connect-personal-api-python](https://github.com/garmin/connect-personal-api-python) (Garmin's official client), [Mason-Levyy/garmin-personal-mcp](https://github.com/Mason-Levyy/garmin-personal-mcp) and [Janhsen/ha-garmin-personal](https://github.com/Janhsen/ha-garmin-personal).

## Disclaimer

This is an independent project, **not affiliated with or endorsed by Garmin Ltd.** Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries. Use it only with your own account, in line with Garmin's Personal API terms. Not medical advice.

## License

[MIT](LICENSE)
