const http = require("http");
const https = require("https");
const url = require("url");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;

function rewriteHtml(html, targetOrigin, proxyBase) {
  html = html.replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi, (_, attr, link) => {
    return `${attr}="${proxyBase}?url=${encodeURIComponent(link)}"`;
  });
  html = html.replace(/(href|src|action)="(\/[^"]*?)"/gi, (_, attr, path) => {
    const full = targetOrigin + path;
    return `${attr}="${proxyBase}?url=${encodeURIComponent(full)}"`;
  });
  html = html.replace(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/gi, (_, link) => {
    return `url("${proxyBase}?url=${encodeURIComponent(link)}")`;
  });
  const banner = `
<div style="position:fixed;top:0;left:0;right:0;z-index:999999;background:#1a1a2e;color:#e0e0e0;
  font-family:monospace;font-size:13px;padding:6px 14px;display:flex;align-items:center;gap:12px;">
  <span style="color:#7c6af7;font-weight:bold;">⬡ PROXY</span>
  <span style="opacity:0.6;">→</span>
  <span style="color:#a5f3c4;">${targetOrigin}</span>
  <a href="/" style="margin-left:auto;color:#f87171;text-decoration:none;font-size:11px;">✕ exit</a>
</div>
<div style="height:32px;"></div>`;
  html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  return html;
}

function decompress(response, callback) {
  const encoding = response.headers["content-encoding"];
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => {
    const buffer = Buffer.concat(chunks);
    if (encoding === "gzip") {
      zlib.gunzip(buffer, (err, result) => callback(err, result));
    } else if (encoding === "deflate") {
      zlib.inflate(buffer, (err, result) => callback(err, result));
    } else if (encoding === "br") {
      zlib.brotliDecompress(buffer, (err, result) => callback(err, result));
    } else {
      callback(null, buffer);
    }
  });
}

const server = http.createServer((req, res) => {
  const parsedReq = url.parse(req.url, true);

  if (parsedReq.pathname === "/" && !parsedReq.query.url) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Web Proxy</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d0d1a;
      color: #e0e0e0;
      font-family: 'Courier New', monospace;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 32px;
      padding: 24px;
    }
    .logo { font-size: 48px; letter-spacing: -2px; color: #7c6af7; }
    h1 { font-size: 22px; font-weight: 400; color: #a0a0b0; letter-spacing: 2px; }
    .box { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 12px; }
    input {
      width: 100%;
      padding: 14px 18px;
      background: #1a1a2e;
      border: 1px solid #2e2e4e;
      border-radius: 8px;
      color: #e0e0e0;
      font-family: monospace;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #7c6af7; }
    button {
      padding: 14px;
      background: #7c6af7;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 15px;
      font-family: monospace;
      cursor: pointer;
      letter-spacing: 1px;
      transition: background 0.2s;
    }
    button:hover { background: #9a8bff; }
    .note { font-size: 12px; color: #555570; text-align: center; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="logo">⬡</div>
  <h1>WEB PROXY</h1>
  <div class="box">
    <input type="text" id="urlInput" placeholder="https://example.com" />
    <button onclick="go()">BROWSE</button>
  </div>
  <p class="note">Enter a full URL including https:// to browse through the proxy.</p>
  <script>
    document.getElementById('urlInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') go();
    });
    function go() {
      let val = document.getElementById('urlInput').value.trim();
      if (!val) return;
      if (!/^https?:\\/\\//i.test(val)) val = 'https://' + val;
      window.location.href = '/proxy?url=' + encodeURIComponent(val);
    }
  </script>
</body>
</html>`);
    return;
  }

  if (parsedReq.pathname === "/proxy" && parsedReq.query.url) {
    const targetUrl = decodeURIComponent(parsedReq.query.url);
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid URL");
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const proxyBase = `http://${req.headers.host}/proxy`;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WebProxy/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Host: parsed.hostname,
      },
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      const headers = { ...proxyRes.headers };
      delete headers["content-security-policy"];
      delete headers["x-frame-options"];
      delete headers["content-encoding"];

      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
        const location = proxyRes.headers["location"];
        if (location) {
          const redirectUrl = location.startsWith("http")
            ? location
            : parsed.origin + location;
          res.writeHead(302, { Location: `/proxy?url=${encodeURIComponent(redirectUrl)}` });
          res.end();
          return;
        }
      }

      if (isHtml) {
        decompress(proxyRes, (err, buffer) => {
          if (err) { res.writeHead(500); res.end("Decompression error"); return; }
          const rewritten = rewriteHtml(buffer.toString("utf-8"), parsed.origin, proxyBase);
          headers["content-type"] = "text/html; charset=utf-8";
          headers["content-length"] = Buffer.byteLength(rewritten);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(rewritten);
        });
      } else {
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:monospace;background:#0d0d1a;color:#f87171;padding:40px;">
        <h2>Proxy Error</h2><p>${err.message}</p>
        <a href="/" style="color:#7c6af7;">← Back</a>
      </body></html>`);
    });

    proxyReq.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n⬡  Proxy running at http://localhost:${PORT}\n`);
});
