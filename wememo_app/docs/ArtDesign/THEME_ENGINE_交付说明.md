# WeMemo 主题引擎 — 交付说明 v2（Task A–I + mecha 机械机甲）

> 日期：2026-08-21（v2：移除 6 套简单主题、新增 mecha 亮暗变体、修复壁纸预览 bug）
> 状态：开发完成，主题专项测试 + 既有逻辑测试全绿
> 设计契约：`docs/THEME_ENGINE.md`（§3 token 契约 / §9 任务拆分 / §10 红线）

## 一、交付物清单

| 文件 | 变更 | 对应任务 |
|---|---|---|
| `src/renderer/css/app.themes.css`（≈1000 行） | 重写：共享叠加层默认 + 主题块（7 套 + mecha 亮暗变体）+ DARK 去重 + skin + 管理器自包含 + @font-face + 装饰层 + mecha 皮肤/交互 | B/D/E/F/I + mecha |
| `src/renderer/js/theme.js`（≈500 行） | 重写：注册表（8 套）、效果运行时、事件、壁纸子模块、体积门控、**亮暗变体机制** | C/I/G + variants |
| `src/renderer/assets/fonts/*.woff2` | 新增 3 个字体文件（Share Tech Mono / Noto Serif SC 400/700） | 字体内嵌 |
| `docs/token-whitelist.md` + `docs/tokens.json` | 新增：token 白名单 + doc/code 漂移修正表 | A |
| `docs/effects.md` | 新增：纯 CSS 效果库 + 3 个运行时助手说明 | D/I(文档侧) |
| `test_theme_engine.js` | 新增：构建集成校验（44 项） | H |
| `test_theme_runtime_smoke.js` | 新增：DOM 桩运行时回环测试（33 项） | C/I/G 验收 |
| `src/renderer/index.html` | **零变更**（结构基线已冻结） | — |
| `build.js` | **零变更**（cpDir 自动含字体与主题文件） | H |

## 二、v2 变更（2026-08-21）

1. **移除 6 套早期简单主题**：`aurora / vault / ember / mono / mist / wallpaper`（注册表与 CSS 块一并删除，无残留规则；DARK/透明/玻璃选择器随 mist 移除简化为 `:where(:not([data-theme="light"]))`）。
2. **新增 mecha 机械机甲主题**：
   - 亮色（默认）：银白金属 + 能量蓝 `#00A8FF`；暗色变体：碳黑金属 + 能量蓝/橙——属 Aura 家族，`--wx-radius:4px` 机械锐利。
   - 皮肤（亮暗共用，不动风格/UI）：金属高光线、直角头像、极淡机械扫描线、双色能量条（青→橙）、激活 Tab 下缘能量条。
   - 交互反馈：会话 hover 能量条预览、卡片悬浮金属描边上抬、主按钮按压下陷、seg/chip 按压缩放。
   - 效果运行时：`cursor-glow + particles + theme-transition`。
3. **亮/暗变体机制（仅 mecha 启用）**：
   - `THEMES` 条目声明 `variants:['light','dark']`；引擎 `applyVariant(v, persist?)` 只改 `data-variant` 属性（配色 token），**不重挂效果运行时、不动皮肤与 UI**。
   - 持久化 `localStorage['wememo-variant']`；切主题时按支持情况恢复/移除变体；`themechange` detail 增加 `variant` 字段。
   - 管理器面板：mecha 卡片内渲染「亮/暗」胶囊按钮（`.wm-variant-btn`），点击即切，按钮点击不误触卡片换主题。
4. **修复壁纸上传不即时预览 bug（复查根因）**：
   - 根因：`body.wm-has-wallpaper::before` 只覆盖 `background-*` 四个属性，缺少 `content:''`；伪元素能否渲染依赖 `:root[data-theme] body::before` 提供的 `content/position/inset`，而该规则只在**非默认浅色**主题命中——默认浅色（无 `data-theme` 属性）下伪元素不渲染 → 壁纸静默失效。
   - 修复：壁纸规则改为自足写法（自带 `content/position/inset`），并新增 3 条回归护栏断言。

## 三、验证结果

| 套件 | 结果 |
|---|---|
| `test_theme_engine.js` | 44 passed（语法/括号配平/注册表↔CSS 一致性/删除守卫/mecha+变体块/index.html 基线 SHA/dist 字节一致/字体魔数/effects↔CSS 钩子/壁纸规则自足） |
| `test_theme_runtime_smoke.js` | 33 passed（themechange 恰好一次、变体默认 dark/切 light/持久化/恢复/不重挂效果、效果挂载/卸载无残留、reduced-motion 门控、壁纸超限门控、resetTheme 清变体） |
| `test_renderer_logic.js`（回归） | 122 passed |
| `test_emoticons_logic.js`（回归） | 150 passed |
| `test_wxgf_logic.js`（回归） | 88 passed |
| `test_startup_sim.js` | 启动模拟通过 |

## 四、红线核对（THEME_ENGINE.md §10）

- ✅ 骨架零变更：index.html 屏蔽两处允许新增（themes.css link / theme.js head 脚本）后哈希与冻结基线一致
- ✅ 浅色默认不受影响：`light` 仍为默认，未知 id 回退 light
- ✅ 闪白约束：theme.js 为 head 脚本，先于 body 渲染
- ✅ Aura 家族背景可见：body 透明 + html 兜底，`body::before` 浮于玻璃之后
- ✅ 性能：玻璃仅 Aura 家族；扫描线 `pointer-events:none`；切主题/切变体无残留定时器/监听器
- ✅ 构建一致性：`node build.js` 后 src 与 dist 主题文件字节一致（fonts/CSS/JS 均验证）

## 五、主题一览（8 套）

- **light 微信浅色**：默认（Opaque）
- **terminal 霓虹终端**：Aura(深) + 等宽直角扫描线 + `theme-transition`
- **liquid 液态玻璃**：Aura(深) + 大圆角重玻璃 + `theme-transition`
- **cyber 赛博霓虹**：Aura(深) + Share Tech Mono + 扫描线 + `cursor-glow/particles/theme-transition`
- **kawaii 甜系可爱**：Aura(浅) + 22px 大圆角 + `theme-transition`
- **glass 玻璃拟态**：Aura(深) + 重玻璃 16px + `particles/theme-transition`
- **guochao 国潮复古**：Aura(浅) + Noto Serif SC + 金描边 + `theme-transition`
- **mecha 机械机甲**：Aura(亮银/碳黑) + 金属皮肤/交互反馈 + `variants:['light','dark']` + `cursor-glow/particles/theme-transition`

## 六、运行方式

```bash
node build.js            # 重建 dist/
node test_theme_engine.js          # 构建集成校验（44 项）
node test_theme_runtime_smoke.js   # 运行时回环（33 项）
# 应用内：标题栏「主题」圆点按钮 → 面板切换 8 套主题 + 壁纸；mecha 卡片内「亮/暗」按钮切变体
# 预览：index.html?theme=mecha&wallpaper=url(...)
# 控制台：applyTheme('mecha') / applyVariant('dark') / setWallpaper('none') / currentTheme() / resetTheme()
```
