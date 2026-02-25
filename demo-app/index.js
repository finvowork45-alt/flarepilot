import { createServer } from "node:http";
import { cpus, totalmem, freemem } from "node:os";

var started = Date.now();
var requests = 0;
var location = process.env.CLOUDFLARE_LOCATION || "unknown";
var region = process.env.CLOUDFLARE_REGION || "unknown";
var country = process.env.CLOUDFLARE_COUNTRY_A2 || "";
var flag = country.length === 2
  ? String.fromCodePoint(...[...country.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
  : "\u{1F30D}";

// D1 via Hrana — auto-provisioned by flarepilot db create / deploy --db
var DB_TOKEN = process.env.DB_TOKEN || "";
var DB_URL = process.env.DB_URL || "";
var dbReady = false;

async function dbQuery(sql, args) {
  var stmt = { sql };
  if (args) stmt.args = args.map(v =>
    v === null ? { type: "null" } :
    typeof v === "number" ? { type: "integer", value: String(v) } :
    { type: "text", value: String(v) }
  );
  var res = await fetch(DB_URL + "/v2/pipeline", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DB_TOKEN,
    },
    body: JSON.stringify({ requests: [{ type: "execute", stmt }] }),
  });
  var json = await res.json();
  var r = json.results[0];
  if (r.type === "error") throw new Error(r.error.message);
  var cols = r.response.result.cols.map(c => c.name);
  return r.response.result.rows.map(row =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]?.value ?? null]))
  );
}

async function ensureTable() {
  if (dbReady) return;
  await dbQuery("CREATE TABLE IF NOT EXISTS visitors (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT, flag TEXT, visited_at TEXT DEFAULT (datetime('now')))");
  dbReady = true;
}

function countryFlag(code) {
  if (!code || code.length !== 2) return "\u{1F30D}";
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function uptime() {
  var s = (Date.now() - started) / 1000;
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

var mb = n => (n / 1024 / 1024).toFixed(0) + " MB";
createServer(async (req, res) => {
  requests++;

  try {
    if (req.url === "/health") {
      res.writeHead(200);
      return res.end("ok");
    }

    var mem = process.memoryUsage();
    var ua = req.headers["user-agent"] || "";
    console.log("TEST", DB_URL, DB_TOKEN)
    var hasDb = !!(DB_URL && DB_TOKEN);

    // Log visitor and fetch recent visits
    var recentVisitors = [];
    var visitorCountry = req.headers["cf-ipcountry"] || "";
    if (hasDb) {
      try {
        await ensureTable();
        if (visitorCountry && visitorCountry !== "XX" && visitorCountry !== "T1") {
          await dbQuery("INSERT INTO visitors (country, flag) VALUES (?, ?)", [visitorCountry, countryFlag(visitorCountry)]);
        }
        recentVisitors = await dbQuery("SELECT flag, country, visited_at FROM visitors ORDER BY id DESC LIMIT 5");
      } catch {}
    }

    // --- curl / plain text ---
    if (ua.startsWith("curl/") || !ua.includes("Mozilla")) {
      var rows = [
        ["Location", location],
        ["Region", region],
        ["Uptime", uptime()],
        ["Requests", String(requests)],
        ["CPUs", String(cpus().length)],
        ["Memory", `${mb(mem.rss)} / ${mb(totalmem())}`],
        ["Database", hasDb ? "connected" : "not configured"],
      ];
      var w = Math.max(...rows.map(r => r[0].length));
      var txt = `\nHello World ${flag} from Node.js ${process.version}\n\n` +
        rows.map(([k, v]) => `  ${k.padStart(w)}  ${v}`).join("\n") + "\n";
      if (recentVisitors.length > 0) {
        txt += "\nRecent visitors:\n" +
          recentVisitors.map(v => `  ${v.flag}  ${v.country}  ${v.visited_at}`).join("\n") + "\n";
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(txt);
    }

    // --- Visitor log HTML section ---
    var visitorsHtml = "";
    if (hasDb && recentVisitors.length > 0) {
      var visitorsRows = recentVisitors.map(v =>
        `<tr><td>${v.flag}</td><td>${v.country}</td><td>${v.visited_at}</td></tr>`
      ).join("");
      visitorsHtml = `
  <div class="vl">
    <h2>Recent visitors <span class="badge">from DB, persistent</span></h2>
    <table>${visitorsRows}</table>
  </div>`;
    }

    // --- HTML response ---
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flarepilot</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #aaa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .c { text-align: center; max-width: 480px; width: 100%; padding: 24px; }
  h1 { color: #fff; font-size: 32px; margin: 0; font-weight: 400; }
  h1 s { color: #555; }
  .sub { color: #555; font-size: 14px; margin: 8px 0 24px; }
  table { margin: 0 auto; border-collapse: collapse; font-size: 14px; }
  td { padding: 4px 12px; }
  td:first-child { color: #555; text-align: right; }
  td:last-child { color: #fff; font-family: ui-monospace, monospace; }
  .vl { margin-top: 32px; }
  .vl h2 { color: #fff; font-size: 16px; font-weight: 500; margin: 0 0 12px; }
  .badge { background: #f38020; color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 3px; vertical-align: middle; font-weight: 600; }
  .vl table { font-size: 13px; }
  .vl td { padding: 3px 10px; color: #888; }
  .vl td:first-child { font-size: 16px; }
</style>
</head>
<body>
<div class="c">
  <h1>Hello <s>World</s> ${flag}</h1>
  <div class="sub">Node.js ${process.version}</div>
  <table>
    <tr><td>Location</td><td>${location}</td></tr>
    <tr><td>Region</td><td>${region}</td></tr>
    <tr><td>Uptime</td><td>${uptime()}</td></tr>
    <tr><td>Requests</td><td>${requests}</td></tr>
    <tr><td>CPUs</td><td>${cpus().length}</td></tr>
    <tr><td>Memory</td><td>${mb(mem.rss)} / ${mb(totalmem())}</td></tr>
    <tr><td>Database</td><td>${hasDb ? "connected" : '<span style="color:#555">not configured</span>'}</td></tr>
  </table>${visitorsHtml}
</div>
</body>
</html>`);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(8080);
