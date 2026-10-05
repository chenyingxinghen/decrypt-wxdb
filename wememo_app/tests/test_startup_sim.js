// test_startup_sim.js — 模拟 Electron 主进程启动流程（mock electron API）
// 验证：loader 自检通过 → 加载 main.js → 无顶层异常 → 窗口创建 → loadFile
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---- Mock electron ----
const mockWindows = [];
let whenReadyCb = null;
const events = {};

// 模拟 userData 目录并放入有效 license.dat（若存在于项目根）
const mockUserData = path.join(__dirname, '_tmp_startup_sim');
fs.mkdirSync(mockUserData, { recursive: true });
const licSrc = path.join(__dirname, '..', 'license.dat');
if (fs.existsSync(licSrc)) fs.copyFileSync(licSrc, path.join(mockUserData, 'license.dat'));

const electronMock = {
  app: {
    whenReady: () => Promise.resolve().then(() => { if (whenReadyCb) whenReadyCb(); }),
    on: (ev, cb) => { events[ev] = cb; },
    quit: () => { console.log('[mock] app.quit() 被调用'); process.exit(0); },
    requestSingleInstanceLock: () => true,
    setAppUserModelId: () => {},
    getVersion: () => '0.0.0-test',
    getPath: (name) => { if (name === 'userData') return mockUserData; return mockUserData; },
  },
  BrowserWindow: class {
    constructor(opts) {
      this.opts = opts;
      this._destroyed = false;
      // 忠实模拟 webContents（生产加固会挂 before-input-event / devtools-opened 等监听）
      this.webContents = {
        on: () => {},
        once: () => {},
        setWindowOpenHandler: () => {},
        closeDevTools: () => {},
        isDevToolsOpened: () => false,
        getURL: () => '',
        send: () => {},
      };
      mockWindows.push(this);
      console.log('[mock] BrowserWindow 创建, preload=', opts.webPreferences.preload,
        '| devTools=', opts.webPreferences.devTools);
    }
    loadFile(p) {
      console.log('[mock] loadFile:', p);
      if (!fs.existsSync(p)) { console.error('[mock] ❌ 加载失败: 文件不存在', p); process.exit(2); }
      console.log('[mock] ✅ 渲染层存在:', p);
      return Promise.resolve();
    }
    loadURL() { return Promise.resolve(); }
    once(ev, cb) { if (ev === 'ready-to-show') cb(); }
    show() {}
    focus() {}
    restore() {}
    isMinimized() { return false; }
    isDestroyed() { return this._destroyed; }
    removeMenu() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
    close() {}
    static fromWebContents() { return mockWindows[0]; }
    static getAllWindows() { return mockWindows; }
  },
  ipcMain: { handle: (ch, fn) => { console.log('[mock] ipcMain.handle:', ch); } },
  shell: {},
  dialog: {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

// ---- 加载 dist 的 loader（走真实路径） ----
const DIST = path.join(__dirname, '..', 'dist');
console.log('模拟启动 dist 应用...\n');

// 先验证自检逻辑（直接 require loader 会执行，我们捕获其行为）
try {
  require(path.join(DIST, 'src', 'main', 'loader.js'));
  // loader 同步执行了 require('./main.js')（若自检通过）或注册静默退出（若失败）
  if (events['window-all-closed']) {
    console.log('\n✅ loader 自检通过，已加载 main.js，注册了窗口生命周期');
  } else {
    console.log('\n❌ main.js 未被加载 —— 自检失败走了静默退出分支');
    process.exit(1);
  }
  // 触发 whenReady → createWindow
  whenReadyCb = () => {
    console.log('[mock] app.whenReady 触发 → createWindow');
    mockWindows[0] && console.log('[mock] 窗口已创建, 数量:', mockWindows.length);
  };
} catch (e) {
  console.error('\n❌ 启动模拟异常:', e.message);
  process.exit(1);
}

// mock 无真实事件循环常驻（loader 的 antiDebug setInterval 会挂住进程），
// 验证主流程完成后显式收尾；若 2s 内未触发说明 whenReady 链路异常。
setTimeout(() => {
  if (!mockWindows.length) {
    console.error('❌ 窗口未创建 —— whenReady 链路异常');
    process.exit(1);
  }
  console.log('✅ 启动模拟完成');
  // 清理临时目录
  try { fs.rmSync(mockUserData, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}, 200);
