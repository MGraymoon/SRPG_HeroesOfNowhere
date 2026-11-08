// dev/server.js — serves the game folder for browser playtesting.
//   node dev/server.js [port]      then open http://localhost:<port>/index.html?test
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || 8686);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".woff": "font/woff",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".efkefc": "application/octet-stream", ".webm": "video/webm",
  ".mp4": "video/mp4",
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  // POST /dev/shot/<name>.png with a PNG data URL as the body -> dev/screenshots/<name>.png
  if (req.method === "POST" && urlPath.startsWith("/dev/shot/")) {
    const name = path.basename(urlPath).replace(/[^\w.-]/g, "_");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const dir = path.join(ROOT, "dev", "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.from(body.replace(/^data:image\/\w+;base64,/, ""), "base64"));
      res.writeHead(200); res.end("saved");
    });
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath === "/" ? "/index.html" : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving ${ROOT} at http://localhost:${PORT}/index.html?test`));
