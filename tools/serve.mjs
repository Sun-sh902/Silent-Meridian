/* ============================================================
   tools/serve.mjs — local development server (npm start)
   ------------------------------------------------------------
   Usage: node tools/serve.mjs [--port 8123]

   index.html and src/*.js are ES modules; under file://, CORS blocks the entire module graph,
   so you must open the game over HTTP during development.

   ⚠️ This file **deliberately does not import harness.mjs**: harness imports puppeteer-core at the top level,
   and after a clone you often have not run npm install yet — the "clone and start serving" path must stay zero-dependency.
   So this file uses only Node built-ins.
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const port = Number(argOf('--port', process.env.PORT || '8123'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    // Directory traversal guard: the resolved path must remain inside the repository
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end('403 forbidden');
      return;
    }
    if (!existsSync(file) || !(await stat(file)).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found: ' + path);
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',   // changes must be visible immediately during development
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Try another: npm start -- --port 8124\n`);
    process.exit(2);
  }
  throw err;
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  THE SILENT MERIDIAN · local development server');
  console.log(`  http://127.0.0.1:${port}/`);
  console.log('');
  console.log('  After editing src/, just refresh the page.');
  console.log('  To update the file:// single-file build: node build.mjs');
  console.log('  Ctrl+C to quit.');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
