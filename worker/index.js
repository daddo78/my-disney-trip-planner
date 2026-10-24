// Our Disney Trip on dtp.ondorilabo.com: serves index.html and keeps everyone's trips in D1.
//
// Accounts (worker/migrations/0002_accounts.sql): sign in with a 6-digit code sent by email (Resend), stay signed in
// with an HttpOnly session cookie. Friends are made with a personal 6-character friend code. A trip is seen and edited by its
// members: whoever created it, plus the accounts linked on its Who's going list.
//
//   POST   /api/auth/start {email}         email a sign-in code
//   POST   /api/auth/verify {email, code}  check it, make the account if it's new, set the session cookie
//   POST   /api/auth/signout
//   GET    /api/me                         me, my friends, names of everyone on my trips, my trip ids
//   PUT    /api/me {name}
//   POST   /api/friends/code               a new friend code (the old one stops working)
//   POST   /api/friends/add {code}         become friends with the code's owner
//   DELETE /api/friends/<id>
//   GET    /api/docs?since=<n>             docs I can see changed after cursor n (0 = everything), the new cursor, my trip ids
//   PUT    /api/docs/<coll>/<id>           save a doc in one of my trips
//   DELETE /api/docs/<coll>/<id>           delete it (kept as a tombstone so other phones see the delete)
//   daily cron                             pulls Walt Disney World news from RSS into news/<id> and ref/news
//
// Writes must send the header "x-dtp: 1"; a custom header can't be sent cross-site without CORS, which this never allows.
// `updated` is a strictly increasing counter, so a phone that asks "what changed since n" never misses a write.
// Without a RESEND_API_KEY secret (local `wrangler dev`), sign-in codes are written to the log instead of emailed.

// The DVC charts, weather and news are shared by everyone and written only by the Worker or by hand.
const SHARED = new Set(["dvc", "ref", "news"]);
// Each trip's own collections. The first trip ("main") uses the plain names; later ones "<coll>@<trip id>".
const TRIP_BASE = new Set(["trip", "resorts", "budget", "wishes", "food", "todos", "proscons", "days"]);
const TRIP_COLL = /^(trip|resorts|budget|wishes|food|todos|proscons|days)@([A-Za-z0-9]{1,24})$/;
const TRIP_ID = /^[A-Za-z0-9]{1,24}$/;
const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_BODY = 256 * 1024;
const COOKIE = "dtp_session";
const SESSION_DAYS = 365, CODE_MINUTES = 10, CODE_TRIES = 5, RESEND_WAIT = 30e3;
const FROM = "Our Disney Trip <trips@ondorilabo.com>";
// Friend codes: 6 characters, leaving out 0/O, 1/I/L so they're easy to read aloud and type. Ten wrong tries an hour.
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ", FRIEND_CODE = /^[2-9A-HJKMNP-Z]{6}$/, FRIEND_TRIES = 10;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
const oops = (error, status = 400) => json({ error }, status);

async function save(db, coll, id, data, deleted = 0) {
  await db.prepare(
    `INSERT INTO docs (coll, id, data, deleted, updated)
     VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(updated), 0) + 1 FROM docs))
     ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated = excluded.updated`
  ).bind(coll, id, data, deleted).run();
}

// Which trip a doc belongs to (null = shared or unknown).
function tripOf(coll, id) {
  if (coll === "trips") return TRIP_ID.test(id) ? id : null;
  const m = coll.match(TRIP_COLL); if (m) return m[2];
  return TRIP_BASE.has(coll) ? "main" : null;
}

// ---------- accounts ----------
const friendCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function cookieOf(request) { const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`)); return m ? m[1] : null; }
const setCookie = (token, days) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(days * 86400)}`;

async function whoIs(request, db) {
  const token = cookieOf(request); if (!token) return null;
  return db.prepare("SELECT u.id, u.email, u.name, u.code FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?1 AND s.expires > ?2")
    .bind(await sha(token), Date.now()).first();
}
async function body(request) { try { const b = await request.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; } }

async function sendCode(env, email, code) {
  const text = `Your Our Disney Trip sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`;
  if (!env.RESEND_API_KEY) { console.log(`sign-in code for ${email}: ${code}`); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [email], subject: `${code} is your Our Disney Trip code`, text,
      html: `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#0D1C2E"><p>Your Our Disney Trip sign-in code is</p>
        <p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:12px 0">${code}</p>
        <p style="color:#555">It works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p></div>`,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function auth(request, env, path) {
  const db = env.DB, b = await body(request);
  if (path === "/api/auth/start") {
    const email = String(b.email || "").trim().toLowerCase();
    if (!EMAIL.test(email)) return oops("That doesn't look like an email address.");
    const prev = await db.prepare("SELECT sent FROM codes WHERE email = ?1").bind(email).first();
    if (prev && Date.now() - prev.sent < RESEND_WAIT) return oops("A code is on its way. Give it 30 seconds before asking for another.", 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    await db.prepare("INSERT OR REPLACE INTO codes (email, hash, expires, tries, sent) VALUES (?1, ?2, ?3, 0, ?4)")
      .bind(email, await sha(`${email}:${code}`), Date.now() + CODE_MINUTES * 6e4, Date.now()).run();
    try { await sendCode(env, email, code); } catch (e) { console.error(e); return oops("The code email didn't send. Try again in a minute.", 502); }
    return json({ ok: true });
  }
  if (path === "/api/auth/verify") {
    const email = String(b.email || "").trim().toLowerCase(), code = String(b.code || "").replace(/\D/g, "");
    const row = await db.prepare("SELECT hash, expires, tries FROM codes WHERE email = ?1").bind(email).first();
    if (!row || row.expires < Date.now() || row.tries >= CODE_TRIES) return oops("That code has expired. Send a new one.");
    if ((await sha(`${email}:${code}`)) !== row.hash) {
      await db.prepare("UPDATE codes SET tries = tries + 1 WHERE email = ?1").bind(email).run();
      return oops(row.tries + 1 >= CODE_TRIES ? "Too many tries. Send a new code." : "That code doesn't match. Check the email and try again.");
    }
    await db.prepare("DELETE FROM codes WHERE email = ?1").bind(email).run();
    let user = await db.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (!user) {
      user = { id: hex(8) };
      await db.prepare("INSERT INTO users (id, email, name, code, created) VALUES (?1, ?2, '', ?3, ?4)").bind(user.id, email, friendCode(), new Date().toISOString()).run();
    }
    const token = hex(32);
    await db.prepare("INSERT INTO sessions (hash, user_id, expires) VALUES (?1, ?2, ?3)").bind(await sha(token), user.id, Date.now() + SESSION_DAYS * 864e5).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie(token, SESSION_DAYS) });
  }
  if (path === "/api/auth/signout") {
    const token = cookieOf(request);
    if (token) await db.prepare("DELETE FROM sessions WHERE hash = ?1").bind(await sha(token)).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });
  }
  return oops("not found", 404);
}

const myTrips = async (db, uid) => (await db.prepare("SELECT trip FROM members WHERE user_id = ?1").bind(uid).all()).results.map((r) => r.trip);
const friendIds = async (db, uid) => new Set((await db.prepare("SELECT b FROM friends WHERE a = ?1").bind(uid).all()).results.map((r) => r.b));

// A new friend code for this account (retried on the rare clash with someone else's).
async function newCode(db, uid) {
  for (let i = 0; i < 5; i++) {
    const code = friendCode();
    try { await db.prepare("UPDATE users SET code = ?1 WHERE id = ?2").bind(code, uid).run(); return code; } catch (e) { if (i === 4) throw e; }
  }
}
async function meInfo(db, user) {
  if (!FRIEND_CODE.test(user.code || "")) user = { ...user, code: await newCode(db, user.id) };
  const friends = (await db.prepare("SELECT u.id, u.name FROM friends f JOIN users u ON u.id = f.b WHERE f.a = ?1 ORDER BY u.name").bind(user.id).all()).results;
  // Names for hearts, pros and cons, and Who's going: everyone on my trips, plus my friends.
  const others = (await db.prepare(`SELECT DISTINCT u.id, u.name FROM members m JOIN members o ON o.trip = m.trip JOIN users u ON u.id = o.user_id WHERE m.user_id = ?1`).bind(user.id).all()).results;
  const people = {}; [...others, ...friends].forEach((p) => (people[p.id] = p.name || "Someone"));
  return { user: { id: user.id, email: user.email, name: user.name, code: user.code }, friends, people, trips: await myTrips(db, user.id) };
}

async function account(request, env, path, user) {
  const db = env.DB;
  if (path === "/api/me" && request.method === "GET") return json(await meInfo(db, user));
  if (path === "/api/me" && request.method === "PUT") {
    const name = String((await body(request)).name || "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 40) return oops("Pick a name up to 40 letters long.");
    await db.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, user.id).run();
    return json(await meInfo(db, { ...user, name }));
  }
  if (path === "/api/friends/code" && request.method === "POST") return json(await meInfo(db, { ...user, code: await newCode(db, user.id) }));
  if (path === "/api/friends/add" && request.method === "POST") {
    const code = String((await body(request)).code || "").toUpperCase().replace(/[\s-]/g, "");
    const tries = await db.prepare("SELECT since, count FROM friend_tries WHERE user_id = ?1").bind(user.id).first();
    const fresh = !tries || Date.now() - tries.since > 36e5;
    if (!fresh && tries.count >= FRIEND_TRIES) return oops("Too many wrong codes. Try again in an hour.", 429);
    const them = FRIEND_CODE.test(code) && await db.prepare("SELECT id, name FROM users WHERE code = ?1").bind(code).first();
    if (!them) {
      await db.prepare("INSERT OR REPLACE INTO friend_tries (user_id, since, count) VALUES (?1, ?2, ?3)").bind(user.id, fresh ? Date.now() : tries.since, fresh ? 1 : tries.count + 1).run();
      return oops("No one has that friend code. Check it with your friend.", 404);
    }
    if (them.id === user.id) return oops("That's your own friend code. Send it to a friend!");
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO friends (a, b) VALUES (?1, ?2)").bind(user.id, them.id),
      db.prepare("INSERT OR IGNORE INTO friends (a, b) VALUES (?1, ?2)").bind(them.id, user.id),
    ]);
    return json({ friend: them, ...(await meInfo(db, user)) });
  }
  const f = path.match(/^\/api\/friends\/([a-z0-9]{1,40})$/);
  if (f && request.method === "DELETE") {
    await db.prepare("DELETE FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)").bind(user.id, f[1]).run();
    return json(await meInfo(db, user));
  }
  return oops("not found", 404);
}

// ---------- the trip docs ----------
async function docs(request, env, url, user) {
  const db = env.DB;
  if (url.pathname === "/api/docs" && request.method === "GET") {
    const since = Number(url.searchParams.get("since")) || 0, trips = await myTrips(db, user.id), mine = new Set(trips);
    const { results } = await db.prepare("SELECT coll, id, data, deleted, updated FROM docs WHERE updated > ?1 ORDER BY updated").bind(since).all();
    const cursor = results.length ? results[results.length - 1].updated : since;
    const seen = results.filter((r) => SHARED.has(r.coll) || mine.has(tripOf(r.coll, r.id)));
    return json({ cursor, trips, docs: seen.map((r) => ({ coll: r.coll, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) })) });
  }
  const m = url.pathname.match(/^\/api\/docs\/([^/]+)\/([^/]+)$/);
  if (!m) return oops("not found", 404);
  const coll = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]), trip = tripOf(coll, id);
  if (!trip || !ID.test(id)) return oops("bad collection or id");
  // A trip nobody has yet belongs to whoever writes to it first; otherwise only its members can touch it.
  const members = (await db.prepare("SELECT user_id, owner FROM members WHERE trip = ?1").bind(trip).all()).results;
  const owner = (members.find((x) => x.owner) || {}).user_id || (members.length ? null : user.id);
  if (!members.length) await db.prepare("INSERT OR IGNORE INTO members (trip, user_id, owner) VALUES (?1, ?2, 1)").bind(trip, user.id).run();
  else if (!members.some((x) => x.user_id === user.id)) return oops("That trip isn't shared with you.", 403);

  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY) return oops("too big", 413);
    let data; try { data = JSON.parse(text); } catch { return oops("not JSON"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return oops("doc must be an object");
    if (coll === "trips") {
      // Who's going decides who else can open the trip. People can only be linked to your friends
      // (or to accounts already on the trip); other links are dropped, keeping the name.
      const prev = await db.prepare("SELECT data FROM docs WHERE coll = 'trips' AND id = ?1 AND deleted = 0").bind(id).first();
      const before = new Set(((prev && JSON.parse(prev.data).people) || []).map((p) => p && p.uid).filter(Boolean));
      const friends = await friendIds(db, user.id);
      data.people = (Array.isArray(data.people) ? data.people : []).filter((p) => p && typeof p === "object").map((p) => {
        const ok = p.uid && (p.uid === user.id || before.has(p.uid) || friends.has(p.uid));
        const { uid, ...rest } = p; return ok ? { ...rest, uid } : rest;
      });
      data.owner = owner;
      const keep = new Set([owner, ...data.people.map((p) => p.uid).filter(Boolean)]);
      await db.batch([
        db.prepare("DELETE FROM members WHERE trip = ?1 AND owner = 0").bind(trip),
        ...[...keep].filter((u) => u !== owner).map((u) => db.prepare("INSERT OR IGNORE INTO members (trip, user_id, owner) VALUES (?1, ?2, 0)").bind(trip, u)),
      ]);
    }
    await save(db, coll, id, JSON.stringify(data));
    return json({ ok: true });
  }
  if (request.method === "DELETE") {
    if (coll !== "trips") { await save(db, coll, id, "null", 1); return json({ ok: true }); }
    // Deleting a trip takes everything in it, and only its creator can do that.
    if (owner !== user.id) return oops("Only the person who started this trip can delete it.", 403);
    const like = trip === "main" ? null : `%@${trip}`;
    const rows = like ? (await db.prepare("SELECT coll, id FROM docs WHERE deleted = 0 AND coll LIKE ?1").bind(like).all()).results
      : (await db.prepare(`SELECT coll, id FROM docs WHERE deleted = 0 AND coll IN (${[...TRIP_BASE].map((c) => `'${c}'`).join(",")})`).all()).results;
    for (const r of rows) if (tripOf(r.coll, r.id) === trip) await save(db, r.coll, r.id, "null", 1);
    await save(db, coll, id, "null", 1);
    await db.prepare("DELETE FROM members WHERE trip = ?1").bind(trip).run();
    return json({ ok: true });
  }
  return oops("method not allowed", 405);
}

async function api(request, env, url) {
  const path = url.pathname;
  if (request.method !== "GET" && request.headers.get("x-dtp") !== "1") return oops("missing x-dtp header", 403);
  if (path.startsWith("/api/auth/") && request.method === "POST") return auth(request, env, path);
  const user = await whoIs(request, env.DB);
  if (!user) return oops("signed out", 401);
  if (path === "/api/me" || path.startsWith("/api/friends")) return account(request, env, path, user);
  if (path === "/api/docs" || path.startsWith("/api/docs/")) return docs(request, env, url, user);
  return oops("not found", 404);
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
