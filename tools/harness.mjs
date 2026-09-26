/* ============================================================
   harness.mjs - 共用测试骨架
   ------------------------------------------------------------
   解决的问题：
     1) Chrome 路径不再硬编码：CHROME_PATH 环境变量优先，其次自动探测；
        全部找不到时给出明确提示并以退出码 2 结束，而不是抛栈。
     2) 页面未捕获异常 / console.error 一律计入失败并影响退出码，
        避免「页面在刷 TypeError 而测试照样全绿」。
     3) 统一 results 打印、统一收尾（关浏览器、关服务、退出码）。
   ============================================================ */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------- Chrome 定位 ---------------- */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function resolveChromePath() {
  for (const p of CHROME_CANDIDATES) { if (p && existsSync(p)) return p; }
  console.error('');
  console.error('[harness] 找不到可用的 Chrome / Chromium 可执行文件。');
  console.error('  请用环境变量 CHROME_PATH 指定，例如：');
  console.error('    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test');
  console.error('  已尝试的路径：');
  for (const p of CHROME_CANDIDATES) console.error('    - ' + p);
  console.error('');
  process.exit(2);
}

/* ---------------- 静态服务 ---------------- */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};

export async function startStaticServer({ port, root = ROOT }) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = join(root, normalize(p));
      if (!existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
      res.end(await readFile(f));
    } catch (err) { res.writeHead(500); res.end(String(err)); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error('');
        console.error('[harness] 端口 ' + port + ' 已被占用 —— 通常是上一次测试异常退出后残留的服务进程。');
        console.error('  清理： lsof -ti:' + port + ' | xargs kill');
        console.error('');
        process.exit(2);
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  process.on('exit', () => { try { server.close(); } catch (e) { /* 已关闭 */ } });
  return {
    server,
    url: 'http://127.0.0.1:' + port + '/',
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ---------------- 测试套件 ---------------- */
const BENIGN_CONSOLE = [/favicon/i];

export class Suite {
  constructor(name, opts = {}) {
    this.name = name;
    this.results = [];
    this.checksFailed = 0;
    this.pageErrors = [];
    this.failOnPageError = opts.failOnPageError !== false;
    this.browser = null;
    this.servers = [];
    this.pages = [];
    process.on('unhandledRejection', (e) => {
      this.pageErrors.push('unhandledRejection: ' + (e && e.message ? e.message : String(e)));
    });
  }

  async serve(opts) { const s = await startStaticServer(opts); this.servers.push(s); return s; }

  async launch(puppeteerOpts = {}) {
    this.browser = await puppeteer.launch({
      executablePath: resolveChromePath(),
      ...puppeteerOpts,
    });
    return this.browser;
  }

  /* 新建页面并自动挂上异常收集 */
  async newPage() {
    const page = await this.browser.newPage();
    this.pages.push(page);
    page.on('pageerror', (e) => {
      this.pageErrors.push('pageerror: ' + (e && e.message ? e.message : String(e)));
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (BENIGN_CONSOLE.some((re) => re.test(t))) return;
      this.pageErrors.push('console.error: ' + t);
    });
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (BENIGN_CONSOLE.some((re) => re.test(u))) return;
      this.pageErrors.push('requestfailed: ' + u);
    });
    return page;
  }

  check(name, ok, detail) {
    if (!ok) this.checksFailed++;
    this.results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    return !!ok;
  }

  /* 仅记录信息，不计入失败 */
  info(name, detail) { this.results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), info: true }); }

  get failures() { return this.checksFailed + (this.failOnPageError ? this.pageErrors.length : 0); }

  async finish() {
    console.log('');
    console.log('===== ' + this.name + ' =====');
    for (const r of this.results) {
      const tag = r.info ? '[info] ' : (r.ok ? '[PASS] ' : '[FAIL] ');
      console.log(tag + r.name + (r.detail ? '  —  ' + r.detail : ''));
    }
    console.log('');
    if (this.pageErrors.length) {
      console.log('页面异常 ' + this.pageErrors.length + ' 条（计入失败）：');
      this.pageErrors.slice(0, 8).forEach((e) => console.log('   ! ' + e));
      if (this.pageErrors.length > 8) console.log('   … 另有 ' + (this.pageErrors.length - 8) + ' 条');
    } else {
      console.log('页面异常：无');
    }
    const total = this.results.filter((r) => !r.info).length;
    console.log('断言 ' + (total - this.checksFailed) + '/' + total + ' 通过' +
      (this.pageErrors.length ? '，页面异常 ' + this.pageErrors.length + ' 条' : ''));
    console.log(this.failures ? '[RESULT] FAIL' : '[RESULT] PASS');
    for (const p of this.pages) { try { await p.close(); } catch (e) { /* 已关闭 */ } }
    if (this.browser) { try { await this.browser.close(); } catch (e) { /* 已关闭 */ } }
    for (const s of this.servers) { try { await s.close(); } catch (e) { /* 已关闭 */ } }
    process.exit(this.failures ? 1 : 0);
  }
}
