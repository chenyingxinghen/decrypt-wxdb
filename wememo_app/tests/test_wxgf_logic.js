// test_wxgf_logic.js — wxgf 渲染层纯逻辑测试（复用 src/renderer/js/wxgf.js，测的即上线代码）
// 覆盖：data URL 识别与解码、Annex-B 扫描、RBSP 去转义、SPS 解析（Exp-Golomb）、
//       codec 串组装、profile 3→1 归一化、多序列（alpha）选片、hvcC 组装、
//       无 WebCodecs 时优雅返回 null
'use strict';

const W = require('../src/renderer/js/wxgf.js');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

// ---- 真实样本字节（810x1440，Main Still Picture，level 4.0）----
const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((b) => parseInt(b, 16)));
const VPS = hex('40 01 0c 01 ff ff 03 70 00 00 03 00 90 00 00 03 00 00 03 00 78 aa 02 40');
const SPS = hex('42 01 01 03 70 00 00 03 00 90 00 00 03 00 00 03 00 78 a0 06 62 00 5a 1c 9e 5a'
              + ' a9 24 c2 e6 c0 80 00 00 03 00 80 00 00 0f 04');
const PPS = hex('44 01 c1 25 7c 08 90');
const IDR = hex('26 01 ac 98 cc e6 7e 95 e6 24 25 d4 35 93 3a d0');
const SC = [0, 0, 1];
function cat() {
  const parts = [].concat(...[...arguments].map((a) => [...a]));
  return Uint8Array.from(parts);
}
const ANNEXB = cat(SC, VPS, SC, SPS, SC, PPS, SC, IDR);

// ---- data URL ----
const b64 = Buffer.from(ANNEXB).toString('base64');
const URL_WXGF = 'data:image/x-wxgf;base64,' + b64;
assert('MIME 为 image/x-wxgf', W.MIME === 'image/x-wxgf');
assert('识别 wxgf data URL', W.isWxgfUrl(URL_WXGF) === true);
assert('不误判 png data URL', W.isWxgfUrl('data:image/png;base64,iVBOR') === false);
assert('不误判 null', W.isWxgfUrl(null) === false);
assert('fromDataUrl 还原字节',
  Buffer.compare(Buffer.from(W.fromDataUrl(URL_WXGF)), Buffer.from(ANNEXB)) === 0);
assert('fromDataUrl 非 wxgf → null', W.fromDataUrl('data:image/png;base64,iVBOR') === null);
assert('fromDataUrl 垃圾输入 → null', W.fromDataUrl('not a url') === null);

// ---- Annex-B 扫描 ----
const nals = W.scanNals(ANNEXB);
assert('扫到 4 个 NAL', nals.length === 4);
assert('NAL 类型 VPS/SPS/PPS/IDR', JSON.stringify(nals.map((n) => n.type)) === '[32,33,34,19]');
assert('NAL 长度正确', nals[0].data.length === VPS.length && nals[3].data.length === IDR.length);
assert('4 字节起始码同样识别',
  JSON.stringify(W.scanNals(cat([0, 0, 0, 1], VPS, [0, 0, 0, 1], SPS)).map((n) => n.type)) === '[32,33]');
assert('去掉 NAL 尾部填充 0',
  W.scanNals(cat(SC, VPS, [0, 0, 0], SC, SPS))[0].data.length === VPS.length);
assert('空输入不炸', W.scanNals(new Uint8Array(0)).length === 0);
assert('无起始码 → 空', W.scanNals(hex('de ad be ef ca fe')).length === 0);

// ---- RBSP ----
assert('rbsp 去 emulation prevention byte',
  Buffer.compare(Buffer.from(W.rbsp(hex('00 00 03 01 02'))), Buffer.from(hex('00 00 01 02'))) === 0);
assert('rbsp 保留 00 00 01',
  Buffer.compare(Buffer.from(W.rbsp(hex('00 00 01 02'))), Buffer.from(hex('00 00 01 02'))) === 0);
assert('rbsp 无 00 00 03 时原样',
  Buffer.compare(Buffer.from(W.rbsp(hex('11 22 33'))), Buffer.from(hex('11 22 33'))) === 0);

// ---- 比特读取器 / Exp-Golomb ----
const br = W.bitReader(hex('a0'));   // 1010 0000
assert('u(1) 读位', br.u(1) === 1 && br.u(1) === 0 && br.u(1) === 1);
const br2 = W.bitReader(hex('80'));  // 1 → ue=0
assert('ue(0)', br2.ue() === 0);
const br3 = W.bitReader(hex('40'));  // 010 → ue=1
assert('ue(1)', br3.ue() === 1);
const br4 = W.bitReader(hex('60'));  // 011 → ue=2
assert('ue(2)', br4.ue() === 2);
const br5 = W.bitReader(hex('20'));  // 00100 → ue=3
assert('ue(3)', br5.ue() === 3);
let threw = false;
try { W.bitReader(new Uint8Array(0)).u(1); } catch (e) { threw = true; }
assert('越界抛异常', threw);

// ---- SPS 解析 ----
const sps = W.parseSps(SPS);
assert('SPS 尺寸 810x1440', sps.width === 810 && sps.height === 1440);
assert('SPS profile=3', sps.profile === 3);
assert('SPS level=120', sps.level === 120);
assert('SPS tier=0 space=0', sps.tier === 0 && sps.space === 0);
assert('SPS chroma=1(4:2:0)', sps.chroma === 1);
assert('SPS 位深 8', sps.bdL === 8 && sps.bdC === 8);
assert('SPS compat=0x70000000', sps.compat === 0x70000000);

const pr = W.probe(ANNEXB);
assert('probe 返回尺寸', pr && pr.width === 810 && pr.height === 1440);
assert('probe 附带 NAL 列表', JSON.stringify(pr.nals) === '[32,33,34,19]');
assert('probe 无 SPS → null', W.probe(cat(SC, VPS)) === null);
assert('probe 垃圾输入 → null', W.probe(hex('de ad be ef')) === null);

// ---- compat / codec 串 ----
assert('revBits32(0x70000000)=0xE', W.revBits32(0x70000000) === 0xe);
assert('revBits32(0x60000000)=0x6', W.revBits32(0x60000000) === 0x6);
assert('compatHas Main 位', W.compatHas(0x70000000, 1) === true);
assert('compatHas Main10 位', W.compatHas(0x70000000, 2) === true);
assert('compatHas RExt 位为假', W.compatHas(0x70000000, 4) === false);
assert('compatHas RExt(0x08000000)', W.compatHas(0x08000000, 4) === true);
assert('约束字节 6 个', W.constraintBytes(sps).length === 6);
assert('约束首字节 0x90', W.constraintBytes(sps)[0] === 0x90);
assert('codecString 规范 compat',
  W.codecString('hev1', sps, 1, W.CANON_COMPAT[1]) === 'hev1.1.6.L120.90');
assert('codecString hvc1 前缀',
  W.codecString('hvc1', sps, 1, '6') === 'hvc1.1.6.L120.90');
assert('codecString 省略约束字节',
  W.codecString('hev1', sps, 1, '6', true) === 'hev1.1.6.L120');
assert('codecString 高 tier 用 H',
  W.codecString('hev1', Object.assign({}, sps, { tier: 1 }), 1, '6') === 'hev1.1.6.H120.90');
assert('codecString 默认反位序 compat',
  W.codecString('hev1', sps) === 'hev1.3.E.L120.90');

// 归一化后的候选串：必须带真实 level、且 compat 段用规范值
const cands = W.codecCandidates(W.normalize(ANNEXB).sps);
assert('候选串首选 hev1.1.6.L120.90', cands[0] === 'hev1.1.6.L120.90');
assert('候选串都带真实 level 120', cands.every((c) => /L120|L186/.test(c)));
assert('候选串含 hvc1 变体', cands.some((c) => c.indexOf('hvc1') === 0));
assert('候选串无重复', new Set(cands).size === cands.length);
assert('候选串对 null 兜底', W.codecCandidates(null).length === 1);
const rext = { space: 0, tier: 0, profile: 4, compat: 0x08000000, c1: 0x9fc800, c2: 0,
               level: 93, chroma: 0, bdL: 8, bdC: 8, nest: 1, maxSub: 0, width: 100, height: 100 };
assert('RExt 候选用 profile 4 + compat 10',
  W.codecCandidates(rext)[0] === 'hev1.4.10.L93.9F.C8');

// ---- profile 归一化（Main Still Picture → Main）----
const patched = W.patchProfile(ANNEXB, 3, 1);
assert('patchProfile 返回新数组', patched !== ANNEXB);
assert('patchProfile 不改原数组', W.probe(ANNEXB).profile === 3);
assert('patchProfile 把 profile 改成 1', W.probe(patched).profile === 1);
assert('patchProfile 不动尺寸',
  W.probe(patched).width === 810 && W.probe(patched).height === 1440);
assert('patchProfile 不动 level/compat',
  W.probe(patched).level === 120 && W.probe(patched).compat === 0x70000000);
assert('patchProfile 长度不变', patched.length === ANNEXB.length);
assert('patchProfile profile 不匹配则原样返回',
  W.patchProfile(ANNEXB, 7, 1) === ANNEXB);

const norm = W.normalize(ANNEXB);
assert('normalize 归一化 profile', norm.sps.profile === 1);
assert('normalize 无 alpha', norm.alpha === null);
assert('normalize 垃圾输入 → null', W.normalize(hex('de ad be ef')) === null);
assert('normalize 空输入 → null', W.normalize(new Uint8Array(0)) === null);

// ---- 多序列（带 alpha 的原图：单色掩膜 + 彩色正片）----
// 伪造一个 4:0:0 单色 SPS（profile 4 / RExt），尺寸与正片一致
const MONO_SPS = (() => {
  const a = Uint8Array.from(SPS);
  a[3] = (a[3] & 0xe0) | 4;          // profile_idc → 4 (RExt)
  return a;
})();
const MULTI = cat(SC, VPS, SC, MONO_SPS, SC, PPS, SC, hex('26 01 aa bb'),
                  SC, VPS, SC, SPS, SC, PPS, SC, IDR);
const segs = W.sequences(MULTI);
assert('切出 2 段序列', segs.length === 2);
assert('每段各自的 SPS', segs[0].sps.profile === 4 && segs[1].sps.profile === 3);
assert('切片字节数累计', segs[0].payload === 4 && segs[1].payload === IDR.length);
const main = W.pickSequence(segs);
assert('pickSequence 取切片更大的那段', main === segs[1]);
assert('pickSequence 单序列直接返回', W.pickSequence(W.sequences(ANNEXB)).sps.profile === 3);
assert('pickSequence 空 → null', W.pickSequence([]) === null);
assert('选中段的字节能独立扫描',
  JSON.stringify(W.scanNals(main.bytes).map((n) => n.type)) === '[32,33,34,19]');
// chroma=0 才算 alpha：这里伪造的 MONO_SPS 只改了 profile，chroma 仍是 1，故不算掩膜
assert('同尺寸但非单色不算 alpha', W.pickAlpha(segs, main) === null);
assert('pickAlpha 参数缺失安全', W.pickAlpha(null, null) === null);

// ---- hvcC / 长度前缀 ----
const hvcC = W.buildHvcC(W.scanNals(ANNEXB), sps);
assert('hvcC configurationVersion=1', hvcC[0] === 1);
assert('hvcC profile 字节', (hvcC[1] & 0x1f) === 3);
assert('hvcC level 落位', hvcC[12] === 120);
assert('hvcC lengthSizeMinusOne=3', (hvcC[21] & 3) === 3);
assert('hvcC 三组参数集', hvcC[22] === 3);
const lp = W.toLengthPrefixed(W.scanNals(ANNEXB));
assert('长度前缀只保留切片', lp.length === 4 + IDR.length);
assert('长度前缀写入正确长度',
  (lp[0] << 24 | lp[1] << 16 | lp[2] << 8 | lp[3]) === IDR.length);

// ---- 无 WebCodecs 时优雅降级（Node 环境本就没有 VideoDecoder）----
assert('Node 下无 VideoDecoder', typeof VideoDecoder === 'undefined');
assert('hasWebCodecs() 为 false', W.hasWebCodecs() === false);

let asyncFail = 0;
function aassert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; asyncFail++; console.log('  ✗ FAIL:', name); }
}

(async () => {
  aassert('isSupported() → false', (await W.isSupported()) === false);
  aassert('decodeAnnexB 无 WebCodecs → null', (await W.decodeAnnexB(ANNEXB)) === null);
  aassert('decodeAnnexB 空输入 → null', (await W.decodeAnnexB(null)) === null);
  aassert('decodeDataUrl 无 WebCodecs → null', (await W.decodeDataUrl(URL_WXGF)) === null);
  aassert('decodeDataUrl 非 wxgf → null',
    (await W.decodeDataUrl('data:image/png;base64,iVBOR')) === null);
  W.clearCache();
  aassert('clearCache 后仍安全', (await W.decodeDataUrl(URL_WXGF)) === null);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
