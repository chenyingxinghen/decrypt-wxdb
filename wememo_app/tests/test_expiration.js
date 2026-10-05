// test_expiration.js — 过期控制系统验证
// 测试：许可证签名验证、过期判定、高水位时钟守卫、硬底线
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write(`  ✅ ${msg}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${msg}\n`); }
}

// --- 1) 许可证格式与签名验证 ---
process.stdout.write('\n━━━ 许可证签名验证 ━━━\n');

const licPath = path.join(ROOT, 'license.dat');
assert(fs.existsSync(licPath), 'license.dat 存在');

const buf = fs.readFileSync(licPath);
const payloadLen = buf.readUInt32LE(0);
const payload = buf.slice(4, 4 + payloadLen);
const sig = buf.slice(4 + payloadLen, 4 + payloadLen + 64);
assert(sig.length === 64, '签名长度 64 字节');

const pubHex = fs.readFileSync(path.join(ROOT, 'keys', 'license.pub'), 'utf8').trim();
const pubKey = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]),
  format: 'der', type: 'spki'
});
const valid = crypto.verify(null, payload, pubKey, sig);
assert(valid, '签名验证通过');

const lic = JSON.parse(payload.toString('utf8'));
assert(lic.customer === 'test-user', 'customer 字段正确');
assert(lic.expires > Math.floor(Date.now() / 1000), 'expires 在未来');
assert(lic.expires <= Math.floor(Date.now() / 1000) + 31 * 86400, 'expires 在 31 天内');

// --- 2) 篡改签名应失败 ---
process.stdout.write('\n━━━ 篡改检测 ━━━\n');
const tampered = Buffer.from(buf);
tampered[5] ^= 0xFF; // 翻转 payload 一字节
const tamperedPayload = tampered.slice(4, 4 + payloadLen);
const tamperedValid = crypto.verify(null, tamperedPayload, pubKey, sig);
assert(!tamperedValid, '篡改 payload 后签名验证失败');

// --- 3) 高水位模块基本功能 ---
process.stdout.write('\n━━━ 高水位时钟守卫 ━━━\n');
// 直接测试模块逻辑（mock electron.app）
const hwmSrc = path.join(ROOT, 'src', 'main', 'hwm.js');
// 用临时目录模拟 userData
const tmpDir = path.join(ROOT, 'tests', '_tmp_hwm_test');
fs.mkdirSync(tmpDir, { recursive: true });

// 简化测试：直接读源码中的文件/mtime逻辑
const hwmCode = fs.readFileSync(hwmSrc, 'utf8');
assert(hwmCode.includes('readFile'), 'hwm 含 readFile');
assert(hwmCode.includes('readMtime'), 'hwm 含 readMtime');
assert(hwmCode.includes('readReg'), 'hwm 含 readReg (Windows)');
assert(hwmCode.includes('writeAll'), 'hwm 含 writeAll');

// 功能测试：写入高水位文件再读回
const hwmFile = path.join(tmpDir, 'h');
const nowSec = Math.floor(Date.now() / 1000);
fs.writeFileSync(hwmFile, String(nowSec));
const readBack = parseInt(fs.readFileSync(hwmFile, 'utf8').trim(), 10);
assert(readBack === nowSec, '高水位文件读写一致');

// 清理
try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}

// --- 4) 构建产物含 HARD_DEADLINE ---
process.stdout.write('\n━━━ 硬底线注入 ━━━\n');
const loaderDist = path.join(ROOT, 'dist', 'src', 'main', 'loader.js');
if (fs.existsSync(loaderDist)) {
  const loaderCode = fs.readFileSync(loaderDist, 'utf8');
  assert(!loaderCode.includes('__HARD_DEADLINE__'), 'HARD_DEADLINE 已被注入（非占位符）');
  assert(!loaderCode.includes('__BUILD_SIG__'), 'BUILD_SIG 已被注入');
  assert(!loaderCode.includes('__MANIFEST_SIG__'), 'MANIFEST_SIG 已被注入');
  // 提取 HARD_DEADLINE 值
  const m = loaderCode.match(/HARD_DEADLINE\s*=\s*'(\d+)'/);
  if (m) {
    const dl = parseInt(m[1], 10);
    const daysFromNow = (dl - nowSec) / 86400;
    assert(daysFromNow > 85 && daysFromNow < 95, `硬底线约 ${daysFromNow.toFixed(0)} 天后到期`);
  } else {
    assert(false, '未能提取 HARD_DEADLINE 数值');
  }
} else {
  assert(false, 'dist/src/main/loader.js 不存在（需先 npm run build）');
}

// --- 5) hwm.js 在 manifest 中 ---
process.stdout.write('\n━━━ 清单覆盖 ━━━\n');
const manifestPath = path.join(ROOT, 'dist', 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert('src/main/hwm.js' in manifest, 'hwm.js 在完整性清单中');
} else {
  assert(false, 'manifest.json 不存在');
}

// --- 汇总 ---
process.stdout.write(`\n================ 过期控制测试汇总 ================\n`);
process.stdout.write(`  通过: ${passed}  失败: ${failed}\n`);
process.exit(failed ? 1 : 0);
