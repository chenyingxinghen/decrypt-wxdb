// tools/smoke_gui.js — 渲染层无头冒烟：加载 dist 的 index.html + preload，
// 捕获渲染进程 console 错误，验证 app.js 无 DOM 运行时异常（不启动引擎/不弹窗）
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
let errors = 0;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(DIST, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {  // warning/error
      errors++;
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    errors++;
    console.error('[renderer-gone]', details.reason);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors++;
    console.error('[load-fail]', code, desc);
  });
  win.loadFile(path.join(DIST, 'src', 'renderer', 'index.html'));

  // 等渲染层完成 init 尝试（含失败路径），再收集结果
  setTimeout(() => {
    win.webContents.executeJavaScript(`
      (() => ({
        bodyReady: !!document.getElementById('chatBody'),
        hasBtnToBottom: !!document.getElementById('btnToBottom'),
        hasBootBar: !!document.getElementById('bootBar'),
        bootErrVisible: document.getElementById('bootErr') ? getComputedStyle(document.getElementById('bootErr')).display !== 'none' : false,
        bootErrText: document.getElementById('bootErr') ? document.getElementById('bootErr').textContent : '',
        tabCount: document.querySelectorAll('.tabbar .tab').length,
        wememoApi: typeof window.wememo,
      }))()
    `).then((r) => {
      console.log('smoke-state:', JSON.stringify(r));
      console.log(errors === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${errors} renderer errors)`);
      app.exit(errors === 0 ? 0 : 1);
    }).catch((e) => {
      console.error('smoke-eval-fail:', e.message);
      app.exit(2);
    });
  }, 4000);
});
