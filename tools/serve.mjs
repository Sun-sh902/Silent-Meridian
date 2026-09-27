/* ============================================================
   tools/serve.mjs — 本地开发服务器（npm start）
   ------------------------------------------------------------
   用法： node tools/serve.mjs [--port 8123]

   index.html 与 src/*.js 是 ES module，file:// 下会被 CORS 拦掉整张模块图，
   所以开发时必须用 HTTP 打开。

   ⚠️ 这个文件**刻意不 import harness.mjs**：harness 顶层 import puppeteer-core，
   而 clone 之后往往还没跑 npm install ——「clone 下来就能起服务」这条路径必须零依赖。
   所以这里只用 node 内置模块。
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
    // 目录穿越防护：解析后的路径必须仍在仓库内
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
      'cache-control': 'no-cache',   // 开发时要能立刻看到改动
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${port} 已被占用。换一个： npm start -- --port 8124\n`);
    process.exit(2);
  }
  throw err;
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  寂静子午线 · 本地开发服务器');
  console.log(`  http://127.0.0.1:${port}/`);
  console.log('');
  console.log('  改动 src/ 后刷新页面即可。');
  console.log('  要更新 file:// 单文件版： node build.mjs');
  console.log('  Ctrl+C 退出。');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
