# WeMemo 微忆 · 主题引擎设计文档

> 状态：v1（设计文档，用于向编程代理派发实现任务）
> 适用范围：`wememo_app`（Electron 桌面应用，微信 4.0 解密归档）
> 配套实现（已存在，本文档将其**契约化**）：`src/renderer/css/app.themes.css`、`src/renderer/js/theme.js`

---

## 0. 文档目的与读者

**目标**：在不改动任何 HTML 骨架 / 布局 / 交互逻辑（指**业务功能**逻辑）的前提下，让**任一元素、组件、效果的"外观"与"响应态"都可以通过「主题」自由定义**。

- 颜色、字体、圆角、描边、阴影、辉光、玻璃、气泡、头像光环、图表、背景氛围、壁纸、悬停/激活/聚焦态、流光/呼吸/扫描等动效 —— 全部走主题。
- **冻结的是"业务"**：HTML 语义结构、布局尺寸、业务功能 JS（数据/事件逻辑）一律不动。
- **不冻结的是"主题系统本身"**：主题引擎 JS（applyTheme / setWallpaper / 持久化 / 动效运行时）、装饰层（伪元素 + 引擎托管的装饰容器）、纯外观 CSS，都属于主题系统，可正常演进。详见 §1.5。

**读者**：编程代理。第 9 章把工作拆成可独立派发的任务，每任务带接口契约与验收标准。代理拿到对应章节即可实现，互不阻塞。

**非目标（红线）**：
- 不重构业务组件，不新增/删除**业务** DOM 节点（引擎托管装饰层与主题管理器面板的注入节点属拓展项，见 §1.3 / §1.4，不计入业务结构）。
- 不改布局尺寸、不改动业务交互行为、不引入新依赖（除非任务明确允许）。
- 主题不得直接操作 / 监听业务 DOM 或业务事件；需要"响应"时一律走纯外观 CSS 或引擎提供的效果运行时（§1.5）。

---

## 1. 总体架构（分层）

```
┌─────────────────────────────────────────────────────────┐
│ Layer 0  骨架层（冻结，不动）                              │
│   src/renderer/index.html + app.css 基础样式（浅色默认）    │
├─────────────────────────────────────────────────────────┤
│ Layer 1  Token 层（单一事实来源）                          │
│   全部外观以 CSS 自定义属性 --wx-* 表达（§3 契约）          │
├─────────────────────────────────────────────────────────┤
│ Layer 2  主题层（注册表驱动）                              │
│   每主题 = tokens(:root[data-theme=id]) + 可选 effects +   │
│   可选 skin（组件外观覆盖）                                │
├─────────────────────────────────────────────────────────┤
│ Layer 3  引擎层（运行时）                                  │
│   applyTheme / setWallpaper / 持久化 / 预览 / 事件         │
├─────────────────────────────────────────────────────────┤
│ Layer 4  装饰 & 壁纸层（与主题正交的维度）                 │
│   --wx-aura 氛围图层 + --wm-wallpaper 用户壁纸             │
└─────────────────────────────────────────────────────────┘
```

### 1.1 唯一约束（贯穿全文）

外观变化**只能**通过以下三种受控途径之一表达，禁止其他手段：

1. 改变 `--wx-*` token 的取值（在 `:root[data-theme="id"]` 作用域内）；或
2. 在该主题作用域内写**纯外观 CSS**（覆盖 `color / background / border / box-shadow / border-radius / font-family / filter / backdrop-filter / 伪元素装饰 / 纯 CSS 动效`）；或
3. 声明式地请求引擎提供的**效果运行时**（如 `cursor-glow` / `particles` / `theme-transition`），由引擎统一挂载（见 §1.5），主题自身不直接写 JS。

**禁止**：在主题里改业务 DOM 结构、改 `width/height`/`margin`/`padding`/`position`/`display`（布局）、改业务 JS 事件/逻辑、改 `z-index` 语义（除既有装饰伪元素 `z-index:-1/1`）。**但**引擎层本身（applyTheme / setWallpaper / 效果运行时 / 装饰层挂载）的 JS 演进不受此限——它属于"主题系统"而非"业务"。

**关于"JS 冻结"的澄清（重要，代理必读）**：本文档**不冻结 JS**，冻结的是**业务功能 JS**。主题引擎、动效运行时、装饰层挂载都是 JS，且必须存在，否则换肤与"花里胡哨的响应"无法实现。请区分：
- 冻结 = 业务数据处理、业务事件监听/派发、业务组件生命周期；
- 允许 = 主题引擎运行时、根据 `data-theme` 切换 token、主题声明的效果运行时、引擎托管的装饰层注入。

### 1.2 主题的两类家族

| 家族 | 行为 | 背景实现 |
|---|---|---|
| **Opaque 家族** | `--wx-aura` 无效或等同实色，`--wx-bg` 直接是页面底色 | `body` 保持不透明，`--wx-bg` 作底色 |
| **Aura 家族** | 背景是渐变/极光/壁纸，需浮在玻璃面板之后 | `body` 置 `transparent`，`html` 给兜底底色，`--wx-aura` 经 `body::before`(z-index:-1) 浮出，被 `backdrop-filter` 虚化 |

> 现有 `light` 属 Opaque 家族；`terminal/liquid` 属 Aura 家族。§8 四套风格化主题中，**玻璃拟态、赛博霓虹** 为 Aura（深色兜底），**甜系可爱、国潮复古** 为 Aura（浅色兜底）——即它们也需要 `body` 透明 + 浅色 `html` 兜底，才能把 `--wx-aura` 渐变露出来。`mecha` 机械机甲为 Aura 家族亮/暗双变体（亮变体浅色兜底）。

### 1.3 装饰层约定（DOM 边界澄清）

- **伪元素装饰（`::before` / `::after`）**：它们是 **CSS，不是真实 DOM 节点**，因此不计入"骨架变更"红线，主题可自由使用。
  - `body::before`：背景氛围层（`--wx-aura`），`position:fixed; inset:0; z-index:-1; pointer-events:none`。所有主题通用，靠 `var()` 跟随。
  - `body::after`：可选叠加层（栅格 / 扫描线 / 噪点），仅特定皮肤主题使用，同样 `z-index:-1`（栅格）或 `z-index:1`（扫描线，置于内容之上但不挡交互）。
- **引擎托管装饰容器（`wx-deco-layer`）**：少数需要"真实节点"的装饰（如悬浮贴纸、SVG 角花、粒子画布）由**引擎**在 `body` 末尾挂载一个固定层 `<div class="wx-deco-layer">`（`position:fixed; inset:0; z-index:-1; pointer-events:none`），主题**仅通过声明式清单**登记要渲染的 SVG/节点（见 §1.5 效果运行时），不直接 `appendChild` 到业务 DOM。这既满足"花里胡哨"的装饰需求，又把 DOM 写入收敛到引擎一处，业务结构零污染。

> **DOM 问题直接回答**："DOM 是干嘛的" —— 在主题引擎语境下，DOM 分两层：① **业务语义 DOM**（index.html 里那些真实 UI 节点，如侧栏、消息列表、输入框）—— 冻结，主题不能动，否则会破坏布局与功能；② **装饰 DOM**（伪元素 + 引擎托管装饰层）—— 主题可以驱动，但必须经引擎收敛，不能任意增删业务节点。装饰伪元素本质是 CSS，连真正的 DOM 改动都不算。

### 1.4 主题管理器面板（可选拓展，非核心）

`theme.js` 当前会向 `.titlebar` 注入一个 `.wm-theme-btn` 圆点按钮，并在 `body` 末尾注入 `.wm-theme-mask > .wm-theme-panel`（主题卡片网格 + 壁纸分区 + 重置）。这是**唯一的 DOM 注入**，属于"拓展项"而非引擎核心。核心能力（`applyTheme` + token）不依赖它。派发任务时，管理器 UI 单独列为 Task F，可后置。

---

### 1.5 响应与动效来源分层（回答"JS 冻结做不出效果"的疑虑）

"响应态"与"花里胡哨的动效"绝大多数**不需要 JS**，纯 CSS 即可，这正是主题系统能"冻结业务、放开外观"的底气：

| 来源 | 典型效果 | 是否需 JS | 归属 |
|---|---|---|---|
| `:hover` / `:active` / `:focus` | 悬浮微抬、激活辉光、按钮按压态、光标可点态（`cursor`） | 否（纯 CSS 伪类） | 主题 CSS |
| `@keyframes` + `animation` | 选中流光、呼吸辉光、渐变流动、扫描线滚动、气泡尾巴摆动 | 否（纯 CSS 动画） | 主题 CSS |
| `transition` | 换肤过渡、悬停平滑、掠光滑过 | 否（纯 CSS 过渡） | 主题 CSS |
| `backdrop-filter` | 玻璃磨砂、壁纸虚化 | 否（纯 CSS 滤镜） | 主题 CSS |
| 伪元素 `::before/::after` | 印章、角花、栅格、扫描线、气泡尾巴、高光 | 否（纯 CSS） | 主题 CSS |
| **引擎效果运行时**（§1.5.1） | 光标跟随辉光、Canvas 粒子/星空、滚动视差、换肤过渡编排、`prefers-reduced-motion` 统一降级 | 是（但由引擎托管，主题只声明） | 引擎 JS |

> 现有实现已验证：流光（`@keyframes wm-shimmer`）、玻璃（`backdrop-filter`）、悬停掠光（`.pay-card::after` + `:hover`）、气泡尾巴（`.bubble::before`）、国潮印章装饰（`body::after`）**全部是纯 CSS**，零业务 JS。换肤的"响应感"主要由这套 CSS 提供。

#### 1.5.1 效果运行时（Effect Runtime）—— JS 仅在此一处为外观服务

仅当某效果 CSS 确实无法单独完成（如依赖鼠标坐标、需要画布逐帧、需要编排多元素过渡）时，才走效果运行时。契约：

- 主题在 `THEMES` 条目里声明 `effects: ['cursor-glow','particles']`；
- 引擎在 `applyTheme` 时据此**挂载/卸载**对应运行时助手（统一挂在 `#wx-deco-layer` 或 `body` 上），并对每个助手负责清理（切主题时 `destroy`）；
- 运行时**只读主题 token**（如 `--wx-glow`）、只写装饰层，绝不触碰业务 DOM 或业务事件；
- 必须尊重 `prefers-reduced-motion: reduce`：自动关闭逐帧/高强度动效，降级为静态；
- 运行时助手本身是可注册的（引擎提供 `registerEffect(name, mount/destroy)`），新增效果不必改引擎主流程。

> 这层 JS 是**被允许的**，正是它弥补了"纯 CSS 做不到的交互型动效"。但主题作者**永远不直接写这段 JS**——只声明要哪个效果。引擎负责实现与生命周期。

---

## 2. 文件与职责

| 文件 | 职责 | 是否冻结 |
|---|---|---|
| `src/renderer/index.html` | 结构；`<head>` 内挂 `app.themes.css` 的 `<link>` 与 `theme.js` 的 head 脚本（先于 body 执行，避免闪白） | 仅可加 link/script 引用，不动结构 |
| `src/renderer/css/app.css` | 浅色默认样式（`:root` 基础 `--wx-*`） | 冻结；新主题不改这里 |
| `src/renderer/css/app.themes.css` | **所有非浅色主题的 token + 效果规则 + 玻璃 + 皮肤 + 壁纸 + 管理器 UI 样式** | 主要编辑对象 |
| `src/renderer/js/theme.js` | 引擎运行时（注册表、applyTheme、壁纸、管理器 UI 注入、持久化、启动） | 主要编辑对象 |
| `build.js` | `node build.js` 重建 `dist/`（src 与 dist 均须含主题文件）；已修复自带 Python 运行时锁导致的 EBUSY 构建中断 | 改主题后必须重跑 |

---

## 3. Token 契约（CSS 变量命名规范）

**这是硬契约**：所有主题、效果、管理器 UI 只能引用下表中的变量；新增变量须先在此登记。下表即现有实现的固化，代理实现时直接复用，不要另起炉灶。

### 3.1 颜色

| 变量 | 语义 | 类型 |
|---|---|---|
| `--wx-bg` | 页面底色（Opaque 家族直接可见；Aura 家族作 `html` 兜底） | color |
| `--wx-panel` | 主面板/卡片底色 | color |
| `--wx-sidebar` | 侧栏底色 | color |
| `--wx-line` | 发丝级分隔线/边框基色 | color |
| `--wx-line-strong` | 强调分隔线 | color |
| `--wx-text` | 主文字 | color |
| `--wx-text-2` | 次级文字 | color |
| `--wx-text-3` | 三级/弱化文字 | color |
| `--wx-green` | **强调色**（品牌绿在浅色；各主题可改为该主题主色） | color |
| `--wx-green-deep` | 强调色深版（渐变终点/图表终点） | color |
| `--wx-blue` | 辅助色 | color |
| `--wx-hover` | 悬浮态底色 | color |
| `--wx-active` | 激活态底色 | color |
| `--wx-red` | 警示/危险语义色 | color |
| `--wx-white` | 卡片内"白底"替代色（暗底时为深色，浅底时为白） | color |

### 3.2 深色修正（替代 app.css 写死浅色）

| 变量 | 语义 |
|---|---|
| `--wx-surface` | 输入框/查找条底色（覆盖 app.css 浅色） |
| `--wx-track` | 图表轨道/进度条底色 |
| `--wx-chipbg` | chip/标签选中态底色 |
| `--wx-glass` | 玻璃面板主底（半透） |
| `--wx-glass2` | 玻璃面板次级底（tabbar/sidebar） |
| `--wx-glass-line` | 玻璃面板发丝边色（兼作面板通用描边） |
| `--wx-hi` | 引用/徽标/上下文条弱高亮 |
| `--wx-hi2` | 强一档高亮 |

### 3.3 效果

| 变量 | 语义 |
|---|---|
| `--wx-glow` | 强调色辉光（box-shadow 用） |
| `--wx-glow-soft` | 弱化辉光（drop-shadow 用） |
| `--wx-aura` | 背景氛围图层（`body::before` 背景，可多段 radial/linear 叠加；Opaque 家族设 `none`） |
| `--wx-glass-bg` | 玻璃面板填充（半透） |
| `--wx-glass-blur` | 玻璃模糊半径（如 `15px`；Opaque 家族设 `0px`） |
| `--wx-bubble-me-grad` | 我的气泡渐变 | 
| `--wx-bubble-me-tail` | 我的气泡尾巴色 |
| `--wx-bubble-me-text` | 我的气泡文字色 |
| `--wx-bubble-you-bg` | 对方气泡底色（半透） |
| `--wx-bubble-you-tail` | 对方气泡尾巴色 |
| `--wx-bubble-you-text` | 对方气泡文字色 |
| `--wx-ava-ring` | 头像光环色 |

### 3.4 形状 / 字体 / 阴影 / 壁纸

| 变量 | 语义 | 默认（建议） |
|---|---|---|
| `--wx-radius` | 基础圆角（skin 可覆盖，组件级用字面量或此变量） | `10px` |
| `--wx-font` | 主题字体族（skin 可覆盖；Opaque 默认继承系统无衬线） | 系统无衬线 |
| `--wx-shadow` | 卡片/面板投影 | 见各主题 |
| `--wm-wallpaper` | 用户壁纸（url(...) 或渐变）；由 JS 运行时写入 `:root.style` | 空 |

> **字体可用性警告（代理必读）**：依赖特殊字体的主题（如赛博霓虹用 `Share Tech Mono`、国潮复古用 `Noto Serif SC`）必须确保该字体在应用内可用（打包进 app 或系统已装），否则回退到 `monospace` / `serif`。**不要**为引入字体而改动 `index.html` 的 `<head>` 之外结构；若需内嵌字体，走资源文件 + `@font-face`，列为独立任务。

---

## 4. 主题数据模型（ThemeDef）

主题在 JS 侧以注册表条目描述，在 CSS 侧以 `:root[data-theme="id"]` 块落地。两者 **id 必须一致**。

```js
// theme.js 中 THEMES 条目（驱动管理器面板）
{ id: 'vault', name: '暗夜保险库', desc: '青蓝极光 + 栅格 + 重玻璃', sw: ['#0A0D12','#12161D','#2DD4BF'] }
//                                                              ↑ sw 三色用于面板卡片缩略图：底色/面板色/强调色
```

```css
/* app.themes.css 中对应落地（节选） */
:root[data-theme="vault"] {
  --wx-bg:#0A0D12; --wx-panel:#12161D; /* ... 全部 §3 变量 ... */
  --wx-aura: radial-gradient(...);      /* 背景氛围 */
  --wx-glass-blur:20px;
}
```

**新增主题的标准动作**（代理照做）：
1. 在 `theme.js` 的 `THEMES` 数组追加一条 `{id,name,desc,sw}`。
2. 在 `app.themes.css` 追加 `:root[data-theme="<id>"] { ... }` 填全部 token。
3. 若该主题属 Aura 家族，把 `<id>` 加入 §5.2 的 `body` 透明选择器列表 + `html` 兜底列表。
4. 若启用共享深色修正（输入框/图表轨道等），把 `<id>` 加入 §5.1 的 DARK 选择器组（或改为 `:root[data-theme]:not(...)` 写法，见 §9 Task B）。
5. 若带 skin，在 `app.themes.css` 的「组件皮肤」区追加 `:root[data-theme="<id>"] ...` 规则。
6. `node build.js` 重建 `dist/`，确认 `src` 与 `dist` 均含改动。

---

## 5. 效果规则库（Effects）

以下效果写在**通用 `:root[data-theme]` 块**内，靠 `var()` 自动跟随每套主题的强调色与色板，因此新增配色主题**无需**重写效果，只需提供对应 token 值。

### 5.1 共享深色修正（DARK 组）

把 `app.css` 写死的浅色背景（输入框、查找条、图表轨道/柱、富卡片、表情退化标签、chip/seg 选中态、滚动条、选区、引用、徽标、上下文条、同步态）替换为 `--wx-surface / --wx-track / --wx-chipbg / --wx-hi / --wx-glass-line / --wx-green`。作用域为所有 Aura 家族 + 任何需要深色修正的主题。

> **契约改进点（Task B，已实现）**：当前实现统一写作
> `:root[data-theme]:where(:not([data-theme="light"]))`（mist 已随 v2 移除，排除仅剩默认浅色），
> 用 `:where()` 包裹保证特异性恒为 0，新增主题自动进入，无需维护 id 列表。

### 5.2 通用艺术效果（所有 `[data-theme]` 生效，含 light/mist）

| 效果 | 作用选择器 | 实现要点 |
|---|---|---|
| 背景氛围 | `body::before` | `background: var(--wx-aura, none)`；`position:fixed; inset:0; z-index:-1` |
| body 透明修复 | `:root[data-theme="<aura id>"] body`, `body.wm-has-wallpaper` | `background: transparent`；对应 `html` 给兜底底色；避免 `body::before` 被不透明 body 盖死 |
| 面板发丝边 | `.titlebar/.tabbar/.sidebar/.chat/.chat-head/.find-bar` | `border-color: var(--wx-glass-line)` |
| 头像光环 | `.session .ava`, `.msg .mava`, `.sidebar-top .avatar` | `box-shadow: 0 0 0 1px var(--wx-ava-ring), 0 0 12px -3px var(--wx-glow)` |
| 我的气泡 | `.msg.me .bubble` | `background: var(--wx-bubble-me-grad); color: var(--wx-bubble-me-text); box-shadow: 0 2px 12px -2px var(--wx-glow)` |
| 对方气泡 | `.msg.you .bubble` | `background: var(--wx-bubble-you-bg); color: var(--wx-bubble-you-text); border:1px solid var(--wx-glass-line)` |
| 选中会话流光 | `.session.active::after` | `@keyframes wm-shimmer` 左侧竖向流光条（`var(--wx-green)` 渐变） |
| 激活 Tab 柔光 | `.tabbar .tab.active` | `filter: drop-shadow(0 0 6px var(--wx-glow-soft))` |
| 卡片悬浮微抬 | `.stat-card/.panel/.me-card` | `:hover { transform: translateY(-2px); box-shadow: 0 8px 26px -8px var(--wx-glow) }` |
| 图表渐变 | `.bar-fill/.rank-fill/.col-bar` | `linear-gradient(90deg, var(--wx-green), var(--wx-green-deep))` |
| 主按钮/启动 logo 辉光 | `.btn-primary`, `.boot .logo` | 强调色渐变 + `box-shadow: 0 4px 14px -4px var(--wx-glow)` |
| 转账/红包掠光 | `.pay-card::after` | 悬浮 `translateX` 掠光（语义色保持原样，仅加动效） |
| 玻璃面板 | `.titlebar/.tabbar/.sidebar/.chat/.chat-head/.find-bar` + `.modal-card` + `.boot` | `backdrop-filter: blur(var(--wx-glass-blur)) saturate(118%)` + `background: var(--wx-glass-bg/glass2)` |

> **玻璃仅对 Aura 家族生效**：Opaque 家族（`light`/`mist`）`--wx-glass-blur:0px` 且 `body` 不透明，玻璃规则自然退化为实色（需把 Opaque 主题 id 排除在玻璃选择器外，或玻璃块加 `:not([data-theme="light"]):not([data-theme="mist"])`）。

---

## 6. 组件皮肤（Skin）—— 正交维度

**定义**：在不改颜色 token 的前提下，改变「形状 / 字体 / 栅格 / 圆角 / 直角 / 扫描线」等**材质观感**，制造"焕然一新"的差异。皮肤与配色主题**正交**：同一皮肤可被多套配色复用，同一配色也可挂载不同皮肤。

**现有示例**：
- `terminal`（霓虹终端）：等宽字体 + `border-radius:2px !important` 直角 + `body::after` 扫描线。
- `liquid`（液态玻璃）：大圆角（面板 18 / 会话 14 / 气泡 20）+ 重玻璃。
- `vault`（暗夜保险库）：`body::after` 栅格叠加（`repeating-linear-gradient` 46px + 径向 mask 淡出）+ 略大圆角 10px。

**皮肤落地形式**：在 `app.themes.css` 的「组件皮肤」区，以 `:root[data-theme="<id>"] <选择器> { ... }` 写覆盖规则。本质是"该主题附带一组材质覆盖"。

**契约**：皮肤只动 `font-family / border-radius / background-image(伪元素装饰) / filter` 等纯外观；不动布局尺寸与结构。新增皮肤遵循 §4 的新增动作 + 在皮肤区追加规则。

---

## 7. 装饰与壁纸层（与主题正交）

- **氛围图层**：每主题的 `--wx-aura`（§3.3），随主题切换。
- **用户壁纸**：`--wm-wallpaper`（运行时由 `theme.js` `setWallpaper()` 写入 `:root.style`），覆盖氛围层：
  ```css
  body.wm-has-wallpaper::before {
    background-image: var(--wm-wallpaper) !important;
    background-size: cover; background-position: center; background-repeat: no-repeat;
  }
  ```
  玻璃面板通过既有的 `backdrop-filter` 实时把壁纸虚化 —— 即"像 wallpaper 一样啥都能换"。
- **预设**：`theme.js` 的 `WALLPAPERS`（纯 CSS 渐变，无需图片文件）；用户可上传任意图片（FileReader → dataURL）。
- 壁纸与主题**独立持久化**（`wememo-wallpaper` vs `wememo-theme`），正交组合。

---

## 8. 四套风格化主题规格（派发实现的样本）

> 这四套是画布「风格化主题探索」(Ardot `717180821826226`) 上展示过的方案，现落成**可直接实现的 token 规格**。代理实现时严格按此填值（完整 `:root[data-theme]` 块已给出，可整段粘贴）。每套都演示了引擎的不同能力：**赛博霓虹=技术字+辉光+扫描线；甜系可爱=浅色渐变+大圆角；玻璃拟态=彩色渐变底+重玻璃；国潮复古=衬线字+金描边+朱红**。

### 8.1 赛博霓虹 Cyberpunk

- **家族**：Aura（深色兜底 `#0A0E1F`）
- **设计意图**：深空蓝紫底 + 青/品红霓虹辉光 + 等宽科技字 + 微扫描线；强调色青 `#00E5FF`，辅色品红 `#FF2BD6`。
- **启用效果**：背景氛围（青+品红双极光）、辉光、玻璃（中等）、气泡渐变（青→品红）、头像光环、选中流光、图表渐变、按钮辉光。
- **皮肤**：`cyber` = `--wx-font:"Share Tech Mono",ui-monospace,monospace` + `border-radius:4px`（锐利）+ `body::after` 极淡扫描线（`repeating-linear-gradient` 透明度 0.06）。
- **字体依赖**：`Share Tech Mono`（或系统 `monospace` 回退）。

```css
:root[data-theme="cyber"] {
  --wx-bg:#0A0E1F; --wx-panel:#0F1626; --wx-sidebar:#0B1020; --wx-line:#1B2540; --wx-line-strong:#25325A;
  --wx-text:#E6F7FF; --wx-text-2:#9FC7E8; --wx-text-3:#5E7DA8;
  --wx-green:#00E5FF; --wx-green-deep:#00A3C4; --wx-blue:#FF2BD6;
  --wx-hover:#14203A; --wx-active:#1A2A4A; --wx-red:#FF5C7A; --wx-white:#0F1626;
  --wx-bubble-me:#0E3A5A; --wx-bubble-you:#111B33; --wx-avatar:#16223E;
  --wx-shadow:0 0 18px -6px rgba(0,229,255,.5);
  --wx-surface:#121A30; --wx-track:#16223E; --wx-chipbg:rgba(0,229,255,.12);
  --wx-glass:rgba(0,229,255,.05); --wx-glass2:rgba(0,229,255,.04); --wx-glass-line:rgba(0,229,255,.22);
  --wx-hi:rgba(0,229,255,.07); --wx-hi2:rgba(0,229,255,.12);
  --wx-glow:rgba(0,229,255,.55); --wx-glow-soft:rgba(0,229,255,.26);
  --wx-aura: radial-gradient(900px 620px at 14% 4%, rgba(0,229,255,.22), transparent 58%),
             radial-gradient(820px 560px at 90% 96%, rgba(255,43,214,.18), transparent 60%),
             radial-gradient(1000px 700px at 50% 50%, rgba(20,11,46,.5), transparent 70%), var(--wx-bg);
  --wx-glass-bg:rgba(10,20,40,.5); --wx-glass-blur:14px;
  --wx-bubble-me-grad:linear-gradient(135deg,#00E5FF,#FF2BD6); --wx-bubble-me-tail:#00A3C4; --wx-bubble-me-text:#03121A;
  --wx-bubble-you-bg:rgba(0,229,255,.06); --wx-bubble-you-tail:rgba(0,229,255,.06); --wx-bubble-you-text:#CDEBFF;
  --wx-ava-ring:rgba(0,229,255,.6);
  --wx-font:"Share Tech Mono",ui-monospace,monospace; --wx-radius:4px;
}
/* skin: cyber 扫描线（极淡，置于内容之上不挡交互） */
:root[data-theme="cyber"] body::after {
  content:''; position:fixed; inset:0; z-index:1; pointer-events:none;
  background: repeating-linear-gradient(0deg, rgba(0,229,255,.05) 0 1px, transparent 1px 3px);
  opacity:.5;
}
```

### 8.2 甜系可爱 Kawaii

- **家族**：Aura（**浅色**兜底 `#FFE3F4`）
- **设计意图**：粉→薰衣草渐变底 + 奶白胶囊卡 + 柔粉投影 + 圆润大圆角；强调色粉 `#FF5FA2`，辅色薰衣草 `#B98BE0`。
- **启用效果**：背景氛围（粉/薰衣草柔光）、弱辉光、玻璃（浅色微透）、气泡（粉渐变/白）、头像光环、卡片悬浮、图表渐变。
- **皮肤**：`kawaii` = `--wx-radius:22px`（大圆角，全圆润）+ 默认圆体（不换字体）。
- **注意**：属浅色 Aura 家族 → 必须 `body` 透明 + `html` 兜底 `#FFE3F4`，否则粉渐变被不透明 body 盖死。

```css
:root[data-theme="kawaii"] {
  --wx-bg:#FFE3F4; --wx-panel:#FFF6FB; --wx-sidebar:#FFEAF6; --wx-line:#FFD0E8; --wx-line-strong:#F7B8D8;
  --wx-text:#6B3A5B; --wx-text-2:#B07BA0; --wx-text-3:#D7A9C8;
  --wx-green:#FF5FA2; --wx-green-deep:#E84C8E; --wx-blue:#B98BE0;
  --wx-hover:#FFE0F0; --wx-active:#FFD0E8; --wx-red:#FF8AAE; --wx-white:#FFFFFF;
  --wx-bubble-me:#FFC2DE; --wx-bubble-you:#FFFFFF; --wx-avatar:#FFD6EC;
  --wx-shadow:0 4px 14px -4px rgba(255,95,162,.28);
  --wx-surface:#FFF0F8; --wx-track:#FFE0F0; --wx-chipbg:rgba(255,95,162,.14);
  --wx-glass:rgba(255,255,255,.5); --wx-glass2:rgba(255,255,255,.4); --wx-glass-line:rgba(255,95,162,.3);
  --wx-hi:rgba(255,95,162,.08); --wx-hi2:rgba(255,95,162,.14);
  --wx-glow:rgba(255,95,162,.32); --wx-glow-soft:rgba(255,95,162,.15);
  --wx-aura: radial-gradient(1000px 720px at 18% 6%, rgba(255,193,230,.9), transparent 58%),
             radial-gradient(900px 700px at 92% 96%, rgba(185,139,224,.85), transparent 60%),
             linear-gradient(135deg,#FFE3F4,#E8E1FF);
  --wx-glass-bg:rgba(255,255,255,.55); --wx-glass-blur:12px;
  --wx-bubble-me-grad:linear-gradient(135deg,#FFC2DE,#FF9ECB); --wx-bubble-me-tail:#FF9ECB; --wx-bubble-me-text:#5A2440;
  --wx-bubble-you-bg:#FFFFFF; --wx-bubble-you-tail:#FFFFFF; --wx-bubble-you-text:#6B3A5B;
  --wx-ava-ring:rgba(255,95,162,.5);
  --wx-radius:22px;
}
```

### 8.3 玻璃拟态 Glass

- **家族**：Aura（深色兜底 `#2A2E55`）
- **设计意图**：蓝→紫→粉鲜艳渐变作底 + 白色半透磨砂卡（强模糊 + 白描边）；文字全白。强调色浅蓝 `#9CC4FF`，辅色浅紫 `#C9A3FF`。
- **启用效果**：背景氛围（鲜艳三色渐变）、**重玻璃**（blur 16px）、白色辉光、气泡（白透/白描边）、头像光环、卡片悬浮、图表渐变。
- **皮肤**：`glass` = `--wx-radius:16px`。
- **注意**：文字用白色系，确保对鲜艳渐变底的可读性；玻璃模糊需 `body` 透明 + 深色兜底。

```css
:root[data-theme="glass"] {
  --wx-bg:#2A2E55; --wx-panel:rgba(255,255,255,.18); --wx-sidebar:rgba(255,255,255,.14); --wx-line:rgba(255,255,255,.22); --wx-line-strong:rgba(255,255,255,.3);
  --wx-text:#FFFFFF; --wx-text-2:#E0E4F5; --wx-text-3:#B8BEE0;
  --wx-green:#9CC4FF; --wx-green-deep:#6FA8FF; --wx-blue:#C9A3FF;
  --wx-hover:rgba(255,255,255,.1); --wx-active:rgba(255,255,255,.16); --wx-red:#FF9DB0; --wx-white:rgba(255,255,255,.2);
  --wx-bubble-me:rgba(255,255,255,.28); --wx-bubble-you:rgba(255,255,255,.16); --wx-avatar:rgba(255,255,255,.22);
  --wx-shadow:0 8px 30px -10px rgba(0,0,0,.4);
  --wx-surface:rgba(255,255,255,.16); --wx-track:rgba(255,255,255,.14); --wx-chipbg:rgba(255,255,255,.22);
  --wx-glass:rgba(255,255,255,.16); --wx-glass2:rgba(255,255,255,.12); --wx-glass-line:rgba(255,255,255,.3);
  --wx-hi:rgba(255,255,255,.12); --wx-hi2:rgba(255,255,255,.18);
  --wx-glow:rgba(159,196,255,.5); --wx-glow-soft:rgba(159,196,255,.25);
  --wx-aura: linear-gradient(135deg,#4F6BFF,#B14CFF 52%,#FF6FCB);
  --wx-glass-bg:rgba(255,255,255,.18); --wx-glass-blur:16px;
  --wx-bubble-me-grad:linear-gradient(135deg,rgba(255,255,255,.4),rgba(255,255,255,.18)); --wx-bubble-me-tail:rgba(255,255,255,.18); --wx-bubble-me-text:#FFFFFF;
  --wx-bubble-you-bg:rgba(255,255,255,.16); --wx-bubble-you-tail:rgba(255,255,255,.16); --wx-bubble-you-text:#EAF0FF;
  --wx-ava-ring:rgba(255,255,255,.5);
  --wx-radius:16px;
}
```

### 8.4 国潮复古 Guochao

- **家族**：Aura（**浅色**兜底 `#EAE0C4`）
- **设计意图**：宣纸米色底 + 金描边 + 朱红强调 + 朱红气泡；标题/正文用衬线（Noto Serif SC）。
- **启用效果**：背景氛围（宣纸纹理径向淡变）、金描边辉光、朱红气泡、头像金光环、卡片悬浮、图表渐变（朱红）、按钮辉光。
- **皮肤**：`guochao` = `--wx-font:"Noto Serif SC",serif` + `--wx-radius:10px` + 金描边（`--wx-glass-line` 金调已设）。
- **装饰拓展（可选，非核心）**：朱红印章「潮」字如做真实节点，应走 §1.3 的引擎托管装饰层（而非业务 DOM），不计入骨架变更；核心用衬线+金描边+朱红已足够传达国潮。
- **字体依赖**：`Noto Serif SC`（或系统 `serif` 回退）。
- **注意**：浅色 Aura 家族 → `body` 透明 + `html` 兜底 `#EAE0C4`。

```css
:root[data-theme="guochao"] {
  --wx-bg:#EAE0C4; --wx-panel:#FBF5E9; --wx-sidebar:#F5ECDA; --wx-line:#E2D6BC; --wx-line-strong:#D6C7A6;
  --wx-text:#2B2620; --wx-text-2:#6E5E45; --wx-text-3:#9A8A6E;
  --wx-green:#C8102E; --wx-green-deep:#9E0C24; --wx-blue:#C99E27;
  --wx-hover:#EFE6D2; --wx-active:#E7DCC2; --wx-red:#C8102E; --wx-white:#FBF5E9;
  --wx-bubble-me:#C8102E; --wx-bubble-you:#FBF5E9; --wx-avatar:#E7D9BC;
  --wx-shadow:0 2px 10px rgba(43,38,32,.18);
  --wx-surface:#F3EAD6; --wx-track:#E7DCC2; --wx-chipbg:rgba(201,158,39,.16);
  --wx-glass:rgba(255,255,255,.4); --wx-glass2:rgba(255,255,255,.3); --wx-glass-line:rgba(201,158,39,.4);
  --wx-hi:rgba(201,158,39,.1); --wx-hi2:rgba(201,158,39,.16);
  --wx-glow:rgba(200,16,46,.3); --wx-glow-soft:rgba(200,16,46,.14);
  --wx-aura: radial-gradient(circle at 30% 18%, #F7EFDD, #EAE0C4 70%);
  --wx-glass-bg:rgba(251,245,233,.7); --wx-glass-blur:10px;
  --wx-bubble-me-grad:linear-gradient(135deg,#C8102E,#9E0C24); --wx-bubble-me-tail:#9E0C24; --wx-bubble-me-text:#FBF5E9;
  --wx-bubble-you-bg:#FBF5E9; --wx-bubble-you-tail:#FBF5E9; --wx-bubble-you-text:#2B2620;
  --wx-ava-ring:rgba(201,158,39,.6);
  --wx-font:"Noto Serif SC",serif; --wx-radius:10px;
}
```

---

## 9. 编程代理任务拆分（可独立派发）

每任务给出：目标 / 输入 / 产出 / 接口契约 / 验收 / 依赖。任务间**依赖尽量低**，可并行派发。

### Task A — Token 契约白名单与默认值固化
- **目标**：把 §3 的全部 `--wx-*` 变量抽成单一白名单 + 默认值（从 `app.css` 的 `:root` 提取浅色默认），作为后续所有主题的校验基准。
- **产出**：`src/renderer/css/_tokens.md`（或 `docs/token-whitelist.md`）+ 可选 `tokens.json`。
- **验收**：白名单覆盖 §3 全部变量；默认值与现有 `app.css` 浅色一致。
- **依赖**：无。

### Task B — 主题注册表与 DARK 组选择器去重
- **目标**：将 `THEMES` 注册表与 CSS 选择器从"逐个枚举 id"改为可维护写法（`:not([data-theme="light"]):not([data-theme="mist"])` 或构建期由 `DARK_THEMES` 数组生成），消除新增主题漏加风险。
- **产出**：改造后的 `theme.js` + `app.themes.css` 选择器；保持视觉不变。
- **接口契约**：`theme.js` 导出 `THEMES`（含 `id/name/desc/sw`）；新增主题只需追加数组项 + CSS 块。
- **验收**：全部现有 9 套主题视觉与改造前逐像素一致；新增主题无需改选择器即可生效（自动进入 DARK 组 / 玻璃组）。
- **依赖**：A。

### Task C — 运行时引擎模块化与事件 + 效果运行时
- **目标**：把 `theme.js` 提炼为可复用模块，补充 `themechange` 事件、明确的 `current()` / `reset()` 公共 API，head 脚本避免闪白；并实现 §1.5.1 的**效果运行时**（主题声明 `effects` 数组 → 引擎挂载/卸载助手，含 `prefers-reduced-motion` 降级与 `registerEffect` 注册点）。
- **接口契约**：
  - `window.applyTheme(id, persist?)` — 设置 `data-theme`；未知 id 回退 `light`。
  - `window.setWallpaper(val, persist?)` — `val` 为 `url(...)` / 渐变 / `'none'`；写入 `--wm-wallpaper` 并切换 `body.wm-has-wallpaper`。
  - `window.currentTheme()` — 返回当前 id（默认 `'light'`）。
  - `window.resetTheme()` — 清壁纸 + 回 `light`。
  - 事件：`document.dispatchEvent(new CustomEvent('themechange',{detail:{id,wallpaper}}))`。
  - 持久化：`localStorage['wememo-theme']` / `['wememo-wallpaper']`；预览 `?theme=` / `?wallpaper=`。
- **验收**：`node --check theme.js` 通过；控制台 `applyTheme('vault')` 立即换肤且无报错；`themechange` 触发一次。
- **依赖**：B（可选）。

### Task D — 效果规则库配置化
- **目标**：把 §5.2 的 12 条效果规则固化为"可开关/可配置"的清单（每条对应一组 token 或开关变量），使新增主题零成本复用效果。
- **产出**：`app.themes.css` 的「通用艺术效果」区 + 一份 `docs/effects.md` 说明每条效果的触发变量与作用选择器。
- **验收**：新增纯配色主题不需重写任何效果规则；仅改 token 即获得全套效果。
- **依赖**：B。

### Task E — 四套风格化主题实现
- **目标**：按 §8 把 `cyber` / `kawaii` / `glass` / `guochao` 四套落成真实主题。
- **产出**：`theme.js` 的 `THEMES` 追加 4 条；`app.themes.css` 追加 4 个 `:root[data-theme]` 块 + 各自 skin 规则；`cyber`/`kawaii`/`guochao` 须加入 Aura 家族的 `body` 透明 + `html` 兜底列表（kawaii/guochao 浅色兜底，glass/cyber 深色兜底）。
- **接口契约**：完全复用 §3/§4/§5；每套仅填 token + 可选 skin + 可选 `effects`（§1.5.1，如赛博霓虹可声明 `cursor-glow`）。
- **验收**：4 套均可在管理器面板切换并实时预览；Aura 家族背景渐变正确浮出且不被 body 盖死；字体缺失时优雅回退（不报错）；浅色家族（kawaii/guochao）文字对比度达标。
- **依赖**：B、D；字体可用性见 §3.4（如需内嵌字体单列任务）。

### Task F — 主题管理器 UI（可选拓展）
- **目标**：把现有 `.wm-theme-btn` + `.wm-theme-mask/.wm-theme-panel` 抽为自包含组件（固定深色玻璃外观，任何主题下可读），支持主题卡片网格 + 壁纸分区 + 重置 + 实时预览。
- **产出**：`theme.js` 的 `buildUI()` + `app.themes.css` 的「主题管理器 UI」样式区。
- **约束**：这是 §1.4 的唯一 DOM 注入，属拓展项；核心引擎不依赖它。
- **验收**：面板在任意主题下清晰可读；点卡片即应用并持久化；上传壁纸经玻璃虚化生效。
- **依赖**：C。

### Task G — 壁纸引擎独立化
- **目标**：把壁纸预设（`WALLPAPERS`）+ 上传 + `setWallpaper` 抽为独立模块，校验上传图片体积（过大仅本次会话，不写 localStorage），与主题正交持久化。
- **产出**：`theme.js` 中 `wallpaper` 子模块。
- **验收**：预设/上传/清除均正常；刷新恢复；与主题任意组合。
- **依赖**：C。

### Task H — 构建集成与验收脚本
- **目标**：确保改主题后 `node build.js` 把 `src` 同步进 `dist`（含 CSS/JS/字体）；加轻量校验（CSS 括号配平、JS `node --check`、结构零变更 diff）。
- **产出**：`build.js` 既有逻辑 + 校验脚本（可复用现有 `test_renderer_logic.js` 思路）。
- **验收**：改任一主题 → `node build.js` → `src` 与 `dist` 均含且一致；无 JS 语法错误；`index.html` 结构相对改造前字节级不变（除允许的 link/script 引用与面板注入）。
- **依赖**：全部。

### Task I — 风格化增强效果运行时（可选，支撑"花里胡哨"）
- **目标**：实现 §1.5.1 的 2~3 个典型交互型效果助手（`cursor-glow` 光标跟随辉光、`particles` 轻量粒子/星空、`theme-transition` 换肤过渡编排），注册进引擎，使四套风格化主题（§8）可声明启用。
- **产出**：`theme.js` 的 `registerEffect` + 三个助手实现 + `docs/effects.md` 补充运行时类效果说明。
- **接口契约**：主题 `THEMES` 条目加 `effects:[...]`；引擎 `applyTheme` 据此 `mount`/`destroy`；所有助手遵守"只读 token、只写 `#wx-deco-layer`、尊重 reduced-motion"三约。
- **验收**：启用 `cursor-glow` 的赛博霓虹主题光标处有辉光且不影响点击；`particles` 不拖慢交互（reduced-motion 时降级为静态）；切主题时旧助手被正确 `destroy`，无残留定时器/监听器。
- **依赖**：C。

---

## 10. 验收与回归红线

1. **骨架零变更**：`index.html` **业务** DOM 结构字节级不变；允许的差异仅限（a）`<head>` 内新增 `app.themes.css` 的 `<link>` 与 `theme.js` 的 head `<script>`；（b）§1.4 管理器面板的运行时注入节点；（c）§1.3 引擎托管的装饰层 `#wx-deco-layer`（挂在 body 末尾、不进业务结构）。
2. **任意主题切换无 JS 报错、无布局位移**：换肤只变外观，不改 `width/height/margin/padding/position`。
3. **浅色默认不受影响**：`light` 仍为默认；未指定主题时回落 `light`。
4. **Aura 家族背景可见**：`body` 透明 + `html` 兜底正确；`body::before` 氛围层浮于玻璃之后、被 `backdrop-filter` 虚化（已有修复，新增 Aura 主题须沿用）。
5. **闪白约束**：`theme.js` 须在 `<head>` 内、`body` 渲染前执行（已通过 head 脚本实现）。
6. **性能**：玻璃 `backdrop-filter` 仅作用于 Aura 家族；扫描线/栅格伪元素 `pointer-events:none`，不挡交互；效果运行时（§1.5.1）须尊重 `prefers-reduced-motion` 并随主题卸载清理，不得残留定时器/监听器拖慢页面。
7. **构建一致性**：`node build.js` 后 `src` 与 `dist` 主题文件一致。

---

## 11. 拓展项（暂不做，骨架不变前提下后续可加）

- **主题市场 / 远程拉取**：主题定义 JSON 化后，可从远端加载（Task B 的 `tokens.json` 为此铺路）。
- **用户自定义 token 编辑器**：基于 §3 白名单做可视化调参，实时写 `--wx-*`。
- **组件级覆盖**：在 token 之上允许按组件（如仅气泡）局部覆盖，而不影响全局。
- **系统明暗自适应**：`prefers-color-scheme` 自动选 Opaque/Aura 家族。
- **内嵌字体任务**：为 `cyber`(Share Tech Mono) / `guochao`(Noto Serif SC) 打包字体并加 `@font-face`，走资源文件，不改结构。

---

## 附：现有主题一览（已实现，供对比）

> 2026-08-21 修订：移除早期 6 套简单主题（aurora/vault/ember/mono/mist/wallpaper）；
> §8 四套风格化主题已实现；新增 mecha（亮/暗变体）。当前共 8 套。
> 2026-08-21（质感重构）：`glass`/`mecha` 引入 AI 生图背景资产（`src/renderer/assets/themes/`，build.js 整目录复制自动进 dist），
> 材质层升级见 §11（glass 光感玻璃+颗粒噪点 / mecha 切角+警示条+角括号+mask 徽章）。

| id | 名称 | 家族 | 关键特征 |
|---|---|---|---|
| `light` | 微信浅色 | Opaque | 默认，轻量增强（渐变气泡+材质） |
| `terminal` | 霓虹终端 | Aura(深)+skin | 等宽+直角+扫描线 |
| `liquid` | 液态玻璃 | Aura(深)+skin | 大圆角+重玻璃 |
| `cyber` | 赛博霓虹 | Aura(深)+skin | 深空蓝紫+青/品红辉光+扫描线（§8.1 已实现） |
| `kawaii` | 甜系可爱 | Aura(浅)+skin | 粉薰衣草渐变+大圆角（§8.2 已实现） |
| `glass` | 玻璃拟态 | Aura(深)+skin | 雨窗街灯夜景壁纸+暗色磨砂玻璃（白字可读）+颗粒噪点+对角高光（§5.4 v5） |
| `guochao` | 国潮复古 | Aura(浅)+skin | 宣纸米色+金描边+朱红（§8.4 已实现） |
| `mecha` | 机械机甲 | Aura(亮银/黑金)+skin | 装甲壁纸+切角+警示条+角括号+金属材质层（高光/拉丝/环境反射），暗色为黑金点缀 #E3B341（金只做点缀，底不泛黄），`variants:['light','dark']` 亮暗只变配色不动风格/UI |

> **主题背景资产**（`assets/themes/`，由 `--wx-aura` 引用，随 body::before 氛围层渲染）：
> `glass-bg.jpg`（雨窗街灯夜景，用户提供，2026-08-21 v4 换图）/ `mecha-light-bg.png`（金属拉丝工程图）/ `mecha-dark-bg.png`（黑金装甲+香槟金辉光，2026-08-21 v4 换图）。
> 文件经生图工具生成并裁除水印；CSS 内相对路径 `../assets/themes/*.png`。更换/删除时同步更新 `test_theme_engine.js` §7.6 资产护栏。
>
> **可读性策略（glass v5，2026-08-21 终版）**：用户确认切回暗色——深色玻璃（`--wx-panel:rgba(18,22,42,.66)`）承载白字，
> 雨窗街灯夜景图经 `--wx-aura` 深蓝压暗层（`rgba(8,10,24,.32)`）+ 玻璃糊开后白字对比度稳定 ≥ 7:1（WCAG AAA）；
> 弹窗/启动页回归深色玻璃分支（kawaii/guochao 保持浅色）。
>
> **金属材质层（mecha v2，2026-08-21）**：`--wx-metal-hi/mid/edge/amb` 四 token（亮=银白/冷蓝，暗=香槟金/暖金），
> §11 皮肤消费：顶部高光 + 明暗过渡 + 3px 间隔拉丝纹理 + 侧缘 1px 高光/阴影 + 底部环境反射；
> 暗色 v3 黑金收敛：中性黑底（`--wx-bg:#0B0B0C`）不泛黄，金色只做点缀（气泡/按钮改深底金描边，激活 Tab 移除下横线）。
>
> **mecha 深度拟态（v2.1，2026-08-21）**：面板改双层内阴影（`inset 0 2px 0 hi` + `inset 0 -2px 0 edge`）+ 外投影（`0 2px 8px`）体现厚度与悬浮；
> 聊天区加底部暗角（radial-gradient）；卡片立体抬升（高光+暗边+投影）；暗色弹窗加深投影。
>
> **品牌图标（2026-08-21 v6 终版）**：概念「记忆冲破束缚」——聊天气泡=时间与遗忘的容器，四角星从气泡右缘破壳而出=记忆挣脱束缚，
> 右上碎片星 + 右下星火圆点=挣脱的张力与被点亮的闪光。
> ① 应用图标 = `icons.js` 的 `logo`（boot 启动页自动跟随，纯外观替换）；② 自头像 = `app.themes.css` §2 通用规则
> `.sidebar-top .avatar { color: transparent; position: relative }` + `::before` **绝对定位（inset:0 + margin:auto）居中**注入同款 SVG
> （消除"忆"字占位导致的图标偏移，不动 index.html/app.js）。
> **Windows 任务栏图标**：`assets/app-icon.png`（256×256，PIL 生成，`tools/_gen_app_icon.py` 可复现），
> main.js 的 BrowserWindow `icon` 选项 + `app.setAppUserModelId('com.wememo.app')`。
>
> **特殊消息对比度统一（2026-08-21 v7）**：暗色主题下，引用（`.quote-ref`）与系统消息（`.msg.system`）文字提至正文色 `--wx-text`，
> 链接/文件/位置/小程序/视频号/转发/联系人卡片描述文字由 `--wx-text-3` 提亮至 `--wx-text-2`（小字号灰字在暗底对比不足，尤其 mecha 暗色 text-3）。
> 转账金额统一全角 `￥`(U+FFE5)，不使用半角 `¥`(U+00A5，日元符号)。
> 主题按钮（`.wm-theme-btn`）由纯圆点改为「圆点 + 主题文字」自适应宽度。
> 聊天区只保留光晕与高光（不加拉丝，避免干扰阅读）；暗色模糊 14→10px、亮色 12→8px。
