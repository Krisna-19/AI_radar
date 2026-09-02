/*
 * AI RADAR - zero-dependency static + RSS-proxy server.
 *
 *   - Serves the static site (index.html, css/, js/).
 *   - Exposes  GET /api/fetch?url=<encoded>  which fetches RSS behind the
 *     scenes with no CORS limits (feeds don't send CORS headers).
 *
 * Run:  node server.js    (or: npm start)
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function fetchUrl(target, onDone) {
  const mod = target.startsWith("https:") ? https : http;
  const req = mod.get(
    target,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AIRadarBot/1.0; +https://airadar.local)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Encoding": "identity",
      },
      timeout: 15000,
    },
    (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        if (/^https?:\/\//.test(next)) return fetchUrl(next, onDone);
        return onDone(new Error("Invalid redirect"), null);
      }
      if (status !== 200) {
        res.resume();
        return onDone(new Error("HTTP " + status), null);
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => onDone(null, data));
    }
  );
  req.on("timeout", () => req.destroy(new Error("Timeout")));
  req.on("error", (e) => onDone(e, null));
}

function serveStatic(res, filePath) {
  const abs = path.normalize(path.join(ROOT, filePath));
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/fetch") {
    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//.test(target)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing or invalid 'url' param" }));
    }
    fetchUrl(target, (err, body) => {
      if (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
      res.writeHead(200, {
        "Content-Type": "application/xml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      });
      res.end(body);
    });
    return;
  }

  const filePath = decodeURIComponent(url.pathname);
  if (filePath === "/" || filePath === "") return serveStatic(res, "/index.html");
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log("─────────────────────────────");
  console.log("  AI RADAR running at");
  console.log(`  http://localhost:${PORT}`);
  console.log("─────────────────────────────");
});