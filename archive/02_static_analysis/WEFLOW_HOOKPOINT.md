# WeFlow 真实 hook 点(从 wx_key.dll 运行时状态提取)

- wx_key.dll: F:\WeFlow\resources\resources\key\win32\x64\wx_key.dll (195KB, x64)
- 导出 ABI: InitializeHook(u32 pid) / PollKeyData(char*,int>=0x41) / GetStatusMessage / CleanupHook / GetLastErrorMsg
- 运行时状态串证实: "分配远程伪栈" + "分配远程数据缓冲区" + "远程Hook" —— 与用户观察一致
- **目标函数地址 0x7ffcda61efb0, Weixin.dll base 0x7FFCDA040000 => RVA 0x5DEFB0**
- 入口5字节: 55 41 57 41 56 (push rbp;push r15;push r14;push rsi;push rdi;push rbx;sub rsp,0x58)
- 4 参数函数(rcx,rdx,r8d,r9d); call 0x2965c0; call 0x6f54f1c(ecx=0x238 分配)
- 关键: 状态 "Hook安装成功，现在登录微信..." => key 在【登录动作】那一刻产生, 需 hook 先装好再登录
- PollKeyData 要求 buffer>=0x41=65 => 64hex+null = 32字节 key
