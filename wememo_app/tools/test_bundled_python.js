// test_bundled_python.js — 自带 Python 运行时自检（不依赖 Electron / 测试框架）
// 验证：runtime/python/python.exe 可运行 → 版本正确 → cryptography / zstandard 可导入
//       → 能以该解释器跑起 engine/bridge.py 并完成一次 JSON-RPC ping
//
// 用法：node tools/test_bundled_python.js
// 未执行过 `npm run vendor:python` 时优雅跳过（退出码 0），不阻塞 CI。
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PY = path.join(ROOT, 'runtime', 'python', 'python.exe');
const BRIDGE = path.join(ROOT, 'engine', 'bridge.py');
const WANT_MAJOR_MINOR = '3.12';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  OK   ${name}${extra ? '  — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '  — ' + extra : ''}`); }
}

// ---- 跳过条件：未准备自带运行时 ----
if (!fs.existsSync(PY)) {
  console.log('跳过：未找到自带 Python 运行时 ' + path.relative(ROOT, PY));
  console.log('     先执行 `npm run vendor:python`（node tools/fetch_python.js）再运行本测试。');
  process.exit(0);
}

console.log('自带 Python 运行时自检:', PY, '\n');

// ---- 1. 解释器可运行 + 版本 ----
const ver = spawnSync(PY, ['-c', 'import sys;print(sys.version.split()[0]);print(sys.executable)'],
  { encoding: 'utf8', timeout: 60000 });
const verLines = (ver.stdout || '').trim().split(/\r?\n/);
const pyVer = verLines[0] || '(无输出)';
ok('解释器可运行', ver.status === 0, `退出码 ${ver.status}`);
ok('版本符合预期 ' + WANT_MAJOR_MINOR + '.x', pyVer.startsWith(WANT_MAJOR_MINOR + '.'), 'Python ' + pyVer);
ok('sys.executable 指向自带运行时',
  (verLines[1] || '').toLowerCase() === PY.toLowerCase(), verLines[1] || '');

// ---- 2. 关键依赖可导入（site 是否被正确启用的实测判据）----
const dep = spawnSync(PY, ['-c',
  'import cryptography,zstandard;print(cryptography.__version__);print(zstandard.__version__)'],
  { encoding: 'utf8', timeout: 60000 });
const depLines = (dep.stdout || '').trim().split(/\r?\n/);
ok('import cryptography（库解密必需）', dep.status === 0 && !!depLines[0],
  dep.status === 0 ? 'v' + depLines[0] : (dep.stderr || '').trim().split('\n').pop());
ok('import zstandard（zstd 原生快路径）', dep.status === 0 && !!depLines[1],
  dep.status === 0 ? 'v' + depLines[1] : '');

// ---- 3. 引擎实际走的是原生 zstd 通道（而非纯 Python 回退）----
const zc = spawnSync(PY, ['-c', 'import sys;sys.path.insert(0,r"' + path.join(ROOT, 'engine') +
  '");import zstd_py;print("native" if zstd_py._NATIVE is not None else "pure")'],
  { encoding: 'utf8', timeout: 60000 });
const backend = zc.status === 0 ? (zc.stdout || '').trim().split(/\r?\n/).pop() : '';
ok('zstd_py 走原生快路径', backend === 'native',
  zc.status === 0 ? 'backend=' + backend : (zc.stderr || '').trim().split('\n').pop());

// ---- 4. 以自带解释器跑起 bridge.py 并 ping ----
(function pingBridge() {
  const child = spawn(PY, [BRIDGE], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', stderr = '', done = false;

  const finish = (cond, extra) => {
    if (done) return;
    done = true;
    ok('bridge.py ping 响应 ok=true', cond, extra);
    try { child.kill(); } catch (e) { /* 静默 */ }
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed ? 1 : 0);
  };

  const timer = setTimeout(() => finish(false, '5s 内无响应；stderr: ' + stderr.trim().split('\n').pop()), 5000);

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.event) continue;          // 事件行（进度推送）不是响应
      if (msg.id !== 1) continue;
      clearTimeout(timer);
      const pong = msg.result && msg.result.pong;
      finish(msg.ok === true && pong === true,
        'engine v' + ((msg.result && msg.result.version) || '?'));
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  child.on('error', (e) => { clearTimeout(timer); finish(false, '无法启动 bridge.py: ' + e.message); });

  child.stdin.write(JSON.stringify({ id: 1, method: 'ping', params: {} }) + '\n');
})();
