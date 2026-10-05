# WeMemo 主题引擎 · Token 白名单（硬契约）

> 配套设计文档：`docs/THEME_ENGINE.md` §3
> 状态：Task A 产出。**这是唯一事实来源**——所有主题、效果规则、管理器 UI 只能引用本表变量；新增变量必须先登记到此处。
> 机器可读版本：`docs/tokens.json`

## 0. 与 THEME_ENGINE.md §3 的差异说明（doc/code 漂移修正）

设计文档 §3 是事后归纳的清单，与真实代码存在两处漂移，Task A 予以修正：

| 类别 | 变量 | 处理 | 理由 |
|---|---|---|---|
| §3 遗漏、代码在用 | `--wx-bubble-me`<br>`--wx-bubble-you`<br>`--wx-avatar` | **补登记** | `app.css` `:root` 第 19–21 行已定义默认值，现有 9 套主题全部在用（如 `app.themes.css` aurora 块 `--wx-bubble-me:#1F6B4A`），§8 四套规格块也带。属气泡/头像的业务外观变量，不在通用效果层消费，故被 §3 漏掉。 |
| 效果层硬编码、应为 token | `--wx-overlay*`<br>`--wx-scroll*`<br>`--wx-select` | **新登记** | 原 DARK 组把白色叠加写成字面量（`rgba(255,255,255,.05~.24)`）。浅色 Aura 家族（kawaii/guochao）需要黑色叠加，硬编码会导致图片占位块 / 滚动条 / 选区在浅底上隐形。token 化后新主题零成本适配。 |
| §3.4 声明、代码未定义 | `--wx-radius` | **补默认值 + 落地消费** | `app.css` 从未定义该变量，且此前无任何规则消费它——§8 里 `--wx-radius:22px` 原本不会产生任何圆角。现给出默认 `10px` 并由 skin 规则实际消费。 |

---

## 1. 颜色（§3.1）

默认值取自 `src/renderer/css/app.css` 的 `:root`（微信 4.0 浅色基线）。

| 变量 | 语义 | 浅色默认 |
|---|---|---|
| `--wx-bg` | 页面底色（Opaque 家族直接可见；Aura 家族作 `html` 兜底） | `#EDEDED` |
| `--wx-panel` | 主面板 / 卡片底色 | `#F7F7F7` |
| `--wx-sidebar` | 侧栏底色 | `#F7F7F7` |
| `--wx-line` | 发丝级分隔线 / 边框基色 | `#E5E5E5` |
| `--wx-line-strong` | 强调分隔线 | `#DADADA` |
| `--wx-text` | 主文字 | `#1A1A1A` |
| `--wx-text-2` | 次级文字 | `#999999` |
| `--wx-text-3` | 三级 / 弱化文字 | `#B2B2B2` |
| `--wx-green` | **强调色**（浅色为品牌绿；各主题改为该主题主色） | `#07C160` |
| `--wx-green-deep` | 强调色深版（渐变终点 / 图表终点） | `#06AD56` |
| `--wx-blue` | 辅助色 | `#576B95` |
| `--wx-hover` | 悬浮态底色 | `#F0F0F0` |
| `--wx-active` | 激活态底色 | `#E4E4E4` |
| `--wx-red` | 警示 / 危险语义色 | `#FA5151` |
| `--wx-white` | 卡片内「白底」替代色（暗底时为深色） | `#FFFFFF` |
| `--wx-bubble-me` | 我的气泡实色底（**补登记**） | `#95EC69` |
| `--wx-bubble-you` | 对方气泡实色底（**补登记**） | `#FFFFFF` |
| `--wx-avatar` | 头像占位底色（**补登记**） | `#C0C4CC` |

## 2. 深色修正（§3.2）

`app.css` 未定义；由各主题在 `:root[data-theme="id"]` 内提供。用于替换 app.css 写死的浅色底。

| 变量 | 语义 |
|---|---|
| `--wx-surface` | 输入框 / 查找条底色 |
| `--wx-track` | 图表轨道 / 进度条底色 |
| `--wx-chipbg` | chip / 标签选中态底色 |
| `--wx-glass` | 玻璃面板主底（半透） |
| `--wx-glass2` | 玻璃面板次级底（tabbar / sidebar） |
| `--wx-glass-line` | 玻璃面板发丝边色（兼作面板通用描边） |
| `--wx-hi` | 引用 / 徽标 / 上下文条弱高亮 |
| `--wx-hi2` | 强一档高亮 |

## 3. 效果（§3.3）

| 变量 | 语义 |
|---|---|
| `--wx-glow` | 强调色辉光（`box-shadow` 用） |
| `--wx-glow-soft` | 弱化辉光（`drop-shadow` 用） |
| `--wx-aura` | 背景氛围图层（`body::before` 背景；Opaque 家族设 `none`） |
| `--wx-glass-bg` | 玻璃面板填充（半透） |
| `--wx-glass-blur` | 玻璃模糊半径（Opaque 家族设 `0px`） |
| `--wx-bubble-me-grad` | 我的气泡渐变 |
| `--wx-bubble-me-tail` | 我的气泡尾巴色 |
| `--wx-bubble-me-text` | 我的气泡文字色 |
| `--wx-bubble-you-bg` | 对方气泡底色（半透） |
| `--wx-bubble-you-tail` | 对方气泡尾巴色 |
| `--wx-bubble-you-text` | 对方气泡文字色 |
| `--wx-ava-ring` | 头像光环色 |

## 4. 叠加层（新登记 · Task A/D）

统一在 `app.themes.css` 的 `:root[data-theme]` 共享默认块内给出**深色家族默认值**（等于改造前的硬编码字面量，保证现有 9 套主题逐像素一致）；浅色 Aura 家族（kawaii / guochao）在自己的主题块内覆盖为黑色叠加，取值对齐 `app.css` 浅色基线。

| 变量 | 语义 | 深色默认（原硬编码） | 浅色家族建议 | app.css 浅色基线对照 |
|---|---|---|---|---|
| `--wx-overlay` | 我方消息富卡片底（file/link/mp/ch/fwd/loc/contact） | `rgba(255,255,255,.06)` | `rgba(0,0,0,.05)` | — |
| `--wx-overlay-weak` | 图片占位块 / 链接缩略图底 | `rgba(255,255,255,.05)` | `rgba(0,0,0,.05)` | `.link-thumb` `rgba(0,0,0,.05)` |
| `--wx-overlay-strong` | 表情退化标签 / 群标签底 | `rgba(255,255,255,.08)` | `rgba(0,0,0,.06)` | — |
| `--wx-overlay-heavy` | 我方表情退化标签底 | `rgba(255,255,255,.10)` | `rgba(0,0,0,.09)` | `.msg.me .wx-emo.none` `rgba(0,0,0,.09)` |
| `--wx-scroll` | 滚动条滑块 | `rgba(255,255,255,.14)` | `rgba(0,0,0,.15)` | `rgba(0,0,0,.15)` |
| `--wx-scroll-hover` | 滚动条滑块悬浮 | `rgba(255,255,255,.24)` | `rgba(0,0,0,.28)` | `rgba(0,0,0,.28)` |
| `--wx-select` | 文本选区高亮 | `rgba(255,255,255,.16)` | 主色 16% 半透 | `rgba(7,193,96,.25)` |

## 5. 形状 / 字体 / 阴影 / 壁纸（§3.4）

| 变量 | 语义 | 默认 |
|---|---|---|
| `--wx-radius` | 基础圆角（由 skin 规则消费；**Task A 新增默认值**） | `10px` |
| `--wx-font` | 主题字体族 | `"PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif` |
| `--wx-shadow` | 卡片 / 面板投影 | `0 2px 12px rgba(0,0,0,0.08)` |
| `--wm-wallpaper` | 用户壁纸（`url(...)` 或渐变）；由 `theme.js` 运行时写入 `:root.style` | 空 |

## 6. 布局变量（骨架层 · 主题禁止修改）

以下变量存在于 `app.css` `:root`，但属 **Layer 0 骨架**。THEME_ENGINE.md §1.1 明令主题不得改布局，因此它们**不在主题可写白名单内**，仅在此登记以防误改。

| 变量 | 语义 | 值 |
|---|---|---|
| `--wx-titlebar-h` | 标题栏高度 | `38px` |
| `--wx-tabs-w` | 左侧 tab 栏宽度 | `60px` |
| `--wx-sidebar-w` | 侧栏宽度 | `260px` |

---

## 7. 校验规则

1. 主题块内出现的每个 `--wx-*` / `--wm-*` 必须存在于第 1–5 节。
2. 第 6 节三个布局变量若出现在任何 `:root[data-theme=...]` 块内 → **违规**。
3. 新主题至少必须提供：`--wx-bg`、`--wx-panel`、`--wx-text`、`--wx-green`、`--wx-aura`、`--wx-glass-blur`，否则会继承浅色默认导致对比度异常。
4. 浅色家族主题必须覆盖第 4 节全部叠加 token，否则白色叠加在浅底上隐形。
