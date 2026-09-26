/* ============================================================
   build.mjs — 打包为单文件 HTML（可直接双击运行，无需服务器）
   用法： node build.mjs
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

const esbuild = join(root, 'node_modules', '.bin', 'esbuild');
const bundlePath = join(dist, 'silent-meridian.js');

// ---- 版本一致性校验：index.html 里 ui.css?v= 与 bootstrap 的 V 必须一致 ----
const srcHtml = readFileSync(join(root, 'index.html'), 'utf8');
const cssV = (srcHtml.match(/ui\.css\?v=([\w.]+)/) || [])[1];
const jsV = (srcHtml.match(/var V = '([\w.]+)'/) || [])[1];
if (!cssV || !jsV || cssV !== jsV) {
  console.error(`✗ 版本号不一致：ui.css?v=${cssV} / bootstrap V=${jsV}。请先统一再打包。`);
  process.exit(1);
}
console.log(`· 版本 v${jsV} · 打包经典脚本（file:// 可加载）…`);
execFileSync(esbuild, [
  join(root, 'src', 'main.js'),
  '--bundle',
  '--format=iife',
  '--target=es2020',
  '--minify',
  `--outfile=${bundlePath}`,
], { stdio: 'inherit' });

console.log('· 内联 HTML …');
let html = srcHtml;
const css = readFileSync(join(root, 'styles', 'ui.css'), 'utf8');
const js = readFileSync(bundlePath, 'utf8');

if (/<\/script/i.test(js)) throw new Error('打包脚本中包含 </script，需要转义处理');

// 注意：必须用替换函数，否则脚本里的 `$&` / `$'` 会被 String.replace 当成模式解析
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, () => '');
// 单文件模式：告诉引导脚本“游戏代码已内联”，并把打包结果追加到 </body> 之前
html = html.replace('<!-- SM:BOOTSTRAP -->', () => '<script>window.__SM_INLINE=1;</script>\n<!-- SM:BOOTSTRAP -->');
html = html.replace('</body>', () => `<script>\n${js}\n</script>\n</body>`);
html = html.replace('<title>', () => `<!-- 单文件构建 v${jsV} · 全部资源内联，可直接双击打开（file:// 可用） -->\n<title>`);

const outHtml = join(dist, 'silent-meridian.html');
writeFileSync(outHtml, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✔ dist/silent-meridian.html （${kb} KB，单文件，双击即可运行）`);
console.log(`✔ dist/silent-meridian.js   （经典脚本，index.html 在 file:// 下会自动加载它）`);
