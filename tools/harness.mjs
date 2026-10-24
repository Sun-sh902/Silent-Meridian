/* ============================================================
   harness.mjs - shared test harness
   ------------------------------------------------------------
   Problems it solves:
     1) Chrome path is no longer hard-coded: CHROME_PATH env var first, then auto-detection;
        when nothing is found, a clear message and exit code 2 instead of a stack trace.
     2) uncaught page errors / console.error always count as failures and affect the exit code,
        so "the page is spewing TypeErrors but the tests are all green" can't happen.
     3) one results printer, one teardown (close browser, close servers, exit code).
   ============================================================ */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------- Locate Chrome ---------------- */
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
  console.error('[harness] No usable Chrome / Chromium executable found.');
  console.error('  Set it with the CHROME_PATH environment variable, e.g.:');
  console.error('    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test');
  console.error('  Paths tried:');
  for (const p of CHROME_CANDIDATES) console.error('    - ' + p);
  console.error('');
  process.exit(2);
}

/* ---------------- Static server ---------------- */
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
        console.error('[harness] Port ' + port + ' is in use — usually a server left over from a test run that crashed.');
        console.error('  Clean up: lsof -ti:' + port + ' | xargs kill');
        console.error('');
        process.exit(2);
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  process.on('exit', () => { try { server.close(); } catch (e) { /* already closed */ } });
  return {
    server,
    url: 'http://127.0.0.1:' + port + '/',
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ---------------- Test suite ---------------- */
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

  /* New page with error collection attached
     ------------------------------------------------------------
     pointerLock is off by default. Why (measured, not guessed):
       · Chrome 132 removed old headless; headless:'shell' with an explicit executablePath
         pointing at full Chrome degrades to new headless (--headless), and new headless
         really grants pointer lock.
       · On macOS Chromium hides and warps the system cursor when granting lock. The game's deploy()
         requests lock unconditionally (game.js:335), so every suite was dragging the user's real mouse pointer around.
       Isolation: an injected script turns requestPointerLock into a rejected promise.
       The game already .catch(() => {})es it (game.js requestLock), so it never becomes a page error.
       Suites that genuinely test locking (click-test) pass { pointerLock: true } explicitly. */
  async newPage(opts = {}) {
    const page = await this.browser.newPage();
    this.pages.push(page);
    if (opts.pointerLock !== true) {
      await page.evaluateOnNewDocument(() => {
        const deny = () => Promise.reject(new Error('pointer lock disabled in tests'));
        Element.prototype.requestPointerLock = deny;
        Document.prototype.exitPointerLock = function () {};
      });
    }
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

  /* informational only, not counted as a failure */
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
      console.log('Page errors: ' + this.pageErrors.length + ' (counted as failures):');
      this.pageErrors.slice(0, 8).forEach((e) => console.log('   ! ' + e));
      if (this.pageErrors.length > 8) console.log('   … ' + (this.pageErrors.length - 8) + ' more');
    } else {
      console.log('Page errors: none');
    }
    const total = this.results.filter((r) => !r.info).length;
    console.log('Assertions ' + (total - this.checksFailed) + '/' + total + ' passed' +
      (this.pageErrors.length ? ', page errors ' + this.pageErrors.length : ''));
    console.log(this.failures ? '[RESULT] FAIL' : '[RESULT] PASS');
    /* release pointer lock before closing pages: closing while locked can leave the system cursor hidden */
    for (const p of this.pages) {
      try { await p.evaluate(() => document.exitPointerLock && document.exitPointerLock()); } catch (e) { /* page already closed */ }
      try { await p.close(); } catch (e) { /* already closed */ }
    }
    if (this.browser) { try { await this.browser.close(); } catch (e) { /* already closed */ } }
    for (const s of this.servers) { try { await s.close(); } catch (e) { /* already closed */ } }
    process.exit(this.failures ? 1 : 0);
  }
}
