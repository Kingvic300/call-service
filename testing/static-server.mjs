// Minimal static file server for browser-app/ — no framework needed for
// serving a handful of static files to Playwright-driven pages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const port = Number(process.argv[2] ?? 8899);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  let filePath = req.url === '/' ? '/browser-app/index.html' : req.url;
  if (filePath.startsWith('/dist/')) filePath = `/browser-app${filePath}`;
  const resolved = path.join(ROOT, filePath);

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`browser-app static server on :${port}`);
});
