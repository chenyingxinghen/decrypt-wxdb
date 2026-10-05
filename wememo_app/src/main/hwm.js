// hwm.js — 高水位时钟守卫（防系统时钟回拨绕过过期判定）
// 持久化「见过的最晚时间」到三处冗余存储：文件内容 / 文件 mtime / 注册表。
// 任一存储被删仍有另两处兜底；全部被清理则退化为纯时钟判定（与 weflow 同级）。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REG_KEY = 'HKCU\\Software\\WeMemo';
const REG_VAL = 'hwm';

let _hwmDir = null;

function hwmDir() {
  if (_hwmDir) return _hwmDir;
  try {
    const { app } = require('electron');
    _hwmDir = path.join(app.getPath('userData'), '.wm');
  } catch (e) {
    _hwmDir = path.join(process.env.APPDATA || process.env.HOME || '.', 'WeMemo', '.wm');
  }
  try { fs.mkdirSync(_hwmDir, { recursive: true }); } catch (e) {}
  return _hwmDir;
}

function hwmFile() { return path.join(hwmDir(), 'h'); }

// 读文件内容里的时间戳（秒）
function readFile() {
  try {
    const t = parseInt(fs.readFileSync(hwmFile(), 'utf8').trim(), 10);
    return isFinite(t) ? t : 0;
  } catch (e) { return 0; }
}

// 读文件 mtime（秒）
function readMtime() {
  try { return Math.floor(fs.statSync(hwmFile()).mtimeMs / 1000); }
  catch (e) { return 0; }
}

// 读注册表（Windows only）
function readReg() {
  if (process.platform !== 'win32') return 0;
  try {
    const r = spawnSync('reg', ['query', REG_KEY, '/v', REG_VAL], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return 0;
    const m = /REG_QWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
    if (m) return parseInt(m[1], 16);
    const m2 = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
    if (m2) return parseInt(m2[1], 16);
    return 0;
  } catch (e) { return 0; }
}

// 写入三处
function writeAll(ts) {
  const s = String(ts);
  try { fs.writeFileSync(hwmFile(), s); } catch (e) {}
  // touch mtime
  try { const t = new Date(ts * 1000); fs.utimesSync(hwmFile(), t, t); } catch (e) {}
  // registry
  if (process.platform === 'win32') {
    try {
      spawnSync('reg', ['add', REG_KEY, '/v', REG_VAL, '/t', 'REG_QWORD', '/d', s, '/f'],
        { timeout: 3000, stdio: 'ignore' });
    } catch (e) {}
  }
}

// 核心：校验时钟有没有被回拨。返回 true = 正常，false = 检测到回拨
// tolerance: 允许的回退秒数（默认 60s，容许正常 NTP 同步微调）
function check(tolerance) {
  const tol = tolerance || 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const hw = Math.max(readFile(), readMtime(), readReg());
  if (hw > 0 && nowSec < hw - tol) {
    return false; // 回拨
  }
  // 更新高水位
  if (nowSec > hw) writeAll(nowSec);
  return true;
}

// 读取当前高水位（给外部判定用）
function getHighWater() {
  return Math.max(readFile(), readMtime(), readReg());
}

module.exports = { check, getHighWater, writeAll };
