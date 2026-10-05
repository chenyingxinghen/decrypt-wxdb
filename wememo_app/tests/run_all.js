// run_all.js — 一键回归：聚合全部 Node 逻辑测试 + 引擎 Python 测试。
// 约定：子进程退出码 0 视为通过（含「缺真实库自动跳过」的用例）；非 0 记为失败。
// 用法：node tests/run_all.js   （或 npm test）
// 备注：test_startup_sim.js 依赖 dist/，若未构建则自动跳过——正式回归请先 `npm run build`。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');

function findPython() {
  const cands = [
    process.env.WEMEMO_PYTHON,
    path.join(ROOT, 'runtime', 'python', 'python.exe'),
    path.join(ROOT, 'dist', 'engine', 'py', 'python.exe'),
    'python3', 'python',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-c', 'import sys;print(sys.version)'], { encoding: 'utf8', timeout: 10000 });
      if (r.status === 0) return c;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

function listTests(dir, re) {
  try { return fs.readdirSync(dir).filter(f => re.test(f)).sort(); }
  catch (e) { return []; }
}

const results = [];
function run(label, cmd, args, opts) {
  process.stdout.write(`\n━━━ ${label} ━━━\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', timeout: 15 * 60 * 1000, ...opts });
  const ok = r.status === 0;
  results.push({ label, ok, status: r.status, signal: r.signal });
  return ok;
}

// 1) Node 逻辑测试（tests/test_*.js，排除本聚合器）
const distExists = fs.existsSync(path.join(ROOT, 'dist', 'src', 'main', 'loader.js'));
for (const f of listTests(__dirname, /^test_.*\.js$/)) {
  if (f === 'run_all.js') continue;
  if (f === 'test_startup_sim.js' && !distExists) {
    results.push({ label: `node ${f}`, ok: true, skipped: 'dist 未构建' });
    process.stdout.write(`\n━━━ node ${f} ━━━\n(跳过：dist 未构建，先 npm run build)\n`);
    continue;
  }
  run(`node ${f}`, process.execPath, [path.join(__dirname, f)]);
}

// 2) 引擎 Python 测试（engine/test_*.py；缺真实库的用例自会跳过）
const py = findPython();
if (!py) {
  results.push({ label: 'engine/*.py', ok: true, skipped: '未找到 Python' });
  process.stdout.write('\n(跳过全部引擎 Python 测试：未找到可用 Python)\n');
} else {
  // 引擎测试会打印 •／✓／emoji 等非 GBK 字符；Windows 控制台默认 GBK 会在 print 时抛
  // UnicodeEncodeError（伪装成测试失败）。强制子进程 UTF-8 stdio，与主程序 spawn 口径一致。
  const pyEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  for (const f of listTests(ENGINE, /^test_.*\.py$/)) {
    run(`py   ${f}`, py, ['-B', path.join(ENGINE, f)], { cwd: ENGINE, env: pyEnv });
  }
}

// 3) 汇总
process.stdout.write('\n================ 回归汇总 ================\n');
let failed = 0;
for (const r of results) {
  const tag = r.skipped ? `跳过(${r.skipped})` : (r.ok ? '通过' : `失败(code=${r.status}${r.signal ? ',' + r.signal : ''})`);
  if (!r.ok) failed += 1;
  process.stdout.write(`  ${r.ok ? '✅' : '❌'} ${r.label} — ${tag}\n`);
}
process.stdout.write(`\n共 ${results.length} 项，失败 ${failed} 项。\n`);
process.exit(failed ? 1 : 0);
