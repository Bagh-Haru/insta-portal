import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist/client');
const csp = "default-src 'none'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com";
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/upload/')) { res.writeHead(500); res.end('Browser tests must intercept API and upload calls.'); return; }
  let file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try { if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html'); }
  catch { file = path.join(root, 'index.html'); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream' };
  try { const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'Cross-Origin-Opener-Policy': 'same-origin' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(8789, '127.0.0.1', () => console.log('Creative browser test server ready.'));
