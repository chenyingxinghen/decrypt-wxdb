# WeMemo 主题引擎 · 效果规则库与效果运行时（Effects）

> 配套：`src/renderer/css/app.themes.css`（纯 CSS 效果库 + §10 装饰层）、`src/renderer/js/theme.js`（效果运行时）
> 契约来源：`docs/THEME_ENGINE.md` §5（效果规则库）与 §1.5.1（效果运行时）

效果分两类，边界清晰：

- **纯 CSS 效果库**（零 JS）：写在通用 `:root[data-theme]` 块内，靠 `var(--wx-*)` 自动跟随每套主题，**新增配色主题无需重写任何效果规则**。
- **引擎效果运行时**（少量 JS）：仅当效果必须依赖鼠标坐标 / Canvas 逐帧 / 多元素过渡编排时使用。主题只声明 `effects:[...]`，引擎负责挂载与清理。

---

## 一、纯 CSS 效果库（12 条）

均位于 `app.themes.css` 第 2 节（DARK 修正）与第 5 节（通用艺术效果）。共享深色修正的作用域是
`:root[data-theme]:where(:not([data-theme="light"]))`（Task B 去重写法，特异性恒为 0，
新主题**自动进入**，无需逐个枚举 id；2026-08-21 已随 mist 主题移除而简化，排除仅剩默认浅色）。

### 5.1 共享深色修正（DARK 组）

| 效果 | 作用选择器（节选） | 消费 token |
|---|---|---|
| 输入框/查找条底色 | `.search-box input` / `.find-bar input` | `--wx-surface` |
| 图表轨道/进度条 | `.bar-track` / `.ratio` / `.rank-track` / `.rank-tag` / `.col-bar`（平色，被渐变覆盖） | `--wx-track` |
| 富卡片中性底 | `.msg.me .file-card / .link-card / .mp-card / .ch-card / .fwd-card / .loc-card / .contact-card` | `--wx-overlay` |
| 图片占位/链接缩略图 | `.img-ph` / `.link-card .link-thumb` | `--wx-overlay-weak` |
| 表情退化标签 | `.wx-emo.none`（对方） / `.msg.me .wx-emo.none`（我方） | `--wx-overlay-strong` / `--wx-overlay-heavy` |
| 绿色语义标签 | `.tag.group` | `--wx-overlay-strong` + `--wx-green` |
| chip/seg 选中态 | `.chip.on` / `.seg-item.active` | `--wx-chipbg` + `--wx-green` |
| 滚动条 / 选区 | `::-webkit-scrollbar-thumb` / `::selection` | `--wx-scroll` / `--wx-scroll-hover` / `--wx-select` |
| 引用/徽标/上下文条 | `.quote-card .quote-ref` / `.c-badge` / `.ctx-bar` / `.sync-state` | `--wx-hi` / `--wx-hi2` |

> 叠加层 token（`--wx-overlay*` / `--wx-scroll*` / `--wx-select`）默认在 `:root[data-theme]` 共享块（第 0 节）给出
> **深色值**（= 改造前硬编码的白色叠加字面量，保证既有深色主题逐像素一致）；浅色 Aura 家族
> （`kawaii`/`guochao`/`mecha`亮色）在各自主题块覆盖为**黑色/深色叠加**，否则浅底上占位块/滚动条/选区隐形。

### 5.2 通用艺术效果（所有 `[data-theme]` 生效，含默认浅色）

| 效果 | 作用选择器 | 触发 token |
|---|---|---|
| 背景氛围 | `body::before`（`position:fixed; inset:0; z-index:-1`） | `--wx-aura`（Opaque 家族设 `none`） |
| 用户壁纸覆盖氛围 | `body.wm-has-wallpaper::before` | `--wm-wallpaper`（JS 运行时写 `:root.style`） |
| 面板发丝边 | `.titlebar / .tabbar / .sidebar / .chat / .chat-head / .find-bar` | `--wx-glass-line` |
| 头像光环 | `.session .ava` / `.msg .mava` / `.sidebar-top .avatar` | `--wx-ava-ring` + `--wx-glow` |
| 我的气泡 | `.msg.me .bubble` | `--wx-bubble-me-grad` / `--wx-bubble-me-text` / `--wx-glow` |
| 对方气泡 | `.msg.you .bubble` | `--wx-bubble-you-bg` / `--wx-bubble-you-text` / `--wx-glass-line` |
| 选中会话流光 | `.session.active::after`（`@keyframes wm-shimmer`） | `--wx-green` 渐变 |
| 激活 Tab 柔光 | `.tabbar .tab.active`（`filter: drop-shadow`） | `--wx-glow-soft` |
| 卡片悬浮微抬 | `.stat-card / .panel / .me-card :hover` | `--wx-glow` |
| 图表渐变 | `.bar-fill / .rank-fill / .col-bar` | `--wx-green` → `--wx-green-deep` |
| 主按钮/启动 logo 辉光 | `.btn-primary` / `.boot .logo` | `--wx-green` 渐变 + `--wx-glow` |
| 转账/红包掠光 | `.pay-card::after` + `:hover`（`@keyframes` 平移） | 语义色保持原样，仅动效 |
| 玻璃面板 | 上述 7 个 chrome 面板 + `.modal-card` + `.boot` | `--wx-glass-bg` / `--wx-glass2` / `--wx-glass-blur` |

> 玻璃仅对 Aura 家族生效：默认浅色（Opaque）`--wx-glass-blur:0px` 且 `body` 不透明，规则自然退化为实色。

---

## 二、引擎效果运行时（3 个助手）

主题在 `theme.js` 的 `THEMES` 条目里声明 `effects:['cursor-glow', ...]`；引擎在 `applyTheme` 时先 `destroy` 旧助手、
再按新主题的声明 `mount` 新助手（统一挂到引擎托管的 `#wx-deco-layer`，不进业务 DOM）。

**三约（THEME_ENGINE.md §1.5.1）**：只读主题 token、只写 `#wx-deco-layer`、尊重 `prefers-reduced-motion`。

### cursor-glow 光标跟随辉光

- 声明主题：`cyber`（赛博霓虹）、`mecha`（机械机甲）
- 行为：`document` 上挂一个 `mousemove` 监听，把 `clientX/Y` 写入 `:root` 的 `--wx-cx/--wx-cy`；样式在
  `app.themes.css` §10 的 `.wx-cursor-glow`（`radial-gradient(var(--wx-glow))` + `translate3d` 跟随）。
- 清理：切主题时移除监听、删除两个变量、移除节点。**不挡点击**（装饰层 `pointer-events:none`）。

### particles 轻量粒子 / 星空

- 声明主题：`cyber`、`glass`、`mecha`
- 行为：`#wx-deco-layer` 内建一个全屏 `<canvas class="wx-particles">`，粒子颜色取自 `--wx-glow`，数量按视口面积
  自适应（`min(64, max(18, W·H/26000))`），`devicePixelRatio` 上限 2；窗口 `resize` 时重播种。
- 清理：`cancelAnimationFrame` + 移除 `resize` 监听 + 移除画布，无残留 rAF。

### theme-transition 换肤过渡编排

- 声明主题：`cyber/kawaii/glass/guochao/mecha`（风格化家族）+ `terminal/liquid`
- 行为：换肤时一次性插入 `.wx-theme-flash`（全屏强调色晕开，`animation: wm-theme-flash .5s`，600ms 后自动移除）。
  同时引擎每次 `applyTheme` 会给 `:root` 加临时 `wx-theming` 类（360ms 移除），让 7 个 chrome 面板
  `background-color/color/border-color` 做 300ms 过渡。
- 性能注：过渡刻意**不含** `.session/.bubble`（上千节点，加 transition 会在换肤瞬间掉帧，红线 #6）。

### 无障碍降级（reduced-motion）

系统开启「减少动态效果」时，引擎**完全不挂载**任何效果助手（无 rAF、无监听、无节点）；
CSS 侧同步兜底（§10 末尾 `@media (prefers-reduced-motion: reduce)` 隐藏辉光、粒子静态化、过渡动画关闭）。

---

## 三、扩展点：registerEffect

引擎导出 `window.registerEffect(name, factory)`：

```js
window.registerEffect('my-effect', function (decoLayer) {
  // 只读 token、只写 decoLayer
  var el = document.createElement('div');
  el.className = 'wx-my-effect';
  decoLayer.appendChild(el);
  // ... 挂监听 / rAF ...
  return {
    destroy: function () {
      // 必须清理监听、定时器、rAF 与节点（切主题时引擎调用）
    }
  };
});
```

主题侧只需 `{ id: 'x', ..., effects: ['my-effect'] }`，引擎主流程零改动。校验 `test_theme_engine.js`
会检查每个 `effects` 名称在 CSS 中存在对应 `.wx-*` 钩子（`FX_CSS_HOOK` 映射）。

---

## 四、验收对照

| 断言 | 校验位置 |
|---|---|
| 新增配色主题不重写效果、自动进 DARK/玻璃组 | `test_theme_engine.js`「DARK 组去重写法」+ `:where` 作用域 |
| 效果助手挂载/卸载无残留 | `test_theme_runtime_smoke.js` 第 3/4 节（节点清空、监听移除、reduced-motion 门控） |
| 壁纸超限不写 localStorage | `test_theme_runtime_smoke.js` 第 5 节（1.5MB 门控 + `.wm-wp-note.show`） |
