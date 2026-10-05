// test_theme_runtime_smoke.js — 主题引擎运行时冒烟测试（DOM 桩环境，测的即上线代码）
// 覆盖（THEME_ENGINE.md §9 Task C/I/G 验收）：
//   1. boot 默认 light；currentTheme() 返回正确 id
//   2. applyTheme 设置 data-theme 且 themechange 恰好派发一次（detail={id,wallpaper}）
//   3. 效果运行时：cyber 声明 3 个效果 → #wx-deco-layer 挂 3 个节点、mousemove 监听注册；
//      光标移动写入 --wx-cx/--wx-cy；切回 light 后全部 destroy（节点清空、监听移除，无残留）
//   4. reduced-motion 门控：效果一律不挂载（不注册监听、不建节点）
//   5. 壁纸：超限 dataURL 不写 localStorage（仅本次会话）+ 提示元素 .show；正常图写持久化；none 清除
//   6. resetTheme() 回 light 且清壁纸
'use strict';

// ---------- 最小 DOM 桩 ----------
const events = [];
const docListeners = {};
const winListeners = {};
let reduced = false;

// 可跟踪的 classList（用于断言 body.wm-has-wallpaper / 提示 .show）
function trackedClassList() {
  const s = { _set: {}, add(c) { s._set[c] = 1; }, remove(c) { delete s._set[c]; }, toggle(c, on) { if (on === undefined ? !s._set[c] : on) s._set[c] = 1; else delete s._set[c]; }, has(c) { return !!s._set[c]; } };
  return s;
}
function makeEl() {
  return {
    className: '', id: '', innerHTML: '', textContent: '', title: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: trackedClassList(),
    parentNode: null, children: [],
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    clientWidth: 800, clientHeight: 600,
    getContext() { return { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, globalAlpha: 1, fillStyle: '' }; }
  };
}
const root = makeEl();
root.classList = { add() {}, remove() {} };
root.style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
root.attrs = {};
root.getAttribute = (k) => (k in root.attrs ? root.attrs[k] : null);
root.setAttribute = (k, v) => { root.attrs[k] = v; };
root.removeAttribute = (k) => { delete root.attrs[k]; };

const body = makeEl();
const note = makeEl();
let ls = {};

globalThis.document = {
  readyState: 'loading',
  documentElement: root,
  body,
  createElement: (tag) => (tag === 'canvas' ? makeEl() : makeEl()),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'wmWpNote' ? note : null),
  addEventListener: (name, cb) => { docListeners[name] = cb; },
  removeEventListener: (name) => { delete docListeners[name]; },
  dispatchEvent: (ev) => { events.push(ev); return true; }
};
globalThis.window = {
  matchMedia: () => ({ matches: reduced }),
  devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
  addEventListener: (name, cb) => { winListeners[name] = cb; },
  removeEventListener: (name) => { delete winListeners[name]; }
};
globalThis.location = { search: '' };
globalThis.localStorage = {
  getItem: (k) => (k in ls ? ls[k] : null),
  setItem: (k, v) => { ls[k] = String(v); },
  removeItem: (k) => { delete ls[k]; }
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => 'rgba(0,0,0,.5)' });
globalThis.requestAnimationFrame = () => 0;   // 不进入 rAF 循环
globalThis.cancelAnimationFrame = () => {};

// 加载被测代码（IIFE 立即执行 boot）
require('../src/renderer/js/theme.js');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

// ---- 1) 默认与 API ----
assert('boot 默认 light', window.currentTheme() === 'light');
assert('currentTheme 返回当前 id', (window.applyTheme('cyber'), window.currentTheme() === 'cyber') && (window.applyTheme('light'), true));
assert('未知 id 回退 light', (window.applyTheme('nope'), window.currentTheme() === 'light'));

// ---- 2) themechange 恰好一次 + data-theme ----
const before = events.length;
window.applyTheme('cyber', false);
assert('applyTheme 设置 data-theme=cyber', root.attrs['data-theme'] === 'cyber');
const fired = events.slice(before);
assert('themechange 恰好派发一次', fired.length === 1);
assert('detail 含 id/wallpaper', fired[0].detail && fired[0].detail.id === 'cyber' && 'wallpaper' in fired[0].detail);

// ---- 2.5) 亮暗变体（mecha）----
window.applyTheme('mecha', false);
assert('mecha 默认变体为 dark', root.attrs['data-variant'] === 'dark');
assert('mecha 挂载效果运行时', decoLayer() && decoLayer().children.length === 3);
const vBefore = events.length;
window.applyVariant('light', true);
assert('applyVariant 设置 data-variant=light', root.attrs['data-variant'] === 'light');
assert('变体持久化到 localStorage', localStorage.getItem('wememo-variant') === 'light');
assert('切变体派发 themechange（detail.variant）', events.length === vBefore + 1
  && events[events.length - 1].detail.variant === 'light');
assert('变体不重挂效果（节点数不变）', decoLayer().children.length === 3);
window.applyTheme('cyber', false);
assert('无 variants 主题移除 data-variant', root.attrs['data-variant'] === undefined || root.attrs['data-variant'] === null);
window.applyTheme('mecha', false);
assert('切回 mecha 恢复已存变体 light', root.attrs['data-variant'] === 'light');
window.applyTheme('light', false);
assert('light 无 data-variant', root.attrs['data-variant'] === undefined || root.attrs['data-variant'] === null);

// ---- 3) 效果运行时挂载/卸载 ----
function decoLayer() { return body.children.find((c) => c.className === 'wx-deco-layer'); }
window.applyTheme('cyber', false); // 2.5 节结束时在 light，先切回 cyber
assert('#wx-deco-layer 已挂载且含 3 个效果节点', !!decoLayer() && decoLayer().children.length === 3);
assert('cyber 挂载了 mousemove 监听', typeof docListeners.mousemove === 'function');
docListeners.mousemove({ clientX: 100, clientY: 200 });
assert('光标坐标写入 --wx-cx/--wx-cy', root.style.props['--wx-cx'] === '100px' && root.style.props['--wx-cy'] === '200px');
window.applyTheme('light', false);
assert('切回 light 后装饰层节点清空', decoLayer().children.length === 0);
assert('mousemove 监听已移除（无残留）', typeof docListeners.mousemove === 'undefined');

// ---- 4) reduced-motion 门控 ----
reduced = true;
window.applyTheme('cyber', false);
assert('reduced-motion 下不挂任何效果节点', decoLayer().children.length === 0);
assert('reduced-motion 下不注册 mousemove 监听', typeof docListeners.mousemove === 'undefined');
reduced = false;
window.applyTheme('light', false);

// ---- 5) 壁纸体积门控与持久化 ----
const big = 'url(data:image/png;base64,' + 'A'.repeat(3000000) + ')';
window.setWallpaper(big, true);
assert('超限壁纸本次会话生效（写入 --wm-wallpaper）', root.style.props['--wm-wallpaper'] === big);
assert('超限壁纸不写 localStorage', localStorage.getItem('wememo-wallpaper') === null);
assert('超限时提示 .show', note.classList.has('show'));
const small = 'url(data:image/png;base64,QUJDRA==)';
window.setWallpaper(small, true);
assert('正常壁纸写入 localStorage', localStorage.getItem('wememo-wallpaper') === small);
assert('正常时提示隐藏', !note.classList.has('show'));
assert('body 标记 wm-has-wallpaper', body.classList.has('wm-has-wallpaper'));

// ---- 5.5) 壁纸微调（模糊 / 亮度） ----
window.setWallpaperBlur(12, true);
assert('壁纸模糊写入 --wm-wp-blur', root.style.props['--wm-wp-blur'] === '12px');
assert('壁纸模糊持久化', localStorage.getItem('wememo-wp-blur') === '12');
assert('壁纸模糊越界被钳制', (window.setWallpaperBlur(99, false), root.style.props['--wm-wp-blur'] === '30px'));
window.setWallpaperBrightness(1.4, true);
assert('壁纸亮度写入 --wm-wp-brightness', root.style.props['--wm-wp-brightness'] === '1.4');
assert('壁纸亮度持久化', localStorage.getItem('wememo-wp-brightness') === '1.4');
assert('壁纸亮度下限钳制', (window.setWallpaperBrightness(0.05, false), root.style.props['--wm-wp-brightness'] === '0.4'));

// ---- 6) resetTheme ----
window.applyTheme('cyber', false);
window.applyVariant('dark', true);
window.setWallpaper(small, true);
window.setWallpaperBlur(8, true);
window.setWallpaperBrightness(1.3, true);
window.resetTheme();
assert('resetTheme 回 light', window.currentTheme() === 'light');
assert('resetTheme 清壁纸与持久化', root.style.props['--wm-wallpaper'] === undefined
  && localStorage.getItem('wememo-wallpaper') === null
  && !body.classList.has('wm-has-wallpaper'));
assert('resetTheme 清壁纸模糊/亮度', root.style.props['--wm-wp-blur'] === undefined
  && localStorage.getItem('wememo-wp-blur') === null
  && root.style.props['--wm-wp-brightness'] === undefined
  && localStorage.getItem('wememo-wp-brightness') === null);
assert('resetTheme 持久化主题为 light', localStorage.getItem('wememo-theme') === 'light');
assert('resetTheme 清变体持久化', localStorage.getItem('wememo-variant') === null);
assert('resetTheme 移除 data-variant', root.attrs['data-variant'] === undefined || root.attrs['data-variant'] === null);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
