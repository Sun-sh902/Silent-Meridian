/* ============================================================
   selftest-red.mjs — proves that page errors turn a test red
   ------------------------------------------------------------
   Spawns itself as a fixture twice:
     green control: no page error → expect exit code 0
     red case: an uncaught page error is thrown → expect non-zero exit
   Returns 0 only if the red case really goes red and the green control really stays green.
   Usage: node tools/selftest-red.mjs          (as an acceptance check)
          node tools/selftest-red.mjs --fixture (internal)
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SELF = join(HERE, 'selftest-red.mjs');

if (process.argv.includes('--fixture')) {
  const { Suite } = await import('./harness.mjs');
  const inject = process.argv.includes('--inject');
  const suite = new Suite('fixture(' + (inject ? 'error injected' : 'no error') + ')');
  const server = await suite.serve({ port: 8220 });
  const browser = await suite.launch({ headless: 'shell', args: ['--no-sandbox'], defaultViewport: { width: 600, height: 400 } });
  const page = await suite.newPage();
  await page.goto(server.url, { waitUntil: 'load' });
  if (inject) {
    /* a real uncaught page error: thrown inside setTimeout, not via the evaluate channel */
    await page.evaluate(() => { setTimeout(() => { throw new Error('INJECTED_TEST_ERROR'); }, 0); });
    await new Promise((r) => setTimeout(r, 300));
  }
  /* every assertion passes — the only possible failure source is the page error */
  suite.check('placeholder assertion (always true)', true, 'verifies the exit code depends only on page errors');
  await suite.finish();
}

function runFixture(inject) {
  const args = [SELF, '--fixture'].concat(inject ? ['--inject'] : []);
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
}

const green = runFixture(false);
const red = runFixture(true);

const greenOk = green.status === 0;
const redOk = red.status !== 0;
const redSawError = /INJECTED_TEST_ERROR/.test((red.stdout || '') + (red.stderr || ''));

console.log('');
console.log('===== selftest-red =====');
for (const r of [{ name: 'green control: nothing injected ⇒ exit 0', ok: greenOk, detail: 'exit=' + green.status },
                 { name: 'red case: uncaught error injected ⇒ non-zero exit', ok: redOk, detail: 'exit=' + red.status },
                 { name: 'red case output really contains the error', ok: redSawError, detail: redSawError ? 'INJECTED_TEST_ERROR captured' : 'not present' }]) {
  console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + '  —  ' + r.detail);
}
console.log(redOk && greenOk && redSawError ? '[RESULT] PASS' : '[RESULT] FAIL');
process.exit(redOk && greenOk && redSawError ? 0 : 1);
