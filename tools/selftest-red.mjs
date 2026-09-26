/* ============================================================
   selftest-red.mjs — 证明「页面异常会让测试变红」
   ------------------------------------------------------------
   本脚本 spawn 自身作为 fixture 跑两次：
     绿对照：页面无异常 → 期望退出码 0
     红用例：页面上抛一个未捕获异常 → 期望退出码非 0
   只有红用例真的变红、且绿对照真的为绿，本脚本才返回 0。
   用法： node tools/selftest-red.mjs          （作为验收项）
          node tools/selftest-red.mjs --fixture （内部使用）
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
  const suite = new Suite('fixture(' + (inject ? '注入异常' : '无异常') + ')');
  const server = await suite.serve({ port: 8220 });
  const browser = await suite.launch({ headless: 'shell', args: ['--no-sandbox'], defaultViewport: { width: 600, height: 400 } });
  const page = await suite.newPage();
  await page.goto(server.url, { waitUntil: 'load' });
  if (inject) {
    /* 真正的「页面未捕获异常」：setTimeout 里抛错，不经过 evaluate 通道 */
    await page.evaluate(() => { setTimeout(() => { throw new Error('INJECTED_TEST_ERROR'); }, 0); });
    await new Promise((r) => setTimeout(r, 300));
  }
  /* 断言全部通过 —— 唯一的失败来源只能是页面异常 */
  suite.check('占位断言（恒真）', true, '用来验证退出码只由页面异常决定');
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
for (const r of [{ name: '绿对照：无注入 ⇒ 退出 0', ok: greenOk, detail: 'exit=' + green.status },
                 { name: '红用例：注入未捕获异常 ⇒ 退出非 0', ok: redOk, detail: 'exit=' + red.status },
                 { name: '红用例输出中确实出现异常内容', ok: redSawError, detail: redSawError ? '已捕获 INJECTED_TEST_ERROR' : '未出现' }]) {
  console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + '  —  ' + r.detail);
}
console.log(redOk && greenOk && redSawError ? '[RESULT] PASS' : '[RESULT] FAIL');
process.exit(redOk && greenOk && redSawError ? 0 : 1);
