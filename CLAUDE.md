# Our Disney Trip planner

A pink, phone-first planner for a Walt Disney World trip, built for my wife. She plans; I help. Keep it fun, cute and pink.

## The trip
- Late September into early October 2027. Current trip dates: Sep 22 – Oct 5, 2027 (13 nights). Earlier option: Sep 19 – Oct 1 (12 nights).
- 2 adults + 3 kids (5 people). Total budget: **$15,000**.
- Booking a **DVC point rental**, ideally a 5th-sleeper Deluxe Studio (sleeps 5, kitchenette). A 1-bedroom costs about $3K more. A 2-bedroom (~$15K) is out.
- She wants: a kitchenette at least, walking distance to EPCOT and Hollywood Studios (extended evening hours there for deluxe/DVC guests), a Florida-beach or BoardWalk vibe, refillable resort mugs (Diet Coke, coffee).
- Front-runners: **BoardWalk Villas** studio (rooms around the pools near the boat launch) and **Old Key West** 1-bedroom (family nostalgia, cheapest 1BR, but no 5th-sleeper studio and a long walk for mug refills). Swan & Dolphin ruled out (no family suites, no kitchenette).
- Later dates are cooler but cost more; earlier are cheaper but hotter.

## The app
- **Live at https://dtp.ondorilabo.com.** A Cloudflare Worker (`worker/index.js`, config `wrangler.jsonc`) serves `index.html` and keeps the shared plan in the D1 database `disney-trip-planner` (table `docs`). The README has the API and the deploy command. There's no sign-in, by choice.
- One self-contained page: `index.html` (HTML/CSS/JS, no build step). Tabs: Home, Resorts, Dates, Budget, Dreams, To-do, News.
- Storage modes: on the website it uses the Worker API and checks for changes every 5 seconds. The claude.ai artifact (https://claude.ai/artifact/XoojCoRWJGJiB31w4jiKoQ) still runs but is **no longer the live copy**. Opened as a file, it uses localStorage seeded from `STARTER`.
- Change live data through the API (`PUT`/`DELETE https://dtp.ondorilabo.com/api/docs/<coll>/<id>`), not with the artifact tools.
- Ticket prices: 4 adult-price + 1 child ticket (Amelia, 13, and Avery, 10, pay adult prices by the trip; Annie is 3). The tickets line is a formula estimate (`ref/tickets`).
- Collections (one doc per item):
  - `trip/settings`: `{budget, start, end, adults, kids, pickId, tixDays, tixAdults, tixKids}`; `trip/compare`: `{opts: [{start, end} ×3]}`
  - `proscons/<resort-slug>`: `{name, pros[], cons[]}` (items `{id, text, by}`)
  - `dvc/<resort>` (official 2027 points charts), `ref/seasons2027`, `ref/weather`, `ref/tickets`, `ref/news`, `news/<id>`
  - `resorts/<id>`: `{name, room, size, sleeps, kitchen, start, end, total, points, ppp, source, walk, eeh, vibe, notes, hearts[], out}`
  - `budget/<id>`: `{label, cat, amount, status, note}` (`cat` is one of stay, tickets, travel, food, mugs, fun, other; the picked resort fills the stay line automatically)
  - `wishes/<id>`: `{text, park, hearts[], done}`
  - `todos/<id>`: `{text, months|days|due, done, note}` (dates count back from check-in)
- The db is already seeded with her real quotes (from her screenshots of a DVC rental site). The budget lines for tickets, travel, food, mugs and souvenirs are **my guesses**, marked "Estimate".

## Status
Done: everything in the list below except real ticket totals. Disney's ticket calendar won't load in an automated browser, so the tickets line is still an estimate. Also done: up to 3 date options, pros and cons, park days vs. off days, and a News tab.

## Original brief
1. **Real DVC pricing by date.** Get the official 2027 DVC points charts (points per night by resort, room type, season, weeknight vs. weekend) for the resorts she's comparing: BoardWalk, Beach Club, Riviera, Grand Floridian, Polynesian, Old Key West, Fort Wilderness Cabins, Animal Kingdom Villas (Kidani), Bay Lake Tower. Studio and 1-bedroom at minimum. Store the charts in the db. Her quoted $/point: BWV $26, OKW $22, BCV $29, Riviera $24, VGF $26, Poly $29, Cabins $29, AKV $24, BLT $24.
2. **Compare dates screen.** She picks check-in/check-out and sees every resort's real cost (points × $/point, editable), side by side, and how far each leaves us under or over $15K. Check results against her quotes (e.g. BWV studio Sep 19–Oct 1 2027 = 126 pts = $3,276; Sep 22–Oct 5 = 156 pts = $4,056; OKW 1BR Sep 19–Oct 1 = 250 pts; Sep 22–Oct 5 = 314 pts).
3. **Real ticket prices.** 2027 tickets are on sale. Replace the $4,500 ticket estimate with actual multi-day prices for 2 adults + 3 kids for the chosen dates (note kids' ages matter: 3–9 is child pricing).
4. **Weather.** For any dates she picks: average high/low, chance of rain per day and typical storm count, from ~30 years of daily history for Walt Disney World (lat 28.37, lon -81.55). Open-Meteo's archive API (`archive-api.open-meteo.com`) is free. Label it as historical averages; real forecasts only exist ~2 weeks out.
5. Cite sources in the app for prices and weather (a small "Source" line).

## Network note
The first cloud session couldn't reach outside sites (Trusted network level). Use a session with **Full** network access, or a local session, so `archive-api.open-meteo.com`, `dvcfan.com`, `dvcnews.com`, `wdwnt.com` and Disney fan sites are reachable.

## Conventions
- Work on branch `claude/disney-vacation-planner-341o6o`.
- Keep `index.html` single-file. Colors are tokens in `:root` with dark-mode overrides; keep the pink palette and the Fredoka/Nunito fonts.
- Never invent prices or weather numbers. If something can't be verified, mark it as an estimate.
