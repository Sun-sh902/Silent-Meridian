/* ============================================================
   tools/serve.mjs — 本地开发服务器（npm start）
   ------------------------------------------------------------
   用法： node tools/serve.mjs [--port 8123]

   index.html 与 src/*.js 是 ES module，file:// 下会被 CORS 拦掉整张模块图，
   所以开发时必须用 HTTP 打开。这里复用测试骨架里的静态服务，不新增依赖。
   ============================================================ */
import { startStaticServer } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const port = Number(argOf('--port', process.env.PORT || '8123'));

const { url, close } = await startStaticServer({ port });

console.log('');
console.log('  寂静子午线 · 本地开发服务器');
console.log('  ' + url);
console.log('');
console.log('  改动 src/ 后刷新页面即可（浏览器不走缓存的话）。');
console.log('  要更新 file:// 单文件版： node build.mjs');
console.log('  Ctrl+C 退出。');
console.log('');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await close();
    process.exit(0);
  });
}
