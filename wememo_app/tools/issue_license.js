// issue_license.js — 签发带过期时间的许可证文件（Ed25519 签名）
// 用法: node tools/issue_license.js --customer <id> --days <N> [--out <path>]
// 产物: license.dat（交付给客户放入 userData）
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { customer: '', days: 30, out: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--customer' && args[i + 1]) opts.customer = args[++i];
    else if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    else if (args[i] === '--out' && args[i + 1]) opts.out = args[++i];
  }
  return opts;
}

const opts = parseArgs();
if (!opts.customer) {
  console.error('用法: node tools/issue_license.js --customer <id> --days <N> [--out <path>]');
  process.exit(1);
}

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PRIV_PATH = path.join(KEYS_DIR, 'license.key');

if (!fs.existsSync(PRIV_PATH)) {
  console.error('❌ 未找到私钥 keys/license.key，请先执行 node tools/generate_keypair.js');
  process.exit(1);
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV_PATH, 'utf8'));

const now = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({
  customer: opts.customer,
  issued: now,
  expires: now + opts.days * 86400,
  features: ['all']
});

const payloadBuf = Buffer.from(payload, 'utf8');
const sig = crypto.sign(null, payloadBuf, privateKey);

// 输出格式: [4 字节 payload 长度 LE][payload][64 字节签名]
const out = Buffer.alloc(4 + payloadBuf.length + sig.length);
out.writeUInt32LE(payloadBuf.length, 0);
out.set(payloadBuf, 4);
out.set(sig, 4 + payloadBuf.length);

const outPath = opts.out || path.join(__dirname, '..', 'license.dat');
fs.writeFileSync(outPath, out);

const expires = new Date((now + opts.days * 86400) * 1000).toISOString().slice(0, 10);
console.log('✅ 许可证已签发:');
console.log(`   客户: ${opts.customer}`);
console.log(`   有效期: ${opts.days} 天 (到 ${expires})`);
console.log(`   输出: ${outPath}`);
console.log('');
console.log('交付方式: 客户把 license.dat 放到应用 userData 目录即可，无需重新分发软件包。');
