// THE ROPE — global tug-of-war. One shared rope, everyone pulls.
// SSE for server->client push (native EventSource, no deps), POST /pull to tug.
//
// Anti-cheat (in-memory, single process):
//  - a pull needs a session id issued only by an open /stream connection,
//    sent from that session's own IP — no headless spam, no pull-without-playing
//  - per-session + per-IP token buckets cap everyone to ~human cadence
//  - Origin must match host — no cross-site drive-by pulls
//  - capped open connections per IP — limits fake player-count farming
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

const PORT = process.env.PORT || 3000;
const WIN = 100; // rope position range -WIN..+WIN; hitting an edge = that side wins

// gameplay / anti-cheat tunables (standalone toy — no shared config file)
const MAX_CONNS_PER_IP = 15;
const SESSION_RATE = { capacity: 15, refillPerSec: 12 }; // client pulls ~12/s; burst 15
const IP_RATE = { capacity: 40, refillPerSec: 30 };      // a few tabs on one IP, not a fleet

const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
const STATIC = /^[a-z0-9_-]+\.(html|js|css)$/; // single safe filename, no path traversal

let pos = 0; // <0 = left winning, >0 = right winning
const wins = { left: 0, right: 0 };
const clients = new Set();   // open SSE responses
const sessions = new Map();  // sid -> { ip, bucket }
const ips = new Map();       // ip  -> { conns, bucket }

// Token bucket: returns true and spends one token if available, else false.
// Refills continuously at refillPerSec, capped at capacity. ponytail: per-process
// only — behind >1 server replica, move buckets to Redis.
function allow(bucket, capacity, refillPerSec) {
  const now = Date.now();
  const have = bucket.tokens ?? capacity;
  const elapsed = (now - (bucket.t ?? now)) / 1000;
  bucket.tokens = Math.min(capacity, have + elapsed * refillPerSec);
  bucket.t = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function clientIp(req) {
  // ponytail: trusts X-Forwarded-For — correct behind one known proxy; if exposed
  // raw to the internet, an attacker can spoof XFF to dodge per-IP limits.
  const xff = req.headers["x-forwarded-for"];
  return (xff ? xff.split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return false; // browsers always send Origin on a POST; absence = curl/script
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

function broadcast() {
  const line = `data:${JSON.stringify({ pos, wins, players: clients.size })}\n\n`;
  for (const res of clients) res.write(line);
}

function pull(side) {
  pos += side === "left" ? -1 : 1;
  if (pos <= -WIN || pos >= WIN) {
    wins[pos <= -WIN ? "left" : "right"]++;
    pos = 0; // reset rope after a win
  }
}

// ---- self-check: token bucket caps at capacity with no refill ----
if (process.argv.includes("--selftest")) {
  const b = {};
  let granted = 0;
  for (let i = 0; i < 100; i++) if (allow(b, SESSION_RATE.capacity, 0)) granted++;
  assert.strictEqual(granted, SESSION_RATE.capacity, `bucket leaked: ${granted} != ${SESSION_RATE.capacity}`);
  console.log("selftest ok");
  process.exit(0);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/pull" && req.method === "POST") {
      const side = url.searchParams.get("side");
      if (side !== "left" && side !== "right") { res.writeHead(400); return res.end(); }
      if (!originOk(req)) { res.writeHead(403); return res.end(); }
      const sess = sessions.get(url.searchParams.get("s"));
      const ip = clientIp(req);
      if (!sess || sess.ip !== ip) { res.writeHead(403); return res.end(); } // must be a live session on its own IP
      const ipRec = ips.get(ip);
      if (!allow(sess.bucket, SESSION_RATE.capacity, SESSION_RATE.refillPerSec) ||
          !ipRec || !allow(ipRec.bucket, IP_RATE.capacity, IP_RATE.refillPerSec)) {
        res.writeHead(429); return res.end();
      }
      pull(side);
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === "/stream") {
      const ip = clientIp(req);
      const ipRec = ips.get(ip) || { conns: 0, bucket: {} };
      if (ipRec.conns >= MAX_CONNS_PER_IP) { res.writeHead(429); return res.end(); }
      ipRec.conns++;
      ips.set(ip, ipRec);
      const sid = crypto.randomUUID();
      sessions.set(sid, { ip, bucket: {} });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: session\ndata: ${JSON.stringify({ id: sid })}\n\n`);
      res.write(`data:${JSON.stringify({ pos, wins, players: clients.size + 1 })}\n\n`);
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
        sessions.delete(sid);
        if (--ipRec.conns <= 0) ips.delete(ip);
      });
      return;
    }

    // static files: / -> ascii.html, /<name>.html|js|css -> that file (read per-request)
    const name = url.pathname === "/" ? "ascii.html" : url.pathname.slice(1);
    if (STATIC.test(name) && name !== "server.js") {
      const file = path.join(__dirname, name);
      if (fs.existsSync(file)) {
        res.writeHead(200, { "content-type": TYPES[path.extname(name)] });
        return res.end(fs.readFileSync(file));
      }
    }

    res.writeHead(404);
    res.end("not found");
  })
  .listen(PORT, () => console.log(`tug-of-war on http://localhost:${PORT}`));

// One broadcast tick instead of per-pull spam. 20fps is plenty for a rope.
setInterval(broadcast, 50);
