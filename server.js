// Global tug-of-war. One shared rope. Everyone pulls.
// SSE for server->client push (native EventSource, no deps), POST /pull to tug.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const WIN = 100; // rope position range is -WIN..+WIN; hitting an edge = that side wins

let pos = 0; // <0 = left winning, >0 = right winning
const wins = { left: 0, right: 0 };
const clients = new Set(); // open SSE responses

const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
const STATIC = /^[a-z0-9_-]+\.(html|js|css)$/; // single safe filename, no path traversal

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

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/pull" && req.method === "POST") {
      const side = url.searchParams.get("side");
      if (side === "left" || side === "right") pull(side);
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === "/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data:${JSON.stringify({ pos, wins, players: clients.size + 1 })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // static files: / -> chooser, /<name>.html|js|css -> that file (read per-request, edits are live)
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
