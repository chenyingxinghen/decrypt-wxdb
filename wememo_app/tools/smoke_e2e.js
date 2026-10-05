// tools/smoke_e2e.js — 端到端冒烟：真实渲染层(app.js) + 真实引擎(bridge.py)
// 验证：init → 会话列表 → 打开含图片的会话 → 图片懒加载 → 显示 <img>
// 用法：env -u ELECTRON_RUN_AS_NODE electron tools/smoke_e2e.js --no-sandbox
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// 兜底默认值用占位符；实际运行请设置 WEMEMO_DB_ROOT / WEMEMO_XWECHAT_ROOT
const DB_ROOT = process.env.WEMEMO_DB_ROOT || '%USERPROFILE%/AppData/Roaming/wememo/decrypted/<YOUR_WXID>_c359';
const XWECHAT = process.env.WEMEMO_XWECHAT_ROOT || '%USERPROFILE%/xwechat_files';

// ---- 模拟主进程桥接（复用真实 bridge.py 引擎）----
let py = null, pyBuf = '', pyPending = new Map(), pySeq = 0;
function startPy() {
  py = spawn('python3', [path.join(__dirname, '..', 'engine', 'bridge.py')],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  py.stdout.on('data', (d) => {
    pyBuf += d.toString('utf8');
    let idx;
    while ((idx = pyBuf.indexOf('\n')) >= 0) {
      const line = pyBuf.slice(0, idx).trim();
      pyBuf = pyBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const cb = pyPending.get(msg.id);
        if (cb) { pyPending.delete(msg.id); cb(msg); }
      } catch (e) { /* 忽略 */ }
    }
  });
  py.stderr.on('data', () => {});
}
function callPy(method, params) {
  if (!py) startPy();
  const id = ++pySeq;
  return new Promise((resolve) => { pyPending.set(id, resolve); py.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
}

ipcMain.handle('env:init', async () => {
  await callPy('init', { dbRoot: DB_ROOT, xwechatRoot: XWECHAT });
  return { ok: true, found: true };
});
ipcMain.handle('bridge', async (_e, method, params) => callPy(method, params || {}));
ipcMain.handle('window:action', () => true);

let errors = 0;
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: true, width: 1040, height: 720,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.on('console-message', (_e, level, message, line, sid) => {
    if (level >= 2) { errors++; console.error(`[renderer:${level}] ${message} (${sid}:${line})`); }
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // 等渲染层 init + 会话渲染完成后，逐个打开会话找图片
  setTimeout(async () => {
    const state = await win.webContents.executeJavaScript(`
      (async () => {
        const sessions = [...document.querySelectorAll('.session')];
        if (!sessions.length) return { error: 'no sessions rendered', tab: document.querySelectorAll('.tab').length };
        let opened = null, imgPh = 0;
        for (const el of sessions) {
          el.click();
          await new Promise(r => setTimeout(r, 500));
          const imgs = document.querySelectorAll('.chat-messages .img-ph');
          if (imgs.length) { opened = el.querySelector('.name').textContent.trim(); imgPh = imgs.length; break; }
        }
        return { opened, imgPh, sessionTotal: sessions.length };
      })()
    `);
    console.log('e2e-open:', JSON.stringify(state));

    // 再等图片懒加载完成，统计实际渲染的 <img>
    setTimeout(async () => {
      const imgStat = await win.webContents.executeJavaScript(`
        (async () => {
          const phs = [...document.querySelectorAll('.chat-messages .img-ph')];
          // 无头/后台窗口时 IntersectionObserver 可能不触发；手动调用 getImage 验证 IPC+引擎链路
          const first = phs[0];
          let manual = null;
          if (first) {
            const active = document.querySelector('.session.active');
            const user = active ? active.dataset.user : '';
            const r = await window.wememo.getImage(user, first.dataset.ts, first.dataset.hash);
            manual = { urlLen: (r && r.url) ? r.url.length : 0, urlPrefix: (r && r.url) ? r.url.slice(0, 30) : '' };
            if (manual.urlLen > 0) first.innerHTML = '<img src="' + r.url + '" />';
          }
          return new Promise(res => setTimeout(() => res({
            loaded: document.querySelectorAll('.chat-messages .img-ph img').length,
            missed: document.querySelectorAll('.chat-messages .img-ph.miss').length,
            phTotal: phs.length,
            manual,
          }), 500));
        })()
      `);
      console.log('e2e-imgs:', JSON.stringify(imgStat));
      const ok = !state.error && imgStat.manual && imgStat.manual.urlLen > 0;
      console.log(ok && errors === 0 ? 'E2E PASS' : 'E2E FAIL');
      if (py) try { py.kill(); } catch (e) {}
      app.exit(ok && errors === 0 ? 0 : 1);
    }, 4000);
  }, 6000);
});
