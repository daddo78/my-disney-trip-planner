// Pulls Walt Disney World news from RSS feeds and prepares db writes for the planner's News tab.
// The artifact page can't fetch anything itself, so a Claude run uses this, then writes the result with ArtifactData.
//
// usage: node refresh-news.js <existingIds.json> <outDir>
//   existingIds.json: JSON array of news doc ids already in the db (skipped, so no versions are needed)
//   outDir: gets one <id>.json per new story, meta.json for ref/news, and writes.json (ArtifactData batch "writes", max 49 stories)
const fs = require("fs"), path = require("path"), crypto = require("crypto");

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

(async () => {
  const [idsFile, outDir] = process.argv.slice(2);
  const existing = new Set(idsFile && fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, "utf8")) : []);
  fs.mkdirSync(outDir, { recursive: true });
  const found = [], failed = [];
  for (const [name, url] of FEEDS) {
    let xml;
    try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }); if (!r.ok) throw new Error(r.status); xml = await r.text(); }
    catch (e) { failed.push(`${name} (${e.message})`); continue; }
    for (const it of xml.split("<item>").slice(1)) {
      const title = ent(get(it, "title")), link = ent(get(it, "link")).replace(/[?]adt_ei=.*$/, ""), date = new Date(get(it, "pubDate"));
      const cats = [...it.matchAll(/<category>([^]*?)<\/category>/g)].map((m) => ent(m[1]));
      let summary = ent(get(it, "description")); if (summary.length > 180) summary = summary.slice(0, 177).replace(/\s+\S*$/, "") + "…";
      if (!title || !link || !WDW.test(title + " " + cats.join(" ") + " " + summary) || SKIP.test(title)) continue;
      const id = crypto.createHash("sha1").update(link).digest("hex").slice(0, 16);
      const tags = TAGS.filter(([t, re]) => re.test(t === "Resorts" ? title : title + " " + cats.join(" "))).map(([t]) => t);
      found.push({ id, doc: { title, url: link, source: name, date: isNaN(date) ? "" : date.toISOString(), summary, tags } });
    }
  }
  const fresh = [...new Map(found.filter((f) => !existing.has(f.id)).map((f) => [f.id, f])).values()]
    .sort((a, b) => b.doc.date.localeCompare(a.doc.date)).slice(0, 49);
  const dir = path.resolve(outDir).replace(/\\/g, "/");
  const writes = fresh.map((f) => { fs.writeFileSync(path.join(outDir, f.id + ".json"), JSON.stringify(f.doc)); return { op: "set", collection: "news", doc_id: f.id, file_path: `${dir}/${f.id}.json` }; });
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ updated: new Date().toISOString(), sources: FEEDS.map(([n, , home]) => ({ name: n, url: home })) }));
  fs.writeFileSync(path.join(outDir, "writes.json"), JSON.stringify(writes));
  console.log(JSON.stringify({ storiesFound: found.length, newStories: writes.length, failedFeeds: failed, metaFile: `${dir}/meta.json`, writesFile: `${dir}/writes.json` }));
})();
