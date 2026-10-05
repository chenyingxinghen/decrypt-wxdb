// main.js — 主进程：窗口管理 + Python 桥接
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---- 配置（打包时由 build.js 注入真实值）----
// 开发态：app 直接跑在 wememo_app/ 或 dist/，引擎在 __dirname 上溯两级的 engine/。
// 打包态：JS 进了 app.asar，引擎由 extraResources 投递到 resources/engine/
//         （与 app.asar 同级、真实磁盘）。引擎是 Nuitka 编译的原生独立二进制 bridge.exe，
//         自带 Python 运行时与全部依赖，软件包内不再含解释器，故按 app.isPackaged 切换。
const APP_ROOT = path.join(__dirname, '..', '..');
const ENGINE_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'engine')
  : path.join(APP_ROOT, 'engine');
let DB_ROOT = '';   // 解密库根目录（运行时由渲染层触发探测）

// ---- 引擎桥接 ----
// 打包态：spawn Nuitka 编译产物 bridge.exe（原生独立二进制，内嵌 Python 运行时 +
//         cryptography/zstandard 等全部依赖，软件包内不再含解释器）。
// 开发态：直接用 Python 跑 engine/bridge.py 源码（免编译，迭代快）。
let py = null;
let pyBuf = '';
const PYBUF_MAX = 64 * 1024 * 1024;   // stdout 行缓冲上限（防损坏/超大行拖爆内存）
let pyPending = new Map();  // id -> resolve
let pySeq = 0;

// 打包态定位 bridge.exe：优先根目录，否则在 engine/ 下递归找首个
// （Nuitka 通常把 bridge.exe 放根、依赖放 bridge.dist/ 子目录，递归兜底更稳）。
function findEngineExe() {
  if (!app.isPackaged) return null;
  const root = path.join(process.resourcesPath, 'engine');
  const direct = path.join(root, 'bridge.exe');
  if (fs.existsSync(direct)) return direct;
  let found = null;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'bridge.exe') found = p;
    }
  };
  try { walk(root); } catch (err) {}
  return found;
}

function ensurePython() {
  if (py) return py;
  // PYTHONIOENCODING 保证二进制/源码两种路径下 stdin/stdout 都是 UTF-8（协议满是中英混合与 emoji）。
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  const exe = findEngineExe();
  let bin, args;
  if (exe) {
    bin = exe;
    args = [];                 // 原生二进制，无需解释器参数
  } else {
    // 开发态：用 Python 跑源码入口
    bin = process.env.WEMEMO_PYTHON || 'python';
    args = [path.join(ENGINE_ROOT, 'bridge.py')];
  }
  py = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  py.stdout.on('data', (d) => {
    pyBuf += d.toString('utf8');
    // 保护：单行响应异常膨胀（损坏/超大 BLOB data URL）时设上限，防主进程内存被拖爆。
    // 正常图片 data URL 也可能数 MB，故上限给到 64MB；越限即丢弃当前累积并跳到下一行边界。
    if (pyBuf.length > PYBUF_MAX) {
      const nl = pyBuf.lastIndexOf('\n');
      pyBuf = nl >= 0 ? pyBuf.slice(nl + 1) : '';
    }
    let idx;
    while ((idx = pyBuf.indexOf('\n')) >= 0) {
      const line = pyBuf.slice(0, idx).trim();
      pyBuf = pyBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event) {
          // 事件行（如解密进度）→ 转发到渲染层
          try {
            const w = BrowserWindow.getAllWindows()[0];
            if (w && w.webContents && !w.isDestroyed()) {
              w.webContents.send('bridge-event', msg.event, msg.data);
            }
          } catch (e) { /* 静默 */ }
          continue;
        }
        const cb = pyPending.get(msg.id);
        if (cb) {
          pyPending.delete(msg.id);
          cb(msg);
        }
      } catch (e) { /* 忽略损坏行 */ }
    }
  });
  py.stderr.on('data', () => { /* 静默，不向用户暴露细节 */ });
  py.on('exit', () => { py = null; });
  return py;
}

function callPy(method, params, timeout = 15000) {
  const p = ensurePython();
  const id = ++pySeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pyPending.delete(id);
      reject(new Error(`引擎调用超时: ${method}`));
    }, timeout);
    pyPending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    p.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

// ---- 窗口 ----
let win = null;

// 生产标记：由 loader.js 在签名自检通过后写入 global.__wememo_sec.prod。
// 开发树（未注入 BUILD_SIG）下为 false，保留 DevTools 便于调试。
function isProd() {
  try { return !!(global.__wememo_sec && global.__wememo_sec.prod); }
  catch (e) { return false; }
}

// 反侵入动作：静默、不暴露原因，延迟收尾（与 loader 的风格一致）。
let _tamperFired = false;
function onIntrusion() {
  if (_tamperFired) return;
  _tamperFired = true;
  try { if (py) { py.kill(); py = null; } } catch (e) {}
  setTimeout(() => { try { app.quit(); } catch (e) {} try { process.exit(0); } catch (e) {} }, 1500);
}

function hardenWindow(w) {
  if (!isProd()) return;   // 开发模式不设限
  try {
    const wc = w && w.webContents;
    if (!wc || typeof wc.on !== 'function') return;
    // 1) 禁用 DevTools 快捷键（F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C）
    wc.on('before-input-event', (e, input) => {
      const k = ((input && input.key) || '').toLowerCase();
      if (k === 'f12') { e.preventDefault(); return; }
      if (input && input.control && input.shift && ['i', 'j', 'c'].includes(k)) { e.preventDefault(); }
    });
    // 2) 任何途径打开 DevTools（含 --remote-debugging / 菜单）→ 立即关闭并按入侵处理
    wc.on('devtools-opened', () => { try { wc.closeDevTools(); } catch (e) {} onIntrusion(); });
    // 3) 渲染层不得导航或开新窗口（离线单页应用，外链走 shell.openExternal）
    if (typeof wc.setWindowOpenHandler === 'function') wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => {
      try { if (url !== wc.getURL()) e.preventDefault(); } catch (err) { e.preventDefault(); }
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  } catch (e) { /* 静默：加固失败绝不阻断启动 */ }
}

function createWindow() {
  const prod = isProd();
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#EDEDED',
    titleBarStyle: 'hidden',
    frame: false,
    show: false,
    // Windows 任务栏 / 窗口图标（build 后位于 dist/src/renderer/assets/app-icon.png）
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !prod,            // 生产包彻底关闭 DevTools
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  hardenWindow(win);
  // 生产包移除应用菜单（连带 DevTools 菜单项与其加速键）
  if (prod) { try { win.removeMenu(); } catch (e) {} }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// ---- IPC ----
// 部分方法需要更长时间：stats/profile 要对全部 Msg 表做一次聚合扫描（20 万+ 行），
// search_messages 首次要解码全库内容建索引（本地库不存明文，SQL LIKE 无从下手），
// sync_run 要重解密所有变化的库（微信在线时的增量同步）
const SLOW_METHODS = {
  stats: 120000, profile: 60000, search_messages: 180000, context: 30000,
  sync_run: 300000, sync_status: 30000, original_image: 30000,
  auto_decrypt: 180000, extract_key: 180000,
};

// 渲染层可经通用 'bridge' 通道调用的方法白名单（A-P2）。
// 只放行 preload 实际使用的只读查询；auto_decrypt/extract_key/init/export 等
// 只由主进程内部按需调用（envInitInner / export:run），不经此通道，杜绝渲染层一旦
// 被 XSS/CDP 控制即可直呼引擎全部能力（含任意路径写文件）。
const BRIDGE_METHODS = new Set([
  'sessions', 'messages', 'msg_count', 'image', 'original_image',
  'search', 'search_messages', 'context', 'messages_after',
  'contacts', 'stats', 'profile', 'sync_status', 'sync_run',
]);

// 校验 IPC 来源：必须来自本应用主窗口的顶层框架（拒绝子框架/被劫持的 sender）。
function isTrusted(e) {
  try {
    if (!win || win.isDestroyed()) return false;
    if (e.sender !== win.webContents) return false;
    const f = e.senderFrame;
    if (f && f.parent) return false;   // 仅顶层框架
    return true;
  } catch (err) { return false; }
}

ipcMain.handle('bridge', async (e, method, params) => {
  if (!isTrusted(e) || !BRIDGE_METHODS.has(method)) {
    return { ok: false, error: 'forbidden' };
  }
  const res = await callPy(method, params, SLOW_METHODS[method] || 15000);
  return res;
});

ipcMain.handle('window:action', (e, act) => {
  if (!isTrusted(e)) return false;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (act === 'min') w.minimize();
  else if (act === 'max') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (act === 'close') w.close();
  return true;
});

// 外部链接：仅放行 http/https，交系统默认浏览器打开（离线应用不内嵌 web 内容）
ipcMain.handle('open:external', (e, url) => {
  if (!isTrusted(e)) return false;
  try {
    // 用 URL 解析判定协议，避免正则中出现 "//"（构建期极简混淆器会误判为行注释）
    if (typeof url === 'string') {
      const proto = new URL(url).protocol;
      if (proto === 'http:' || proto === 'https:') {
        shell.openExternal(url);
        return true;
      }
    }
  } catch (e2) { /* 静默：非法 URL 或解析失败 */ }
  return false;
});

// 导出：选目录 → 引擎写文件 → 可在资源管理器中定位结果
ipcMain.handle('export:run', async (e, opts) => {
  if (!isTrusted(e)) return { ok: false, error: 'forbidden' };
  const o = opts || {};
  const w = BrowserWindow.fromWebContents(e.sender);
  const pick = await dialog.showOpenDialog(w, {
    title: o.all ? '选择导出目录（将新建带时间戳的子目录）' : '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '导出到此处',
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths.length) {
    return { ok: false, canceled: true };
  }
  const outDir = pick.filePaths[0];
  // 全部导出可能很久（数百会话）：给足超时
  const timeout = o.all ? 30 * 60 * 1000 : 5 * 60 * 1000;
  const res = await callPy('export', {
    outDir, format: o.format || 'txt', all: !!o.all, username: o.username || '',
  }, timeout);
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || '导出失败' };
  return { ok: true, ...res.result };
});

// 在系统文件管理器中显示导出结果
ipcMain.handle('reveal:path', (e, p) => {
  if (!isTrusted(e)) return false;
  try {
    if (typeof p === 'string' && fs.existsSync(p)) {
      shell.showItemInFolder(p);
      return true;
    }
  } catch (e2) { /* 静默 */ }
  return false;
});

// 打开本地目录（个人主页「打开数据目录」）；仅限已存在的目录，避免任意路径执行
ipcMain.handle('open:path', async (e, p) => {
  if (!isTrusted(e)) return false;
  try {
    if (typeof p === 'string' && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      await shell.openPath(p);
      return true;
    }
  } catch (e2) { /* 静默 */ }
  return false;
});

// 运行环境信息（个人主页展示；不含任何敏感数据）
ipcMain.handle('app:info', (e) => {
  if (!isTrusted(e)) return {};
  // app.getVersion() 在未打包运行时返回 Electron 版本，故优先读 package.json
  let version = '';
  try {
    version = require(path.join(APP_ROOT, 'package.json')).version || '';
  } catch (e2) { /* 回退到 app.getVersion */ }
  return {
    version: version || app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${os.release()}`,
    dbRoot: DB_ROOT,
  };
});

// ---- 健壮的文件系统探测（绝不因单个坏条目/无权限/非目录而抛，导致整个启动失败）----
function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch (e) { return []; }
}
function safeExists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

ipcMain.handle('env:init', async (e) => {
  if (!isTrusted(e)) return { ok: false, found: false, reason: 'unexpected' };
  // 兜底：无论内部发生什么，都返回结构化结果，绝不让前端只看到一句「初始化失败」。
  // reason 字段是机器可读的原因码，渲染层据此给出针对性的操作建议。
  try {
    return await envInitInner();
  } catch (e2) {
    return { ok: false, found: false, reason: 'unexpected',
             detail: String((e2 && e2.message) || e2) };
  }
});

async function envInitInner() {
  // 启动引导：1) 现成解密库  2) 自动解密（首次）  3) 打开库并校验
  const xwechatHome = path.join(os.homedir(), 'xwechat_files');
  let dec = null;
  let xwechat = process.env.WEMEMO_XWECHAT_ROOT && safeIsDir(process.env.WEMEMO_XWECHAT_ROOT)
    ? process.env.WEMEMO_XWECHAT_ROOT : null;

  // 1) 显式指定
  if (process.env.WEMEMO_DB_ROOT) dec = findDecrypted(process.env.WEMEMO_DB_ROOT);

  // 2) 标准 APPDATA 输出位置（autodecrypt 默认写到这里）。
  //    注意此目录里除账号子目录外还有 master_key.txt 等文件——必须逐项容错，
  //    绝不能对文件调 readdir（否则 ENOTDIR，整个启动崩成「初始化失败」）。
  if (!dec) {
    const appData = process.env.APPDATA || path.join(os.homedir(), '.wememo');
    const wememoDir = path.join(appData, 'wememo', 'decrypted');
    for (const sub of safeReaddir(wememoDir)) {
      const d = findDecrypted(path.join(wememoDir, sub));
      if (d) { dec = d; break; }
    }
  }
  // 3) xwechat 数据目录下（旧兼容：解密在 xwechat_files/<account>/decrypted）
  if (!dec) {
    for (const sub of safeReaddir(xwechatHome)) {
      const p = path.join(xwechatHome, sub);
      if (!safeIsDir(p)) continue;
      const d = findDecrypted(p);
      if (d) { dec = d; break; }
    }
  }
  if (!xwechat && safeIsDir(xwechatHome)) xwechat = xwechatHome;

  // 4) 首次启动：未发现解密库 → 自动解密（含密钥提取，全程可能 2~180s）
  if (!dec) {
    if (!xwechat) {
      // 既没有解密库，也没有微信数据目录：无从下手
      return { ok: false, found: false, reason: 'no_wechat_data' };
    }
    let res;
    try {
      res = await callPy('auto_decrypt', {}, 180000);
    } catch (e) {
      // 引擎无响应/超时（bridge 起不来、密钥提取一直等扫码等）
      return { ok: false, found: false, reason: 'engine_timeout',
               detail: String((e && e.message) || e) };
    }
    if (res && res.ok && res.result && res.result.ok) {
      dec = res.result.root;
    } else {
      // 引擎给的失败原因（多半是密钥提取相关），透传给渲染层
      const msg = (res && res.result && res.result.msg) || (res && res.error) || '';
      return { ok: false, found: false, reason: 'decrypt_failed', msg };
    }
  }

  // 5) 打开库（构建 store）——必须校验结果，别再「假装成功」后到处报错
  DB_ROOT = dec;
  let initRes;
  try {
    initRes = await callPy('init', { dbRoot: dec, xwechatRoot: xwechat || '' }, 60000);
  } catch (e) {
    return { ok: false, found: false, reason: 'engine_timeout',
             detail: String((e && e.message) || e) };
  }
  if (!initRes || !initRes.ok) {
    // 找到了解密数据，但库打不开（半截解密 / 文件损坏 / 结构变化）
    return { ok: false, found: false, reason: 'store_open_failed',
             detail: (initRes && initRes.error) || '', dbRoot: dec };
  }
  return { ok: true, found: true, auto: dec !== (process.env.WEMEMO_DB_ROOT || '') };
}

function findDecrypted(root) {
  // 允许直接指向解密根（含 session/session.db.plain）
  if (safeExists(path.join(root, 'session', 'session.db.plain'))) return root;
  // 否则在其下逐项探测 <sub>/decrypted/session/...——跳过文件与不可读目录，绝不抛
  if (!safeIsDir(root)) return null;
  for (const sub of safeReaddir(root)) {
    const dec = path.join(root, sub, 'decrypted');
    if (safeExists(path.join(dec, 'session', 'session.db.plain'))) return dec;
  }
  return null;
}

// 重新解密：仅清空本应用生成的解密副本（可从微信源库再生），**保留 master_key.txt**
// 以免用户再次扫码登录。绝不触碰微信原始数据。用于"半截解密/文件损坏"的一键恢复。
ipcMain.handle('env:reset', async (e) => {
  if (!isTrusted(e)) return { ok: false, error: 'forbidden' };
  const w = BrowserWindow.fromWebContents(e.sender);
  const appData = process.env.APPDATA || path.join(os.homedir(), '.wememo');
  const decRoot = path.join(appData, 'wememo', 'decrypted');
  if (!safeIsDir(decRoot)) return { ok: true, removed: 0 };
  const pick = await dialog.showMessageBox(w, {
    type: 'warning',
    buttons: ['重新解密', '取消'],
    defaultId: 0, cancelId: 1, noLink: true,
    title: '重新解密',
    message: '将清空已解密的数据并重新解密',
    detail: '只删除本应用生成的解密副本，不会动微信原始数据；已保存的密钥会保留，'
      + '通常无需再次扫码登录。',
  });
  if (pick.response !== 0) return { ok: false, canceled: true };
  // 先结束引擎，释放 sqlite 只读句柄，否则 Windows 下删不掉这些文件
  if (py) { try { py.kill(); } catch (e2) {} py = null; }
  let removed = 0;
  for (const name of safeReaddir(decRoot)) {
    if (name === 'master_key.txt') continue;   // 保留密钥，免得重新登录
    try { fs.rmSync(path.join(decRoot, name), { recursive: true, force: true }); removed += 1; }
    catch (e2) { /* 个别文件占用/无权限：跳过，重试仍可推进 */ }
  }
  DB_ROOT = '';
  return { ok: true, removed };
});

// 打开本应用的数据目录（%APPDATA%\wememo），方便用户自行排查/清理
ipcMain.handle('open:dataDir', async (e) => {
  if (!isTrusted(e)) return false;
  const appData = process.env.APPDATA || path.join(os.homedir(), '.wememo');
  const dir = path.join(appData, 'wememo');
  try {
    if (!safeExists(dir)) fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  } catch (e2) { return false; }
});

// ---- 生命周期 ----
// 单实例锁（C-P1）：拿不到锁直接退出，杜绝双开并发操作同一解密库
// （env:reset 删文件时另一实例正持句柄 → Windows 静默删除失败、状态错乱），
// 同时堵住「第二个实例附加调试」这条侧信道。
const _gotLock = app.requestSingleInstanceLock ? app.requestSingleInstanceLock() : true;
if (!_gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已有实例：聚焦现有窗口，忽略新启动
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Windows 任务栏分组/图标归属（AppUserModelID 需与打包 exe 一致才能显示自定义图标）
    if (process.platform === 'win32' && app.setAppUserModelId) {
      app.setAppUserModelId('com.wememo.app');
    }
    // 反侵入（生产包）：命令行含调试开关即视为受控环境，静默收尾。
    // loader 已在更早阶段做过一轮 argv 探测；这里覆盖 whenReady 之后的窗口期。
    if (isProd() && hasDebugFlag()) { onIntrusion(); return; }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// 探测本进程是否带远程调试/inspector 开关（生产包下判定为入侵）
function hasDebugFlag() {
  try {
    const argv = (process.argv || []).concat(process.execArgv || []).join(' ').toLowerCase();
    return /--inspect|--remote-debugging-port|--remote-debugging-pipe|--inspect-brk|--js-flags=.*debug/.test(argv);
  } catch (e) { return false; }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (py) { try { py.kill(); } catch (e) {} }
});
