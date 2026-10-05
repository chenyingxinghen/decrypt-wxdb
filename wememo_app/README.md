# 微忆 WeMemo — 微信记忆离线归档

一个**纯离线**的微信 4.0 聊天记录解密与浏览应用。界面高度贴近微信客户端本体风格，
运行性能优于 Electron 同类工具，内置多层防逆向保护。

> ⚠️ 请仅用于解密**你自己设备上**的聊天记录，并遵守相关法律法规。

---

## 特性

| 维度 | 说明 |
|---|---|
| **界面** | 微信 4.0 客户端风格（三栏式：Tab栏 / 会话列表 / 聊天区），手绘线性图标，无边框窗口 |
| **一键式** | **首次启动自动解密**：探测微信数据目录 → 恢复密钥 → 自动解密全部库 → 直接浏览，全程无手动步骤，解密进度实时进度条 |
| **消息类型全解码** | **18 类消息零占位**：文本 / 图片 / 表情（cdnurl 直显）/ 语音（时长条）/ 视频（缩略占位 + 时长）/ 转账·红包（金额 + 收发方向）/ 文件（名称 + 大小 + 类型）/ 链接（标题 + 描述 + 缩略图，可外部打开）/ 小程序 / 视频号 / 合并转发（含摘要）/ 引用回复（被引消息还原）/ 位置 / 名片 / 群接龙 / 群公告 / 拍一拍 / 通话 / 系统消息（撤回等）。真实库 3500+ 消息实测 **0 条裸占位** |
| **内置表情** | 文本里的 `[微笑]` `[旺柴]` `[破涕为笑]` 一类微信内置表情记号（实测 822 种、18133 处）在文本流中就地渲染：有 Unicode 对应的显示为 emoji，微信独有、无对应字符的（旺柴 / 吃瓜 / 让我看看…）显示为带原名的浅色小胶囊而非裸露的方括号。名字表（146 正名 + 228 繁体/英文别名）直接抽自微信本体的 Qt 资源与 `newemoji-config.xml`，非臆测；白名单匹配，非表情的方括号（如 `[已收款]`）原样保留 |
| **完整取全** | 会话列表纳入**已从最近列表移除的历史会话**（标「历史」标签）；分页用 `(sort_seq, local_id)` 复合游标 + `server_id` 去重，**任意会话都能取到全部消息**（实测 61879 / 31477 / 22013 / 14989 条逐条对齐 `count(*)`，无重无漏、严格时序）；头部实时显示「已载 N / 共 M 条」，一键「全部」加载到最早 |
| **全库搜索** | 搜索框同时搜**会话名**与**全部聊天记录内容**：结果按会话分组（每组显示命中数与预览，可展开全部），点击命中**跳转到该消息**并在上下文中高亮闪烁，片段视图可继续上下翻页或一键「回到最新」。微信本地库不存明文（内容为 zstd 帧，SQL LIKE 无从下手），首次检索解码全库建索引（实测 23.8 万条约 3.8s），之后换关键词为纯内存过滤（**35ms**）|
| **会话内查找** | `Ctrl+F` 或头部「查找」：只搜当前会话，显示 `第 N / 共 M` 计数，`Enter`/`Shift+Enter` 或 `‹ ›` 逐条跳转（命中不在已渲染范围时自动加载其上下文），`Esc` 关闭 |
| **快捷键** | `Ctrl+F` 会话内查找 / `Ctrl+K` 全局搜索 / `↑ ↓` 切换会话 / `Esc` 关闭查找条与对话框 |
| **数据报告（发现）** | 真实统计报告：消息总数 / 会话数 / 活跃天数 / 日均条数，时间跨度（第一条、最近一条、最热闹的一天）、**收发比例**、**按月与按年柱状图**、**19 类消息类型分布**（含占比）、**聊得最多的会话 TOP 10**（点击直达）。统计口径由 `local_type` 直接得出（高 32 位即 app 子类型），**无需解压任何 zstd 帧**，每张 Msg 表只做一次聚合扫描（23.8 万条约 1.5s，引擎内缓存） |
| **个人主页（我）** | 本人头像 / 昵称 / wxid，通讯录规模（好友·群聊·公众号·有记录），本地数据档案（库数量与体积、消息分片数、解密库与附件目录，可一键在系统中打开），运行环境（微忆版本 / Electron·Chromium / Python / **zstd 解码通道** / 系统），离线声明 |
| **导出** | 单会话或**全部会话**导出为 **HTML / TXT / JSON**：HTML 为微信风格单文件（图片 base64 内嵌、按天分隔、可点链接），TXT 为逐行可读文本，JSON 为结构化数据（含 `meta` 富字段）；系统目录选择框 + 实时进度 + 导出后一键定位文件 |
| **性能** | zstd 解码**双通道**：优先原生 `zstandard`（实测 330× 于纯 Python，翻页 2~6ms），缺失时透明回退自研纯 Python 解码器（零依赖，4000+ 帧逐字节通过）；惰性分片定位 + **缓存体系**（连接复用 / 分片表定位 / 解码 LRU / 语音时长缓存 / 会话短 TTL）；渲染层 rAF 节流滚动、**消息交互事件委托**（数万条消息也只挂 2 个监听器）、批量加载时跳过逐轮布局锚定、图片/表情视口懒加载（一次性 observe） |
| **数据** | 跨分片合并（同一会话消息分布在多个 message_N/biz_message_N 库）、收发判定（real_sender_id→Name2Id→本人）、公众号/群聊识别、语音时长回查 media_N.db |
| **交互** | 类型感知右键菜单（复制消息 / 复制·打开链接 / 复制引用内容 / 复制时间）、单击气泡复制、**图片点击灯箱放大**（Esc 关闭）、链接点击系统浏览器打开、hover 完整时间、跨天时间线**居中**对齐、翻页滚动位置保持与去重、搜索高亮与空态、回到底部浮钮、会话内空态与失败提示 |
| **图片** | **本地图片关联全打通**：会话目录 = `attach/md5(会话username)`，文件名 hash 藏在消息 `packed_info_data` 内嵌 protobuf。列表内显示缩略图（`_t.dat`/`_t_W.dat`，jpg 约 4~6KB）；**点击放大自动换本地原图**：`_h.dat`（png 高清）直显，而微信 4.0 的原图 `.dat` 是 **`wxgf` 专有壳（内为 HEVC/H.265 单帧内编码）**——引擎剥壳出裸 Annex-B 码流，渲染层用 **WebCodecs `VideoDecoder`** 客户端解成 PNG（实测本机 145 张原图 **145/145** 解码成功，约 110ms/张，含解码器池化与结果缓存；关键点：wxgf 声明的 Main-Still-Picture `profile=3` 需归一化为 Main `profile=1`，level 必须取自 SPS）。缺平台 HEVC 解码器时优雅回退到缩略图。原图**尚未下载**（微信只留了缩略图）时如实提示"在微信中点开原图后可在『我 → 数据同步』获取"，不伪造 |
| **增量同步** | 微信登录在线时，「我 → 数据同步」可把新收发的消息**增量重解密**进来：只重解密 `(size, mtime_ns)` 变化的库（含 `-wal` signal），复制到临时文件+撕裂检测后解密，`os.replace` 原子替换，读者永不见半截库。实测微信不独占库文件、WAL 频繁 checkpoint（新消息已落主库，无需重放 WAL）。`status()` 廉价轮询（~35ms，只 stat）判断是否有更新；替换前经 `reset_caches()` 释放只读连接（否则 Windows 下被占用会失败） |
| **会话列表** | 排除微信内部占位会话（`brandsessionholder` / `brandservicesessionholder`）；**公众号折叠为单张聚合卡**（仿"订阅号消息"，显示数量与未读汇总，点进为子列表可返回）；未读角标贴头像右上角，不遮挡时间 |
| **通讯录** | 可选过滤开关 **非好友 / 无记录**（默认都隐藏）。contact 库含大量群成员与陌生人（本机 6071 条中 5373 条），按 `local_type==1` 判定真实好友；"无记录"指本地无该会话 `Msg_` 表。实测默认视图 310 项，放开后 6071 项 |
| **防逆向** | 8 层：入口签名 / 全量完整性清单 + 清单签名绑定 / 引擎源码字节码化并删源 / 主进程混淆 + minify 语法安全网 / 真实反调试（调试开关门禁·计时探测·蜜罐读取方）/ DevTools 全面封锁 / 单实例锁 / IPC 白名单 + 发送方校验（详见「防逆向 / 反侵入设计」）|
| **技术栈** | Electron 31 + 纯 Python 引擎桥接（JSON-RPC over stdio）+ 原生 HTML/CSS/JS（渲染纯逻辑层 `render.js` 浏览器与测试共用） |
| **自带运行时** | `npm run vendor:python` 把 **CPython 3.12.10 embeddable + cryptography + zstandard**（33.6 MB / 221 文件）打进 `dist/engine/py/`，装机即用，**不依赖用户环境里的 Python**；未打包时透明回退到系统 Python |

---

## 目录结构

```
wememo_app/
├── src/
│   ├── main/
│   │   ├── loader.js      # 启动入口：全量完整性校验 + 清单签名绑定 + 反调试门禁（不暴露逻辑）
│   │   └── main.js        # 主进程：窗口(发布态封锁DevTools) + 单实例锁 + IPC白名单 + Python桥接 + 外部链接放行 + 导出
│   ├── preload/preload.js # contextBridge 最小安全 API（意图化接口）
│   └── renderer/          # 微信风格 UI
│       ├── index.html
│       ├── css/app.css
│       └── js/
│           ├── render.js  # 纯逻辑渲染层（消息卡片 + 统计报告 + 个人主页 + 搜索结果，浏览器与测试共用）
│           ├── emoticons.js # 微信内置表情记号 [微笑]→emoji 映射（名字表抽自微信本体）
│           ├── wxgf.js     # 微信原图 wxgf(HEVC) → PNG 客户端解码（WebCodecs）
│           ├── app.js      # 渲染层主逻辑（DOM / 事件委托 / 懒加载 / 灯箱 / 搜索跳转 / 查找 / 快捷键 / 导出 / 同步）
│           └── icons.js
├── engine/                # Python 引擎（解码 + 数据访问 + 桥接）
│   ├── zstd_py.py         # zstd 解码器：原生 zstandard 快路径 + 纯 Python 回退
│   ├── wcdb.py            # 数据访问层 + 全类型解码器 + 复合游标分页 + 全文检索索引 + 统计/档案
│   ├── imgfile.py         # 图片 .dat 解密 + 消息→本地文件关联 + wxgf(HEVC) 剥壳
│   ├── livesync.py        # 微信在线时的增量重解密（只重解变化的库，原子替换）
│   ├── exporter.py        # 导出（HTML / TXT / JSON，单会话或全部）
│   ├── bridge.py          # JSON-RPC over stdio 桥接服务
│   ├── test_decode.py     # 解码器 + 本人判定 + 统计口径单元测试（不依赖真实库）
│   ├── test_paging.py     # 分页/取全/导出/统计/检索/上下文一致性测试（需真实库，缺库自动跳过）
│   └── make_preview.py    # 生成静态 UI 预览（供浏览器查看，不随发布）
├── build.js               # 构建：复制 + 混淆 + 签名注入 + 清单 + 引擎字节码 + 打包运行时
├── tools/
│   ├── fetch_python.js    # 下载并裁剪 CPython embeddable + 依赖 → runtime/（原子、可幂等）
│   └── test_bundled_python.js  # 自带运行时自检（缺 runtime/ 时优雅跳过）
├── runtime/python/        # 自带 Python 运行时（vendor:python 生成，不入版本库）
└── dist/                  # 构建产物（loader.js 入口）
```

---

## 使用

### 构建
```bash
# （可选，推荐）把 Python 运行时打进包内，之后不依赖用户机器上的 Python
npm run vendor:python      # 下载 CPython 3.12.10 embeddable + cryptography/zstandard → runtime/
node build.js              # runtime/ 存在时自动复制到 dist/engine/py/
```
> 不执行 `vendor:python` 也能构建，此时应用回退到系统 Python（需 3.9+ 且含 `cryptography`）。

### 运行（开发）
```bash
# 首次运行：自动探测微信数据目录并解密（无需手动配置）
npm start

# 指定微信数据目录（可选）
set WEMEMO_XWECHAT_ROOT=<xwechat_files路径>
npm start

# 指定已解密库（跳过自动解密）
set WEMEMO_DB_ROOT=<解密库根>
npm start
```

> 说明：自动解密使用本机绑定的 master key（跨机器需重新提取），
> 建议微信完全退出后首次解密以获得完整数据。

---

## 防逆向 / 反侵入设计（发布态生效）

> 「发布态」= 经 `node build.js` 产出、loader 注入了真实签名的 `dist/`。开发树（`electron .`）
> 全部主动防护自动跳过，不干扰调试。以下机制均已落地并有回归/对抗验证（见 `docs/终审报告…`）。

1. **入口签名校验**（`loader.js`）：`main.js` 的 SHA256 构建时注入，启动比对，不符即静默延迟退出。
2. **完整性清单 + 清单签名绑定**（`manifest.json`）：清单**全量**记录 283 项文件哈希（含引擎全部
   `.pyc` 与自带运行时 `engine/py` 下的原生 `.pyd/.dll/.exe` 和所有 `.py`）；loader 启动时**逐项**核对，
   任一被登记文件被改/被删即拦下。清单本身的 SHA256 也注入 loader（`MANIFEST_SIG`），
   **攻击者篡改文件后重算清单蒙混也会被这道绑定拦下**（已对抗验证）。
3. **引擎源码字节码化 + 移除明文**：除入口 `bridge.py` 外，全部引擎模块（含 `keyextract`/`decryptor`/
   `autodecrypt`/`wcdb`/`imgfile`/`livesync`/`exporter`/`sig_scan` 等）在构建期用**自带运行时**编译为
   **无源 `.pyc`**（`UNCHECKED_HASH` 失效模式）并**删除 `.py` 源码**；运行时以 `-B` 启动且
   `PYTHONDONTWRITEBYTECODE=1`，绝不再生成清单外的 `__pycache__`。hook 地址、PBKDF2 参数、解密算法
   等不再明文可见。
4. **主进程混淆 + minify 安全网**：`main.js`/`loader.js` 压缩去注释；构建期对 minify 产物做**语法校验**
   （`vm.Script`），破坏即让构建**显式失败**（历史坑：注释里的 `/**` 会被块注释正则误删代码）。
5. **真实反调试（运行期）**：命令行含 `--inspect`/`--remote-debugging-port`/`--inspect-brk` 等开关
   → 门禁拒绝加载 `main.js` 并静默退出；计时探测（连续 N 次墙钟跳变超阈值才判定，滤除抖动）；
   蜜罐标记 `__wememo_integrity` 有**读取方**周期校验，被改写即收尾。
6. **DevTools 全面封锁（发布态）**：窗口 `devTools:false` + 移除应用菜单 + 拦截 `F12`/`Ctrl+Shift+I/J/C`
   + 监听 `devtools-opened` 即关闭并按入侵处理；渲染层禁止导航/开新窗口/挂 webview。
7. **单实例锁**：`app.requestSingleInstanceLock()` 拿不到即退出，杜绝双开并发操作同一解密库的竞态，
   并堵住「第二实例附加调试」侧信道。
8. **IPC 最小面**：通用 `bridge` 通道校验**发送方为主窗口顶层框架** + **方法白名单**（只放行渲染层实际
   使用的只读查询）；`extract_key`/`auto_decrypt`/`export`/`init` 等只由主进程内部按需调用，不经该通道。
   引擎侧 `init` 只认首个 `dbRoot`、拒绝运行期切换，损坏请求行不会拖垮服务。

> `.pyc` 的 magic number 与解释器版本绑定（3.12 = 3531）。打包自带运行时后字节码**必须用自带解释器
> 编译**，`build.js` 已强制用 `engine/py/python.exe` 编译，保证与发布解释器一致。

所有保护层对用户**透明**，异常时不抛错、不写日志、不暴露原因。

---

## 技术要点

- **数据模型**：`Msg_<md5(username)>` 分片表 + `SessionTable` 会话 + `contact` 联系人；`local_type` 为 64 位（高 32 位子类型 + 低 32 位主类型）。
- **分页与取全（关键）**：同一会话的消息按时间分布在多个 `message_N` 库、各库 `local_id` 独立自增，且 **`sort_seq` 并不唯一**（实测单表内可有上百行共用同一毫秒）。因此排序与游标用 `(sort_seq, local_id)` 复合键，去重用全局唯一的 `server_id`（缺失退化为 `shard:local_id`），"是否到底"只由**空页/游标不再推进**判定——用"页不满"推断会提前截断（历史 bug：14989 条只取到 1820 条）。
- **历史会话补全**：`SessionTable` 只保留最近会话，已移除但 `Msg_` 表仍在的会话通过 `Name2Id`/`contact` 反查 `Msg_<md5>` 找回，标记 `archived` 并按最后消息时间并入列表。
- **消息解码**：非文本消息内容为 zstd 帧，解码后为 XML；`wcdb.py` 按主类型 + app 子类型分派到各解码器，产出 `(sender_hint, body, meta)`，`meta.kind` 驱动渲染层卡片。app 子类型修正：`sub=19` 为合并转发（非转账）、`sub=62` 拍一拍与视频号按内容消歧、`sub=2000/2001` 按 `paysubtype` 判收发。
- **zstd 双通道**：优先原生 `zstandard`（快 ~330×），失败或缺失时回退移植自 fzstd 的纯 Python 解码器（MIT License，零依赖）；`WEMEMO_FORCE_PURE_ZSTD=1` 可强制纯 Python 用于审计。两通道对 4133 帧输出逐字节一致。
- **性能缓存**：引擎维护只读连接池、分片表定位缓存、解码 LRU（512）、语音时长缓存（2048）、会话 2s TTL；首次解密用跨库多进程（`autodecrypt` jobs=CPU）。翻页首开实测 2~6ms。
- **渲染层性能**：消息交互（右键菜单 / 复制 / 打开链接）走**事件委托**，容器只挂 2 个监听器，数万条消息不产生数万闭包；`loadAllMessages` 批量模式跳过逐轮滚动锚定与懒加载注册（逐轮读 `scrollHeight` 会对增长中的列表强制同步布局，累积近似二次开销），结束后统一锚定并注册。
- **桥接协议**：Electron 主进程与 Python 引擎用 stdio 上的 JSON-RPC 通信，响应按 `id` 匹配；事件行（`{"event":...}`）用于解密与导出进度等异步推送；每次引擎调用带超时（常规 15s / 解密 120s / 单会话导出 5min / 全部导出 30min）。
- **导出**：`exporter.py` 复用解码结果（与界面所见一致），经 `iter_messages` 流式分页读取，大会话不占满内存。HTML 内嵌 base64 缩略图（有数量上限防文件过大）；文件名按会话名安全化（去非法字符、限长 80）；全部导出写入带时间戳的子目录。目录由主进程 `dialog` 选择，渲染层不接触路径。
- **布局**：消息挂在 `.chat-messages` 容器内，该容器必须与 `.chat-body` 同为 flex 列，否则子项 `align-self`（系统消息居中、我方右对齐）全部失效。侧栏与 Tab 栏必须 `flex: none`——否则右侧数据面板的 min-content 宽度会把侧栏挤成一列竖排文字（发现页曾出现）。
- **导航高亮（易错）**：主导航四个 Tab 的"索引 → 名字"映射只能有一份（`TABS`）。曾经高亮用 `['contacts','discover','me'].indexOf(tab) === i` 判定，而 `i` 是含"聊天"在内的 tabbar 下标，整体错位一位，结果除聊天外**任何 Tab 都不亮**。发现页/个人主页的页内章节导航用 scroll spy 跟随右栏滚动：判定线取容器顶部下方 90px，选"线之上最后一个面板"；滚到底部要强制选中最后一节（末节太矮时永远越不过判定线）；点击导航后锁高亮 600ms，避免平滑滚动途中章节一路闪过。
- **人民币符号（易错）**：转账金额必须用**全角 ￥(U+FFE5)**——微信自己写进 `feedesc` 的就是它（实测本机 1352 条转账全部如此），半角 `¥`(U+00A5) 是日元符号。解码时把 `feedesc` 原文存进 `meta.amount_text`，渲染与导出优先用原文，符号才与微信客户端逐字一致。
- **表情地址的三处来源**：`<emoji>` 消息取属性 `cdnurl`；企业微信（`@openim`）互通表情 `cdnurl` 为空，真实地址在 `tpurl`（`wwfile.work.weixin.qq.com`）；appmsg 内嵌表情（`type=49 sub=8`）的地址在 `<appattach cdnurl="...">` **属性**上而非同名子元素。三处都回退后，本机 26256 条表情的可显示率从 98.7% 升到 99.0%（余下 270 条消息体内确实没有任何 URL）。
- **全文检索**：微信本地库不存明文（`message_content` 为 zstd 帧），无法用 SQL LIKE，只能解码后匹配。首次检索时构建常驻内存索引 `(username, sort_seq, local_id, kind, sender, body)`，实测 23.8 万条 3.8s；之后换关键词为纯内存过滤（35ms）。条数超过 60 万时不建索引，退化为每次扫描以免内存膨胀。命中片段由引擎以关键词为中心截取（否则长消息里"命中却看不到关键词"），渲染层再二次居中并高亮。
- **跳转定位**：搜索命中带 `(sort_seq, local_id)` 游标 → `context()` 取前后各 30 条窗口。与常规视图不同，片段视图需要**双向**翻页：向上仍是 `messages(before_…)`，向下用 `_messages_after(strict=True)`（不含游标自身），日期分隔线因此需要同时跟踪已渲染的最早一天与最新一天。
- **统计口径**：类型分布不解码内容——`local_type` 高 32 位即 app 子类型，`kind_of()` 直接映射，故每张 Msg 表只需一次 `group by local_type, 是否本人, 日期` 的聚合扫描（23.8 万条 1.5s）。系统提示（10000/10002/11000）不计入收发比。
- **本人账号判定（易错）**：优先从**目录名**解析（`wxid_xxx_c359`，解密库与 xwechat 账号目录同名），其次 `contact` 表 `id=1`——实测**并非所有库的 id=1 都是本人**（自动解密产出的库里 id=1 是 `notifymessage`），命中系统伪账号（`_SYSTEM_ACCOUNTS`）时视为无效。判定错误会导致全部消息的收发方向反转。另外 `_detect_self()` 依赖连接缓存，必须在 `self._conns` 初始化之后调用。
- **图片元数据与显示**：解码时提取 `aeskey / md5 / 尺寸 / file_hash`；`file_hash` 来自 `packed_info_data` 内嵌 protobuf。本地 `Img/` 下同一 hash 有多种变体，按用途择优：缩略图取 `_t.dat` → `_t_W.dat` → `_t_NW.dat`，原图（灯箱放大）取 `_h.dat`（png 高清）→ 无后缀 `.dat`。**原图 `.dat` 是 `wxgf` 专有壳**：解密后头 4 字节为 `wxgf`，内部是 **HEVC/H.265 Annex-B 单帧内编码**（`00 00 01` 起始码 + VPS/SPS/PPS/IDR，NAL 类型 32/33/34/19），概念上类似 HEIC。引擎 `wxgf_annexb()` 从首个 VPS 起始码剥出裸码流，渲染层 `wxgf.js` 用 WebCodecs 解码。**关键坑（实测）**：① wxgf 的 `general_profile_idc=3`（Main Still Picture）Chromium 接受配置却拒绝码流，把 VPS+SPS 里这一字节改成 `1`（Main，码流自带的 compatibility_flags 已声明兼容）即可解；② codec 字符串的 level 必须取自 SPS（写死 `L93` 会在 L120/L150 码流上失败）；③ Chromium 无 HEVC 软解，缺平台解码器时全部优雅回退 null。**为什么大多是缩略图**：微信只把缩略图落到本地（本机 19k 图中 `_t*.dat` 19071 个、`_h.dat` 61 个、原图 176 个其中 145 个 wxgf），未点开过的图原图不在本地——只能在微信中点开后经增量同步纳入。渲染层 IntersectionObserver 一次性懒加载 + LRU 缓存，宽高比预留占位。
- **增量同步（微信在线）**：`livesync.py` 不实现任何密码学，密钥派生/逐页解密全复用 `decryptor`/`autodecrypt`。变更签名 = 主库 + `-wal` 的 `(size, mtime_ns)`（不含 `-shm`：读操作也会改它，纳入只会误报）。实测结论写进模块文档：微信以共享模式打开库、可直接读；WCDB 开 WAL 但频繁 checkpoint、有效帧恒为 0（新消息已落主库，故不重放 WAL，并留 `wal_has_frames()` 自检）；`.db.factory` 备份桩能过首页魔数却非合法 SQLite，记入状态 `bad` 字段避免每次都报"有更新"。原子性：解密到 `.plain.tmp` → `os.replace`；**读者（`WCDBStore` 的 sqlite 只读连接）不释放会导致 Windows `os.replace` 拒绝访问**，故 bridge 传 `release=store.reset_caches` 先关连接，成功后再 `reset_caches()` 让下次访问读新库。
- **表情**：`emoji` 的 `cdnurl`（http/https）由渲染层懒加载直显（CSP `img-src` 已放行），无 url 时占位。
- **链接**：`link/miniprogram/channel` 的 `url` 经主进程 `open:external` 校验协议后交系统浏览器打开（离线应用不内嵌 web 内容）。
- **头像**：直接引用 contact 库中的头像 URL（本地缓存可后续增强）。

## 测试

```bash
# 一键回归：聚合全部 Node 逻辑测试 + 引擎 Python 测试（子进程强制 UTF-8 stdio；
# 缺真实库/密钥的用例自动跳过；startup_sim 需先 npm run build）
npm test

# 引擎：解码器 + 本人账号判定 + 统计口径（全类型 / 子类型消歧 / 摘要清理）
python engine/test_decode.py

# 引擎：分页取全、导出、全量统计、全文检索、上下文定位一致性
# （真实库；逐条对齐 count(*)，缺库自动跳过）
python engine/test_paging.py

# 引擎：zstd 解码器回环（原生快路径 + 纯 Python 回退，逐字节比对）
python engine/test_zstd_loopback.py
WEMEMO_FORCE_PURE_ZSTD=1 python engine/test_zstd_loopback.py

# 主进程桥接模拟（不依赖 Electron GUI）
node tests/test_bridge_node.js

# 渲染层逻辑测试（复用 src/renderer/js/render.js，测的即上线代码）
node tests/test_renderer_logic.js

# 内置表情映射（名字表 / 别名 / 白名单 / XSS / 往返还原）
node tests/test_emoticons_logic.js

# wxgf(HEVC) 解码纯逻辑（Annex-B 扫描 / codec 串 / 无 WebCodecs 优雅降级）
node tests/test_wxgf_logic.js

# 引擎：wxgf 剥壳 + Annex-B 提取（真实 145 张原图；缺库自动跳过）
python engine/test_wxgf.py

# 引擎：增量同步（变更检测 / 原子替换 / 锁定跳过 / status 非侵入；缺库或密钥自动跳过）
python engine/test_livesync.py

# 启动流程模拟（loader 全量完整性校验 → main.js 加载 → 窗口创建；需先 npm run build）
node tests/test_startup_sim.js

# 自带 Python 运行时自检（解释器 / cryptography / zstandard / bridge ping）
npm run test:python
```
