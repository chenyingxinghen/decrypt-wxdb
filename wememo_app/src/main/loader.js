// loader.js — 启动入口（防逆向保护层 1+2+3）
// 真实逻辑在 main.js；本入口执行完整性自检 + 反调试探测 + 蜜罐校验，异常时不暴露原因。
'use strict';
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 由 build.js 注入的构建时签名：
//   BUILD_SIG    = sha256(minified main.js)
//   MANIFEST_SIG = sha256(manifest.json)  —— 把清单绑定到 loader，攻击者无法「改文件后重算清单蒙混」
//   HARD_DEADLINE = 构建期烘焙的绝对到期 Unix 时间戳（秒），即便 license.dat 被剥离也有硬底线
const BUILD_SIG = '__BUILD_SIG__';
const MANIFEST_SIG = '__MANIFEST_SIG__';
const HARD_DEADLINE = '__HARD_DEADLINE__';
// Ed25519 公钥（32 字节 hex）—— 验证 license.dat 签名用，私钥只在签发端
const LICENSE_PUB = '963143f67e9768231d29a7436fe866ba844409159db9cf24b51f7f9ef251f05a';
// 应用自校验常量（蜜罐标记的期望值）
const EXPECTED_MARK = 0x7E57C0DE;

// 已签名（发布）态：只有注入过真实签名才启用全部主动防护，开发树不误伤。
const SIGNED = !!(BUILD_SIG && BUILD_SIG.indexOf('__BUILD') !== 0);

// 应用根目录：__dirname = <dist>/src/main，需上溯两级到 <dist>
const APP_ROOT = path.join(__dirname, '..', '..');

function sha256buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function sha256file(p) { return sha256buf(fs.readFileSync(p)); }

// 静默延迟收尾：不抛错、不写日志、不暴露原因（对齐现有风格）。
let _exiting = false;
function scheduleExit(delay) {
  if (_exiting) return;
  _exiting = true;
  const bye = () => { try { app.quit(); } catch (e) {} setTimeout(() => { try { process.exit(0); } catch (e2) {} }, 800); };
  try { app.whenReady().then(() => setTimeout(bye, delay || 2000)); }
  catch (e) { setTimeout(bye, delay || 2000); }
}

// 完整性清单校验（B-P1 加固）：**全量**核对 manifest 每一项（含引擎全部 .pyc、
// 自带运行时 engine 下 py 目录的原生 pyd·dll·exe 与所有 py），不再只抽查 3 个文件。
// 清单本身经 MANIFEST_SIG 绑定，攻击者篡改任意被登记文件后重算清单也会被这道绑定拦下。
// 成本：一次全量 sha256 约数十毫秒（34MB 运行时），可接受。
function verifyManifest() {
  const manifestPath = path.join(APP_ROOT, 'manifest.json');
  let raw;
  try { raw = fs.readFileSync(manifestPath); } catch (e) { return false; }
  if (MANIFEST_SIG && MANIFEST_SIG.indexOf('__MANIFEST') !== 0) {
    if (sha256buf(raw) !== MANIFEST_SIG) return false;
  }
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch (e) { return false; }
  // 引擎（engine/ 开头的条目）在打包态由 extraResources 投递到 resources/engine/
  // （与 app.asar 同级），不在 app.asar 内，故其哈希需从 process.resourcesPath 读取；
  // 其余文件仍在 app.asar 内。
  const resolveEntry = (rel) => rel.startsWith('engine/')
    ? path.join(process.resourcesPath, rel)
    : path.join(APP_ROOT, rel);
  for (const rel of Object.keys(manifest)) {
    let actual;
    try { actual = sha256file(resolveEntry(rel)); }
    catch (e) { return false; }          // 被登记文件缺失即视为篡改
    if (actual !== manifest[rel]) return false;
  }
  return true;
}

function selfCheck() {
  if (!SIGNED) return true; // 开发模式跳过
  try {
    const mainPath = path.join(__dirname, 'main.js');
    if (sha256file(mainPath) !== BUILD_SIG) return false;
    return verifyManifest();
  } catch (e) { return false; }
}

// 命令行是否带调试/远程调试开关（附加调试器的最直接信号）
function hasDebugFlag() {
  try {
    const argv = (process.argv || []).concat(process.execArgv || []).join(' ').toLowerCase();
    return /--inspect|--remote-debugging-port|--remote-debugging-pipe|--inspect-brk/.test(argv);
  } catch (e) { return false; }
}

// 反调试探测：真实判定 + 动作（替换旧的空转实现）。
// 启动期的命令行调试开关判定已上移到入口门禁（见文件末尾），此处负责**运行期**持续探测。
function antiDebug() {
  if (!SIGNED) return; // 开发模式跳过，避免误伤调试

  // 计时探测：正常情况下一段极短运算恒在亚毫秒级；调试器附加/单步/断点命中会让
  // 相邻两次采样的墙钟间隔显著跳变。仅当**连续多次**超阈值才判定，滤除 GC/调度抖动。
  let strikes = 0;
  const BUDGET_MS = 200;   // 单轮探测预算（宽松，仅捕捉「明显停顿」）
  const NEED = 3;          // 连续命中次数
  const timer = setInterval(() => {
    try {
      const t0 = process.hrtime.bigint();
      // 轻量确定性运算，正常耗时可忽略
      let acc = 0;
      for (let i = 0; i < 20000; i++) acc += i ^ (i << 1);
      void acc;
      const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (dtMs > BUDGET_MS) {
        strikes += 1;
        if (strikes >= NEED) { clearInterval(timer); scheduleExit(1200); }
      } else if (strikes > 0) {
        strikes -= 1;   // 衰减，避免偶发抖动累积
      }
    } catch (e) { /* 静默 */ }
  }, 4000);
  if (timer.unref) timer.unref();   // 不因探测器阻止进程正常退出

  // 蜜罐校验（有读取方）：进程标记若被外部改写/删除，判定受控。
  const trap = setInterval(() => {
    try {
      const m = global.__wememo_integrity;
      if (!m || m.mark !== EXPECTED_MARK) { clearInterval(trap); scheduleExit(1200); }
    } catch (e) { /* 静默 */ }
  }, 3000);
  if (trap.unref) trap.unref();
}

// 许可证过期校验（两层叠加：硬底线 + 签名许可证 + 高水位防回拨）
function checkExpiration() {
  if (!SIGNED) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  // 层 1：高水位防回拨
  try {
    const hwm = require('./hwm.js');
    if (!hwm.check(60)) return false;
  } catch (e) { /* hwm 模块缺失不阻断（清单校验已覆盖） */ }
  // 层 2：硬底线到期（构建期烘焙）
  if (HARD_DEADLINE && HARD_DEADLINE.indexOf('__HARD') !== 0) {
    if (nowSec > Number(HARD_DEADLINE)) return false;
  }
  // 层 3：签名许可证
  try {
    const licPath = path.join((require('electron').app.getPath('userData')), 'license.dat');
    if (!fs.existsSync(licPath)) return false;
    const buf = fs.readFileSync(licPath);
    if (buf.length < 68) return false;
    const payloadLen = buf.readUInt32LE(0);
    if (buf.length < 4 + payloadLen + 64) return false;
    const payload = buf.slice(4, 4 + payloadLen);
    const sig = buf.slice(4 + payloadLen, 4 + payloadLen + 64);
    const pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(LICENSE_PUB, 'hex')]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, payload, pubKey, sig)) return false;
    const lic = JSON.parse(payload.toString('utf8'));
    if (!lic.expires || nowSec > lic.expires) return false;
  } catch (e) { return false; }
  return true;
}

// 进程内标记：供蜜罐校验（同时向 main.js 传递「是否发布态」以决定 DevTools 封锁）
function plantMark() {
  try {
    global.__wememo_integrity = { mark: EXPECTED_MARK };
    global.__wememo_sec = { prod: SIGNED };
  } catch (e) { /* 静默 */ }
}

plantMark();

// 入口门禁：自检未过 **或** 命令行带调试开关 **或** 过期 → 静默延迟退出，绝不加载 main.js。
if (!selfCheck() || (SIGNED && hasDebugFlag())) {
  if (process.env.WEMEMO_DEBUG === '1') {
    console.error('[wememo] 启动被拒：签名/清单校验失败或检测到调试开关');
  }
  scheduleExit(3000);
} else if (SIGNED && !checkExpiration()) {
  if (process.env.WEMEMO_DEBUG === '1') {
    console.error('[wememo] 启动被拒：许可证过期或时钟异常');
  }
  scheduleExit(3000);
} else {
  antiDebug();
  require('./main.js');
}
