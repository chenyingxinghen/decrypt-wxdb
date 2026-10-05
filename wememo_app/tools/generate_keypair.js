// generate_keypair.js — 一次性生成 Ed25519 密钥对（许可证签名用）
// 用法: node tools/generate_keypair.js
// 产物: keys/license.key（私钥，绝不入库） + keys/license.pub（公钥，嵌入 loader）
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PRIV = path.join(KEYS_DIR, 'license.key');
const PUB = path.join(KEYS_DIR, 'license.pub');

if (fs.existsSync(PRIV)) {
  console.error('❌ keys/license.key 已存在，不会覆盖。如需重新生成请手动删除 keys/ 目录。');
  process.exit(1);
}

fs.mkdirSync(KEYS_DIR, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// 导出为 raw 格式（Ed25519 公钥 32 字节、私钥 32 字节种子）
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32); // SPKI 尾 32 字节即 raw
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.writeFileSync(PRIV, privPem);
fs.writeFileSync(PUB, pubRaw.toString('hex'));

console.log('✅ Ed25519 密钥对已生成:');
console.log(`   私钥: ${PRIV}  (绝不入版本库！)`);
console.log(`   公钥: ${PUB}  (hex: ${pubRaw.toString('hex')})`);
console.log('');
console.log('下一步:');
console.log('  1) 把公钥 hex 写入 src/main/loader.js 的 LICENSE_PUB 常量');
console.log('  2) 用 node tools/issue_license.js 签发许可证');
console.log('  3) 确认 keys/ 在 .gitignore 中');
