# Our Disney Trip

A phone-friendly planner, in vintage Disneyland ticket-book colors, for our Walt Disney World trip (late September 2027, 2 adults + 3 kids, $15,000 budget).

Live at **https://dtp.ondorilabo.com**. Both phones see the same plan, and changes show up on the other phone within about 5 seconds.

- **Home**: countdown to check-in, budget at a glance, our resort pick, usual weather for our dates, what's coming up.
- **Resorts**: one card per option (resort, dates, and the price we found). Perks and amenities are free tags. Icons flag hot dates, rainy season and hurricane season, from the dates. A 1–5 star "how much we want it" rating, pros and cons, an overall score out of 100, and "our pick".
- **Compare**: every option ranked by score, "what matters most" weights (want it / price / weather), and up to three options side by side: price, per night, budget, rating, dates, usual highs, rain, seasons, room, walk to the parks, pros and cons.
- **Budget**: one amount per category that we set ourselves (resort, tickets, travel, food, mugs, fun, other), against the total budget. Left blank, the resort line uses our pick's price.
- **Dream list**: rides, snacks and moments by park.
- **To-do**: booking windows and reminders, dated by counting back from check-in.
- **News**: Walt Disney World stories from Disney Parks Blog, WDW News Today, BlogMickey and Disney Tourist Blog, refreshed daily.

## How it's built

```
index.html                 the whole app (HTML/CSS/JS, no build step)
worker/index.js            Cloudflare Worker: serves index.html, the shared-plan API, and the daily news refresh
worker/migrations/*.sql    D1 schema (one table: docs)
wrangler.jsonc             Worker config: D1 binding, daily cron, custom domain dtp.ondorilabo.com
.assetsignore              only index.html is served as a static file
tools/refresh-news.js      the same news logic as a local script (used before the Worker had it)
```

- **Storage:** D1 database `disney-trip-planner`, table `docs (coll, id, data, deleted, updated)`. Collections: `trip`, `resorts`, `budget`, `wishes`, `todos`, `dvc`, `ref`, `proscons`, `news`. `updated` is a counter that only goes up, so each phone asks for "what changed since n" every 5 seconds.
- **API:** `GET /api/docs?since=n`, `PUT /api/docs/<coll>/<id>`, `DELETE /api/docs/<coll>/<id>`.
- **No sign-in, by choice:** anyone with the link can read and edit. Each phone picks "Dan" or "Brittany" once, for hearts and pros and cons.
- **News:** cron `15 11 * * *` UTC (about 7:15 AM Eastern) pulls the RSS feeds, keeps Walt Disney World stories, and drops ones older than 30 days. WDW News Today refuses requests from Cloudflare's servers, so the daily refresh only gets the other three sites.
- **Opened as a plain file**, the page falls back to saving on that device, seeded from `STARTER` in the code. It also still runs as the claude.ai artifact (https://claude.ai/artifact/XoojCoRWJGJiB31w4jiKoQ), but that copy is no longer the live one.

## Deploy

```bash
CLOUDFLARE_API_TOKEN=$(cat ~/.bgc/cloudflare-token.txt) npx wrangler@4 deploy
```

Schema changes: add a file in `worker/migrations/`, then `npx wrangler@4 d1 migrations apply disney-trip-planner --remote`.
