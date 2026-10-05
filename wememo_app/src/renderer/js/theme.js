/* WeMemo 微忆 — 主题引擎 + 效果运行时 + 壁纸子系统
 * 结构 / 布局 / 业务交互一律不动。本文件属于「主题系统」层（THEME_ENGINE.md §1.1），
 * 不在冻结范围内，可正常演进。
 *
 * 入口：标题栏「主题」圆点按钮（由本脚本注入，DOM 结构不变）
 * 主题：注册表驱动，每个主题可携带配色 + 组件皮肤（圆角 / 字体 / 栅格 / 玻璃强度）
 *       风格化主题还可声明 effects:['cursor-glow','particles','theme-transition']，
 *       由引擎统一挂载/卸载（§1.5.1 效果运行时）。
 * 壁纸：面板内可选渐变预设或上传任意图片，玻璃面板实时虚化（与主题正交持久化）。
 *
 * 公共 API（window）：
 *   applyTheme(id, persist?)     设置 data-theme；未知 id 回退 light
 *   applyVariant(v, persist?)    亮/暗变体（仅声明 variants 的主题，如 mecha）；只改配色不动风格/UI
 *   setWallpaper(val, persist?)  val = url(...)/渐变/'none'；写 --wm-wallpaper + 切 body.wm-has-wallpaper
 *   currentTheme()               返回当前 id（默认 'light'）
 *   resetTheme()                 清壁纸 + 回 light
 *   registerEffect(name, factory) 注册新的效果助手（主题只声明，引擎负责生命周期）
 * 事件：
 *   document 'themechange'  detail={id, wallpaper, variant}  —— 每次换肤/切变体派发一次
 * 预览：
 *   ?theme=vault&wallpaper=url(...)  —— 直接进入对应主题/壁纸（不持久化）
 * 持久化：
 *   localStorage['wememo-theme'] / ['wememo-wallpaper'] / ['wememo-variant']
 */
(function () {
  'use strict';

  var KEY = 'wememo-theme';
  var WKEY = 'wememo-wallpaper';
  var VKEY = 'wememo-variant'; // 亮暗变体（仅对声明 variants 的主题生效，如 mecha）
  // 上传壁纸超过此体积则不写入 localStorage（仅本次会话生效），避免撑爆存储。
  var MAX_WP_BYTES = 1572864; // 1.5 MB

  // 主题注册表（引擎核心）：sw = [底色, 面板色, 强调色]，用于面板色板缩略图。
  // 风格化主题声明 effects（效果运行时）与 variants（亮暗变体，仅变配色不动风格/UI）。
  // 2026-08-21：移除早期 6 套简单主题（aurora/vault/ember/mono/mist/wallpaper），
  //             保留 light 默认 + terminal/liquid 皮肤 + 四套风格化，新增 mecha（亮暗可变）。
  var THEMES = [
    { id: 'light',    name: '微信浅色',   desc: '微信 4.0 默认风格',                sw: ['#EDEDED', '#F7F7F7', '#07C160'] },
    { id: 'terminal', name: '霓虹终端',   desc: '等宽字体 + 直角 + 扫描线',         sw: ['#0B0F0C', '#0E1410', '#39FF8B'], effects: ['theme-transition'] },
    { id: 'liquid',   name: '液态玻璃',   desc: '大圆角 + 重玻璃柔光',             sw: ['#0C0F14', '#12161D', '#7CC4FF'], effects: ['theme-transition'] },
    { id: 'cyber',    name: '赛博霓虹',   desc: '深空蓝紫 + 青/品红辉光 + 扫描线',   sw: ['#0A0E1F', '#0F1626', '#00E5FF'], effects: ['cursor-glow', 'particles', 'theme-transition'] },
    { id: 'kawaii',   name: '甜系可爱',   desc: '粉薰衣草渐变 + 大圆角胶囊',         sw: ['#FFE3F4', '#FFF6FB', '#FF5FA2'], effects: ['theme-transition'] },
    { id: 'glass',    name: '玻璃拟态',   desc: '雨窗街灯夜景 · 暗色磨砂玻璃',       sw: ['#10131F', 'rgba(18,22,42,.66)', '#7FA8FF'], effects: ['particles', 'theme-transition'] },
    { id: 'guochao',  name: '国潮复古',   desc: '宣纸米色 + 金描边 + 朱红',          sw: ['#EAE0C4', '#FBF5E9', '#C8102E'], effects: ['theme-transition'] },
    { id: 'mecha',    name: '机械机甲',   desc: '装甲金属 · 黑金点缀暗色',           sw: ['#DCE2EA', '#EFF3F8', '#00A8FF'], variants: ['light', 'dark'], effects: ['cursor-glow', 'particles', 'theme-transition'] }
  ];

  // 壁纸预设（纯 CSS 渐变，无需图片文件；用户也可上传自己的图片）
  var WALLPAPERS = [
    { id: 'none',    name: '无',       css: '' },
    { id: 'aurora',  name: '极光',     css: 'radial-gradient(1000px 700px at 20% 0%, #14463f, transparent 55%), radial-gradient(900px 600px at 90% 100%, #1b3a5e, transparent 55%), linear-gradient(135deg,#0b1020,#0d1b2a)' },
    { id: 'dusk',    name: '暮光',     css: 'radial-gradient(900px 600px at 80% 10%, #5e3a1b, transparent 55%), radial-gradient(900px 700px at 10% 100%, #1b3a5e, transparent 55%), linear-gradient(135deg,#1a1010,#0d0d1a)' },
    { id: 'space',   name: '深空',     css: 'radial-gradient(2px 2px at 20% 30%, #fff, transparent), radial-gradient(2px 2px at 70% 60%, #cfe, transparent), radial-gradient(1px 1px at 40% 82%, #fff, transparent), linear-gradient(135deg,#05060f,#0a0f1f)' },
    { id: 'moss',    name: '青绿',     css: 'radial-gradient(900px 700px at 30% 0%, #0f3b2e, transparent 55%), linear-gradient(135deg,#06140f,#0a1a14)' }
  ];

  var currentWallpaper = '';
  var currentVariant = '';     // 当前亮/暗变体（'' = 主题不支持变体）
  var booted = false;            // DOM 就绪后才挂载效果运行时
  var decoLayer = null;          // 引擎托管的装饰容器（#wx-deco-layer）
  var activeEffects = [];        // 当前已挂载的效果助手句柄 {destroy}
  var EFFECTS = {};              // 已注册的效果工厂 {name: factory(decoLayer)->handle|null}

  function isKnown(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
    return false;
  }
  function byId(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return null;
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ============ 效果运行时注册表（§1.5.1） ============
  // factory(decoLayer) -> { destroy: fn } | null
  // 约定：只读主题 token、只写 #wx-deco-layer、尊重 prefers-reduced-motion。
  function registerEffect(name, factory) {
    EFFECTS[name] = factory;
  }

  function ensureDecoLayer() {
    if (decoLayer && decoLayer.parentNode) return decoLayer;
    if (!document.body) return null;
    decoLayer = document.createElement('div');
    decoLayer.id = 'wx-deco-layer';
    decoLayer.className = 'wx-deco-layer';
    document.body.appendChild(decoLayer);
    return decoLayer;
  }

  // 卸载当前全部效果助手（切主题前清理，避免残留定时器/监听器）
  function teardownEffects() {
    for (var i = 0; i < activeEffects.length; i++) {
      try { activeEffects[i].destroy(); } catch (e) {}
    }
    activeEffects = [];
  }

  // 按主题声明的 effects 挂载对应助手（仅 DOM 就绪后；reduced-motion 下全部跳过）
  function mountEffects(id) {
    teardownEffects();
    if (!document.body || reducedMotion()) return; // 无障碍降级：不挂载任何逐帧/跟手动效
    var theme = byId(id);
    var fx = (theme && theme.effects) || [];
    var layer = ensureDecoLayer();
    if (!layer) return;
    for (var i = 0; i < fx.length; i++) {
      var f = EFFECTS[fx[i]];
      if (!f) continue;
      var handle = f(layer);
      if (handle && handle.destroy) activeEffects.push(handle);
    }
  }

  // —— 效果助手 1：光标跟随辉光（坐标写入 --wx-cx / --wx-cy，样式见 app.themes.css §10）——
  registerEffect('cursor-glow', function (layer) {
    var el = document.createElement('div');
    el.className = 'wx-cursor-glow';
    layer.appendChild(el);
    var root = document.documentElement;
    var onMove = function (e) {
      root.style.setProperty('--wx-cx', e.clientX + 'px');
      root.style.setProperty('--wx-cy', e.clientY + 'px');
    };
    document.addEventListener('mousemove', onMove);
    return {
      destroy: function () {
        document.removeEventListener('mousemove', onMove);
        root.style.removeProperty('--wx-cx');
        root.style.removeProperty('--wx-cy');
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  });

  // —— 效果助手 2：轻量粒子 / 星空（Canvas 逐帧；reduced-motion 仅画一帧静态）——
  registerEffect('particles', function (layer) {
    var canvas = document.createElement('canvas');
    canvas.className = 'wx-particles';
    layer.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = 1, parts = [], raf = 0;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth || window.innerWidth;
      H = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function seed() {
      parts = [];
      var n = Math.min(64, Math.max(18, Math.round(W * H / 26000)));
      for (var i = 0; i < n; i++) {
        parts.push({
          x: Math.random() * W, y: Math.random() * H,
          r: Math.random() * 1.8 + 0.6,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          a: Math.random() * 0.5 + 0.2
        });
      }
    }
    function glowColor() {
      var c = getComputedStyle(document.documentElement).getPropertyValue('--wx-glow').trim();
      return c || 'rgba(255,255,255,.6)';
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      var c = glowColor();
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
        if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.globalAlpha = p.a;
        ctx.fillStyle = c;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function frame() { draw(); raf = requestAnimationFrame(frame); }
    resize(); seed(); draw();
    if (reducedMotion()) return { // 静态一帧，不进入 rAF 循环
      destroy: function () { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    };
    raf = requestAnimationFrame(frame);
    var onResize = function () { resize(); seed(); };
    window.addEventListener('resize', onResize);
    return {
      destroy: function () {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  });

  // —— 效果助手 3：换肤过渡编排（一次性全屏强调色晕开；--wx-glow 取自新主题）——
  registerEffect('theme-transition', function (layer) {
    var el = document.createElement('div');
    el.className = 'wx-theme-flash';
    layer.appendChild(el);
    var t = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
    return {
      destroy: function () {
        clearTimeout(t);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  });

  // ============ 主题应用 + 亮暗变体（mecha 亮/暗只换配色，不动风格与 UI） ============
  function themeHasVariants(id) {
    var t = byId(id);
    return !!(t && t.variants && t.variants.length);
  }
  function applyTheme(id, persist) {
    if (!isKnown(id)) id = 'light';
    var root = document.documentElement;
    if (id === 'light') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', id);
    // 变体：支持 variants 的主题恢复上次亮/暗（默认 dark），其余主题移除残留属性
    if (themeHasVariants(id)) {
      var saved = '';
      try { saved = localStorage.getItem(VKEY); } catch (e) {}
      var v = (saved === 'light' || saved === 'dark') ? saved : 'dark';
      root.setAttribute('data-variant', v);
      currentVariant = v;
    } else {
      root.removeAttribute('data-variant');
      currentVariant = '';
    }
    if (persist) {
      try { localStorage.setItem(KEY, id); } catch (e) {}
    }
    // 通用换肤过渡：给 7 个 chrome 面板短促底色过渡（§10，reduced-motion 下 CSS 自动关闭）
    root.classList.add('wx-theming');
    setTimeout(function () { root.classList.remove('wx-theming'); }, 360);
    // 挂载/卸载效果助手（DOM 就绪后；head 期 boot 不挂载，留待 buildUI）
    if (document.body) mountEffects(id);
    syncActive();
    syncVariant();
    // 派发 themechange（每次换肤一次，供外部监听）
    try {
      document.dispatchEvent(new CustomEvent('themechange', {
        detail: { id: id, wallpaper: currentWallpaper, variant: currentVariant }
      }));
    } catch (e) {}
  }
  window.applyTheme = applyTheme;

  // 亮暗变体切换：仅对有 variants 的主题生效；只改配色（data-variant），不重挂效果运行时。
  function applyVariant(v, persist) {
    if (!themeHasVariants(current())) return;
    if (v !== 'light' && v !== 'dark') v = 'dark';
    var root = document.documentElement;
    root.setAttribute('data-variant', v);
    currentVariant = v;
    if (persist) {
      try { localStorage.setItem(VKEY, v); } catch (e) {}
    }
    syncVariant();
    try {
      document.dispatchEvent(new CustomEvent('themechange', {
        detail: { id: current(), wallpaper: currentWallpaper, variant: v }
      }));
    } catch (e) {}
  }
  window.applyVariant = applyVariant;
  function currentVariantOf() { return currentVariant || 'dark'; }

  // ============ 壁纸子模块（Task G，与主题正交） ============
  // 壁纸微调：模糊（px）与亮度（0.4–1.6），独立持久化，作用于 body::before 的 filter。
  var BKEY = 'wememo-wp-blur';
  var LKEY = 'wememo-wp-brightness';
  var currentWpBlur = 0;
  var currentWpBrightness = 1;

  function setWallpaperBlur(px, persist) {
    px = Math.max(0, Math.min(30, Number(px) || 0));
    currentWpBlur = px;
    document.documentElement.style.setProperty('--wm-wp-blur', px + 'px');
    if (persist !== false) {
      try { localStorage.setItem(BKEY, String(px)); } catch (e) {}
    }
  }
  window.setWallpaperBlur = setWallpaperBlur;

  function setWallpaperBrightness(v, persist) {
    v = Math.max(0.4, Math.min(1.6, Number(v) === 0 ? 1 : (Number(v) || 1)));
    currentWpBrightness = v;
    document.documentElement.style.setProperty('--wm-wp-brightness', String(v));
    if (persist !== false) {
      try { localStorage.setItem(LKEY, String(v)); } catch (e) {}
    }
  }
  window.setWallpaperBrightness = setWallpaperBrightness;

  function syncWpAdjust() {
    var blurIn = document.getElementById('wmWpBlur');
    var lightIn = document.getElementById('wmWpLight');
    if (blurIn) blurIn.value = String(currentWpBlur);
    if (lightIn) lightIn.value = String(currentWpBrightness);
  }

  var Wallpaper = {
    presets: WALLPAPERS,
    set: setWallpaper,
    get: function () { return currentWallpaper; },
    clear: function (persist) { setWallpaper('none', persist); },
    setBlur: setWallpaperBlur,
    setBrightness: setWallpaperBrightness,
    // dataURL 解码后的近似字节数（用于体积校验）
    bytesOf: function (s) {
      var m = /^data:.*;base64,/.exec(s);
      var b64 = m ? s.slice(m[0].length) : s;
      return Math.round(b64.length * 3 / 4);
    }
  };
  function setWallpaper(val, persist) {
    var root = document.documentElement, body = document.body;
    var noteEl = document.getElementById('wmWpNote');
    if (!val || val === 'none') {
      root.style.removeProperty('--wm-wallpaper');
      if (body) body.classList.remove('wm-has-wallpaper');
      currentWallpaper = '';
      if (persist) { try { localStorage.removeItem(WKEY); } catch (e) {} }
      if (noteEl) noteEl.classList.remove('show');
    } else {
      var persistOk = persist !== false;
      // 上传图片（dataURL，含 url(...) 包裹）过大时仅本次会话生效，不写 localStorage。
      // 注意调用方传的是 'url(data:image/...;base64,...)'，故用「包含 data:」而非「开头是 data:」判断。
      if (persistOk && val.indexOf('data:') !== -1 && Wallpaper.bytesOf(val) > MAX_WP_BYTES) {
        persistOk = false;
        if (noteEl) {
          noteEl.textContent = '图片较大（>' + (MAX_WP_BYTES / 1048576).toFixed(1) +
            'MB），本次会话生效，刷新后不保留。';
          noteEl.classList.add('show');
        }
      } else if (noteEl) {
        noteEl.classList.remove('show');
      }
      root.style.setProperty('--wm-wallpaper', val);
      if (body) body.classList.add('wm-has-wallpaper');
      currentWallpaper = val;
      if (persistOk) {
        try { localStorage.setItem(WKEY, val); } catch (e) { /* 写入失败则仅本次会话 */ }
      }
    }
    syncWallpaper();
  }
  window.setWallpaper = setWallpaper;

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
  window.currentTheme = current;

  function resetTheme() {
    setWallpaper('none', true);
    // 壁纸微调归零：移除属性（等价默认值），而非写 0px
    document.documentElement.style.removeProperty('--wm-wp-blur');
    document.documentElement.style.removeProperty('--wm-wp-brightness');
    currentWpBlur = 0; currentWpBrightness = 1;
    try { localStorage.removeItem(BKEY); } catch (e) {}
    try { localStorage.removeItem(LKEY); } catch (e) {}
    applyTheme('light', true);
    try { localStorage.removeItem(VKEY); } catch (e) {}
  }
  window.resetTheme = resetTheme;

  // ============ 启动（head 中执行，避免浅→暗闪白） ============
  (function boot() {
    var urlTheme = '', urlWp = '';
    try {
      var q = new URLSearchParams(location.search);
      urlTheme = q.get('theme') || '';
      urlWp = q.get('wallpaper') || '';
    } catch (e) {}
    var saved = '';
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    applyTheme(urlTheme || saved || 'light', false);
    var wp = urlWp || '';
    if (!wp) { try { wp = localStorage.getItem(WKEY); } catch (e) {} }
    if (wp) setWallpaper(wp, false);
    var savedBlur = 0, savedLight = 1;
    try { savedBlur = Number(localStorage.getItem(BKEY)) || 0; } catch (e) {}
    try { savedLight = Number(localStorage.getItem(LKEY)) || 1; } catch (e) {}
    setWallpaperBlur(savedBlur, false);
    setWallpaperBrightness(savedLight, false);
  })();

  // ============ 面板同步 ============
  function syncActive() {
    var cur = current();
    var cards = document.querySelectorAll('.wm-theme-card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var on = c.getAttribute('data-theme-id') === cur;
      c.classList.toggle('active', on);
      var tag = c.querySelector('.wm-theme-now');
      if (tag) tag.style.display = on ? '' : 'none';
    }
    var btn = document.querySelector('.wm-theme-btn');
    if (btn) {
      var t = null;
      for (var j = 0; j < THEMES.length; j++) if (THEMES[j].id === cur) t = THEMES[j];
      btn.style.setProperty('--wm-cur-name', t ? t.name : '微信浅色');
      btn.title = '主题 · 当前：' + (t ? t.name : '微信浅色');
      var dot = btn.querySelector('.wm-dot');
      if (dot) dot.style.background = t ? t.sw[2] : '#07C160';
    }
  }

  function syncWallpaper() {
    var sws = document.querySelectorAll('.wm-wp-sw');
    for (var i = 0; i < sws.length; i++) {
      var id = sws[i].getAttribute('data-wp');
      var on = (id === 'none' && !currentWallpaper) ||
               (id !== 'none' && currentWallpaper && currentWallpaper.indexOf(WALLPAPERS_BY_ID(id)) === 0);
      sws[i].classList.toggle('active', on);
    }
  }

  // 亮暗变体按钮同步（仅当前主题卡片内渲染了 .wm-variant-btn 时生效）
  function syncVariant() {
    var cur = current();
    var cards = document.querySelectorAll('.wm-theme-card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-theme-id') !== cur) continue;
      var btns = cards[i].querySelectorAll('.wm-variant-btn');
      for (var j = 0; j < btns.length; j++) {
        btns[j].classList.toggle('active', btns[j].getAttribute('data-v') === currentVariant);
      }
    }
  }

  function WALLPAPERS_BY_ID(id) {
    for (var i = 0; i < WALLPAPERS.length; i++) if (WALLPAPERS[i].id === id) return WALLPAPERS[i].css;
    return '';
  }

  function toggle() {
    var mask = document.querySelector('.wm-theme-mask');
    if (mask) mask.classList.toggle('open');
  }

  var FX_LABEL = { 'cursor-glow': '光标辉光', 'particles': '粒子', 'theme-transition': '换肤过渡' };
  var VAR_LABEL = { 'light': '亮', 'dark': '暗' };
  function fxBadge(theme) {
    if (!theme.effects || !theme.effects.length) return '';
    var labels = theme.effects.map(function (n) { return FX_LABEL[n] || n; });
    return '<span class="wm-theme-fx">' + labels.join(' · ') + '</span>';
  }
  // 亮暗变体切换控件（仅 themes 声明 variants 时渲染；点击只改配色不重挂效果）
  function variantRow(theme) {
    if (!theme.variants || !theme.variants.length) return '';
    return '<div class="wm-variant-row">' + theme.variants.map(function (v) {
      return '<span class="wm-variant-btn" data-v="' + v + '">' + (VAR_LABEL[v] || v) + '</span>';
    }).join('') + '</div>';
  }

  function buildUI() {
    var titlebar = document.querySelector('.titlebar');
    if (titlebar && !document.querySelector('.wm-theme-btn')) {
      var btn = document.createElement('div');
      btn.className = 'wm-theme-btn';
      btn.title = '主题';
      btn.innerHTML = '<span class="wm-dot"></span><span class="wm-label">主题</span>';
      var ctrls = titlebar.querySelector('.win-ctrls');
      if (ctrls) titlebar.insertBefore(btn, ctrls);
      else titlebar.appendChild(btn);
      btn.addEventListener('click', toggle);
    }

    if (!document.querySelector('.wm-theme-mask')) {
      var mask = document.createElement('div');
      mask.className = 'wm-theme-mask';
      var panel = document.createElement('div');
      panel.className = 'wm-theme-panel';
      panel.innerHTML =
        '<div class="wm-theme-head"><h3>主题与外观</h3>' +
        '<div class="wm-theme-close" title="关闭">×</div></div>' +
        '<div class="wm-theme-grid"></div>' +
        '<div class="wm-wp-title"><span>背景壁纸</span>' +
        '<span class="wm-wp-upload" id="wmWpUpload">上传图片</span></div>' +
        '<div class="wm-wp-row"></div>' +
        '<div class="wm-wp-adjust">' +
        '<label class="wm-wp-adj"><span>模糊</span><input type="range" id="wmWpBlur" min="0" max="30" step="1" value="0" /><em id="wmWpBlurV">0</em></label>' +
        '<label class="wm-wp-adj"><span>亮度</span><input type="range" id="wmWpLight" min="40" max="160" step="5" value="100" /><em id="wmWpLightV">1.0</em></label>' +
        '</div>' +
        '<div class="wm-wp-note" id="wmWpNote"></div>' +
        '<div class="wm-theme-foot"><span>实时预览 · 点击即应用</span>' +
        '<span class="wm-theme-reset">恢复默认（浅色）</span></div>';
      mask.appendChild(panel);
      document.body.appendChild(mask);

      // 主题卡片
      var grid = panel.querySelector('.wm-theme-grid');
      THEMES.forEach(function (t) {
        var card = document.createElement('div');
        card.className = 'wm-theme-card';
        card.setAttribute('data-theme-id', t.id);
        var sw = t.sw.map(function (c) {
          return '<span class="wm-theme-sw" style="background:' + c + '"></span>';
        }).join('');
        card.innerHTML =
          '<span class="wm-theme-now" style="display:none">当前</span>' +
          '<div class="wm-theme-swatches">' + sw + '</div>' +
          '<div class="wm-theme-name">' + t.name + '</div>' +
          '<div class="wm-theme-desc">' + t.desc + '</div>' +
          fxBadge(t) +
          variantRow(t);
        card.addEventListener('click', function () { applyTheme(t.id, true); });
        // 亮暗变体按钮：只切换配色，不触发卡片换主题
        var vbtns = card.querySelectorAll('.wm-variant-btn');
        for (var vb = 0; vb < vbtns.length; vb++) {
          (function (b, tid) {
            b.addEventListener('click', function (ev) {
              if (ev.stopPropagation) ev.stopPropagation();
              applyTheme(tid, true);          // 确保主题激活（含变体恢复）
              applyVariant(b.getAttribute('data-v'), true);
            });
          })(vbtns[vb], t.id);
        }
        grid.appendChild(card);
      });

      // 壁纸预设
      var wpRow = panel.querySelector('.wm-wp-row');
      WALLPAPERS.forEach(function (w) {
        var s = document.createElement('div');
        s.className = 'wm-wp-sw';
        s.setAttribute('data-wp', w.id);
        s.title = w.name;
        if (w.id === 'none') {
          s.style.background = 'repeating-linear-gradient(45deg,#2a2f37 0 6px,#23282f 6px 12px)';
        } else {
          s.style.background = w.css;
        }
        s.addEventListener('click', function () { setWallpaper(w.css || 'none', true); });
        wpRow.appendChild(s);
      });

      // 隐藏的文件输入
      var fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      panel.appendChild(fileInput);
      fileInput.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () { setWallpaper('url(' + r.result + ')', true); };
        r.readAsDataURL(f);
      });
      var uploadBtn = panel.querySelector('#wmWpUpload');
      if (uploadBtn) uploadBtn.addEventListener('click', function () { fileInput.click(); });

      // 壁纸微调滑块：模糊（px）与亮度（40%–160%）
      var blurIn = panel.querySelector('#wmWpBlur');
      var lightIn = panel.querySelector('#wmWpLight');
      var blurV = panel.querySelector('#wmWpBlurV');
      var lightV = panel.querySelector('#wmWpLightV');
      if (blurIn) blurIn.addEventListener('input', function () {
        setWallpaperBlur(Number(blurIn.value), true);
        if (blurV) blurV.textContent = blurIn.value;
      });
      if (lightIn) lightIn.addEventListener('input', function () {
        var v = Number(lightIn.value) / 100;
        setWallpaperBrightness(v, true);
        if (lightV) lightV.textContent = v.toFixed(1);
      });
      syncWpAdjust();

      panel.querySelector('.wm-theme-close').addEventListener('click', toggle);
      mask.addEventListener('click', function (e) { if (e.target === mask) toggle(); });
      panel.querySelector('.wm-theme-reset').addEventListener('click', function () {
        resetTheme();
      });

      syncWallpaper();
    }

    syncActive();
    // DOM 就绪：挂载当前主题的装饰层与效果助手（boot 期因 body 未存在而延迟到这里）
    ensureDecoLayer();
    mountEffects(current());
    booted = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();
