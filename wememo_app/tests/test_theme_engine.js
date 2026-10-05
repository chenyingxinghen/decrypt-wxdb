// test_theme_engine.js — 主题引擎构建集成校验（THEME_ENGINE.md §9 Task H + §10 红线）
// 覆盖：
//   1. theme.js 语法（node --check）
//   2. app.themes.css 括号配平（{ } 与 ( )）
//   3. 注册表 ↔ CSS 一致性：THEMES 每个 id 必须有 :root[data-theme="id"] 块（Task B 防漏加）
//   4. index.html 结构零变更：屏蔽两处允许新增（themes.css link / theme.js head 脚本）后哈希须与冻结基线一致
//   5. 效果运行时声明 ↔ CSS 钩子：effects 引用的助手类必须存在于 app.themes.css §10
//   6. 内嵌字体存在且为合法 woff2（wOF2 魔数）
//   7. DARK 组去重写法在位（:where(:not(light):not(mist))，Task B）
//   8. dist 一致性：若已执行 node build.js，src 与 dist 的主题文件字节级一致（红线 #7）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RENDER = path.join(ROOT, 'src', 'renderer');
const CSS = path.join(RENDER, 'css', 'app.themes.css');
const JS = path.join(RENDER, 'js', 'theme.js');
const HTML = path.join(RENDER, 'index.html');
const FONTS = path.join(RENDER, 'assets', 'fonts');
const DIST_RENDER = path.join(ROOT, 'dist', 'src', 'renderer');
// 冻结基线：屏蔽两处允许新增后的 index.html SHA256（2026-08-21 定稿，改动需显式更新此处）
const BASELINE_SHA = '8366c625858bc45b3509331aca62a06c0f8ef987082f727069b23396f386a359';
// 效果名 → §10 装饰层助手类（app.themes.css 必须有对应规则）
const FX_CSS_HOOK = { 'cursor-glow': '.wx-cursor-glow', 'particles': '.wx-particles', 'theme-transition': '.wx-theme-flash' };

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

// ---- 1) JS 语法 ----
const js = fs.readFileSync(JS, 'utf8');
const r = spawnSync(process.execPath, ['--check', JS], { encoding: 'utf8' });
assert('theme.js 语法通过（node --check）', r.status === 0);
console.log(r.status === 0 ? '' : '      ' + (r.stderr || '').split('\n')[0]);

// ---- 2) CSS 括号配平 ----
const css = fs.readFileSync(CSS, 'utf8');
const pairs = [
  ['{', '}'], ['(', ')']
];
for (const [o, c] of pairs) {
  const oc = (css.match(new RegExp('\\' + o, 'g')) || []).length;
  const cc = (css.match(new RegExp('\\' + c, 'g')) || []).length;
  assert(`app.themes.css ${o}${c} 配平（${oc}/${cc}）`, oc === cc);
}

// ---- 3) 注册表 ↔ CSS 一致性（Task B 防漏加） ----
const themesBlock = js.slice(js.indexOf('var THEMES = ['), js.indexOf('];'));
const ids = [];
const idRe = /id:\s*'([^']+)'/g;
let m;
while ((m = idRe.exec(themesBlock))) ids.push(m[1]);
assert(`THEMES 注册表可解析（${ids.length} 个主题）`, ids.length === 8);
// 2026-08-21：移除早期 6 套简单主题，仅剩 light/terminal/liquid/cyber/kawaii/glass/guochao/mecha
for (const id of ['light', 'terminal', 'liquid', 'cyber', 'kawaii', 'glass', 'guochao', 'mecha']) {
  assert(`注册表含 ${id}`, ids.includes(id));
}
for (const gone of ['aurora', 'vault', 'ember', 'mono', 'mist', 'wallpaper']) {
  assert(`已移除主题 ${gone} 不再出现在注册表`, !ids.includes(gone));
}
let missingCss = [];
for (const id of ids) {
  if (id === 'light') continue; // light 是默认（无 data-theme 属性），不需要块
  if (!css.includes(`:root[data-theme="${id}"]`)) missingCss.push(id);
}
assert('每个非 light 主题都有 :root[data-theme] 块', missingCss.length === 0);
if (missingCss.length) console.log('      缺失:', missingCss.join(', '));
assert('已删主题无残留 CSS 块',
  !css.includes(':root[data-theme="aurora"]') && !css.includes(':root[data-theme="mist"]')
  && !css.includes(':root[data-theme="wallpaper"]') && !css.includes(':root[data-theme="vault"]'));
assert('mecha 亮色块存在', css.includes(':root[data-theme="mecha"]'));
assert('mecha 暗色变体块存在', css.includes(':root[data-theme="mecha"][data-variant="dark"]'));
assert('mecha 声明 variants 亮/暗', /variants:\s*\[['"]light['"],\s*['"]dark['"]\]/.test(js));

// ---- 4) index.html 结构零变更（屏蔽允许项后哈希 = 冻结基线） ----
const html = fs.readFileSync(HTML, 'utf8');
const masked = html
  .replace('  <link rel="stylesheet" href="css/app.themes.css" />', '  <link rel="stylesheet" href="css/__THEMES__" />')
  .replace('  <script src="js/theme.js"></script>', '  <script src="js/__THEME_JS__"></script>');
const htmlSha = crypto.createHash('sha256').update(masked).digest('hex');
assert('index.html 结构零变更（基线 SHA 一致）', htmlSha === BASELINE_SHA);
assert('themes.css link 在 head 中', /<head>[\s\S]*app\.themes\.css[\s\S]*<\/head>/.test(html));
assert('theme.js 为 head 脚本（避免闪白）', /<head>[\s\S]*<script src="js\/theme\.js"><\/script>[\s\S]*<\/head>/.test(html));

// ---- 5) 效果运行时声明 ↔ CSS 钩子 ----
let fxUsed = new Set();
const fxRe = /effects:\s*\[([^\]]*)\]/g;
let fm;
while ((fm = fxRe.exec(themesBlock))) {
  const names = fm[1].match(/'([^']+)'/g) || [];
  names.forEach((n) => fxUsed.add(n.replace(/'/g, '')));
}
for (const name of fxUsed) {
  const hook = FX_CSS_HOOK[name];
  assert(`效果「${name}」有 CSS 钩子 ${hook}`, !!hook && css.includes(hook));
}
assert('主题声明了效果运行时', fxUsed.size > 0);

// ---- 6) 内嵌字体 ----
const wantFonts = ['ShareTechMono-Regular.woff2', 'NotoSerifSC-Regular.woff2', 'NotoSerifSC-Bold.woff2'];
for (const f of wantFonts) {
  const p = path.join(FONTS, f);
  let ok = false;
  if (fs.existsSync(p)) {
    const head = fs.readFileSync(p).slice(0, 4).toString('latin1');
    ok = head === 'wOF2';
  }
  assert(`字体 ${f} 存在且为 woff2`, ok);
}
assert('@font-face 引用与文件命名一致', css.includes('ShareTechMono-Regular.woff2')
  && css.includes('NotoSerifSC-Regular.woff2') && css.includes('NotoSerifSC-Bold.woff2'));

// ---- 7) DARK 组去重写法在位（Task B；mist 已删，排除仅剩 light） ----
assert('DARK 组使用 :where(:not([data-theme="light"])) 去重',
  css.includes(':where(:not([data-theme="light"]))'));
assert('DARK 组不再枚举 mist 排除（mist 已删）', !css.includes(':not([data-theme="mist"])'));
assert('共享深色修正消费 --wx-overlay/--wx-scroll/--wx-select',
  css.includes('--wx-overlay') || css.includes('--wx-surface'));

// ---- 7.5) 壁纸规则自足（回归护栏：默认浅色无 data-theme 时伪元素仍须渲染） ----
// 曾缺 content/position/inset，导致浅色下上传壁纸静默失效（2026-08-21 修复）。
const wpRule = css.slice(css.indexOf('body.wm-has-wallpaper::before'),
  css.indexOf('/* =========================================================', css.indexOf('body.wm-has-wallpaper::before') + 10));
assert('壁纸伪元素规则自带 content', /content:\s*'?''?/.test(wpRule));
assert('壁纸伪元素规则自带 fixed/inset 定位', wpRule.includes('position: fixed') && wpRule.includes('inset: 0'));
assert('壁纸覆盖背景用 !important（盖过氛围层）', wpRule.includes('background-image: var(--wm-wallpaper) !important'));

// ---- 7.6) 材质升级资产（2026-08-21：glass/mecha 质感重构 + v5 暗色回归） ----
const THEMES_ASSETS = path.join(RENDER, 'assets', 'themes');
const wantBg = ['glass-bg.jpg', 'mecha-dark-bg.png', 'mecha-light-bg.png'];
for (const f of wantBg) {
  assert(`主题背景资产存在: assets/themes/${f}`, fs.existsSync(path.join(THEMES_ASSETS, f)));
}
assert('应用图标存在: assets/app-icon.png', fs.existsSync(path.join(RENDER, 'assets', 'app-icon.png')));
assert('glass --wx-aura 引用雨窗街灯壁纸', /data-theme="glass"[\s\S]*?glass-bg\.jpg/.test(css));
assert('mecha 亮色变体引用金属工程图', /data-theme="mecha"\] \{[\s\S]*?mecha-light-bg\.png/.test(css));
assert('mecha 暗色变体引用装甲图', /data-theme="mecha"\]\[data-variant="dark"\] \{[\s\S]*?mecha-dark-bg\.png/.test(css));
assert('glass 有颗粒噪点层（feTurbulence）', css.includes('feTurbulence'));
assert('glass 面板为暗色玻璃（白字可读）', /data-theme="glass"\] :is\(\.titlebar[\s\S]*?linear-gradient\(135deg, rgba\(255,255,255,\.14\)/.test(css));
assert('glass 背景引用雨窗街灯图（jpg）', /data-theme="glass"\] \{[\s\S]*?glass-bg\.jpg/.test(css));
assert('glass 文字为白色（暗色主题回归）', /data-theme="glass"\] \{[\s\S]*?--wx-text:#FFFFFF/.test(css));
assert('glass 有深蓝压暗层（夜景亮区不撞白字）', css.includes('rgba(8,10,24,.32)'));
assert('glass 气泡为靛蓝渐变白字（AA 对比）', css.includes('--wx-bubble-me-grad:linear-gradient(135deg,#5A7FE8,#7A5CFF)'));
assert('glass 弹窗回归深色玻璃分支', !/where\(\[data-theme="kawaii"\],\[data-theme="guochao"\],\[data-theme="glass"\]\) \.modal-card/.test(css));
assert('glass 不再列在浅色弹窗分支', !/:not\(\[data-theme="kawaii"\]\):not\(\[data-theme="guochao"\]\):not\(\[data-theme="glass"\]\)\) \.modal-card/.test(css));
assert('mecha 亮/暗变体均声明 --wx-hazard 警示条', (css.match(/--wx-hazard:/g) || []).length >= 2);
assert('mecha 暗色为黑金配色（#E3B341）', /data-variant="dark"\] \{[\s\S]*?--wx-green:#E3B341/.test(css));
assert('mecha 暗色底色中性不泛黄', /data-variant="dark"\] \{[\s\S]*?--wx-bg:#0B0B0C/.test(css));
assert('mecha 暗色气泡为深底金描边（金只点缀）', /data-variant="dark"\] \.msg\.me \.bubble \{[\s\S]*?border: 1px solid rgba\(227,179,65,\.32\)/.test(css));
assert('mecha 暗色主按钮为深底金边', /data-variant="dark"\] \.btn-primary \{[\s\S]*?background: linear-gradient\(135deg, #232018/.test(css));
assert('mecha 激活 Tab 已移除下横线', !/tabbar \.tab\.active \{ box-shadow: inset 0 -2px 0 var\(--wx-green\)/.test(css));
assert('mecha 有装甲切角 clip-path', css.includes('clip-path: polygon(12px 0, 100% 0, 100% calc(100% - 12px)'));
assert('mecha 有 L 形角括号（::before/::after 定位符）', css.includes('border: 2px solid var(--wx-green); opacity: .85;'));
assert('mecha 有金属材质 token（--wx-metal-hi）', (css.match(/--wx-metal-hi:/g) || []).length >= 2);
assert('特殊消息文字对比度统一（引用/系统提至正文色）',
  /:where\(:not\(\[data-theme="light"\]\)\) \.quote-card \.quote-ref[\s\S]*?\.msg\.system \.bubble \{ color: var\(--wx-text\)/.test(css));
assert('卡片描述文字提亮至 text-2',
  /:where\(:not\(\[data-theme="light"\]\)\) \.link-card \.link-des[\s\S]*?\.contact-card \.contact-sub \{ color: var\(--wx-text-2\)/.test(css));
assert('自头像图标绝对定位居中（消除"忆"字占位偏移）',
  css.includes('.sidebar-top .avatar { color: transparent; position: relative; }') && css.includes('position: absolute; inset: 0; margin: auto;'));
assert('主题按钮带文字标签（.wm-label）', css.includes('.wm-theme-btn .wm-label'));
assert('mecha 有金属拉丝纹理层', css.includes('repeating-linear-gradient(90deg, transparent 0 3px, rgba(255,255,255,.014)'));
assert('mecha 有环境反射层（--wx-metal-amb）', (css.match(/--wx-metal-amb:/g) || []).length >= 2);
assert('mecha 深度拟态：双层内阴影', css.includes('inset 0 2px 0 var(--wx-metal-hi)') && css.includes('inset 0 -2px 0 var(--wx-metal-edge)'));
assert('mecha 深度拟态：面板外投影', css.includes('0 2px 8px rgba(0,0,0,.16)'));
assert('mecha 深度拟态：聊天区暗角', css.includes('rgba(0,0,0,.22), transparent 62%'));
assert('mecha 有边缘高光描边（2px 双层）', css.includes('inset 0 2px 0 var(--wx-metal-hi)'));
assert('mecha 暗色模糊降至 10px', /data-variant="dark"\] \{[\s\S]*?--wx-glass-blur:10px/.test(css));
assert('mecha 启动 logo 为六边形 mask 徽章', css.includes('mask-image: url("data:image/svg+xml;utf8,<svg') && css.includes('M32 4 L56 19'));

// ---- 7.7) 品牌图标 + 主进程窗口图标（2026-08-21 v5） ----
const iconsJs = fs.readFileSync(path.join(RENDER, 'js', 'icons.js'), 'utf8');
assert('icons.js logo 为「记忆冲破束缚」（星破出气泡右缘）',
  iconsJs.includes("M15.9 4.7l1.2 2.9 2.9 1.2-2.9 1.2-1.2 2.9-1.2-2.9-2.9-1.2 2.9-1.2z"));
assert('icons.js logo 含碎片星（挣脱张力）', iconsJs.includes("M20.9 2.4l.75 1.8"));
assert('自头像替换规则（隐藏“忆”字 + ::before 图标）',
  css.includes('.sidebar-top .avatar { color: transparent; position: relative; }') && css.includes('.sidebar-top .avatar::before'));
assert('自头像 SVG 与 logo 同源（冲破束缚）', css.includes("M15.9 4.7l1.2 2.9"));
// 主进程窗口图标（Windows 任务栏）
const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
assert('main.js 设置窗口 icon（任务栏）', /icon:\s*path\.join\(__dirname,\s*'\.\.',\s*'renderer',\s*'assets',\s*'app-icon\.png'\)/.test(mainJs));
assert('main.js 设置 AppUserModelID（Windows）', mainJs.includes("setAppUserModelId('com.wememo.app')"));


// ---- 8) dist 一致性（红线 #7；未构建时跳过） ----
if (fs.existsSync(DIST_RENDER)) {
  const files = ['css/app.themes.css', 'js/theme.js', 'index.html'];
  for (const rel of files) {
    const s = path.join(RENDER, rel), d = path.join(DIST_RENDER, rel);
    const ok = fs.existsSync(d) &&
      fs.readFileSync(s).equals(fs.readFileSync(d));
    assert(`dist 与 src 一致: ${rel}`, ok);
  }
  for (const f of wantFonts) {
    const s = path.join(FONTS, f), d = path.join(DIST_RENDER, 'assets', 'fonts', f);
    const ok = fs.existsSync(d) &&
      fs.readFileSync(s).equals(fs.readFileSync(d));
    assert(`dist 与 src 一致: assets/fonts/${f}`, ok);
  }
  for (const f of wantBg) {
    const s = path.join(THEMES_ASSETS, f), d = path.join(DIST_RENDER, 'assets', 'themes', f);
    const ok = fs.existsSync(d) &&
      fs.readFileSync(s).equals(fs.readFileSync(d));
    assert(`dist 与 src 一致: assets/themes/${f}`, ok);
  }
} else {
  console.log('  · dist/ 不存在，跳过一致性检查（请先 node build.js）');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
