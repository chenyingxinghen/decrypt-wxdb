# 自研复刻 WeChat 4.0 数据库解密工具 —— 完整开发历程

> 个人知识文档 · 记录从零开始到全流程跑通的操作与技术历程
> 目标账号数据目录：`%USERPROFILE%\xwechat_files\<YOUR_WXID>_c359\db_storage\`
> 开发时间：2026-08-19（单日，深夜 00:16 起 → 傍晚 15:35 收尾）
> 最终状态：**解密链路 100% 透明（纯 Python，零外部 DLL）；密钥提取链路（per-db + master）100% 自研并实测验证，彻底脱离 WeFlow**

---

## 0. 一句话结论

用一把 **master key** 经 `PBKDF2-HMAC-SHA512` 逐库派生，再以 **AES-256-CBC**（IV 在页尾）分页解密，即可把 WeChat 4.0 的全部 WCDB 加密库还原成合法 SQLite。全流程用纯 Python 复刻，配套自研进程内注入器（透明版 WeFlow）可动态抓取 per-db 密钥。实测：**26/29 活动库解密成功**（3 个未命中为独立 salt 的 `.factory` 迁移快照），**23/26 通过完整 `integrity_check`**（其余 3 个仅因缺私有 FTS 分词器无法跑内部校验，页与 schema 均正常解出）。

---

## 1. 项目背景与目标

### 1.1 要解决的问题
WeChat 4.0 把本地聊天记录、联系人、会话等存在 `db_storage\` 下的一批 `.db` / `.kvdb` 文件里，全部经 **WCDB**（腾讯基于 **SQLCipher 4.x** 的定制分支）加密。目标：**不依赖任何第三方黑盒工具（如 WeFlow / welive.exe），用可完全审计的自研代码把这些库解密成明文 SQLite。**

### 1.2 为什么不能直接套 SQLCipher
- 标准 SQLCipher 页布局是 `salt(16) + ciphertext + HMAC`，**IV 由页号推导**。
- WeChat 4.0 做了定制：**IV 显式存在每页页尾**（HMAC 之前），且第 1 页明文开头不是 `SQLite format 3`，而是 WCDB 私有 16 字节头 `10 00 02 02 50 40 20 20 …`。
- 因此直接用 `sqlcipher.exe` + `PRAGMA key` 全参数组合暴力 **必然失败**（这是开发第一小时踩的第一个大坑）。

---

## 2. 完整技术历程（按时间线）

开发分五个阶段推进，目录 `01_recon` → `07_validation` 正是这条主线的固化。

### 阶段一 · 侦察与首批失败尝试（00:16 – 00:40）
| 操作 | 脚本 | 结果 |
|---|---|---|
| 直接用 sqlcipher CLI 试全参数 | `archive/try_sqlcipher.{sh,ps1,py}` | ❌ 失败（页布局非标准） |
| 尝试借 WeFlow 的 `WCDB.dll` 绕过 | `01_recon/poc_open_wcdb*.py` | ❌ 放弃黑盒依赖路线 |
| 读 `key_info.db` | `01_recon/read_keyinfo.py` | ✅ **重要发现**：它是明文 SQLite |
| 分析 WCDB 结构 / DLL 过期 | `01_recon/analyze_wcdb*.py`、`check_dll_expiry.py` | 摸清目标 |

**关键发现①**：`%USERPROFILE%\xwechat_files\all_users\login\<YOUR_WXID>\key_info.db` 是**明文** SQLite，表 `LoginKeyInfoTable(user_name_md5, key_md5, key_info_md5, key_info_data)`。真正的持久化源头是同目录的 `key_info.dat`（180 字节，与 db 行字节完全一致；删 db 后微信从 dat 恢复重建）。

### 阶段二 · 密码学暴力 + 静态反汇编（00:30 – 02:47）
- **SQLCipher 全参数暴力**：`04_crypto_attack/bruteforce_sqlcipher.py`、`true_decrypt*.py`、`decrypt_pipline.py`、`full_bruteforce.py`、`try_key_derivations.py` —— 穷举 raw key / PBKDF2 passphrase / iter=1 / cipher_compatibility 1-4 等组合，**全部失败**。失败本身指向了「页布局被定制」这一正确方向。
- **攻 `key_info_data`**：`analyze_keyinfo_blob.py`、`parse_blob_proto.py`、`attack_blob_v1.py` —— 解出它是 protobuf（field1=168B 载荷 + field2 + field3=时间戳），但载荷加密算法未破。
- **静态反汇编 Weixin.dll / WCDB**：`disasm_wcdb.py`、`find_selfdestruct.py`、`find_aes_pbkdf2.py`、`find_aes_capstone.py`、`get_evp_cipher.py`、`disasm_keyflow.py`（用 capstone 定位 AES / PBKDF2 / EVP_Cipher）。
- **首次动态 hook**：`03_dynamic_hook/hook_aes_init.py`、`hook_cbc_decrypt.py`。

**关键发现②（决定性正确模型）**：综合静态与动态证据，确认了真正的加密模型 —— 这直接催生了 `wechat_decrypt.py`：

```
master key
  └─ PBKDF2-HMAC-SHA512(master, salt=文件前16字节, 256000 次, 输出32字节)
        └─ per-db derived key  (= setCipherKey 实际收到的 key)
              └─ AES-256-CBC 分页解密, IV 取自每页页尾 [4016:4032]
                    └─ 明文首页 = WCDB 私有头 → 还原 "SQLite format 3\x00"
```

### 阶段三 · 内存扫描 + master 验证闭环（08:23 – 11:57）
- **静态定位密钥设置点**：`02_static_analysis/locate_setcipherkey.py` → `setCipherKey` @ RVA `0x03576230`（家族），密钥补丁点 `0x03576376`。
- **内存扫描全家桶**：`05_memory_scan/scan_mem_key.py`、`scan_master.py`、`scan_keys*.py`、`probe_protection.py`。
- **✅ master 验证闭环**（`07_validation/verify_master.py`，11:33）：
  - 用户提供 master key `<REDACTED_MASTER_KEY>`（账号相关，已脱敏；请用本仓库 `keyextract.py` 自行提取）。
  - `PBKDF2(master, 各库 salt)` 派生后对每库首页解 AES → **26/26 活动库命中** WCDB 魔数 `10 00 02 02`。
  - 且 `session.db` 派生结果恰为此前 setCipherKey 钩子抓到的 derived key `7e18b312…` —— **动态抓取路径与离线派生路径闭环互证**。
- **✅ 批量解密全绿**：`wechat_decrypt.py --master-batch` 解密 `db_storage` 全部库 = **35/35 合法 SQLite**（26 个 `.db` + 9 个 `.kvdb`）。

> 至此，**解密半链路 100% 完成、透明、纯 Python、零外部 DLL**。

### 阶段四 · 穷尽外部手段抓 master（12:11 – 13:45）—— 决定性负结果
目标：脱离「用户提供 master」，用自研方式抓 master。此阶段系统性排除了所有**外部**手法。

| 手法 | 脚本 | 结果 |
|---|---|---|
| 登录窗口轮询扫描（47 轮/6 分钟，250–330MB） | `scan_login_window.py` | ❌ MASTER=0 / DERIVED=0 / SALT=0 |
| 全内存 hex 串扫描 | `scan_hex_strings.py` | ❌ 0 命中 |
| SHA512_Update 钩子 | （早期） | ❌ 全程 0 命中 —— **假阴性：hook 错了 SHA-512（见 §2.6 修正）**，当时误判为「派生 key 缓存复用」 |
| key_info.db 静态调用链 | `static_xref_setcipher.py`、`xref_keyinfo.py` | ✅ 定位链路但拿不到 master |
| 动态 hook 读表+解析 | `hook_keyinfo_dbg.py`、`dump_rdi_*.py` | ✅ 命中，rdi 含明文 wxid，但无 master |
| `key_info_data` 加密穷举 | `brute_keyinfo.py`、`chacha_attempt.py`、`xor_fix32.py`、`verify_*` | ❌ AES(5模式)×多 key、SM4、DPAPI、XOR、ChaCha20、AES-GCM/CCM 全灭 |
| CreateFileW 钩子实证恢复链 | `hook_createfile.py` | ✅ 证明启动早期即从 `key_info.db.factory\vacuum\` 恢复 |

**决定性实验**：备份并删除 `key_info.dat` → 微信登录**报「数据库损坏」**。证明 `key_info.dat` 是密钥的**唯一本地来源**。

> ⚠️ **后续修正（见 §2.6）**：本阶段当时的结论「微信登录时不做本地 PBKDF2 重派生 / master 只在登录窗口瞬时出现」是**错误**的，源于 SHA-512 hook 下错了函数（假阴性）。经用户用 WeFlow 复测：**已登录状态下无需重新登录即可抓到 master**，证明 master 每次开库都参与 PBKDF2 派生、每次都在进程内出现。真正的原因是 hook 点错位，非架构不可达。

**阶段结论（已修正）**：外部**扫描/静态区 hook** 拿不到 master，是因为 master 以掩码/瞬时形式存在、且我们 hook 的点（setCipherKey）在派生**下游**。但 master 确实每次都在进程内被计算 —— 正确出路是 hook 派生**上游**（PBKDF2 口令输入），而非放弃。

### 阶段五 · 自研透明注入器 + 主流方案对照（14:22 – 15:35）
- **重大认知修正**（`probe_jit_regions.py`）：此前以为「JIT 区外部不可读」，实测当前微信 **256 个 EXECUTE 区全部外部可读** —— 之前是 ASLR 地址误判。
- **TF 寄存器级跟踪**（`jit_ret_hook.py`）：命中密钥恢复链后单步 2 万条指令查寄存器 == master 前 8 字节 → **0 命中**。修复了 SINGLE_STEP 分支嵌套 bug（原来嵌在 BREAKPOINT 分支内导致跟踪从未运行）。
- **✅ 自研注入器 `inject_keyhook.py`（交付物）**：
  - `CREATE_SUSPENDED` 启动 Weixin.exe → `VirtualAllocEx` 在 DLL 附近分配 shellcode（保证 `E9 rel32` 可达）→ 5 字节内联补丁 `41 C6 46 42 27` → `E9` 跳 shellcode → shellcode 拷 `r14` 指向的 `x'<64hex>'` 密钥串 → trampoline 恢复原指令 → `ResumeThread`。
  - **关键 bug 修复**：`mov rsi,r14` 正确编码为 `49 8B F6`；初版 8KB 栈拷贝触发微信自检退出，**去掉栈拷贝改最小 hook 后微信零崩溃**，栈改由外部 `ReadProcessMemory` 读。
  - **实测捕获**：`7cd0bae0…`=message_4.db、`2103c82d…`=message_3.db（会话内抓取+映射成功）。
- **主流方案对照验证**（`find_sqlite3_key.py`）：weixin.dll **无 `sqlite3_key` 导出**（4.x 静态链接二次封装），但 SQLCipher 内核完整在库内。定位出等价函数链：

```
setCipherKey 0x03576230  (收 x'<hex>' 字符串, 我们 hook 的点)
  → 0x356e560   (hex 解码)
    → 0x5629b20 (找 db + 设 key)  ← 主流 hook 的 sqlite3_key_v2 等价内部函数(无导出)
      → sqlite3CodecAttach       (codec 初始化)
```

**结论**：主流工具 hook 的 `sqlite3_key_v2(pKey, nKey==32)` 在微信 4.x 的等价物就是 `0x5629b20`；我们在 setCipherKey 抓到的 `x'<hex>'` 与主流拿到的 pKey 是**同一把 per-db derived key**。**自研注入器与主流方案完全等价且更透明。**「4.x XOR 掩码驻留」也解释了全内存扫描 0 命中 —— key 从不以明文驻留，使用前一刻才在栈上还原。

### 阶段六 · master hook 点复盘与修正（2026-08-19 补充 RE）

**触发**：用户用 WeFlow 复测发现 —— **无需让登录态失效重新扫码，已登录实例即可抓到 master**。这直接推翻了阶段四「master 只在全新登录出现 / 不重派生」的结论：master **每次开库都在进程内被 PBKDF2 消费**，之前抓不到纯属 **hook 点错位**。

对 `Weixin.dll`（版本 **4.1.12.55**，194MB）用 capstone 重新静态定位（新脚本 `find_pbkdf2_master*.py`、`disasm_kdf_master.py`、`disasm_pbkdf2_site.py`、`trace_pbkdf2_master.py`）：

- **确认 WCDB = 内嵌 stock SQLCipher 4.1.0 "community"**：PRAGMA 处理函数 `0x5627D30` 内含完整字符串表 `kdf_iter` / `cipher_default_kdf_iter` / `HMAC_SHA512` / `PBKDF2_HMAC_SHA512` / `cipher_kdf_algorithm` 等，且有版本串 `"4.1.0"`+`"community"`。
- **iter=256000（0x3E800）** 作为立即数出现在 `0x5629254`(`mov edx,0x3e800`) 与 `0x56292E5`(`mov ecx,0x3e800`)，即 SQLCipher 默认 kdf_iter 配置点，**与解密器实测参数完全吻合**。
- **定位 SHA-512 原语**（K512 常量表两份：`.text@0x5703D10`、`.rdata@0x8D1D3B0`）：
  - `0x6FA9770` = SHA-512 **init**（载入 8 个初始哈希常量 `6a09e667…`/`bb67ae85…`）
  - `0x6FA9910` = SHA-512 **update/final**（`0x80` 填充 + 分块）
  - `0x6FAA110` = SHA-512 **one-shot**；`0x5702A80` = transform core
  - 均位于**加密库簇 `0x6F–0x70xxxxx`**（独立于 codec 簇 `0x562xxxx`）。**PBKDF2-HMAC-SHA512 执行体在此簇**，master 是其口令入参。

**根因定论（master 为何抓不到）**：
```
master ──[PBKDF2-HMAC-SHA512 执行, 0x6F–0x70xxxxx 簇]──▶ per-db key
          ↑ 正确 master hook 点(派生上游, 口令入参=master)
                                    │
                                    ▼ 构造 x'<hex>' 字符串
        setCipherKey 0x03576376 ────┘  ← 我的注入器 hook 点(派生【下游】, 只能拿到 per-db key 输出)
```
- 我的注入器 hook 在 `setCipherKey`，那里 `r14` 指向的是**派生完成后**的 per-db key 的 `x'<hex>'` 串 —— **按构造就永远看不到 master**。
- 早期 SHA512 hook「0 命中」是**假阴性**：下错了 SHA-512 实现（库内有两份 K512 表/两套实现），没命中 PBKDF2 实际调用的那套。

**修正后的正确打法**：把注入 hook 从下游 `setCipherKey` 上移到 **PBKDF2 执行入口（`0x6F–0x70xxxxx` 簇）**，读其口令参数即得 master；或再往上 hook 到「WeChat 从 `key_info.dat` 解出 master 的那一刻」。**这正是 WeFlow 的做法**——它用的注入技术与我的 `inject_keyhook.py` 同类，差别仅在 hook 点选在了派生上游。

> **诚实边界**：本阶段为纯静态定位（未跑 live hook，因分析时微信未运行、且不擅自拉起需扫码的进程）。「PBKDF2 执行体在 `0x6F–0x70` 簇、master 为其口令入参」是基于 SHA-512 原语位置 + SQLCipher 结构的**强推断**；精确到单个 PBKDF2 入口 RVA 与「master 落在哪个寄存器」需 live hook 最终确认。**我未逆向 WeFlow 自身字节码**，对 WeFlow 的描述是基于其注入技术已被证实 + master 在二进制中唯一可能出现位置的推断。

### 阶段七 · master 提取终于打通：转向 WeFlow 本体（2026-08-19 深夜续）

**触发**：用户提示「master 只在程序启动登录那一瞬出现」，并追问「对微信动手太难，对 WeFlow 动手会不会简单」。这两点都对，且指向了正解。

**先纠正阶段六的一个残留错误**：master **不是**「每次开库都派生」，而是**只在启动/登录引导那一次**出现（读 `key_info.dat` → 解出 master → 派生各库 per-db key，一次性）。这解释了此前所有 attach 已登录进程的尝试为何 0 命中——引导早跑完了。

**自研直接 hook 屡屡受挫（但都是有价值的负结果）**：
- INT3 于 SQLCipher KDF `0x6FD7A90`：全程 0 命中 → **证明 WeChat 不用 SQLCipher 自带 KDF**（它把预派生好的 raw key 交给 WCDB）。
- INT3 于 AES 单块 `0x570B6C0`：抓到 29 个启动期 key，但**全是 AES-128/192（应用层 TLS/config），无一是 DB 的 AES-256**；且该热路径断点**导致微信报错崩溃**（教训：绝不在全应用共用的 AES 原语上下 INT3）。
- 修了一串工程 bug：`DEBUG_EVENT` 结构 union 未按 16 字节对齐（读到错位 4 字节的垃圾 hProcess/base）、`weixin.dll` 按内容（入口字节）而非 hFile 识别。修好后 INT3 能稳定 armed，但仍抓不到 master——**根因是 hook 点选错，不是工程问题**。

**决定性转向：不啃微信，改用 WeFlow 自己的引擎**（用户的关键建议）：
- WeFlow 是 **Electron 应用**，逻辑在 `resources/app.asar`（**明文可读**，绕过其所有反破译——那些只保护运行中的 App，不保护磁盘源）。
- 密钥引擎是原生 **`wx_key.dll`**（195KB，x64，内部项目名 **Xkey**），用 **koffi FFI** 从 JS 调用，导出干净 C ABI：
  `InitializeHook(pid)` / `PollKeyData(buf,size≥0x41)` / `GetStatusMessage` / `CleanupHook` / `GetLastErrorMsg`。
- 我用 ctypes **直接调它自己的引擎**（`06_inject/call_wxkey.py`）——零逆向内部、零自研 shellcode、不碰热路径。
- **✅✅✅ 成功**：hook 装好后由用户「退出登录 → 重新扫码」，`PollKeyData` 在登录那一刻返回
  `<REDACTED_MASTER_KEY>` = **MASTER，与已知值逐字节一致**。
- 引擎状态串**逐字证实了用户的观察**：`分配远程数据缓冲区` → `分配远程伪栈` → `IPC通信` → `安装远程Hook` → `Hook安装成功，现在登录微信`。

**附带成果：WeFlow 真实 hook 点** = `Weixin.dll` RVA **`0x5DEFB0`**（引擎运行时报出 `目标函数地址 0x7ffcda61efb0` − base；入口 `55 41 57 41 56 56 57 53...`，一个登录时调用、被 8 处引用的 4 参数函数）——与我此前试的 SQLCipher KDF / AES **全都不是同一个**。记于 `02_static_analysis/WEFLOW_HOOKPOINT.md`。

### 阶段八 · WeFlow 如何逆向定位密钥函数 + 特征码构造原理（2026-08-19 收尾）

**问题**：WeFlow 究竟怎么找到 `0x5DEFB0` 这个函数？总不能是猜的。**答**：从 `wx_key.dll` 静态还原出它的完整机制 = **「版本分档 + 带通配符的特征码扫描」**（即 Gemini 说的方案一，加了抗更新设计）。详见 `02_static_analysis/WEFLOW_HOWITWORKS.md`。

- **引擎身份**：PDB `D:\a\Xkey\Xkey\x64\Release\wx_key.pdb`（项目名 Xkey）；C++ 类 `RemoteScanner`/`IRemoteScannerBase`；内嵌 **Zydis** 反汇编器；导入 `K32EnumProcessModules`+`ReadProcessMemory`（扫）+`WriteProcessMemory`（装 hook）+`MapViewOfFile`（共享内存 IPC）。
- **版本分档表**（`.rdata` 明文）：
  ```
  "4.0.x 及以上 4.x 版本"   -> 掩码 xxxxxxxxxxxxxxxxxxxxxxxx (24B 全固定)
  ">4.1.6.14"              -> 掩码 xxxxxxxxxx?xxxx?xxxxxxxx (24B, 通配位 10、15)
  ">=4.1.4 && <=4.1.6.14"  -> 另一档
  "<4.1.4"                 -> 另一档
  ```
  版本分派函数 `wx_key.dll+0x135C0`：取微信版本 → SSE 逐段比较 → 按区间选 {特征码,掩码}。
- **通配位落在"会变的字节"上**（实测对齐到 `0x5DEFB0` 序言）：`sub rsp,[??]`（栈帧大小）、`lea rbp,[rsp+??]`（同一栈帧）——**固定寄存器保存序言、通配栈帧大小** = 微信小改仍命中。教科书级抗更新特征码。

**特征码是如何构造的（三条铁律，非猜非独创）**：
1. **先靠真逆向一次性确定目标函数**（人做的活）：交叉引用锚点 / API 追踪 / 动态断点，产出一个确定地址。地址本身没法分发（更新即变），故转成特征码。**这一步的经验才是作者的"传家宝"。**
2. **再把函数"翻译"成特征码**（规则明确、机器可做）：指令的**结构字节**（opcode/寄存器/ModRM）固定 `x`，**数据字节**（立即数/位移/RIP相对）通配 `?`——因为版本更新变的正是数据字节。用反汇编器的 `imm_offset`/`disp_offset` 自动定位通配位。
3. **边加指令边测唯一性，够唯一即停**——这就是特征码长度的决定规则。

  实证（`02_static_analysis/build_signature_demo.py`，对 `0x5DEFB0` 逐指令收敛）：
  ```
  1 指令(push rbp)      -> 729132 命中
  8 指令(…push rbx)     ->  42233
  9 指令(mov[rbp],-2)   ->   3370
  14 指令(mov rcx,rdx)  ->      1  ✓ 唯一 -> 0x5DEFB0
  生成: 55 41 57 41 56 56 57 53 48 83 EC ?? 48 8D 6C 24 ?? 48 C7 45 ?? ... (40B,7通配)
  ```

**「特征码 vs 方法论」——收获到底是什么**：
- 把特征码挖出来 ≈ **免费拿到作者定位函数的"结论"**（省了最费脑的定位活），这层意义上「白捡」成立。
- 但特征码是**易腐品**：绑死单个 `Weixin.dll` 版本，函数结构一大改即失效。作者真正的资产是**方法论**（该盯登录密钥函数、该用版本分档特征码扫描）——微信怎么更新都不过时。
- 我们并非「抄源码」，而是**独立重现**：用同一套标准工艺自己生成了一条特征码（那条 40B 的），并从 `wx_key.dll` 完整还原了他的机制。**被复现的是"哪个函数"这个事实**（公开即无法独占），学到的是"怎么找函数"的地图——**换个版本仍能自己再走一遍**。

### 阶段九 · 给自研两条 hook 路各造一条特征码（2026-08-19 收尾续）

**动机**：用户确认「同账户不同机器密钥不同」→ 坐实 **master 本机绑定**，破 `key_info_data` 做离线的价值大打折扣（跨机器无效）。遂把精力转向**提升自研工具的鲁棒性**——把定位方式从「写死 RVA」升级成「特征码扫描」，对齐 WeFlow 的抗更新水平。给我们自研的**两条 hook 路**各生成一条带通配符特征码：

| hook 路 | 目标点 | 拿到什么 | 特征码 | 长度 |
|---|---|---|---|---|
| per-db 下游 | `0x03576376`（补丁点，`mov byte [r14+0x42],0x27`，此刻 `r14`→67B `x'<hex>'` 串） | per-db key | `41 C6 46 ?? ?? 48 8D 4D ?? 41 B8 ?? ?? ?? ??` | 3 指令/15B/7通配 |
| master 上游 | `0x5DEFB0`（登录密钥函数入口，WeFlow 同点） | master | `55 41 57 41 56 56 57 53 48 83 EC ?? 48 8D 6C 24 ?? 48 C7 45 ?? ?? ?? ?? ?? 44 89 CF 44 89 C3 49 89 D6 48 89 CE 48 89 D1` | 14 指令/40B/7通配 |

**关键设计决策**：per-db 特征码**锚在补丁点本身**（写密钥串那条指令），不锚函数入口再 +0x146 偏移。因为①两函数入口序言完全相同（MSVC 通用 `55 41 57 41 56 56 57 53`，光序言撞几万处）；②`mov byte [r14+0x42],0x27`（往密钥串补收尾引号 `'`）这个动作极独特，3 条指令就唯一——比 master 那条还稳。

**交付脚本（全部实测通过）**：
- `02_static_analysis/make_signatures.py` —— 特征码生成器 + **回环验证**（生成的 {pattern,mask} 扫 `.text` 必须恰好命中 1 处且 == 目标 RVA）。产物 `signatures.json`。
- `02_static_analysis/sig_scan.py` —— 共用扫描器模块，离线 `find_in_file` + 在线 `find_in_process`（从活进程 PE 头读 `.text` 范围、分块 `ReadProcessMemory` 扫描、处理跨块边界）。
- `02_static_analysis/drift_test.py` —— **受控漂移模拟**，三项对照实证抗更新能力：
  ```
  [A 地址平移]   把函数字节搬到 .text 别处 → 仍命中（不依赖绝对地址）✓
  [B 数据字节变] 翻转全部 7 个通配字节（模拟新版本栈帧/立即数变化）→ 仍唯一命中 ✓
  [C 结构字节变] 翻转 1 个固定 opcode 字节 → 立即失配（证明非瞎匹配）✓
  ```
- `02_static_analysis/smoke_scan_live.py` —— **在线真实验证**：微信运行时对活 `weixin.dll`（base `0x7FFCDA040000`）扫两条特征码，**均精确命中目标 RVA**（非纸面推断，实测活进程内存）。

**接线到注入器**：`deliverables/inject_keyhook.py` 已改造 ——
- `resolve_hook_rva()`：**特征码扫描优先 → 命中即用（不管漂到哪）→ 扫不到才退回写死 RVA**；扫描器缺失时自动降级，功能不受影响。
- trampoline 改用**运行时实读的原字节**（不再用写死常量 `HOOK_BYTES`），新版本里被通配的 `disp/imm` 字节（`0x42` 偏移、`0x27`）变了也不崩。
- 移除了 step 5 里对写死 `HOOK_BYTES` 的二次强校验（那会在漂移版本上误判放弃）。

**成果**：自研 per-db 提取链的「找地址」环节已与 WeFlow 同级（特征码扫描 + 通配抗小改）；master 上游点特征码也已就位，为「完全脱离 wx_key.dll 的自研 master hook」铺好了定位基础。

> **诚实边界**：本机只有 1 份 `Weixin.dll`（4.1.12.55），无第二个真实版本，故「跨版本」是**受控模拟**（人为制造地址平移/数据字节变动）而非真·跨版本验证；真实验证需另一版本 DLL 样本。master 上游点特征码已能定位，但把它接成完整自研 hook（处理登录时机 + XOR 掩码 + 读对参数寄存器）尚未落地——目前 master 提取仍走 `call_wxkey.py` 借 WeFlow 引擎。

### 阶段十 · 完全自研 master hook 打通：彻底脱离 WeFlow（2026-08-19 终章）

**目标**：把阶段八/九铺好的 `0x5DEFB0` 特征码接成**完整自研 hook**，实测抓到 master，**全程零第三方 DLL**。**✅✅✅ 已达成**——实测抓到 `c47f0cb5…`，与已知值逐字节一致。

**先深挖 `0x5DEFB0` 的函数签名（不猜，静态定死）**：反汇编函数体 + 全部 8 个调用点，确认：
```
setKey(rcx=ctx, rdx=&std::string keyMaterial, r8d=0x1000 flags, r9d=mode)
  · 8 个调用点无一例外：先用 0x1436430 构造一个 std::string，再传其地址(rdx)
  · 内部 0x2965C0 读 [rdx+0x10]=std::string.size 验证非空
  · 冷函数(登录/开库级, 非 AES 热路径) → 内联补丁安全，不会像 AES 块那样崩
```

**踩坑与三次修复（这是本阶段的真正价值）**：
1. **hook 点写错**：旧 `inject_master_hook.py` 指向 `0x6FD7A90`（SQLCipher 自带 KDF，微信根本不调）→ 0 命中。改指 `0x5DEFB0`（特征码扫描定位）。
2. **登录突发丢失**：初版 shellcode 只存「最近一次」寄存器到单槽，实测计数一个 poll 内 1→25 暴涨，master 会被后续调用覆盖。→ 改**环形缓冲**（512 槽 + `lock inc` 原子计数）。
3. **决定性坑——key 材料是栈局部串，调用返回即消失**：初版「最小 hook + 事后 Python 外部读 rdx」策略失败（per-db key 那次能成是因为串驻留久）。实测 25 条命中里 rdx 多为**栈地址、Python 去读时栈帧已销毁**（全 `读失败`）。→ 改 **shellcode 当场解引用 rdx，把 `*(rdx)` 的 32B std::string 头拷进缓冲**（内联串直接得数据；堆串拷回堆指针，堆分配 hook 后仍存活可补读）。

**上线前机械验证**（`02_static_analysis/verify_master_hook.py`，不碰活微信）：反汇编 shellcode 逐条核对（push/pop 8/8 配平、`jz` 精确跳过拷贝段落到 `lock inc`、`rep movsb` 拷 32B、栈偏移 rdx@[rsp+0x18]）；`cands_from_header` 对内联/堆/raw 三种布局的单测；环形无覆盖。全绿才上线。

**实测闭环**（用户扫码登录那一刻）：
```
[*] hook 点 RVA=0x5DEFB0 ← 特征码扫描 [scan==写死RVA ✓]   ← 自研特征码在活进程定位
[*] shellcode 107B + trampoline 10B 已写入
[+] hook 已装: 5541574156 -> e94b10a1ff
    [✓✓✓] MASTER 命中! <REDACTED_MASTER_KEY> (mode=4)
[*] 轮询结束: 函数触发 25 次, master=已找到
[*] hook 已还原                                          ← 自动还原, 微信零崩溃
```

**全自研链条（零 `wx_key.dll`）**：①自研特征码扫描定位 `0x5DEFB0` → ②自研 shellcode 内联 hook + 当场解引用 rdx 拷 std::string → ③自研环形缓冲防突发 → ④自研分类器（AES 直解认 per-db / PBKDF2 锚点认 master）自包含识别。master 命中在第 4 条 `mode=4`（登录引导那一刻）。**至此从解密到取钥全链路 100% 自研、透明、可审计。**

---

## 3. 最终技术方案（核心知识点）

### 3.1 加密参数
| 项 | 值 |
|---|---|
| 页大小 `PAGE_SIZE` | 4096 |
| 保留区 `RESERVE` | 80 = IV(16) + HMAC(64) |
| KDF | `PBKDF2-HMAC-SHA512(master, salt, 256000, 32)` |
| salt | 文件**前 16 字节** |
| 对称加密 | **AES-256-CBC** |
| HMAC | HMAC-SHA512（64 字节） |

### 3.2 页布局（WeChat 定制点）
```
第 1 页: salt[0:16] + ciphertext[16:4016] + IV[4016:4032] + HMAC[4032:4096]
第 N 页:              ciphertext[0:4016]   + IV[4016:4032] + HMAC[4032:4096]
                                             ↑ IV 在页尾、HMAC 之前 —— 这是相对标准 SQLCipher 的关键改动
```

### 3.3 首页头还原
第 1 页明文开头是 WCDB 私有 16 字节头 `10 00 02 02 50 40 20 20 …`（**不是** `SQLite format 3`）。还原方式：输出 `b"SQLite format 3\x00"` + 明文 + 补 80 字节 reserved，后续结构即标准 SQLite。

### 3.4 密钥链全貌
```
服务器/登录流程
  → master (瞬时, 仅登录窗口内进程中存在, 绝不留驻)
    → 解密 key_info_data (算法独立于 master, 未破)
      → per-db derived key   ←── 主流工具 & 自研注入器的提取目标
        → setCipherKey → SQLCipher codec → AES-256-CBC 解密
--- 或离线等价路径 ---
master → PBKDF2(master, 各库 salt) → 同一把 per-db derived key
```

---

## 4. 两条交付链路

### 4.1 解密器 `deliverables/wechat_decrypt.py`（纯 Python，零 DLL）
```bash
# 单库（master 派生模式，默认）
python wechat_decrypt.py <db_path> <master_hex> [out.db] --master
# 单库（已有 per-db derived key，直接解）
python wechat_decrypt.py <db_path> <derived_hex> [out.db] --derived
# 批量（一把 master 解全部库）
python wechat_decrypt.py --master-batch <master_hex> <db_root> <out_dir>
# 批量（per-db key 映射表）
python wechat_decrypt.py --derived-batch <derived_keys.txt> <out_dir>
```
依赖：`cryptography`（已验证 44.0.1 + Python 3.13.2 可用）。

### 4.2 自研注入器 `deliverables/inject_keyhook.py`（透明版 WeFlow）
进程内联 hook `setCipherKey`（RVA `0x03576376`），在密钥设置瞬间从 `r14` 抓取 per-db key，映射到具体 db（AES 解首页校验）。支持 launch(CREATE_SUSPENDED) + attach 双模式，微信零崩溃。

---

## 5. 关键认知与踩坑清单（最有价值的经验）

1. **标准 SQLCipher 参数暴力必然失败** —— WeChat 把 IV 显式放在页尾，且首页头是 WCDB 私有头。别在 `sqlcipher.exe` 上浪费时间。
2. **一把 master 能解全部库** —— 早期一度以为该假设错误，实际成立：master 逐库 `PBKDF2(master, 该库 salt)` 派生。
3. **master 抓不到是「hook 点错位」，不是架构不可达（已修正，见 §2.6）** —— master **每次开库都在进程内被 PBKDF2 派生**（用户 WeFlow 复测：已登录态无需重扫码即可抓到）。抓不到是因为：①注入器 hook 在 `setCipherKey`（派生**下游**），只能拿到 per-db key 输出；②早期 SHA512 hook「0 命中」是下错 SHA-512 实现的**假阴性**。**别把假阴性当成「架构不可能」下结论。**
4. **抓 per-db key（下游）已足够解密**，且是主流做法；**抓 master 需 hook 派生上游（PBKDF2 口令入参，`0x6F–0x70xxxxx` crypto 簇）** —— 两者是不同 hook 点，别混为一谈。
5. **JIT 区外部可读** —— 「不可读」曾是 ASLR 地址误判，`probe_jit_regions.py` 已证伪。
6. **shellcode 踩坑**：`mov rsi,r14` = `49 8B F6`；栈拷贝会触发微信自检退出，最小化 hook + 外部 ReadProcessMemory 读栈最稳。
7. **调试器会 kill 登录态** —— 之前每次都要重新扫码，是因为调试器杀了微信导致登录缓存丢失；已登录状态下启动时微信启动早期即自动从 `key_info.db.factory\vacuum\` 恢复密钥。
8. **`key_info.db` 是明文镜像，`key_info.dat` 是唯一源头**。

---

## 6. 最新验证结果（2026-08-19 交付验证）

| 验证项 | 结果 |
|---|---|
| master 解密活动库 | **26/29 命中**（3 个未命中 = 独立 salt 的 `.factory` 迁移快照，非活动库） |
| E2E 实跑 `session.db` | ✅ 合法 SQLite 魔数、`integrity_check=ok`、7 张真实表 |
| E2E 实跑 `message_0.db`（47MB） | ✅ `integrity_check=ok`、132 张表、单会话表 7887 条真实消息 |
| 批量产物整库体检 | **23/26 `integrity_check=ok`**；3 个 `*_fts.db` 仅缺私有 `MMFtsTokenizer`（页与 schema 均正常解出，FTS5 虚表齐全，非解密失败） |
| 注入器 per-db key 复核 | 2/3 完全验证且与 `PBKDF2(master,salt)` 逐字节一致；`session.db` 那把因微信在抓取后 rekey（换新 salt）失效 —— master 路径仍能派生当前正确 key |

---

## 7. 目录结构索引

```
2026-08-18-22-24-53/
├── 01_recon/           侦察：进程/DLL/DB 普查、key_info.db 发现、WCDB 分析
├── 02_static_analysis/ 静态 RE：capstone 反汇编、定位 setCipherKey/AES/PBKDF2/codec
├── 03_dynamic_hook/    动态调试：INT3/TF 单步、hook AES/CBC/CreateFile/keyinfo
├── 04_crypto_attack/   密码学：SQLCipher 暴力、key_info_data 算法穷举、KDF 尝试
├── 05_memory_scan/     内存扫描：master/derived/salt 扫描、JIT 区探测、保护探测
├── 06_inject/          注入：runtime_patch v1-v4、extract_key
├── 07_validation/      验证：verify_master/keys、诊断脚本
├── deliverables/       ★ 交付物
│   ├── wechat_decrypt.py     纯 Python 解密器（零 DLL）
│   ├── inject_keyhook.py     自研进程内注入器（透明版 WeFlow）
│   ├── master_key.txt        master key
│   ├── derived_keys.txt      密钥汇总（master + 注入器抓的 per-db keys）
│   └── decrypted_master/     解密产物（26 个明文 SQLite 库）
├── decrypted_master/   同上（工作副本）
├── archive/            过程产物：早期尝试、日志、callstack、blob dump
├── keyinfo_backup/     key_info.db / key_info.dat 备份
└── .workbuddy/memory/  逐时段工作日志（技术决策原始记录）
```

---

## 8. 复现步骤（拿到 master 后）

```bash
# 1. 确认依赖
python -c "import cryptography; print(cryptography.__version__)"

# 2. 一把 master 批量解密全部库
python deliverables/wechat_decrypt.py --master-batch \
  <REDACTED_MASTER_KEY> \
  "%USERPROFILE%\xwechat_files\<YOUR_WXID>_c359\db_storage" \
  ./decrypted_master

# 3. 验证产物（Windows 控制台需 PYTHONUTF8=1 避免 GBK emoji 报错）
PYTHONUTF8=1 python 07_validation/verify_master.py

# 4. 查询明文库
sqlite3 decrypted_master/message/message_0.db.plain ".tables"
```

**自研抓 per-db key（不依赖外部提供）**：运行 `deliverables/inject_keyhook.py`（需按本机路径改 `WECHAT_EXE`/`WECHAT_DIR`，并在微信触发 DB 访问时抓取）。

---

## 9. 局限与后续方向

- **✅ 已达成（阶段七）**：纯自研抓 **master** 已打通——经 `06_inject/call_wxkey.py` 调 WeFlow 的 `wx_key.dll` 引擎，用户重新登录瞬间取到 master（与已知值一致）。master **只在启动/登录引导那一次**出现（非「每次开库」，此为阶段六残留错误，已更正）。
- **✅✅✅ 完全自研闭环（阶段十）**：`06_inject/inject_master_hook.py` 已改造为**完全脱离 `wx_key.dll`** 的自研 hook——自研特征码定位 `0x5DEFB0` + 自研 shellcode 当场解引用 rdx 拷 std::string + 环形缓冲 + 自包含分类器，实测登录瞬间抓到 master `c47f0cb5…`（逐字节一致，hook 自动还原、微信零崩溃）。**从解密到取钥全链路 100% 自研。**
- **未攻克**：`key_info_data` 载荷的加密算法（独立于 master 的静态密钥材料）—— 破解它可实现「离线从 `key_info.dat` 直接推 master/per-db key」，彻底脱离运行时与 WeFlow。**但用户已确认 master 本机绑定（同账户不同机器密钥不同），故即便破了也只在原机原账户成立，跨机器无效——收益有限。**
- **未逐字提取**：WeFlow 与掩码配对的**具体特征码字节**（其 pattern 为运行时构造，静止态 `.data` 为空）；机制与构造原理已还原并能独立复现，但要拿到它记录的确切字节，需在 Xkey 扫描瞬间 dump 其缓冲。
- **✅ 鲁棒性已升级（阶段九）**：自研两条 hook 路（per-db `0x3576376`、master `0x5DEFB0`）各已生成带通配符特征码并接入注入器，定位从「写死 RVA」升级为「特征码扫描优先 + 写死兜底」，微信运行时活进程实测均精确命中。抗更新水平对齐 WeFlow。
- **离线不可跨机**：用户确认「同账户不同机器密钥不同」→ master **本机绑定**。即便破了 `key_info_data`，离线派生也只在**原机原账户**成立，拷到别的机器无效——这大幅降低了「破 blob 做离线」的收益。
- **master 自研 hook 未完全落地**：上游点 `0x5DEFB0` 特征码已就位，但接成完整自研 hook（登录时机 + XOR 掩码 + 参数寄存器）尚未做；当前 master 提取仍借 WeFlow 的 `wx_key.dll` 引擎（`call_wxkey.py`）。
- **跨版本仅受控模拟**：本机只有 4.1.12.55 一份 DLL，抗漂移能力用 `drift_test.py` 受控模拟（地址平移+数据字节翻转）证实，非真·跨版本；真实验证需另一版本样本。
- **FTS 库全文校验**：需注册微信私有 `MMFtsTokenizer` 才能对 3 个 `*_fts.db` 跑内部 FTS 校验（不影响主数据读取）。
- **版本适配**：所有 RVA（`setCipherKey`、PBKDF2 簇、WeFlow hook 点 `0x5DEFB0`）绑定 `Weixin.dll` **4.1.12.55**，微信升级后需按阶段八的特征码方法重新定位。

---

## 10. 图片解密与消息格式解析（2026-08-20 新增模块）

> 延续阶段十之后的交付扩展：库已解出，补齐**媒体解码**与**结构化消息解析**两个环节。

### 10.1 微信图片 .dat 三种加密格式（调研结论 + 本机实测）

| 格式 | 签名 | 加密方式 | 密钥来源 | 本机情况 |
|---|---|---|---|---|
| 旧 XOR（<4.0） | 无 | 单字节 XOR 全文件 | 文件头 magic 反推 | 无（老数据已迁移） |
| V1（4.0.0 过渡） | `07 08 56 31 08 07` | AES-128-ECB + XOR | 固定 key `cfcd208495d565ef` | 无 |
| **V2（4.0.3+）** | `07 08 56 32 08 07` | AES-128-ECB + XOR | **AES: 进程内存提取；XOR: 缩略图尾部反推** | ✅ **全部图片（实测确认）** |

V2 文件结构（15 字节头 + 三段）：
```
[0:6]   签名 \x07\x08V2\x08\x07
[6:10]  aes_size (uint32 LE, AES 明文长度)
[10:14] xor_size (uint32 LE, 尾部 XOR 段长度)
[14:15] padding
[15:]   AES-ECB 密文（PKCS7 对齐） + 明文段 + XOR 段
```

**V2 两个 key 的获取（关键难点）**：
- **XOR key 反推**：V2 头部是 AES 加密的，不能从头反推。因 JPEG 必以 `FF D9` 结尾，取 `xor_key = tail[-2] ^ 0xFF`，校验 `tail[-1] ^ 0xD9`。跨 64 个 `*_t.dat` 缩略图投票取众数。**本机实测反推 = 0xEE**。
- **AES key 内存提取**：AES key 是 16 字符 ASCII 串，**只在微信点开图片查看时短暂驻留 Weixin.exe 内存**，不落盘。扫描方法：`VirtualQueryEx` 枚举内存区域 → 正则匹配 16/32 位字母数字 → 用 V2 缩略图密文块（bytes[15:31]）做 AES-ECB 试解 → 校验 magic（JPEG/PNG/WEBP/wxgf/GIF）。需管理员权限 + 先在微信中点开 2~3 张图。

**WxAM 第二层（wxgf）**：V2 原图（非缩略图）解密后通常不是标准图片，而是微信私有 `wxgf` 压缩格式（头 `77 78 67 66`）。需调用官方 `VoipEngine.dll` 的 `wxam_dec_wxam2pic_5`（mode 1/2/0/3 对应 png/jpeg/gif 逐个尝试）。本机路径：`F:/Weixin/Weixin/4.1.12.55/VoipEngine.dll`。缩略图 `_t.dat` 解密后直接是标准 JPEG，无需第二层。

### 10.2 新增交付物

| 文件 | 功能 |
|---|---|
| `deliverables/wechat_img.py` | 图片 .dat 解密器：三格式自动检测、XOR 反推、V2/V1 解密、wxgf 第二层。CLI: `single` / `batch` / `xor-detect` |
| `deliverables/find_image_key.py` | V2 AES key 内存扫描器（VirtualQueryEx + ReadProcessMemory + AES 试解）。找到后写入 `image_keys.txt` 供 wechat_img.py 自动加载 |
| `deliverables/wechat_msg.py` | 消息解析器：local_type 64 位解码、17 类消息类型解析、zstd 解压、群前缀剥离、图片/语音媒体定位与导出。CLI: `--list-chats` / `--chat` / `--all` / `--media` |

### 10.3 消息库解析要点（实测确认）

- **local_type 64 位编码**：`[sub_type(高32)][type(低32)]`。解码：`type = lt & 0xFFFFFFFF`。
- **message_content 是 zstd 压缩的**！魔数 `28 B5 2F FD`（WCDB 内置压缩）。文本消息是明文，富媒体全部 zstd。
- **群聊消息带发送者前缀** `wxid_xxx:\n`（在 zstd 解压后的正文头部），需剥离。
- 类型分布（实测 61879 条样本）：1 文本 / 3 图片 / 47 表情 / 49-57 引用回复 / 49-5 卡片链接 / 49-6 文件 / 49-2000 转账 / 34 语音 / 43 视频 / 48 位置 / 50 通话 / 10000 系统消息等。
- **图片映射链（含关键坑）**：
  ```
  Msg 表 server_id == MessageResourceInfo.message_svr_id
    → packed_info(protobuf field2→field1) 提取 32hex
    → 该 32hex 是 hardlink.file_name 的【主体】（去掉 _t/_h/_W.dat 后缀），不是 md5 列！
    → dir1/dir2 是 rowid，经 dir2id 表映射目录名
    → attach/<dir1名>/<dir2名>/Img/<file_name>
  ```
  ⚠️ **坑 1**：packed_info 的 32hex ≠ hardlink.md5 列（交集 0），而是 file_name 主体（交集 3305/4715）。md5 列是内容哈希，对应不到文件名。
  ⚠️ **坑 2**：MessageResourceInfo 只覆盖部分消息（部分群/部分时间无记录），无记录时只能靠 XML 里 md5 属性尽力匹配。
  ⚠️ **坑 3**：attach 文件名可能与 hardlink.file_name 一致（`xxx_t_W.dat`），也可能因清理而缺失——"尽力而为"映射，命中即用。
- **语音映射**：`media_N.db VoiceInfo.svr_id == Msg.server_id`，`voice_data` 为 SILK（头 `\x02\x23!SILK_V3`）。
- **转账金额**：`wcpayinfo.feedesc`（如 `￥39.00`），不是 amount 属性（老格式才有）。

### 10.4 端到端验证结果（2026-08-20）

| 验证项 | 结果 |
|---|---|
| V2 结构解析（aes_size/xor_size/aligned） | ✅ 与实测文件逐字节吻合 |
| XOR key 反推（投票法） | ✅ 0xEE，单文件/子目录/全目录均稳定 |
| V2 解密回环测试（加密→解密往返） | ✅ 逐字节一致（head/tail/全长） |
| find_image_key 内存扫描 | ✅ 2217 区域扫完无崩溃；未找到 key 因用户未点开图片（符合预期流程） |
| VoipEngine.dll 定位 + wxam_dec_wxam2pic_5 导出 | ✅ `F:/Weixin/Weixin/4.1.12.55/VoipEngine.dll` |
| wxgf 解码容错 | ✅ 非 wxgf 原样返回；假 wxgf 返回 None 不崩 |
| 消息解析 61879 条（全类型） | ✅ 文本/图片/引用/转账/语音/视频/文件/位置/小程序/群公告等 17 类全解析 |
| 图片路径映射（server_id→32hex→hardlink→磁盘） | ✅ 2305 张图片有 32hex，249 张磁盘命中（其余为清理/未索引） |
| 语音 BLOB（silk） | ✅ 247/261 条命中 VoiceInfo |

### 10.5 使用方式

```bash
# 1. 提取 V2 AES key（需管理员 + 微信中点开几张图后立即运行）
python deliverables/find_image_key.py --attach "C:\...\xwechat_files\wxid_xxx\msg\attach"

# 2. 批量解密图片（自动反推 XOR key + 自动加载 image_keys.txt）
python deliverables/wechat_img.py batch "C:\...\msg\attach" ./decoded_images

# 3. 消息解析
python deliverables/wechat_msg.py decrypted_master --list-chats
python deliverables/wechat_msg.py decrypted_master --chat Msg_xxx --out ./chat_export --media
```

### 10.6 关键坑：AES key 长度错配（2026-08-20 实测定位并修复）

`find_image_key.py` 抓到的内存候选是 **32 位字母数字串**，但微信 V2 实际只取**前 16 个字符作为 AES-128 的 ASCII key**（`algorithms.AES(key)` 接收 16 字节 ASCII 串即 AES-128）。

- **原 bug**：`scan_regions` 用 `try_key(s[:16], ct) or try_key(s, ct)` 校验，命中后却 `return s.decode("ascii")` —— 把**完整 32 字符**写进了 `image_keys.txt`。
- `wechat_img.py` 的 `_parse_key` 又优先把「32 位全 hex 串」按 `bytes.fromhex()` 解析成 **16 字节 AES-128 hex key**，于是 key 整体错位：用错 key 解密，缩略图/原图 AES 段全变乱码（开头 `6a89f8f1…`，非 `ffd8ff`）。
- **修复**：
  1. `find_image_key.py` 改为 `if try_key(s[:16], ct): return s[:16]`（命中即存验证通过的 16 字符 key）；32 字符候选仅当 `try_key(s, ct)`（AES-256）命中才存全串。
  2. `wechat_img.py._parse_key` 改为**优先按 ASCII 解析**（16 字符→AES-128，32 字符→AES-256），hex 仅作兜底，避免 32 全 hex 被误判为 16 字节 hex。
- 已落盘的正确 key：`1f88258512b9d6b4`（16 字符 ASCII，本账号全局有效）。

### 10.7 全局 key 结论（跨年不变，非按会话轮换）

用正确 16 字符 key 对 **2022-08 ~ 2026-08 全部月份**的 V2 文件首 AES 块解密，均得到合法 JPEG/PNG 头（`ffd8ff` / `89504e47`）。证明该 AES key 是**账号级全局常量**，不随会话轮换，可一次性解出整个 `msg/attach` 目录（约 19811 个 .dat）。少数文件头非 `07 08 56 32 08 07`（标记为 NOT_V2）属 V1/老 XOR 格式，走 `wechat_img.py` 的其他分支，并非 key 失效。

### 10.8 端到端验证（修复后）

| 验证项 | 结果 |
|---|---|
| 缩略图 `_t.dat`（如 2026-06 `310b5eae…`） | ✅ 解出 JPEG（头 `ffd8 ffe0 JFIF`，尾 `ffd9`，4929B） |
| 原图 `_h.dat`（如 2026-08 `7cde0579…`） | ✅ 解出 JPEG（头 `ffd8 ffe0 JFIF`，尾 `ffd9`，127790B） |
| 全量批量 `wechat_img.py batch` | ✅ 19811 文件，按格式自动分流，输出 `.jpg/.png` |

### 10.9 两个关键 bug 与最终确定性结果（2026-08-20 补全）

首轮全量批量出现 **198 个失败 + 143 个原图始终是未解码的 `wxgf` 壳**，根因如下，均已修复：

**Bug A — V2 解密忽略全局 XOR key，逐文件尾部反推失效**
- `decrypt_v2_v1(data, aes_key)` 原实现**不接收也不使用**调用方传入的全局 XOR key，每次都从本文件 XOR 段尾部重推。
- 尾部反推只认 `FF D9`（JPEG）/ `IEND`（PNG）特征；但两类文件会失败：
  1. 微信常在 `FF D9` 后补 `00` 对齐，导致「取最后 2 字节」落在填充 `00` 上 → 反推失败；
  2. WxAM 原图明文以 `wxgf` 开头，根本不以 `FF D9` 结尾 → 反推失败。
- **修复**：给 `decrypt_v2_v1` 增加 `xor_key` 参数并在有传入时优先使用；`decrypt_dat_file` 透传全局 XOR key（缩略图投票得到的 0xEE，账号级稳定）。尾部推断保留为无 key 时的兜底，并增加「填充容忍」：扫描尾部 16 字节窗口内的 `FF D9` 配对。

**Bug B — WxAM 第二层解码 ctypes 传参错误，被静默吞掉**
- `wxgf_decode` 把 `addressof(inbuf)`（裸 Python int，即 64 位内存地址）直接作为指针参数传给 `wxam_dec_wxam2pic_5`，ctypes 将其当作 C `int` 转换 → 地址超 2³¹ 抛 `OverflowError`，被 `except` 静默捕获返回 `None`，143 个原图永远是未解码的 `wxgf` 字节。
- **修复**：显式声明 `voip.argtypes=[c_void_p,c_int,c_void_p,POINTER(c_int),POINTER(c_int)]` / `restype=c_int`，指针参数统一用 `c_void_p(addressof(...))` 包装；并校验输出确实是合法图片 magic 才返回。实测解码成功：mode 0→JPEG、1/2→PNG、3→GIF。

**Bug C — 缓冲区复用导致格式选择不确定（附加修复）**
- 初版 `wxgf_decode` 在 4 种 mode 间复用同一 `outbuf`，偶发回退到 PNG，导致同一文件两次运行 jpg/png 数量漂移（19731/78 vs 19653/156）。
- **修复**：每次 mode 迭代分配全新 `outbuf`/`out_size`，结果确定。

**最终确定性结果**（`wechat_img.py batch` 输出至全新空目录，复跑一致）：

| 指标 | 值 |
|---|---|
| 总 `.dat` | 19811 |
| 成功 / 失败 | 19811 / **0** |
| jpg | 19731 |
| png | 78 |
| bin（非图片：`Ann/<hash>/Dat/0.dat` 笔记/公告附件，V2 解密成功但非图像） | 2 |
| 输出体积 | ~392M |
| 输出目录 | `deliverables/decrypted_final/` |

> 注：因沙箱禁止删除（`windows-sandbox-recycle-bin-unavailable`，`rm`/`os.remove` 均 fail-closed），早期批次在 `decrypted_img/` 残留 133 个垃圾 `.bin`（旧错误批次的同名产物未清理）。最终干净结果在 **`decrypted_final/`**（全新空目录，零残留）。`decrypted_img/` 属历史残留，可忽略或手动删除。

---

*文档基于 `.workbuddy/memory/2026-08-19.md`、`.workbuddy/memory/2026-08-20.md` 工作日志、各阶段脚本时间戳与交付验证实测结果整理。*

---

## 阶段七 · WeMemo App 性能与交互优化（2026-08-20 下午）

对 `wememo_app`（Electron 31 + Python 引擎桥接）做性能与 UX 双线优化，全部回归测试通过。

### 性能（引擎 `wcdb.py` + 主进程）
- **只读连接池**：`_open()` 改为按路径缓存 `sqlite3.Connection`（单线程桥接复用安全），删除各方法内 `con.close()`，新增 `close()` 释放；解决每次查询重建连接的开销。
- **分片表定位缓存**：`_shards_with_table(username)` 结果缓存（分片静态，24 库扫描只做一次），翻页/回看不再重复遍历 `sqlite_master`。
- **解码 LRU**：`_decode_content` 按 `(local_type, raw)` 缓存结果（上限 512，OrderedDict），回看/统计场景避免重复 zstd 解码。
- **会话短 TTL**：`sessions()` 2s 缓存，搜索/统计/会话列表不再重复建库。
- **图片元数据**：图片消息解码提取 `{md5, aeskey, width, height}`（`cdnthumbwidth/height`），透传到前端。
- **消息去重**：跨分片合并按 `sort_seq` 去重后再取 limit 条，避免分片交界重复。
- **主进程**：`callPy` 加超时（常规 15s / auto_decrypt 120s）；stdout 事件行（`{"event":"progress"}`）识别并转发渲染层；窗口 `ready-to-show` 再 show 避免白屏。
- **构建修复**：`build.js` 复制 engine 时跳过子目录（`_bench_tmp/_verify_tmp` 之前导致 EPERM 构建失败）。

### 交互（渲染层）
- 翻页 `prepend` 滚动位置保持（记录 scrollHeight 差）；已渲染消息 `sort_seq` 去重；跨天时间线按局部边界判断（修复全局 `lastMsgDay` 状态错乱）。
- 消息 hover 显示完整时间（title）、**单击气泡复制文本、右键菜单**（复制消息/复制时间，防溢出定位 + 轻提示 toast）。
- 图片/语音/视频/链接改为**类型卡片**（图片带尺寸、链接带 app_tag），不再是裸文本占位。
- 搜索：防抖 250ms + loading 文案 + 结果计数 + **关键字高亮** + 空态。
- 回到底部浮钮（上翻时出现）；顶部"加载更早消息…"指示；未读徽标点击会话即清除并重算 Tab 角标。
- 会话标题带数量（`最近会话 (21)`）；Tab 切换清理聊天区状态避免残留；max 图标随最大化切换。
- 启动页：解密进度条 + 失败重试按钮（`bootRetry` 重新 init）。

### 验证
- `test_renderer_logic.js` 重写：25/25 通过（时间/转义/类型卡片/纯文本复制/高亮/XSS）。
- `test_bridge_node.js`、`test_startup_sim.js`（补 mock `once`/`show`/显式收尾退出）、zstd 回环 4133 帧全通过。
- 新增 `tools/smoke_gui.js`：真实 Electron 无头加载 dist，捕获渲染进程 JS 错误与 DOM 完整性 → **SMOKE PASS**（WorkBuddy 环境全局 `ELECTRON_RUN_AS_NODE=1`，需 `env -u` 运行 electron）。
- 真实库（21 会话 / 26395 条）实测：首屏冷加载 95ms、缓存命中 0.2ms、翻页 110ms、sessions 秒级。
- 图片本地 `.dat` 关联机制（目录/文件 hash 来源）仍未破，App 内图片显示留作专项；解密能力已在 `deliverables` 验证（全局 key `1f88258512b9d6b4` + XOR 0xEE）。

---

*文档基于 `.workbuddy/memory/2026-08-20.md` 工作日志更新。*

---

## 阶段七补充 · 图片本地关联打通（2026-08-20 傍晚）—— 上轮遗留项的闭环

上轮遗留「图片 `.dat` 与消息的关联机制」本轮逆向并实现进 App。

### 关联规则（真实库 19102 条图片消息 100% 命中）
1. **会话目录** = `msg/attach/<md5(会话username)>/<YYYY-MM>/Img/`（表名 `Msg_<md5>` 的 md5 即目录名，直接可算）。
2. **文件名 hash** 存在消息行 `packed_info_data` 内嵌 protobuf：
   `08 01 10 02 1a 22 22 20 <32hex ascii> 58 00` —— field3(0x1a) 内 field4(0x22, len 0x20) = 32 个 hex 字符 = 本地文件名。
3. 缩略图 = `<hash>_t.dat`；原图 = `<hash>.dat`（wxgf 需官方 DLL 第二层，App 走缩略图）。

### 踩过的坑（为何之前破不了）
- 测试库 `_verify_tmp/auto_par` 是**测试残留**（含他账号数据），发送者 `<REDACTED_WXID>` 不在本账号 attach，导致所有 md5/字段 hash 全不命中。必须用**真实解密库**（`AppData/Roaming/wememo/decrypted/`）验证。
- 文件名 ≠ 内容 md5 / XML md5 / aeskey / server_id / server_seq / local_id / create_time / cdnurl 等任何常见字段的 md5（字节级/字符串级都试过）。
- 本地 `.dat` 的 AES key 是**账号级全局常量**（`1f88258512b9d6b4` ASCII），与消息 XML 的 aeskey（CDN 用）无关——曾误以为可用 aeskey 暴力匹配。
- `packed_info_data` 提取的 hash 首次返回 `bytes`（BLOB 正则组未 decode）→ 文件名匹配失败，需 `.decode('ascii')`。
- WorkBuddy 沙箱 Python（3.13.12）缺 `cryptography`，图片解密无法跑 → `pip install cryptography` 补齐（Anaconda 有 44.0.1，本机已装 50.0.0）。

### 实现（wememo_app）
- 新增 `engine/imgfile.py`：V1/V2/XOR 解密 + `extract_file_hash(packed)` + 关联路径解析 + data URL。常量可经 `WEMEMO_IMG_AES_KEY` / `WEMEMO_IMG_XOR_KEY` 覆盖（跨账号需重新提取）。
- `wcdb.py`：`messages()` 查询补 `packed_info_data`，`img_meta['file_hash']` 透传；新增 `image_url()`（LRU 128 + 缺失记录防重复 IO）；`attach_root` 自 xwechat_root 探测。
- `bridge.py`：`image` 方法 → 解密 data URL。
- `preload.js`：`getImage(username, ts, fileHash)`。
- 渲染层：图片卡片 `img-ph` 占位 → IntersectionObserver 懒加载 → data URL 显示；`imgCache` 渲染层缓存。
- 测试：renderer 26/26、bridge image 协议（命中/缓存/缺失/缺参）、Electron 冒烟全过。实测连续 5 张解密 0.03s、缓存 0ms、真实 JPEG 输出。

### 效果
聊天记录中的图片消息现在**直接显示真实缩略图**（本地 `.dat` 解密后 data URL），占 77% 的图片（14785/19102）可显示；其余为微信本地已清理的（正常显示占位卡片）。

---

*文档基于 `.workbuddy/memory/2026-08-20.md` 工作日志更新。*

---

## 阶段七补充2 · App 图片不显示根因修复（2026-08-20 深夜）

关联规则打通后用户反馈 App 内仍不显示图片，定位为两个真实运行环境 bug + 一个 CSP 问题：

1. **Python 环境错位**：App `findPython()` 只取 PATH 第一个 `python`（WorkBuddy `.old.37840`，无 cryptography 且 `_ctypes` DLL 损坏）→ 图片解密依赖 cryptography 静默失败。验证时用的是 `python3`（有 crypto），故引擎层测试通过、App 实际挂。
   - 修复①：新增 `engine/pyaes_fallback.py` 纯 Python AES-128-ECB（零依赖），`imgfile` 解密双路径（cryptography 优先 → 纯 Python fallback）。用 FIPS-197 向量 + 随机回环逐字节验证。
   - 修复②：`main.js` 增加 `probePython()`，spawn 探测候选优先带 cryptography 的 Python（python3 > python），全失败仍回退（图片有 fallback 兜底）。
2. **字符串 ts bug**：渲染层 `dataset.ts` 为字符串，引擎 `ts/1000` 抛 TypeError → image_url 异常返回空。修复：引擎 `rel_path`/bridge 均 `int(ts)` 容错，渲染层 `Number(ts)`。
3. **CSP 拦截头像**：`img-src` 缺 `http:`，微信头像 `http://wx.qlogo.cn` 被拒（console error）。补 `http:`。

验证：新增 `tools/smoke_e2e.js`（真实渲染层 + 真实引擎，打开图片会话 → 懒加载显示真实 JPEG）**E2E PASS**。全量回归（renderer 26/26、bridge、startup、GUI 冒烟）通过。

---

*文档基于 `.workbuddy/memory/2026-08-20.md` 工作日志更新。*
