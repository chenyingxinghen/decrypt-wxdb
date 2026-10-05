// test_renderer_logic.js — 渲染层纯逻辑测试（复用 src/renderer/js/render.js，测的即上线代码）
// 覆盖：时间格式化、全类型消息渲染（图片/表情/语音/视频/转账/红包/文件/链接/小程序/
//       视频号/合并转发/引用/位置/名片/接龙/群公告/拍一拍/voip）、纯文本提取、搜索高亮、XSS 防御
'use strict';

const R = require('../src/renderer/js/render.js');
const { esc, highlight, renderContent, plainContent, fmtDuration, fmtSize } = R;

// 时间格式化仅在 app.js（含 DOM 依赖），此处复制纯函数验证毫秒语义
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

// ---- 时间（毫秒时间戳） ----
const ms = Date.now();
assert('今天→HH:MM', /^\d{2}:\d{2}$/.test(fmtTime(ms)));
assert('昨天', fmtTime(ms - 86400000) === '昨天');
assert('无时间→空', fmtTime(0) === '');
assert('秒级时间戳防御', fmtTime(1787110158).startsWith('1970'));

// ---- 转义与高亮 ----
assert('HTML转义', esc('<script>x</script>') === '&lt;script&gt;x&lt;/script&gt;');
assert('null转义', esc(null) === '');
assert('高亮命中', highlight('你好世界', '世界') === '你好<mark>世界</mark>');
assert('高亮无关键词', highlight('你好', '') === '你好');
assert('高亮正则特殊字符安全', highlight('a+b', 'a+b') === '<mark>a+b</mark>');
assert('高亮null安全', highlight(null, 'x') === '');

// ---- 内置表情（render.js 经 emoticons.js 渲染文本内 [xxx] 记号）----
const emoText = renderContent({ type: 'text', content: '晚安[月亮]' });
assert('文本表情有 Unicode → wx-emo', emoText.includes('class="wx-emo"') && emoText.includes('🌙'));
assert('文本表情 title 保留原记号', emoText.includes('title="[月亮]"'));
const emoNone = renderContent({ type: 'text', content: '哈哈[旺柴]' });
assert('微信独有表情 → 文字胶囊', emoNone.includes('class="wx-emo none"') && emoNone.includes('旺柴'));
assert('非表情方括号原样保留', renderContent({ type: 'text', content: '收到[已收款]了' }).includes('[已收款]')
  && !renderContent({ type: 'text', content: '收到[已收款]了' }).includes('wx-emo'));
// 表情渲染下普通文本仍必须转义（XSS 不因表情通道被绕过）
const emoXss = renderContent({ type: 'text', content: '<img>[微笑]</img>' });
assert('表情通道文本仍转义', emoXss.includes('&lt;img&gt;') && !emoXss.includes('<img>'));
// 引用回复的正文与被引内容都走表情渲染
const emoQuote = renderContent({ type: 'app', content: '好呀[玫瑰]',
  meta: { kind: 'quote', quote: { name: '张三', content: '走吗[太阳]' } } });
assert('引用正文表情', emoQuote.includes('🌹'));
assert('被引内容表情', emoQuote.includes('☀️'));

// ---- 工具函数 ----
assert('时长秒', fmtDuration(6) === '6"');
assert('时长分秒', fmtDuration(75) === "1'15\"");
assert('大小 KB', fmtSize(2048) === '2.0 KB');
assert('大小 MB', fmtSize(5306256) === '5.1 MB');
assert('大小 0→空', fmtSize(0) === '');

// ---- 文本/系统 ----
assert('文本', renderContent({ type: 'text', content: '你好' }) === '你好');
assert('文本 XSS 转义', renderContent({ type: 'text', content: '<img src=x onerror=alert(1)>' }).includes('&lt;img'));
assert('系统消息', renderContent({ type: 'system', content: '"nansu" 撤回了一条消息' }).includes('撤回'));

// ---- 图片 ----
const imgHtml = renderContent({ type: 'image', ts: 111, meta: { kind: 'image', width: 172, height: 432, file_hash: 'abc123' } });
assert('图片卡片', imgHtml.includes('img-ph'));
assert('图片尺寸', imgHtml.includes('172×432'));
assert('图片hash透传', imgHtml.includes('data-hash="abc123"'));
assert('图片宽高比预留', imgHtml.includes('aspect-ratio:172/432'));

// ---- 表情（cdnurl 显示 / 占位） ----
const emo = renderContent({ type: 'emoji', meta: { kind: 'emoji', url: 'http://x/e.gif' } });
assert('表情 sticker', emo.includes('emoji-sticker') && emo.includes('data-src="http://x/e.gif"'));
assert('表情无url占位', renderContent({ type: 'emoji', meta: { kind: 'emoji', url: '' } }).includes('表情'));
assert('表情 url XSS 转义', renderContent({ type: 'emoji', meta: { kind: 'emoji', url: 'http://x?a="><b>' } }).includes('&quot;'));

// ---- 语音 / 视频 / voip ----
assert('语音时长', renderContent({ type: 'voice', meta: { kind: 'voice', duration: 6 } }).includes('6"'));
assert('视频占位+时长', renderContent({ type: 'video', meta: { kind: 'video', duration: 19 } }).includes("19\""));
assert('voip 通话', renderContent({ type: 'voip', content: '语音通话', meta: { kind: 'voip' } }).includes('语音通话'));

// ---- 转账 / 红包 ----
// 人民币符号用全角 ￥(U+FFE5)：微信自己写入 feedesc 的就是它（实测 1352 条全部如此），
// 半角 ¥(U+00A5) 是日元符号。有 amount_text 时原样沿用微信原文。
const tf = renderContent({ type: 'app', content: '4.50 元', meta: { kind: 'transfer', amount: '4.50', state: '已收款' } });
assert('转账金额（全角￥）', tf.includes('￥4.50') && tf.includes('已收款'));
assert('转账金额不含半角¥', !tf.includes('¥'));
const tf2 = renderContent({ type: 'app', meta: { kind: 'transfer', amount: '3.00', amount_text: '￥3.00', state: '转账' } });
assert('转账优先用微信原文 amount_text', tf2.includes('￥3.00'));
assert('红包', renderContent({ type: 'app', meta: { kind: 'redpacket', memo: '恭喜发财' } }).includes('恭喜发财'));

// ---- 文件 ----
const fc = renderContent({ type: 'app', meta: { kind: 'file', name: '报告.docx', size: 5306256, ext: 'docx' } });
assert('文件名', fc.includes('报告.docx'));
assert('文件大小', fc.includes('5.1 MB'));
assert('文件扩展', fc.includes('DOCX'));

// ---- 链接 / 小程序 / 视频号 / 合并转发 ----
const lk = renderContent({ type: 'app', meta: { kind: 'link', title: '标题', des: '描述', url: 'https://a.com', thumb: 'https://a.com/t.jpg' } });
assert('链接标题+描述', lk.includes('标题') && lk.includes('描述'));
assert('链接可打开(data-url)', lk.includes('data-url="https://a.com"'));
assert('链接缩略图', lk.includes('a.com/t.jpg'));
assert('小程序', renderContent({ type: 'app', meta: { kind: 'miniprogram', title: '拼一拼', app: '微商相册' } }).includes('微商相册'));
assert('视频号', renderContent({ type: 'app', meta: { kind: 'channel', title: '直播', author: '人民日报', live: true } }).includes('人民日报'));
assert('合并转发', renderContent({ type: 'app', meta: { kind: 'forward', title: '群聊的聊天记录', des: 'a: 1\nb: 2' } }).includes('群聊的聊天记录'));

// ---- 引用 / 接龙 / 群公告 / 拍一拍 ----
const qt = renderContent({ type: 'app', content: '回复内容', meta: { kind: 'quote', quote: { name: '张三', content: '原消息' } } });
assert('引用被引名', qt.includes('张三'));
assert('引用被引内容', qt.includes('原消息'));
assert('引用正文', qt.includes('回复内容'));
assert('接龙', renderContent({ type: 'app', meta: { kind: 'jielong', text: '#接龙\n1. 张三' } }).includes('接龙'));
assert('群公告', renderContent({ type: 'app', meta: { kind: 'announce', text: '明天放假' } }).includes('明天放假'));
assert('拍一拍', renderContent({ type: 'app', content: '"A" 拍了拍 "B"', meta: { kind: 'pat' } }).includes('拍了拍'));

// ---- 位置 / 名片 ----
assert('位置', renderContent({ type: 'location', content: '', meta: { kind: 'location', poiname: '天安门', label: '北京市' } }).includes('天安门'));
assert('名片', renderContent({ type: 'card', meta: { kind: 'card', nickname: '李四' } }).includes('李四'));

// ---- 富卡片 XSS 防御 ----
assert('转账 memo XSS', renderContent({ type: 'app', meta: { kind: 'redpacket', memo: '<b>x</b>' } }).includes('&lt;b&gt;'));
assert('文件名 XSS', renderContent({ type: 'app', meta: { kind: 'file', name: '<script>' } }).includes('&lt;script&gt;'));
assert('引用内容 XSS', renderContent({ type: 'app', content: '<i>', meta: { kind: 'quote', quote: { name: '<x>', content: '<y>' } } }).includes('&lt;'));

// ---- 纯文本提取（复制用） ----
assert('文本复制', plainContent({ type: 'text', content: '你好' }) === '你好');
assert('图片复制', plainContent({ type: 'image', meta: { kind: 'image' } }) === '[图片]');
assert('语音复制含时长', plainContent({ type: 'voice', meta: { kind: 'voice', duration: 6 } }) === '[语音] 6"');
assert('转账复制', plainContent({ type: 'app', content: '4.50 元', meta: { kind: 'transfer' } }) === '[转账] 4.50 元');
assert('文件复制', plainContent({ type: 'app', meta: { kind: 'file', name: 'a.docx' } }) === '[文件] a.docx');
assert('链接复制', plainContent({ type: 'app', meta: { kind: 'link', title: '标题' } }) === '[链接] 标题');
assert('引用复制含被引', plainContent({ type: 'app', content: '正文', meta: { kind: 'quote', quote: { name: 'A', content: 'B' } } }).includes('引用 A: B'));


// ---- 发现页数据报告 / 个人主页（纯字符串渲染） ----
const ST = {
  session_count: 366, total_unread: 12, archived_count: 3,
  msg_total: 237970, sent: 10519, received: 227451, system_count: 9043,
  direction_ok: true,
  kinds: [{ key: 'text', label: '文字', count: 158478 }, { key: 'image', label: '图片', count: 19087 }],
  months: [{ label: '2026-07', count: 13100 }, { label: '2026-08', count: 2429 }],
  years: [{ label: '2025', count: 55044 }, { label: '2026', count: 33098 }],
  first_day: '2022-08-12', last_day: '2026-08-19', active_days: 1288,
  busiest_day: { day: '2024-12-01', count: 1631 }, avg_per_active_day: 184.8,
  top_sessions: [{ username: 'a@chatroom', name: '群<x>', avatar: '', count: 61879, is_group: true, is_gh: false },
                 { username: 'wxid_b', name: '张三', avatar: '', count: 31477, is_group: false, is_gh: false }],
};
assert('数字千分位', R.fmtNum(237970) === '237,970');
assert('紧凑数字-万', R.fmtCompact(237970) === '24万');
assert('紧凑数字-小于万原样', R.fmtCompact(9999) === '9999');
assert('紧凑数字-一位小数', R.fmtCompact(13100) === '1.3万');
assert('日期中文化', R.fmtDay('2024-12-01') === '2024年12月1日');
assert('日期非法兜底', R.fmtDay('') === '—');
assert('天数跨度含首尾', R.daysBetween('2024-01-01', '2024-01-31') === 31);
assert('天数跨度同日为1', R.daysBetween('2024-01-01', '2024-01-01') === 1);

const rep = R.renderStatsReport(ST);
assert('报告含消息总数', rep.includes('消息总数') && rep.includes('237,970'));
assert('报告含活跃天数', rep.includes('活跃天数') && rep.includes('1,288'));
assert('报告含时间跨度', rep.includes('2022年8月12日'));
assert('报告含最热闹的一天', rep.includes('最热闹的一天') && rep.includes('1,631'));
assert('报告含收发比例', rep.includes('收发比例') && rep.includes('我发出'));
assert('收发比宽度按占比', /ratio-sent" style="width:4%/.test(rep));
assert('报告含按月柱状图', rep.includes('按月消息量') && rep.includes('col-bar'));
assert('柱状图最高柱为 100%', rep.includes('height:100%'));
assert('报告含类型分布', rep.includes('消息类型分布') && rep.includes('文字'));
assert('类型分布含占比', rep.includes('66.6%'));
assert('报告含会话排行', rep.includes('聊得最多的会话') && rep.includes('61,879'));
assert('排行项可点击打开', rep.includes('data-open="a@chatroom"'));
assert('排行项标注群聊', rep.includes('>群聊<'));
assert('报告 XSS 防御', rep.includes('群&lt;x&gt;') && !rep.includes('群<x>'));
assert('无方向数据时隐藏收发比',
  !R.renderStatsReport(Object.assign({}, ST, { direction_ok: false })).includes('收发比例'));
assert('空统计不抛错', typeof R.renderStatsReport({}) === 'string');
assert('单一年份不画按年图', !R.renderStatsReport(Object.assign({}, ST, { years: [{ label: '2026', count: 1 }] })).includes('按年消息量'));

const PROF = {
  username: 'wxid_demo', name: '我<b>', avatar: '', friend_count: 138, contact_total: 6070,
  group_count: 127, gh_count: 64, with_record: 361, db_root: 'G:\db', attach_root: 'C:\attach',
  db_files: 35, db_bytes: 280735744, shard_count: 7, zstd: 'native', python: '3.13.2',
};
const me = R.renderProfile(PROF, { version: '1.0.0', electron: '31.0.0', chrome: '126', platform: 'win32 10' });
assert('主页含 wxid', me.includes('wxid_demo'));
assert('主页昵称转义', me.includes('我&lt;b&gt;'));
assert('主页含通讯录规模', me.includes('好友') && me.includes('138'));
assert('主页含库体积', me.includes('267.7 MB') && me.includes('35 个'));
assert('主页含解密库目录', me.includes('G:\db'));
assert('主页含打开目录按钮', me.includes('btnOpenDb') && me.includes('btnOpenAttach'));
assert('主页含导出入口', me.includes('btnExportAllMe'));
assert('主页标注 zstd 原生通道', me.includes('原生 zstandard'));
assert('主页含数据同步面板', me.includes('btnSyncNow') && me.includes('syncState'));
assert('主页数据同步含微信/上次同步字段', me.includes('syncWechat') && me.includes('syncLast'));
assert('主页纯 Python 通道文案',
  R.renderProfile(Object.assign({}, PROF, { zstd: 'pure' }), {}).includes('纯 Python'));
assert('无附件目录时不出现附件按钮',
  !R.renderProfile(Object.assign({}, PROF, { attach_root: '' }), {}).includes('btnOpenAttach'));
assert('主页含离线声明', me.includes('不联网'));
assert('空档案不抛错', typeof R.renderProfile({}, {}) === 'string');



// ---- 全库搜索结果渲染 ----
const SR = {
  keyword: '会议', total: 7, truncated: true,
  groups: [{
    username: 'a@chatroom', name: '项目<群>', is_group: true, is_gh: false, count: 5,
    hits: [
      { ts: 1700000000000, sort_seq: 1700000000000, id: 12, content: '明天三点开会议室碰头', sender: '张三', kind: 'text' },
      { ts: 1700000001000, sort_seq: 1700000001000, id: 13, content: '会议纪要.docx', sender: '我', kind: 'file' },
      { ts: 1700000002000, sort_seq: 1700000002000, id: 14, content: '会议改期', sender: '李四', kind: 'text' },
      { ts: 1700000003000, sort_seq: 1700000003000, id: 15, content: '会议取消', sender: '李四', kind: 'text' },
    ],
  }],
};
const SESS = [{ username: 'wxid_1', name: '李四', summary: '会议室钥匙', is_group: false, is_gh: false }];
const sr = R.renderSearchResults(SR, { sessions: SESS, fmtTime: () => '昨天' });
assert('搜索结果含会话分区', sr.includes('联系人与会话 (1)'));
assert('搜索结果含记录分区', sr.includes('聊天记录 (7)'));
assert('命中带定位游标', sr.includes('data-seq="1700000000000"') && sr.includes('data-id="12"'));
assert('命中显示发送者', sr.includes('张三：'));
assert('非文本命中带类型前缀', sr.includes('[文件]'));
assert('命中关键词高亮', sr.includes('<mark>会议</mark>'));
assert('默认只预览 3 条', (sr.match(/class="hit"/g) || []).length === 3);
assert('超出部分可展开', sr.includes('展开其余 2 条'));
assert('截断时给出说明', sr.includes('最多展示 20 条'));
assert('搜索结果 XSS 防御', sr.includes('项目&lt;群&gt;') && !sr.includes('项目<群>'));
assert('无结果空态', R.renderSearchResults({ keyword: 'zz', groups: [], total: 0 }, { sessions: [] }).includes('没有找到'));
assert('空态关键词转义', R.renderSearchResults({ keyword: '<x>', groups: [], total: 0 }, { sessions: [] }).includes('&lt;x&gt;'));
const full = R.renderGroupHits(SR.groups[0], '会议', { fmtTime: () => '昨天' });
assert('展开后显示全部命中', (full.match(/class="hit"/g) || []).length === 4);
assert('片段以关键词为中心截断',
  R.snippet('x'.repeat(200) + '会议' + 'y'.repeat(200), '会议').startsWith('…'));
assert('短文本不加省略号', R.snippet('开会议', '会议') === '开<mark>会议</mark>');
assert('片段折叠空白', R.snippet('a\n\nb  c', 'b').includes('a <mark>b</mark> c'));
assert('片段无关键词兜底', R.snippet('abc', 'zzz') === 'abc');


console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
