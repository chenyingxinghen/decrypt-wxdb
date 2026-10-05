// test_emoticons_logic.js — 微信内置表情逻辑测试（复用 src/renderer/js/emoticons.js，测的即上线代码）
// 覆盖：记号识别与白名单、繁体/英文别名一致性、微信独有表情留空、方括号边界情形、
//       splitTokens 往返还原、XSS 防御（转义由调用方或内置兜底转义器完成）、性能兜底。
'use strict';

const E = require('../src/renderer/js/emoticons.js');
const { TABLE, BASE, hasToken, emojiFor, canonical, splitTokens, render } = E;

// 渲染层真实使用的转义器（与 render.js 的 esc 同实现）
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把切好的段拼回原文：文本段原样，表情段补回方括号
function rebuild(segs) {
  return segs.map((s) => (s.t === 'emo' ? `[${s.v}]` : s.v)).join('');
}

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

// ---- 表本身 ----
assert('TABLE 非空', Object.keys(TABLE).length > 300);
assert('正名 146 个（微信 4.1 官方经典 105 + 新增 41）', Object.keys(BASE).length === 146);
assert('别名 228 个（繁体 + 英文）', Object.keys(E.ALIAS).length === 228);
assert('正名 + 别名 = TABLE', Object.keys(BASE).length + Object.keys(E.ALIAS).length === Object.keys(TABLE).length);
assert('每个别名都能解析到正名', Object.keys(E.ALIAS).every((a) => E.ALIAS[a] in BASE));
assert('别名不与正名重名', Object.keys(E.ALIAS).every((a) => !(a in BASE)));
assert('TABLE 值全为字符串', Object.keys(TABLE).every((k) => typeof TABLE[k] === 'string'));
assert('TABLE 无 undefined/null 值', Object.keys(TABLE).every((k) => TABLE[k] != null));
assert('记号名不含方括号', Object.keys(TABLE).every((k) => k.indexOf('[') < 0 && k.indexOf(']') < 0));
assert('记号名非空', Object.keys(TABLE).every((k) => k.length > 0));

// ---- hasToken / emojiFor / canonical ----
assert('hasToken 命中', hasToken('微笑') && hasToken('玫瑰') && hasToken('旺柴'));
assert('hasToken 未知', !hasToken('这不是表情') && !hasToken('图片') && !hasToken(''));
assert('hasToken 非字符串安全', !hasToken(null) && !hasToken(undefined) && !hasToken(123));
assert('hasToken 不被原型属性污染', !hasToken('toString') && !hasToken('constructor') && !hasToken('__proto__'));
assert('emojiFor 已知', emojiFor('微笑') === '🙂' && emojiFor('玫瑰') === '🌹' && emojiFor('强') === '👍');
assert('emojiFor 未知返回空', emojiFor('不存在') === '' && emojiFor(null) === '');
assert('canonical 繁体归一', canonical('破涕為笑') === '破涕为笑' && canonical('掩面') === '捂脸');
assert('canonical 英文归一', canonical('Rose') === '玫瑰' && canonical('Doge') === '旺柴');
assert('canonical 正名原样', canonical('微笑') === '微笑');
assert('canonical 未知原样', canonical('随便写的') === '随便写的');

// ---- 微信独有表情必须留空（宁缺毋滥）----
['旺柴', '吃瓜', '让我看看', '裂开', '苦涩', 'Emm', '社会社会', '加油', '抱拳', '抠鼻', '囧', '666']
  .forEach((n) => assert(`微信独有「${n}」不映射 emoji`, hasToken(n) && emojiFor(n) === ''));

// ---- 别名一致性：繁体 / 英文与简体正名同一结果 ----
// 注意：微信繁体表情包**不是**逐字转换，而是另一套措辞（捂脸→掩面、裂开→崩潰、
// 苦涩→難受、嘿哈→吼嘿、Emm→一言難盡、社会社会→失敬失敬…），这些都取自微信本体名字表。
const ALIAS_PAIRS = [
  ['破涕為笑', '破涕为笑'], ['發呆', '发呆'], ['流淚', '流泪'], ['太陽', '太阳'],
  ['愛心', '爱心'], ['強', '强'], ['疑問', '疑问'], ['讓我看看', '让我看看'],
  ['掩面', '捂脸'], ['崩潰', '裂开'], ['難受', '苦涩'], ['吼嘿', '嘿哈'],
  ['一言難盡', 'Emm'], ['失敬失敬', '社会社会'], ['吃西瓜', '吃瓜'], ['嘆息', '叹气'],
  ['大笑', '憨笑'], ['累', '困'], ['枯萎', '凋谢'], ['冷汗', '囧'],
  ['Rose', '玫瑰'], ['Doge', '旺柴'], ['Facepalm', '捂脸'], ['ThumbsUp', '强'],
  ['Lol', '破涕为笑'], ['Sob', '流泪'], ['Onlooker', '吃瓜'], ['Fight', '抱拳'],
  ['Salute', '抱拳'], ['Shocked', '疑问'], ['Happy', '笑脸'], ['CoolGuy', '得意'],
  ['Surprise', '惊讶'], ['GoForIt', '加油'], ['Blush', '囧'], ['Bye', '再见'],
  ['Awesome', '666'], ['KeepFighting', '加油加油'],
];
ALIAS_PAIRS.forEach(([alias, canon]) => {
  assert(`别名「${alias}」= 正名「${canon}」`, hasToken(alias) && emojiFor(alias) === emojiFor(canon));
});
assert('繁体变体渲染出相同表情字符',
  splitTokens('[破涕為笑]')[0].e === splitTokens('[破涕为笑]')[0].e
  && splitTokens('[破涕為笑]')[0].e === '😂');

// ---- 实测语料 TOP40 覆盖率（用户在真实库中统计的高频记号）----
const TOP40 = ['旺柴', '捂脸', '玫瑰', '强', '流泪', '奸笑', '苦涩', '吃瓜', '破涕为笑', '抱拳',
  '呲牙', '可怜', '疑问', '发呆', '抠鼻', '裂开', '爱心', 'OK', '加油', '微笑',
  'Emm', '庆祝', '合十', '色', '偷笑', '尴尬', '晕', '太阳', '发怒', '大哭',
  '机智', '让我看看', '憨笑', '嘿哈', '敲打', '阴险', '发抖', '撇嘴', '囧', '恐惧'];
const missing = TOP40.filter((n) => !hasToken(n));
assert(`实测 TOP40 全覆盖（缺 ${missing.length} 个${missing.length ? '：' + missing.join('/') : ''}）`,
  missing.length === 0);

// 真实语料里高频出现、但**不是**微信表情的方括号内容，必须原样透传
// （[社会] 20 次、[已收款] 29 次都不在微信官方名字表里——微信自己也只会当普通文本显示）
const NOT_EMO = ['已收款', '转账你无需接收', '社会', '图片', '视频', '语音', '文件', '链接',
  '小程序', '地铁站', '站', 'ERROR', 'senˈseɪʃn', '动画表情', '合并转发', '拍一拍',
  '捂臉', '裂開', '苦澀', '社會社會'];  // 后四个是"想当然"的繁体写法，微信实际不用
NOT_EMO.forEach((n) => assert(`非表情「${n}」不入白名单`, !hasToken(n)
  && splitTokens(`[${n}]`).length === 1 && splitTokens(`[${n}]`)[0].t === 'text'));

// ---- splitTokens：基本切分 ----
assert('纯表情', JSON.stringify(splitTokens('[微笑]')) === JSON.stringify([{ t: 'emo', v: '微笑', e: '🙂' }]));
const s1 = splitTokens('你好[微笑]再见');
assert('文本-表情-文本 三段', s1.length === 3 && s1[0].v === '你好' && s1[1].t === 'emo' && s1[2].v === '再见');
const s2 = splitTokens('[微笑][玫瑰]');
assert('相邻表情各成一段', s2.length === 2 && s2[0].v === '微笑' && s2[1].v === '玫瑰');
assert('表情在首', splitTokens('[强]好').length === 2 && splitTokens('[强]好')[0].t === 'emo');
assert('表情在尾', splitTokens('好[强]').length === 2 && splitTokens('好[强]')[1].t === 'emo');
assert('无对应物的表情 e 为空串', splitTokens('[旺柴]')[0].e === '');

// ---- splitTokens：白名单，未知记号并入文本 ----
const u1 = splitTokens('这是[未知词汇]测试');
assert('未知记号整体作文本', u1.length === 1 && u1[0].t === 'text' && u1[0].v === '这是[未知词汇]测试');
assert('应用标记 [图片] 不当表情', splitTokens('[图片]').length === 1 && splitTokens('[图片]')[0].t === 'text');
const u2 = splitTokens('[未知]中间[微笑]结尾[也未知]');
assert('未知与已知混排', u2.length === 3
  && u2[0].v === '[未知]中间' && u2[1].t === 'emo' && u2[2].v === '结尾[也未知]');

// ---- splitTokens：边界与畸形输入 ----
assert('空串 → 空数组', JSON.stringify(splitTokens('')) === '[]');
assert('null → 空数组', JSON.stringify(splitTokens(null)) === '[]');
assert('undefined → 空数组', JSON.stringify(splitTokens(undefined)) === '[]');
assert('空方括号 []', JSON.stringify(splitTokens('[]')) === JSON.stringify([{ t: 'text', v: '[]' }]));
assert('只有左括号', splitTokens('[微笑')[0].v === '[微笑' && splitTokens('[微笑').length === 1);
assert('只有右括号', splitTokens('微笑]')[0].v === '微笑]' && splitTokens('微笑]').length === 1);
assert('括号倒置', splitTokens(']微笑[').length === 1);
assert('全是左括号', splitTokens('[[[[[').length === 1);
const nest = splitTokens('[a[微笑]');
assert('嵌套左括号仍能识别内层', nest.length === 2 && nest[0].v === '[a' && nest[1].v === '微笑');
const nest2 = splitTokens('[[微笑]]');
assert('双层包裹', rebuild(nest2) === '[[微笑]]' && nest2.some((x) => x.t === 'emo'));
assert('超长括号内容不当记号', splitTokens('[' + 'x'.repeat(500) + ']').length === 1);
assert('记号名前后有空格不算命中', splitTokens('[ 微笑 ]').length === 1);
assert('数字对象非字符串输入安全', splitTokens(12345)[0].v === '12345');

// ---- splitTokens：往返还原 ----
const ROUND = [
  '', '[]', '[微笑]', '你好[微笑]世界', '[微笑][玫瑰][旺柴]',
  '[未知]和[微笑]和[也未知]', '[[微笑]]', '[a[微笑]', '[微笑', '微笑]',
  'a[b]c[微笑]d[]e', '纯文本没有任何括号', '<script>alert(1)</script>[强]',
  '[破涕為笑][Rose][OK]', '换行\n夹[强]着\t制表',
];
ROUND.forEach((t, i) => assert(`往返还原 #${i}`, rebuild(splitTokens(t)) === t));

// 随机串往返（含大量括号与已知记号，覆盖回溯路径）
(function randomRoundTrip() {
  const parts = ['[', ']', 'a', '微笑', '[微笑]', '[未知]', '你好', '[', '[]', '强', '[强]'];
  let ok = true;
  for (let n = 0; n < 300; n++) {
    let s = '';
    for (let k = 0; k < 12; k++) s += parts[(n * 7 + k * 13) % parts.length];
    if (rebuild(splitTokens(s)) !== s) { ok = false; console.log('    往返失败:', JSON.stringify(s)); break; }
  }
  assert('随机串往返还原（300 例）', ok);
}());

// ---- render：HTML 输出 ----
const r1 = render('[微笑]', esc);
assert('render 有映射 → wx-emo', r1 === '<span class="wx-emo" title="[微笑]">🙂</span>');
const r2 = render('[旺柴]', esc);
assert('render 无映射 → wx-emo none', r2 === '<span class="wx-emo none" title="[旺柴]">旺柴</span>');
assert('render 文本经转义', render('a<b>c', esc) === 'a&lt;b&gt;c');
assert('render 空输入', render('', esc) === '' && render(null, esc) === '');
assert('render 混排', render('你好[微笑]!', esc) === '你好<span class="wx-emo" title="[微笑]">🙂</span>!');
assert('render 繁体 title 用原名', render('[破涕為笑]', esc).includes('title="[破涕為笑]"'));
assert('render 未知记号原样输出（不产生 span）',
  render('[未知词]', esc) === '[未知词]');

// ---- XSS 防御 ----
const x1 = render('[<img onerror=x>]', esc);
assert('XSS 记号名不入白名单', !x1.includes('<img'));
assert('XSS 记号名被转义', x1.includes('&lt;img') && x1.includes('&gt;'));
const x2 = render('<script>alert(1)</script>[强]', esc);
assert('XSS 周围文本被转义', x2.startsWith('&lt;script&gt;') && !x2.includes('<script>'));
assert('XSS 表情仍正常渲染', x2.includes('<span class="wx-emo" title="[强]">👍</span>'));
const x3 = render('"><img src=x onerror=alert(1)>', esc);
assert('XSS 引号被转义', !x3.includes('"><img') && x3.includes('&quot;'));
assert('XSS 缺 escapeFn 时用内置兜底', render('<script>x</script>') === '&lt;script&gt;x&lt;/script&gt;');
assert('XSS escapeFn 非函数时用内置兜底', render('<b>', 'not-a-function') === '&lt;b&gt;');
assert('XSS 内置兜底不放过引号', render('a"b\'c').includes('&quot;') && render('a"b\'c').includes('&#39;'));
// 唯一未经 escapeFn 的输出是 TABLE 里的 Unicode 字面量，确认其中没有 HTML 元字符
assert('TABLE 值不含 HTML 元字符',
  Object.keys(TABLE).every((k) => !/[<>&"']/.test(TABLE[k])));

// ---- 性能兜底：畸形长输入不得退化 ----
(function perf() {
  const evil = '['.repeat(200000);                    // 全左括号，无闭合
  const evil2 = ('[未知]').repeat(50000);             // 大量未命中记号
  const big = ('文本[微笑]'.repeat(50000));            // 大量命中记号
  const t0 = Date.now();
  splitTokens(evil); splitTokens(evil2);
  const segs = splitTokens(big);
  const ms = Date.now() - t0;
  assert(`长输入线性时间（20 万 + 5 万 + 5 万 段，${ms}ms < 2000ms）`, ms < 2000);
  assert('大输入切分正确', segs.length === 100000 && segs[1].t === 'emo');
  assert('大输入往返还原', rebuild(segs) === big);
}());

// ---- 与 render.js 协同：不重复转义 ----
assert('splitTokens 不做转义（原始值返回）', splitTokens('<b>[微笑]')[0].v === '<b>');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
