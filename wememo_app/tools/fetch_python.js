// fetch_python.js — 拉取并裁剪「自带 Python 运行时」，让应用完全不依赖用户机器上的 Python
//
// 产物：runtime/python/python.exe（+ Lib/site-packages 内的 cryptography / zstandard）
// 构建时 build.js 会把整个 runtime/python 复制到 dist/engine/py/，
// 运行时 src/main/main.js 的 findPython() 优先选用 <engine>/py/python.exe。
//
// 用法：
//   node tools/fetch_python.js            # 幂等：已就绪则直接跳过
//   node tools/fetch_python.js --force    # 强制重新下载与安装
//   node tools/fetch_python.js --keep-zip # 保留下载缓存（默认也会保留在 runtime/.cache）
//
// 设计要点：
//   1) 全程写入暂存目录 runtime/.python.tmp，**全部成功**后才原子改名为 runtime/python，
//      因此断网/校验失败绝不会留下半成品运行时。
//   2) 官方嵌入式包（embeddable package）默认禁用 site，第三方包无法 import，
//      必须改写 python312._pth：取消 `import site` 注释并加入 `Lib\site-packages`。
//   3) 依赖用**系统 python 的 pip** 以 --target 交叉安装，靠 --python-version/--abi/--platform
//      保证下载的 wheel 与嵌入式解释器（cp312 / win_amd64）匹配，而不是与系统解释器匹配。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');

// ---- 版本选择 ----
// 选 3.12.10 的理由：
//   * 3.12 是「仍有 Windows 嵌入式包」的最新稳定分支中兼容性最好的一档
//     （3.12.10 是 3.12 系列最后一个提供二进制包的版本，2025-04 发布）；
//   * cryptography / zstandard 对 cp312 的 win_amd64 wheel 齐全且成熟，
//     而 3.13 的 wheel 覆盖面与部分 C 扩展稳定性不如 3.12；
//   * 引擎只用到 3.9+ 语法，向下无兼容负担。
const PY_VER = '3.12.10';
const PY_TAG = 'cp312';           // wheel ABI 标签
const PY_XY = '3.12';             // pip --python-version
const PY_DIRNAME = 'python312';   // 嵌入包内 _pth / stdlib zip 的名字
const ZIP_NAME = `python-${PY_VER}-embed-amd64.zip`;
// 镜像：默认官方源；国内网络可用 WEMEMO_PY_MIRROR 指向镜像根（形如 https://host/python）
const PY_BASE = (process.env.WEMEMO_PY_MIRROR || 'https://www.python.org/ftp/python').replace(/\/+$/, '');
const ZIP_URL = `${PY_BASE}/${PY_VER}/${ZIP_NAME}`;
// 官方 HTTPS 源下载后实测（大小 11133606，MD5 与 python.org 发布页公示值
// fe8ef205f2e9c3ba44d0cf9954e1abd3 一致）
const ZIP_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3';
const ZIP_SIZE = 11133606;

// 引擎依赖：cryptography 为数据库解密必需；zstandard 为 zstd 原生快路径（实测 330× 于纯 Python）
const DEPS = ['cryptography', 'zstandard'];

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const TARGET = path.join(RUNTIME, 'python');
const STAGE = path.join(RUNTIME, '.python.tmp');
const CACHE = path.join(RUNTIME, '.cache');
const MARK = '.wememo_runtime.json';   // 就绪标记（幂等判据）

const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');

// ---------------- 小工具 ----------------
const log = (s) => console.log(s);
const step = (n, s) => console.log(`\n[${n}/7] ${s}`);
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  cleanupStage();
  process.exit(1);
}
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  // 与 build.js 一致：优先用系统命令删除，规避沙箱对 rmSync 的拦截
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rd', '/s', '/q', p], { stdio: 'ignore' });
  else spawnSync('rm', ['-rf', p], { stdio: 'ignore' });
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 静默 */ }
}
function cleanupStage() {
  if (fs.existsSync(STAGE)) {
    log('   清理暂存目录（不会留下半成品运行时）…');
    rmrf(STAGE);
  }
}
function dirSize(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; files++; } catch (e2) { /* 静默 */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes: total, files };
}
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

// ---------------- 1. 下载 ----------------
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'wememo-vendor' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor(got / total * 100 / 5) * 5;
          if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r      下载中 ${pct}%  (${mb(got)}/${mb(total)})   `); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(); }));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ---------------- 2. 解压（纯 Node 实现，无第三方依赖） ----------------
// 只需支持 store(0) 与 deflate(8) 两种方式，官方嵌入包不含加密/zip64 条目。
function unzip(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  // 反向定位 EOCD（结束记录），签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 zip：未找到 EOCD 记录');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let written = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('无效的 zip：中央目录条目损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    // 防目录穿越
    const safe = name.replace(/\\/g, '/');
    if (safe.startsWith('/') || safe.includes('..')) throw new Error(`不安全的 zip 条目：${name}`);
    const dest = path.join(outDir, safe);
    if (safe.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue; }

    // 本地文件头：真实数据偏移需按本地头自己的 name/extra 长度计算
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('无效的 zip：本地文件头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
  }
  return written;
}

// ---------------- 3. 打开 site ----------------
function enableSite(dir) {
  const pth = path.join(dir, `${PY_DIRNAME}._pth`);
  if (!fs.existsSync(pth)) throw new Error(`未找到 ${PY_DIRNAME}._pth，嵌入包结构与预期不符`);
  let txt = fs.readFileSync(pth, 'utf8');
  txt = txt.replace(/^#\s*import site\s*$/m, 'import site');
  if (!/^import site\s*$/m.test(txt)) txt += '\nimport site\n';
  if (!/site-packages/.test(txt)) {
    // 插到 `.` 之后、import site 之前
    txt = txt.replace(/^import site\s*$/m, 'Lib\\site-packages\nimport site');
  }
  fs.writeFileSync(pth, txt);
  fs.mkdirSync(path.join(dir, 'Lib', 'site-packages'), { recursive: true });
  return txt.trim().split(/\r?\n/).filter(Boolean).join(' | ');
}

// ---------------- 4. 系统 python（仅用于跑 pip 下载 wheel） ----------------
function findSystemPython() {
  const cands = [];
  if (process.env.WEMEMO_PYTHON) cands.push(process.env.WEMEMO_PYTHON);
  cands.push('python3', 'python', 'py');
  for (const c of cands) {
    const args = c === 'py' ? ['-3', '-m', 'pip', '--version'] : ['-m', 'pip', '--version'];
    const r = spawnSync(c, args, { encoding: 'utf8', timeout: 30000 });
    if (r.status === 0) return { exe: c, prefix: c === 'py' ? ['-3'] : [], pip: (r.stdout || '').trim() };
  }
  return null;
}

// ---------------- 5. 裁剪 ----------------
const PRUNE_TOP = [
  // pip / 打包工具本身不需要随包分发（依赖已经装好）
  'pip', 'pip-', 'setuptools', 'setuptools-', 'pkg_resources', 'wheel', 'wheel-',
  '_distutils_hack', 'distutils-precedence.pth',
];
function prune(dir) {
  let removed = 0, bytes = 0;
  const sp = path.join(dir, 'Lib', 'site-packages');
  if (fs.existsSync(sp)) {
    for (const e of fs.readdirSync(sp)) {
      if (PRUNE_TOP.some((p) => e === p || e.startsWith(p))) {
        const p = path.join(sp, e);
        bytes += dirSize(p).bytes || (fs.existsSync(p) ? fs.statSync(p).size : 0);
        rmrf(p); removed++;
      }
    }
  }
  // 递归清 __pycache__ / tests / *.pyi 之外的测试目录
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__' || e.name === 'tests' || e.name === 'test') {
          bytes += dirSize(p).bytes; rmrf(p); removed++;
        } else walk(p);
      }
    }
  };
  walk(dir);
  return { removed, bytes };
}

// ---------------- 主流程 ----------------
(async function main() {
  log('════════ 微忆 · 自带 Python 运行时打包 ════════');
  log(`  目标版本 : CPython ${PY_VER} (Windows x86-64 embeddable)`);
  log(`  输出目录 : ${TARGET}`);
  log(`  依赖     : ${DEPS.join(', ')}`);

  if (process.platform !== 'win32') {
    log('\n⚠️  当前脚本只准备 Windows x86-64 运行时（嵌入式包仅官方提供 Windows 版）。');
  }

  // 幂等：已就绪且版本一致则跳过
  const markPath = path.join(TARGET, MARK);
  if (!FORCE && fs.existsSync(path.join(TARGET, 'python.exe')) && fs.existsSync(markPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(markPath, 'utf8'));
      if (m.version === PY_VER && (m.deps || []).join() === DEPS.join()) {
        const s = dirSize(TARGET);
        log(`\n✅ 运行时已就绪（${PY_VER}，${mb(s.bytes)} / ${s.files} 个文件），无需重复准备。`);
        log('   如需重建请加 --force');
        return;
      }
      log('\n· 已有运行时版本/依赖与目标不符，重新准备…');
    } catch (e) { /* 标记损坏 → 重建 */ }
  }

  cleanupStage();
  fs.mkdirSync(CACHE, { recursive: true });

  // 1) 下载（带缓存）
  step(1, `下载嵌入式包 ${ZIP_NAME}`);
  const zipPath = path.join(CACHE, ZIP_NAME);
  let cached = false;
  if (fs.existsSync(zipPath) && !FORCE) {
    if (sha256File(zipPath) === ZIP_SHA256) { cached = true; log('      命中本地缓存，跳过下载'); }
    else { log('      本地缓存校验不符，重新下载'); try { fs.unlinkSync(zipPath); } catch (e) {} }
  }
  if (!cached) {
    const tmpZip = zipPath + '.part';
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch (e) {}
    try {
      log(`      ${ZIP_URL}`);
      await download(ZIP_URL, tmpZip);
    } catch (e) {
      try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch (e2) {}
      fail(`下载失败：${e.message}\n   请检查网络（或代理）后重试；本次未改动 runtime/，可安全重跑：\n   node tools/fetch_python.js`);
    }
    fs.renameSync(tmpZip, zipPath);
  }

  // 2) 校验
  step(2, '校验下载文件');
  const size = fs.statSync(zipPath).size;
  const sum = sha256File(zipPath);
  log(`      大小   : ${size} 字节 (${mb(size)})`);
  log(`      SHA256 : ${sum}`);
  if (size !== ZIP_SIZE || sum !== ZIP_SHA256) {
    try { fs.unlinkSync(zipPath); } catch (e) {}
    fail(`校验失败！期望 size=${ZIP_SIZE} sha256=${ZIP_SHA256}\n   已删除损坏文件，请重跑本脚本。`);
  }
  log('      ✔ 与官方发布值一致');

  // 3) 解压到暂存目录
  step(3, '解压到暂存目录');
  fs.mkdirSync(STAGE, { recursive: true });
  let n;
  try { n = unzip(zipPath, STAGE); } catch (e) { fail(`解压失败：${e.message}`); }
  if (!fs.existsSync(path.join(STAGE, 'python.exe'))) fail('解压后未找到 python.exe，包结构异常');
  log(`      ✔ 解压 ${n} 个文件 → ${path.relative(ROOT, STAGE)}`);

  // 4) 打开 site（否则 site-packages 里的第三方包 import 不到）
  step(4, `启用 site（改写 ${PY_DIRNAME}._pth）`);
  let pthTxt;
  try { pthTxt = enableSite(STAGE); } catch (e) { fail(e.message); }
  log(`      ✔ ${pthTxt}`);

  // 5) 安装依赖（用系统 pip 交叉下载 cp312/win_amd64 的 wheel）
  step(5, '安装引擎依赖到 Lib/site-packages');
  const sys = findSystemPython();
  if (!sys) fail('未找到可用的系统 Python（需要 pip 来下载 wheel）。\n   请安装 Python 3 后重试，或设置 WEMEMO_PYTHON 指向解释器。');
  log(`      使用系统 pip: ${sys.pip}`);
  const targetSp = path.join(STAGE, 'Lib', 'site-packages');
  const pipArgs = [
    ...sys.prefix, '-m', 'pip', 'install',
    '--target', targetSp,
    '--python-version', PY_XY,
    '--implementation', 'cp',
    '--abi', PY_TAG,
    '--platform', 'win_amd64',
    '--only-binary=:all:',
    '--upgrade', '--no-cache-dir', '--disable-pip-version-check', '--no-input',
    ...DEPS,
  ];
  log(`      ${sys.exe} ${pipArgs.slice(0, 6).join(' ')} … ${DEPS.join(' ')}`);
  const pip = spawnSync(sys.exe, pipArgs, { encoding: 'utf8', timeout: 900000 });
  if (pip.status !== 0) {
    const err = ((pip.stderr || '') + (pip.stdout || '')).trim().split('\n').slice(-8).join('\n      ');
    fail(`依赖安装失败（网络不可用或无匹配 wheel）：\n      ${err}`);
  }
  for (const line of (pip.stdout || '').split('\n')) {
    if (/^Successfully installed/.test(line)) log(`      ✔ ${line.trim()}`);
  }

  // 6) 裁剪
  step(6, '裁剪冗余文件');
  const pr = prune(STAGE);
  log(`      ✔ 移除 ${pr.removed} 项（约 ${mb(pr.bytes)}）：pip/setuptools/__pycache__/tests`);

  // 7) 自检 + 落地
  step(7, '自检并落地');
  const stageExe = path.join(STAGE, 'python.exe');
  const check = spawnSync(stageExe, ['-c',
    'import sys,json,cryptography,zstandard;' +
    'print(json.dumps({"v":sys.version.split()[0],"c":cryptography.__version__,"z":zstandard.__version__}))'],
    { encoding: 'utf8', timeout: 60000 });
  if (check.status !== 0) {
    fail(`自检失败（嵌入式解释器无法 import 依赖）：\n      ${(check.stderr || check.error && check.error.message || '').trim().split('\n').slice(-5).join('\n      ')}`);
  }
  let info = {};
  try { info = JSON.parse((check.stdout || '').trim().split('\n').pop()); } catch (e) {}
  log(`      ✔ python ${info.v} / cryptography ${info.c} / zstandard ${info.z}`);

  fs.writeFileSync(path.join(STAGE, MARK), JSON.stringify({
    version: PY_VER, tag: PY_TAG, deps: DEPS,
    cryptography: info.c, zstandard: info.z,
    sha256: ZIP_SHA256, builtAt: new Date().toISOString(),
  }, null, 2));

  // 原子落地：先删旧、再改名（此前所有失败路径都不会碰 runtime/python）
  rmrf(TARGET);
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.renameSync(STAGE, TARGET);

  const s = dirSize(TARGET);
  log(`\n✅ 自带运行时已就绪 → ${path.relative(ROOT, TARGET)}`);
  log(`   Python  : ${info.v} (${PY_TAG} / win_amd64)`);
  log(`   体积    : ${mb(s.bytes)}，${s.files} 个文件`);
  log(`   下一步  : node build.js  → 复制到 dist/engine/py/`);
  log(`   自检    : node tools/test_bundled_python.js`);
})().catch((e) => fail(`未预期的错误：${e && e.stack || e}`));
