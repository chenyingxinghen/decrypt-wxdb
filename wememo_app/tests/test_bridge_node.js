// test_bridge_node.js — 模拟主进程 Python 桥接逻辑（不依赖 Electron GUI）
// 验证：spawn bridge.py → 发请求 → 收响应
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ENGINE = path.join(__dirname, '..', 'engine');
// 解释器与主进程 findPython() 同序：自带运行时优先，其次系统 python。
// （曾硬编码某台机器的绝对路径，换机即跑不起来）
const PY = (() => {
  const fs = require('fs');
  const cands = [
    process.env.WEMEMO_PYTHON,
    path.join(__dirname, '..', 'runtime', 'python', 'python.exe'),
    path.join(__dirname, '..', 'dist', 'engine', 'py', 'python.exe'),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
})();
const DB_ROOT = process.env.WEMEMO_DB_ROOT
  || 'G:/ai_proj/decrypt_wxdb/deliverables/decrypted_master';
console.log(`解释器: ${PY}`);

const py = spawn(PY, [path.join(ENGINE, 'bridge.py')], {
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', WEMEMO_DB_ROOT: DB_ROOT },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let seq = 0;

py.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    } catch (e) {}
  }
});

function call(method, params) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    py.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

(async () => {
  try {
    // init + sessions
    const init = await call('init', { dbRoot: DB_ROOT });
    console.log('init ok:', init.ok, init.result.ready);
    const sess = await call('sessions', {});
    const list = sess.result.sessions;
    console.log('sessions count:', list.length);
    console.log('top 3:', list.slice(0, 3).map(s => s.name + '(' + s.unread + '未读)').join(' | '));
    // messages for first chatroom
    const msgs = await call('messages', { username: list[0].username, limit: 5 });
    console.log('messages for', list[0].name, ':', msgs.result.messages.length);
    const m0 = msgs.result.messages[0];
    console.log('first msg type:', m0.type, 'content:', (m0.content||'').slice(0, 30));
    // search
    const search = await call('search', { keyword: '顶程' });
    console.log('search 顶程 results:', search.result.sessions.length);
    console.log('\n=== BRIDGE NODE TEST PASSED ===');
  } catch (e) {
    console.error('FAIL', e);
  } finally {
    py.kill();
  }
})();
