// Our Disney Trip on dtp.ondorilabo.com: serves index.html and keeps the shared plan in D1.
//
//   GET    /api/docs?since=<n>     every doc changed after cursor n (0 = everything), plus the new cursor
//   PUT    /api/docs/<coll>/<id>   save a doc (body: the doc's JSON)
//   DELETE /api/docs/<coll>/<id>   delete a doc (kept as a tombstone so other phones see the delete)
//   daily cron                     pulls Walt Disney World news from RSS into news/<id> and ref/news
//
// No sign-in, by choice: anyone with the link can read and edit.
// `updated` is a strictly increasing counter, so a phone that asks "what changed since n" never misses a write.

const COLLS = new Set(["trip", "resorts", "budget", "wishes", "food", "todos", "dvc", "ref", "proscons", "news", "days"]);
const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BODY = 256 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function save(db, coll, id, data, deleted = 0) {
  await db.prepare(
    `INSERT INTO docs (coll, id, data, deleted, updated)
     VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(updated), 0) + 1 FROM docs))
     ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated = excluded.updated`
  ).bind(coll, id, data, deleted).run();
}

async function api(request, env, url) {
  const db = env.DB;
  if (url.pathname === "/api/docs" && request.method === "GET") {
    const since = Number(url.searchParams.get("since")) || 0;
    const { results } = await db.prepare("SELECT coll, id, data, deleted, updated FROM docs WHERE updated > ?1 ORDER BY updated").bind(since).all();
    const cursor = results.length ? results[results.length - 1].updated : since;
    return json({ cursor, docs: results.map((r) => ({ coll: r.coll, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) })) });
  }
  const m = url.pathname.match(/^\/api\/docs\/([^/]+)\/([^/]+)$/);
  if (!m) return json({ error: "not found" }, 404);
  const coll = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
  if (!COLLS.has(coll) || !ID.test(id)) return json({ error: "bad collection or id" }, 400);
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "too big" }, 413);
    let data; try { data = JSON.parse(text); } catch { return json({ error: "not JSON" }, 400); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "doc must be an object" }, 400);
    await save(db, coll, id, JSON.stringify(data));
    return json({ ok: true });
  }
  if (request.method === "DELETE") { await save(db, coll, id, "null", 1); return json({ ok: true }); }
  return json({ error: "method not allowed" }, 405);
}

// ---------- daily news ----------
const FEEDS = [
  ["Disney Parks Blog", "https://disneyparksblog.com/feed/", "https://disneyparksblog.com/"],
  ["WDW News Today", "https://wdwnt.com/feed/", "https://wdwnt.com/"],
  ["BlogMickey", "https://blogmickey.com/feed/", "https://blogmickey.com/"],
  ["Disney Tourist Blog", "https://www.disneytouristblog.com/feed/", "https://www.disneytouristblog.com/"],
];
const WDW = /walt disney world|magic kingdom|epcot|hollywood studios|animal kingdom|disney springs|boardwalk|beach club|old key west|riviera|grand floridian|polynesian|fort wilderness|bay lake|kidani|typhoon lagoon|blizzard beach|\bwdw\b|disney vacation club|\bdvc\b|orlando/i;
const SKIP = /universal|epic universe/i;
const TAGS = [
  ["Tickets & prices", /ticket|price|pass\b|annual pass|discount|deal/i],
  ["DVC", /disney vacation club|\bdvc\b|villas/i],
  ["EPCOT", /epcot|food (&|and) wine|festival of the holidays/i],
  ["Hollywood Studios", /hollywood studios/i],
  ["Magic Kingdom", /magic kingdom/i],
  ["Animal Kingdom", /animal kingdom/i],
  ["Resorts", /resort|hotel|villas/i], // title only: every WDW story is tagged "Walt Disney World Resort"
  ["Food", /dining|restaurant|snack|menu|food/i],
  ["Rides & shows", /ride|attraction|show|parade|fireworks|coaster/i],
];
const ent = (s) => s.replace(/<!\[CDATA\[([^]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&#8217;|&rsquo;/g, "’").replace(/&#8216;/g, "‘").replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
  .replace(/&#038;|&amp;/g, "&").replace(/\[&#8230;\]|\[…\]|&#8230;/g, "…").replace(/&nbsp;|&#160;/g, " ")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)).replace(/\s+/g, " ").trim();
const get = (x, t) => { const m = x.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([^]*?)</" + t + ">")); return m ? m[1] : ""; };
async function sha16(s) { const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16); }

async function refreshNews(env) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT id, data FROM docs WHERE coll = 'news' AND deleted = 0").all();
  const have = new Set(results.map((r) => r.id));
  let added = 0, failed = [];
  for (const [name, feed] of FEEDS) {
    let xml;
    try { const r = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (dtp.ondorilabo.com news refresh)" } }); if (!r.ok) throw new Error(r.status); xml = await r.text(); }
    catch (e) { failed.push(name); continue; }
    for (const it of xml.split("<item>").slice(1)) {
      const title = ent(get(it, "title")), link = ent(get(it, "link")).replace(/[?]adt_ei=.*$/, ""), date = new Date(get(it, "pubDate"));
      const cats = [...it.matchAll(/<category>([^]*?)<\/category>/g)].map((m) => ent(m[1]));
      let summary = ent(get(it, "description")); if (summary.length > 180) summary = summary.slice(0, 177).replace(/\s+\S*$/, "") + "…";
      if (!title || !link || !WDW.test(title + " " + cats.join(" ") + " " + summary) || SKIP.test(title)) continue;
      const id = await sha16(link);
      if (have.has(id)) continue;
      have.add(id);
      const tags = TAGS.filter(([t, re]) => re.test(t === "Resorts" ? title : title + " " + cats.join(" "))).map(([t]) => t);
      await save(db, "news", id, JSON.stringify({ title, url: link, source: name, date: isNaN(date) ? "" : date.toISOString(), summary, tags }));
      added++;
    }
  }
  // Drop stories older than 30 days.
  const cutoff = Date.now() - 30 * 864e5;
  let removed = 0;
  for (const r of results) { const d = Date.parse(JSON.parse(r.data).date); if (d && d < cutoff) { await save(db, "news", r.id, "null", 1); removed++; } }
  if (failed.length < FEEDS.length) await save(db, "ref", "news", JSON.stringify({ updated: new Date().toISOString(), sources: FEEDS.map(([n, , home]) => ({ name: n, url: home })) }));
  console.log(JSON.stringify({ added, removed, failed }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); } catch (e) { console.error(e); return json({ error: "server error" }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(refreshNews(env)); },
};
