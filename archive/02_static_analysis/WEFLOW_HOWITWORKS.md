# WeFlow (Xkey) 如何逆向定位密钥函数 —— 机制还原

> 从 `wx_key.dll` 静态分析 + 运行时状态串还原。这是"WeFlow 究竟怎么找到那个函数"的答案。

## 结论一句话

WeFlow 的原生引擎 **`wx_key.dll`(内部项目名 Xkey)** 用的是 **"版本分档 + 特征码扫描(带通配符)"**：
运行时读微信版本 → 按版本区间选一条 {特征码, 掩码} → 在 `Weixin.dll` 的 `.text` 里扫描匹配 → 命中地址即 hook 点 → 装远程 hook(伪栈+缓冲区+共享内存 IPC)抓 key。
这正是 Gemini 说的"方案一 特征码扫描",但加了 **版本分档** 和 **通配符**两层抗更新设计。

## 证据链(全部从 wx_key.dll 提取)

### 1. 引擎身份
- PDB 路径 `D:\a\Xkey\Xkey\x64\Release\wx_key.pdb` → 项目名 **Xkey**,GitHub Actions 构建
- C++ 类符号:`RemoteScanner` / `IRemoteScannerBase` / `RemoteScannerCommon`(=内存扫描器)
- 反汇编器字符串 `bad vsib addressing` / `invalid mib address`(=内嵌 **Zydis** 反汇编,用于指令级扫描)
- 导入:`K32EnumProcessModules` + `K32GetModuleInformation`(取模块 base/size) + `ReadProcessMemory`(读内存扫描) + `WriteProcessMemory`(装 hook) + `MapViewOfFile`(共享内存 IPC)

### 2. 版本分档表(.rdata 明文,逐字提取)
```
"4.0.x 及以上 4.x 版本"      -> 掩码 "xxxxxxxxxxxxxxxxxxxxxxxx"  (24字节全固定)
">4.1.6.14"                  -> 掩码 "xxxxxxxxxx?xxxx?xxxxxxxx"  (24字节, 通配位 10 和 15)
">=4.1.4 && <=4.1.6.14"      -> (另一档)
"<4.1.4"                     -> (另一档)
```
- 版本分派函数 `wx_key.dll+0x135C0`:`call 0x13f00` 取微信版本 → 解析成 4 段(主.次.修订.构建)→ 用 `movdqa xmm0/xmm1` 载入版本向量,逐段 `cmp` 比较 → 按区间 `mov rdi,[表]` 选中对应 {特征码,掩码} 记录。
- 取版本失败时报错串:`"获取微信版本失败，目标进程可能已..."`

### 3. 掩码通配位的含义(确证抗更新设计)
当前微信 **4.1.12.55**(> 4.1.6.14)→ 用掩码 `xxxxxxxxxx?xxxx?xxxxxxxx`。
该掩码对齐到 hook 点 `0x5DEFB0` 的函数序言,两个 `?` 精确落在**会随编译版本变动的字节**上:
```
偏移 8-11 : 48 83 ec [58]   sub rsp, 0x58     ← 通配位 关联栈帧大小
偏移12-16 : 48 8d 6c [24]50  lea rbp,[rsp+0x50] ← 通配位 关联同一栈帧
其余固定  : 55 41 57 41 56 56 57 53 ...  push rbp/r15/r14/rsi/rdi/rbx (寄存器保存序言=稳定指纹)
```
→ **固定住稳定的寄存器保存序言,通配掉会变的栈帧大小** = 版本小改时特征码仍能命中。教科书级的抗更新特征码设计。

### 4. hook 安装(证实用户观察的"远程伪栈+缓冲区")
运行时状态串逐字证实:
```
目标函数地址: 0x7ffcda61efb0        (= Weixin.dll base + RVA 0x5DEFB0)
正在分配远程数据缓冲区...
正在分配远程伪栈...                  ← 用户看到的"远程伪栈"
正在初始化IPC通信...                 (MapViewOfFile 共享内存)
正在安装远程Hook...
Hook安装成功，现在登录微信...        ← key 在登录动作那一刻产生
```
- 导出 ABI:`InitializeHook(pid)` / `PollKeyData(buf,size>=0x41)` / `GetStatusMessage` / `CleanupHook` / `GetLastErrorMsg`
- IPC 结构 `SharedKeyData`,JSON 字段 `aesKey` / `xorKey` / `keys[]`(印证 Gemini 说的"4.x XOR 掩码"——key 有 xor 保护)

## 与我之前尝试的对比(为什么我走了弯路)

| | 我的做法 | Xkey 做法 |
|---|---|---|
| 找函数 | 盲搜 194MB DLL 的 PBKDF2/AES,靠语义猜 | **版本分档 + 特征码扫描**,直接命中 |
| hook 点 | SQLCipher KDF(0x6FD7A90,微信不用)、AES块(热路径→崩) | `0x5DEFB0`(登录时调用的密钥函数,非热路径) |
| 抗更新 | 无(RVA 写死) | 通配符掩码 + 版本区间表 |
| 时机 | 被动等/时机错乱 | hook 先装好,再走登录动作 |

## 诚实边界(未完全拿到的部分)

- **确证**:版本分档机制、两条掩码的字节位置、版本标签串、扫描器类/Zydis/API、hook 安装流程、hook 点 RVA 及掩码与其序言的对齐关系。
- **未静态提取到**:与掩码配对的**具体特征码字节**。原因:24 字节序言在 `.text` 里有 298 处重名(仅序言不唯一),说明 Xkey 实际用的特征码要么更长、要么锚定在函数体更深处的独特指令序列;而这些 pattern 字节在 DLL 静态映像里是**运行时构造**(相关 `.data` 全局在静止态为空),没能从磁盘直接抠出。要拿到确切 pattern 字节,需在 Xkey 运行、扫描发生的瞬间 dump 它构造好的 {pattern,mask} 缓冲——这是下一步可做的。
- 未逆向 Xkey 的 anti-tamper(它保护的是 Xkey 自身,不影响我们从磁盘读它的静态特征)。
