# decrypt_wxdb

微信 4.0 本地数据的研究与归档工具集。本仓库用于个人设备上自有数据的备份与查阅。

> ⚠️ **请仅用于解密你自己设备上的数据**，并遵守适用法律与软件条款。
> 请勿提交他人的聊天记录或任何未经授权获取的数据。

---

## 仓库范围

本仓库采用**分层策略**：只承载「文档 + 前端外壳」，解密引擎与密钥材料一律不入库。

```
decrypt_wxdb/
├── wememo_app/          # 微忆 WeMemo —— 微信 4.0 聊天记录离线归档应用
│   ├── src/renderer/    # ✅ 渲染层：微信风格 UI、主题引擎、wxgf(HEVC) 原图解码
│   ├── src/preload/     # ✅ contextBridge 最小安全 API
│   ├── src/main/        # ✅ 主进程：窗口、IPC 白名单、启动完整性校验
│   ├── docs/            # ✅ 主题引擎设计、安全加固与终审报告
│   ├── tests/           # ✅ Node 侧回归测试
│   ├── tools/           # ✅ 构建与辅助工具
│   └── engine/          # ❌ 禁入：Python 解密引擎（见下）
└── archive/             # ❌ 禁入：逆向脚本；✅ 仅保留脱敏后的分析笔记与开发历程
```

### 已入库内容

| 路径 | 说明 |
|---|---|
| `wememo_app/src/renderer/` | 渲染层主逻辑、三栏式布局、主题引擎（mecha / cyberpunk）、内置表情映射 |
| `wememo_app/src/main/` | 主进程与 `loader.js`（全量完整性校验 + 清单签名绑定 + 反调试门禁） |
| `wememo_app/docs/` | 主题引擎设计与交付说明、安全加固报告、终审报告 |
| `wememo_app/tests/`、`tools/` | 回归测试与构建工具 |
| `archive/*.md` | 静态分析笔记、脱敏后的完整开发历程 |

### 未入库内容及原因

| 路径 | 体积 | 排除原因 |
|---|---|---|
| `wememo_app/engine/` | 608 M | **核心解密引擎**（`decryptor` / `keyextract` / `wcdb` / `pyaes_fallback`），及 `_verify_tmp`、`_bench_tmp` 下的解密明文数据库 |
| `archive/**/*.py` | 2.4 M | 逆向脚本，其中硬编码主密钥 61 处 |
| `archive/weflow_extract/` | 2.9 M | 第三方（WeFlow）打包产物，仅作逆向参考 |
| `wememo_app/keys/`、`license.dat` | — | Ed25519 **私钥**与签发产物 |
| 构建产物 | ~1.8 G | `node_modules` / `.toolchain` / `release` / `runtime` / `dist` |

上述排除规则全部记录在 [.gitignore](.gitignore)，按类型精确屏蔽。

---

## 安全设计

**纵深防御**：仓库层面（密钥不入库）+ 发布层面（8 层防逆向，见 `wememo_app/docs/`）。

入库文件经脱敏处理，不含任何真实凭据：

- 密钥材料一律以 `<REDACTED_MASTER_KEY>` 占位
- 真实账号标识以 `<YOUR_WXID>` 占位
- 本地绝对路径改为 `%USERPROFILE%` 相对形式

> 文档中出现的长度 64 位十六进制串多为**公开 SHA256 校验和**（如 Ed25519 公钥指纹、
> 测试基线、发行包校验），非密钥。

### 密钥获取

密钥提取能力**已完全自研**，不依赖任何外部工具：

- 自动化流程：探测微信进程 → 注入 hook → 轮询获取密钥
- 数据目录按 `wxid_*` 通配符自动定位，跨机器通用
- 硬编码密钥对功能无不可替代性，**已从本仓库完全移除**

---

## 开发

完整的功能说明、技术要点与构建指引见 **[wememo_app/README.md](wememo_app/README.md)**。

```bash
cd wememo_app
npm install

# 可选：把 Python 运行时打进包内，之后不依赖系统 Python
npm run vendor:python

npm start        # 开发运行
npm test         # 一键回归
node build.js    # 构建发布态
```

> 注：本仓库不含 `engine/`，克隆后无法独立完成解密与端到端运行。
> 引擎为本地私有资产，如需完整功能请在自有环境中维护完整仓库。

---

## 致谢

- `zstd` 纯 Python 解码器移植自 [fzstd](https://github.com/101arrowz/fzstd)（MIT License）
- 表情名字表抽自微信客户端 Qt 资源与 `newemoji-config.xml`

## 许可

仅供个人研究使用。请勿用于任何未经授权的数据获取或分发。
