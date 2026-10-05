// render.js — 消息渲染纯逻辑层（无 DOM 依赖，浏览器与 Node 测试共用）
// 将 message(type + meta) 渲染为气泡内 HTML 字符串；所有外部文本经 esc 转义。
// 暴露：浏览器 → window.WeMemoRender；Node → module.exports。
(function (root, factory) {
  // 内置表情模块（emoticons.js）：Node 下 require，浏览器下取已加载的全局。
  // 缺失时 factory 内部退化为纯 esc，功能不受影响（只是不渲染 [微笑] 一类记号）。
  let emo = null;
  if (typeof require !== 'undefined') {
    try { emo = require('./emoticons.js'); } catch (e) { /* 浏览器或未提供 */ }
  }
  if (!emo && root && root.WeMemoEmoticons) emo = root.WeMemoEmoticons;
  const api = factory(emo);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WeMemoRender = api;
})(typeof self !== 'undefined' ? self : this, function (EMO) {
  'use strict';

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 文本 + 微信内置表情：把 [微笑] 一类记号渲染为 emoji / 文字胶囊，其余文本经 esc。
  // EMO 缺失（未加载 emoticons.js）时退化为纯 esc，保证渲染层可独立工作。
  function escEmo(t) {
    return EMO ? EMO.render(t, esc) : esc(t);
  }

  // 搜索结果高亮（keyword 内特殊字符先转义再匹配）
  function highlight(text, kw) {
    if (!kw) return esc(text);
    const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return esc(text).replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
  }

  function fmtDuration(s) {
    s = Number(s) || 0;
    if (s < 60) return `${s}"`;
    return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
  }
  function fmtSize(bytes) {
    bytes = Number(bytes) || 0;
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  // 小图标（内联 SVG，随卡片着色）
  const MI = {
    play: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    location: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="9" r="2.4" fill="currentColor"/></svg>',
    money: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 10.5h16" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="14.5" r="1.6" fill="currentColor"/></svg>',
    packet: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="5" y="4" width="14" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 9c3 2 11 2 14 0" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg>',
    voice: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9v6M8 5v14M12 8v8M16 6v12M20 10v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    channel: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
    mp: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="1.6"/></svg>',
    card: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="11" r="2" fill="currentColor"/><path d="M14 10h4M14 13h4M6 16c1-2 5-2 6 0" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    quote: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 17c-2 0-3-1.5-3-3.5S4.5 9 7 9V7C3.5 7 1 9.5 1 13.5S3 20 6 20zM18 17c-2 0-3-1.5-3-3.5S16.5 9 19 9V7c-3.5 0-6 2.5-6 6.5S15 20 18 20z" fill="currentColor"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    forward: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const TYPE_LABEL = {
    text: '', image: '图片', voice: '语音', video: '视频',
    emoji: '表情', app: '链接', card: '名片', location: '位置',
    voip: '通话', other: '', system: '',
  };

  function renderImageCard(m) {
    const meta = m.meta || m.img || {};
    const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '';
    const hash = meta.file_hash || meta.md5 || '';
    let ratioStyle = '';
    if (meta.width && meta.height) {
      const w = Math.min(240, meta.width);
      ratioStyle = ` style="width:${w}px;aspect-ratio:${meta.width}/${meta.height}"`;
    }
    return `<span class="img-ph"${ratioStyle} data-ts="${m.ts}" data-hash="${esc(hash)}">
      <svg class="img-icon" viewBox="0 0 20 20" width="22" height="22"><rect x="2" y="3" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="8" r="1.6" fill="currentColor"/><path d="M4 16l4.2-4.4 2.6 2.6L14 11l4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
      ${size ? `<span class="img-size">${esc(size)}</span>` : ''}
    </span>`;
  }

  function renderEmojiCard(m) {
    const meta = m.meta || {};
    if (meta.url) {
      return `<span class="emoji-sticker" data-src="${esc(meta.url)}">
        <svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/><path d="M8 14c1.5 2 6.5 2 8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>`;
    }
    return `<span class="mtype-card"><span class="mtype-icon">${MI.mp}</span><span class="mtype-name">表情</span></span>`;
  }

  function renderVoiceCard(m) {
    const meta = m.meta || {};
    const secs = meta.duration || 0;
    const w = Math.min(160, 46 + secs * 5);
    return `<span class="voice-card" style="min-width:${w}px">
      <span class="voice-ico">${MI.voice}</span>
      <span class="voice-dur">${fmtDuration(secs)}</span>
    </span>`;
  }

  function renderVideoCard(m) {
    const meta = m.meta || {};
    const dur = meta.duration ? `<span class="video-dur">${fmtDuration(meta.duration)}</span>` : '';
    let ratioStyle = '';
    if (meta.width && meta.height) {
      const w = Math.min(220, meta.width);
      ratioStyle = ` style="width:${w}px;aspect-ratio:${meta.width}/${meta.height}"`;
    }
    return `<span class="video-ph"${ratioStyle}>
      <span class="video-play">${MI.play}</span>${dur}
    </span>`;
  }

  function renderTransferCard(m) {
    const meta = m.meta || {};
    // 金额优先用微信自己写的原文（feedesc，形如 "￥3.00"），符号与客户端完全一致；
    // 缺失时才自己拼，且用全角 ￥(U+FFE5) —— 半角 ¥(U+00A5) 是日元符号，不是人民币
    const amount = meta.amount_text ? esc(meta.amount_text)
      : (meta.amount ? `￥${esc(meta.amount)}` : '');
    const state = esc(meta.state || '转账');
    return `<span class="pay-card transfer">
      <span class="pay-ico">${MI.money}</span>
      <span class="pay-body"><span class="pay-amount">${amount || state}</span><span class="pay-sub">${amount ? state : '微信转账'}</span></span>
    </span>`;
  }
  function renderRedpacketCard(m) {
    const meta = m.meta || {};
    const memo = esc(meta.memo || m.content || '微信红包');
    return `<span class="pay-card redpacket">
      <span class="pay-ico">${MI.packet}</span>
      <span class="pay-body"><span class="pay-amount">${memo}</span><span class="pay-sub">微信红包</span></span>
    </span>`;
  }
  function renderFileCard(m) {
    const meta = m.meta || {};
    const name = esc(meta.name || m.content || '文件');
    const sz = fmtSize(meta.size);
    const ext = esc((meta.ext || '').toUpperCase());
    return `<span class="file-card">
      <span class="file-body"><span class="file-name">${name}</span><span class="file-sub">${sz}${ext ? ' · ' + ext : ''}</span></span>
      <span class="file-ico">${MI.file}${ext ? `<span class="file-ext">${ext}</span>` : ''}</span>
    </span>`;
  }
  function renderLinkCard(m) {
    const meta = m.meta || {};
    const title = esc(meta.title || m.content || '链接');
    const des = meta.des ? `<span class="link-des">${esc(meta.des)}</span>` : '';
    const src = meta.source ? `<span class="link-src">${esc(meta.source)}</span>` : '';
    const thumb = meta.thumb
      ? `<span class="link-thumb"><img src="${esc(meta.thumb)}" loading="lazy" onerror="this.parentNode.style.display='none'"/></span>`
      : `<span class="link-thumb ph">${MI.link}</span>`;
    const url = meta.url ? ` data-url="${esc(meta.url)}"` : '';
    return `<span class="link-card"${url}>
      <span class="link-body"><span class="link-title">${title}</span>${des}${src}</span>
      ${thumb}
    </span>`;
  }
  function renderMiniprogramCard(m) {
    const meta = m.meta || {};
    const title = esc(meta.title || m.content || '小程序');
    const appn = meta.app ? `<span class="mp-app">${MI.mp}${esc(meta.app)}</span>` : '';
    const thumb = meta.thumb
      ? `<span class="mp-thumb"><img src="${esc(meta.thumb)}" loading="lazy" onerror="this.style.display='none'"/></span>` : '';
    const url = meta.url ? ` data-url="${esc(meta.url)}"` : '';
    return `<span class="mp-card"${url}>${appn}<span class="mp-title">${title}</span>${thumb}</span>`;
  }
  function renderChannelCard(m) {
    const meta = m.meta || {};
    const title = esc(meta.title || m.content || '视频号');
    const author = meta.author ? `<span class="ch-author">${MI.channel}${esc(meta.author)}${meta.live ? ' · 直播' : ''}</span>` : '';
    return `<span class="ch-card"><span class="ch-title">${title}</span>${author}</span>`;
  }
  function renderForwardCard(m) {
    const meta = m.meta || {};
    const title = esc(meta.title || m.content || '聊天记录');
    const des = meta.des ? `<span class="fwd-des">${esc(meta.des.slice(0, 90))}</span>` : '';
    return `<span class="fwd-card"><span class="fwd-head"><span class="fwd-ico">${MI.forward}</span><span class="fwd-title">${title}</span></span>${des}</span>`;
  }
  function renderLocationCard(m) {
    const meta = m.meta || {};
    const label = esc(meta.poiname || meta.label || m.content || '位置');
    const sub = meta.label && meta.poiname && meta.label !== meta.poiname ? `<span class="loc-sub">${esc(meta.label)}</span>` : '';
    return `<span class="loc-card"><span class="loc-ico">${MI.location}</span><span class="loc-body"><span class="loc-name">${label}</span>${sub}</span></span>`;
  }
  function renderCardMsg(m) {
    const meta = m.meta || {};
    const name = esc(meta.nickname || m.content || '名片');
    const ava = meta.avatar
      ? `<span class="contact-ava"><img src="${esc(meta.avatar)}" loading="lazy" onerror="this.style.display='none';this.parentNode.textContent='👤'"/></span>`
      : `<span class="contact-ava">👤</span>`;
    return `<span class="contact-card">${ava}<span class="contact-body"><span class="contact-name">${name}</span><span class="contact-sub">个人名片</span></span></span>`;
  }
  function renderVoipCard(m) {
    const text = esc(m.content || '通话');
    return `<span class="mtype-card voip-card"><span class="mtype-icon">${MI.voice}</span><span class="mtype-name">${text}</span></span>`;
  }
  function renderQuoteCard(m) {
    const meta = m.meta || {};
    const q = meta.quote;
    const body = escEmo(m.content || '');
    const quoted = q
      ? `<span class="quote-ref">${MI.quote}<span class="quote-txt"><b>${esc(q.name || '')}</b>${q.name ? '：' : ''}${escEmo(q.content || '')}</span></span>`
      : '';
    return `<span class="quote-card">${quoted}<span class="quote-body">${body}</span></span>`;
  }
  function renderJielongCard(m) {
    const meta = m.meta || {};
    return `<span class="jielong-card">${esc(meta.text || m.content || '接龙')}</span>`;
  }
  function renderAnnounceCard(m) {
    const meta = m.meta || {};
    return `<span class="announce-card"><span class="announce-tag">群公告</span><span class="announce-body">${esc(meta.text || m.content || '')}</span></span>`;
  }
  function renderPatCard(m) {
    return `<span class="pat-card">${esc(m.content || '')}</span>`;
  }

  function renderAppCard(m) {
    const kind = (m.meta && m.meta.kind) || 'link';
    switch (kind) {
      case 'transfer': return renderTransferCard(m);
      case 'redpacket': return renderRedpacketCard(m);
      case 'file': return renderFileCard(m);
      case 'link': return renderLinkCard(m);
      case 'miniprogram': return renderMiniprogramCard(m);
      case 'channel': return renderChannelCard(m);
      case 'forward': return renderForwardCard(m);
      case 'quote': return renderQuoteCard(m);
      case 'jielong': return renderJielongCard(m);
      case 'announce': return renderAnnounceCard(m);
      case 'pat': return renderPatCard(m);
      case 'emoji': return renderEmojiCard(m);
      default: return renderLinkCard(m);
    }
  }

  function renderContent(m) {
    const meta = m.meta || {};
    const kind = meta.kind;
    switch (m.type) {
      case 'text': return escEmo(m.content);
      case 'system': return esc(m.content || '');
      case 'image': return renderImageCard(m);
      case 'emoji': return renderEmojiCard(m);
      case 'voice': return renderVoiceCard(m);
      case 'video': return renderVideoCard(m);
      case 'location': return renderLocationCard(m);
      case 'card': return renderCardMsg(m);
      case 'voip': return renderVoipCard(m);
      case 'app': return renderAppCard(m);
      default: {
        if (kind === 'pat') return renderPatCard(m);
        const label = TYPE_LABEL[m.type];
        return label
          ? `<span class="mtype-card"><span class="mtype-name">${label}</span>${m.content ? `<span class="mtype-sub">${esc(m.content.slice(0, 40))}</span>` : ''}</span>`
          : esc(m.content);
      }
    }
  }

  // 消息纯文本（复制用）
  function plainContent(m) {
    const meta = m.meta || {};
    const kind = meta.kind || m.type;
    switch (kind) {
      case 'image': return '[图片]';
      case 'voice': return meta.duration ? `[语音] ${meta.duration}"` : '[语音]';
      case 'video': return '[视频]';
      case 'emoji': return '[表情]';
      case 'location': return `[位置] ${m.content || ''}`.trim();
      case 'card': return `[名片] ${meta.nickname || m.content || ''}`.trim();
      case 'voip': return `[${m.content || '通话'}]`;
      case 'transfer': return `[转账] ${m.content || ''}`.trim();
      case 'redpacket': return `[红包] ${meta.memo || m.content || ''}`.trim();
      case 'file': return `[文件] ${meta.name || m.content || ''}`.trim();
      case 'link': return `[链接] ${meta.title || m.content || ''}`.trim();
      case 'miniprogram': return `[小程序] ${meta.title || m.content || ''}`.trim();
      case 'channel': return `[视频号] ${m.content || ''}`.trim();
      case 'forward': return `[聊天记录] ${meta.title || m.content || ''}`.trim();
      case 'quote': {
        const q = meta.quote;
        const head = q ? `引用 ${q.name || ''}: ${q.content || ''}\n` : '';
        return `${head}${m.content || ''}`.trim();
      }
      default: return m.content || '';
    }
  }

  // ================= 发现页 / 个人主页（纯字符串渲染，可单测） =================

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString('en-US');
  }

  // 大数字紧凑显示（卡片空间有限）：12345 → 1.2万
  function fmtCompact(n) {
    n = Number(n) || 0;
    if (n < 10000) return String(n);
    if (n < 100000000) return `${(n / 10000).toFixed(n < 100000 ? 1 : 0)}万`;
    return `${(n / 100000000).toFixed(2)}亿`;
  }

  function fmtDay(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : (d || '—');
  }

  function daysBetween(a, b) {
    const t1 = Date.parse(`${a}T00:00:00`);
    const t2 = Date.parse(`${b}T00:00:00`);
    if (isNaN(t1) || isNaN(t2)) return 0;
    return Math.round((t2 - t1) / 86400000) + 1;
  }

  function statCard(value, label, sub) {
    return `<div class="stat-card"><div class="stat-val">${esc(value)}</div>`
      + `<div class="stat-label">${esc(label)}</div>`
      + (sub ? `<div class="stat-sub">${esc(sub)}</div>` : '') + '</div>';
  }

  // 横向条形图（类型分布）：宽度按最大值归一化
  function barList(items, opts) {
    const o = opts || {};
    const max = items.reduce((a, b) => Math.max(a, b.count || 0), 0) || 1;
    const total = o.total || items.reduce((a, b) => a + (b.count || 0), 0) || 1;
    return items.map((it) => {
      const pct = Math.max(1, Math.round((it.count / max) * 100));
      const share = ((it.count / total) * 100).toFixed(1);
      return `<div class="bar-row"><div class="bar-name">${esc(it.label)}</div>`
        + `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`
        + `<div class="bar-num">${fmtNum(it.count)}<span class="bar-pct">${share}%</span></div></div>`;
    }).join('');
  }

  // 竖向柱状图（按月/按年消息量）
  function columnChart(items, opts) {
    const o = opts || {};
    if (!items || !items.length) return '';
    const max = items.reduce((a, b) => Math.max(a, b.count || 0), 0) || 1;
    const cols = items.map((it) => {
      const h = Math.max(2, Math.round((it.count / max) * 100));
      const label = o.shortLabel ? String(it.label).replace(/^\d{4}-/, '') : it.label;
      return `<div class="col" title="${esc(it.label)}：${fmtNum(it.count)} 条">`
        + `<div class="col-bar" style="height:${h}%"></div>`
        + `<div class="col-label">${esc(label)}</div></div>`;
    }).join('');
    return `<div class="col-chart">${cols}</div>`;
  }

  function rankList(items) {
    if (!items || !items.length) return '<div class="rank-empty">暂无数据</div>';
    const max = items[0].count || 1;
    return items.map((it, i) => {
      const pct = Math.max(2, Math.round((it.count / max) * 100));
      const tag = it.is_group ? '群聊' : (it.is_gh ? '公众号' : '');
      return `<div class="rank-row" data-open="${esc(it.username)}" data-name="${esc(it.name)}"`
        + ` data-group="${it.is_group ? 1 : 0}">`
        + `<div class="rank-no${i < 3 ? ' top' : ''}">${i + 1}</div>`
        + `<div class="rank-main"><div class="rank-name">${esc(it.name)}`
        + (tag ? `<span class="rank-tag">${tag}</span>` : '') + '</div>'
        + `<div class="rank-track"><div class="rank-fill" style="width:${pct}%"></div></div></div>`
        + `<div class="rank-num">${fmtNum(it.count)}</div></div>`;
    }).join('');
  }

  function section(title, body, note) {
    if (!body) return '';
    return `<div class="panel"><div class="panel-title">${esc(title)}`
      + (note ? `<span class="panel-note">${esc(note)}</span>` : '') + '</div>'
      + `<div class="panel-body">${body}</div></div>`;
  }

  /** 发现页数据报告（返回 HTML 字符串）。*/
  function renderStatsReport(st) {
    const s = st || {};
    const span = (s.first_day && s.last_day) ? daysBetween(s.first_day, s.last_day) : 0;
    const cards = statCard(fmtCompact(s.msg_total), '消息总数', `${fmtNum(s.msg_total)} 条`)
      + statCard(fmtNum(s.session_count), '会话', s.archived_count ? `含历史 ${s.archived_count}` : '')
      + statCard(fmtNum(s.active_days), '活跃天数', span ? `跨度 ${fmtNum(span)} 天` : '')
      + statCard(fmtNum(s.avg_per_active_day), '日均条数', '按活跃天计');
    let html = `<div class="stat-grid">${cards}</div>`;

    if (s.first_day) {
      html += section('时间跨度',
        `<div class="kv"><span>第一条</span><b>${esc(fmtDay(s.first_day))}</b></div>`
        + `<div class="kv"><span>最近一条</span><b>${esc(fmtDay(s.last_day))}</b></div>`
        + (s.busiest_day && s.busiest_day.day
          ? `<div class="kv"><span>最热闹的一天</span><b>${esc(fmtDay(s.busiest_day.day))}`
            + ` · ${fmtNum(s.busiest_day.count)} 条</b></div>` : ''));
    }

    if (s.direction_ok) {
      const tot = (s.sent || 0) + (s.received || 0) || 1;
      const sp = Math.round((s.sent / tot) * 100);
      html += section('收发比例',
        `<div class="ratio"><div class="ratio-sent" style="width:${sp}%"></div></div>`
        + `<div class="ratio-legend"><span class="dot sent"></span>我发出 ${fmtNum(s.sent)}（${sp}%）`
        + `<span class="dot recv"></span>我收到 ${fmtNum(s.received)}（${100 - sp}%）</div>`,
        s.system_count ? `系统提示 ${fmtNum(s.system_count)} 条不计入` : '');
    }

    if (s.months && s.months.length) {
      html += section('按月消息量', columnChart(s.months, { shortLabel: false }),
        `最近 ${s.months.length} 个月`);
    }
    if (s.years && s.years.length > 1) {
      html += section('按年消息量', columnChart(s.years));
    }
    if (s.kinds && s.kinds.length) {
      html += section('消息类型分布', barList(s.kinds, { total: s.msg_total }),
        `${s.kinds.length} 类`);
    }
    if (s.top_sessions && s.top_sessions.length) {
      html += section('聊得最多的会话', rankList(s.top_sessions), 'TOP 10 · 点击进入');
    }
    return html;
  }

  /** 个人主页（返回 HTML 字符串）。*/
  function renderProfile(p, info) {
    const u = p || {};
    const a = info || {};
    const ava = u.avatar
      ? `<img src="${esc(u.avatar)}" onerror="this.style.display='none'" />`
      : '<div class="emoji">👤</div>';
    let html = `<div class="me-card">
        <div class="me-ava">${ava}</div>
        <div class="me-id"><div class="me-name">${esc(u.name || '我')}</div>
          <div class="me-wxid">${esc(u.username || '')}</div></div>
      </div>`;
    html += section('通讯录',
      `<div class="mini-grid">
        ${statCard(fmtNum(u.friend_count), '好友')}
        ${statCard(fmtNum(u.group_count), '群聊')}
        ${statCard(fmtNum(u.gh_count), '公众号')}
        ${statCard(fmtNum(u.with_record), '有记录')}
      </div>`, `联系人库共 ${fmtNum(u.contact_total)} 条`);
    html += section('本地数据',
      `<div class="kv"><span>数据库</span><b>${fmtNum(u.db_files)} 个 · ${fmtSize(u.db_bytes)}</b></div>`
      + `<div class="kv"><span>消息分片</span><b>${fmtNum(u.shard_count)} 个</b></div>`
      + `<div class="kv path"><span>解密库目录</span><b title="${esc(u.db_root)}">${esc(u.db_root)}</b></div>`
      + (u.attach_root
        ? `<div class="kv path"><span>附件目录</span><b title="${esc(u.attach_root)}">${esc(u.attach_root)}</b></div>`
        : '')
      + `<div class="me-actions">
          <button class="btn-ghost" id="btnOpenDb">打开解密库目录</button>
          ${u.attach_root ? '<button class="btn-ghost" id="btnOpenAttach">打开附件目录</button>' : ''}
          <button class="btn-primary" id="btnExportAllMe">导出全部聊天记录</button>
        </div>`);
    // 数据同步（动态状态由 app.js 填充；微信在线时可增量重解密新消息）
    html += section('数据同步',
      `<div class="kv"><span>微信客户端</span><b id="syncWechat">检测中…</b></div>`
      + `<div class="kv"><span>上次同步</span><b id="syncLast">—</b></div>`
      + `<div class="sync-state" id="syncState">正在检查是否有新消息…</div>`
      + `<label class="sync-toggle"><input type="checkbox" id="syncAuto" checked><span>自动同步新消息（微信在线时每 45 秒检查一次）</span></label>`
      + `<div class="me-actions">
          <button class="btn-primary" id="btnSyncNow">立即同步</button>
        </div>`,
      '微信登录时自动把新收发的消息增量解密进来');
    html += section('运行环境',
      `<div class="kv"><span>微忆</span><b>v${esc(a.version || '1.0.0')}</b></div>`
      + (a.electron ? `<div class="kv"><span>Electron / Chromium</span><b>${esc(a.electron)} / ${esc(a.chrome)}</b></div>` : '')
      + `<div class="kv"><span>Python 引擎</span><b>${esc(u.python || '—')}</b></div>`
      + `<div class="kv"><span>zstd 解码通道</span><b>${u.zstd === 'native' ? '原生 zstandard（快速）' : '纯 Python（回退）'}</b></div>`
      + (a.platform ? `<div class="kv"><span>系统</span><b>${esc(a.platform)}</b></div>` : ''));

    html += section('关于',
      `<div class="me-about">微忆 WeMemo · 微信记忆离线归档<br/>`
      + '聊天数据全部只在本机读写：不上传、不回传、不写回微信库。<br/>'
      + '仅表情与链接缩略图会按消息里的原始地址向腾讯 CDN 取图（与微信客户端同一来源），'
      + '其余功能均不联网。<br/>'
      + '请仅用于解密你自己设备上的聊天记录，并遵守相关法律法规。</div>');
    return html;
  }

  // ================= 全库搜索结果（会话 + 聊天记录命中） =================

  const KIND_PREFIX = {
    image: '[图片]', voice: '[语音]', video: '[视频]', emoji: '[表情]',
    file: '[文件]', link: '[链接]', transfer: '[转账]', redpacket: '[红包]',
    location: '[位置]', card: '[名片]', miniprogram: '[小程序]',
    channel: '[视频号]', forward: '[聊天记录]', quote: '[引用]',
    announce: '[群公告]', voip: '[通话]', pat: '[拍一拍]',
  };

  // 命中片段：以关键词为中心截取，长文两侧加省略号，关键词高亮
  // 默认窗口取 30 字：列表项只有两行（约 50 字），过宽会把关键词挤出可见区域
  function snippet(text, kw, span) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const width = span || 30;
    if (!kw) return esc(t.slice(0, width * 2));
    const i = t.toLowerCase().indexOf(kw.toLowerCase());
    if (i < 0) return esc(t.slice(0, width * 2));
    const from = Math.max(0, i - Math.floor(width / 2));
    const to = Math.min(t.length, i + kw.length + width);
    const cut = (from > 0 ? '…' : '') + t.slice(from, to) + (to < t.length ? '…' : '');
    return highlight(cut, kw);
  }

  function hitRow(g, h, kw, fmtTime) {
    const pre = h.kind && h.kind !== 'text' ? `${KIND_PREFIX[h.kind] || ''} ` : '';
    const who = h.sender ? `${esc(h.sender)}：` : '';
    return `<div class="hit" data-open="${esc(g.username)}" data-name="${esc(g.name)}"`
      + ` data-group="${g.is_group ? 1 : 0}" data-seq="${h.sort_seq}" data-id="${h.id}">`
      + `<div class="hit-text">${who}${esc(pre)}${snippet(h.content, kw)}</div>`
      + `<div class="hit-time">${esc(fmtTime ? fmtTime(h.ts) : '')}</div></div>`;
  }

  /** 搜索结果列表 HTML：会话名命中 + 聊天记录内容命中（按会话分组）。*/
  function renderSearchResults(res, opts) {
    const o = opts || {};
    const kw = (res && res.keyword) || '';
    const sessions = o.sessions || [];
    const groups = (res && res.groups) || [];
    let html = '';
    if (sessions.length) {
      html += `<div class="sidebar-title">联系人与会话 (${sessions.length})</div>`;
      html += sessions.map((s) => {
        const tag = s.is_gh ? '<span class="tag gh">公众号</span>'
          : (s.is_group ? '<span class="tag group">群聊</span>' : '');
        return `<div class="session" data-open="${esc(s.username)}" data-name="${esc(s.name)}"`
          + ` data-group="${s.is_group ? 1 : 0}">`
          + `<div class="ava"><div class="emoji">${s.is_group ? '👥' : (s.is_gh ? '📣' : esc((s.name || '?').slice(0, 1)))}</div></div>`
          + `<div class="info"><div class="row1"><div class="name">${tag}${highlight(s.name, kw)}</div></div>`
          + `<div class="summary">${highlight(s.summary || '', kw)}</div></div></div>`;
      }).join('');
    }
    if (groups.length) {
      const total = res.total || 0;
      html += `<div class="sidebar-title">聊天记录 (${fmtNum(total)})</div>`;
      html += groups.map((g, gi) => {
        const shown = (g.hits || []).slice(0, o.preview || 3);
        const rest = (g.count || 0) - shown.length;
        return `<div class="hit-group" data-gi="${gi}">`
          + `<div class="hit-head"><span class="hit-name">${esc(g.name)}</span>`
          + `<span class="hit-count">${fmtNum(g.count)} 条</span></div>`
          + shown.map((h) => hitRow(g, h, kw, o.fmtTime)).join('')
          + (rest > 0 ? `<div class="hit-more" data-more="${gi}">展开其余 ${fmtNum(rest)} 条</div>` : '')
          + '</div>';
      }).join('');
    }
    if (!html) {
      html = `<div class="list-empty">没有找到与「${esc(kw)}」相关的内容</div>`;
    } else if (res && res.truncated) {
      html += '<div class="hit-note">每个会话最多展示 20 条命中</div>';
    }
    return html;
  }

  /** 某个分组展开后的全部命中（替换该组内容）。*/
  function renderGroupHits(g, kw, opts) {
    const o = opts || {};
    return `<div class="hit-head"><span class="hit-name">${esc(g.name)}</span>`
      + `<span class="hit-count">${fmtNum(g.count)} 条</span></div>`
      + (g.hits || []).map((h) => hitRow(g, h, kw, o.fmtTime)).join('');
  }

  return {
    esc, highlight, fmtDuration, fmtSize, MI, TYPE_LABEL,
    renderContent, plainContent, renderAppCard,
    renderImageCard, renderEmojiCard, renderVoiceCard, renderVideoCard,
    renderTransferCard, renderRedpacketCard, renderFileCard, renderLinkCard,
    renderMiniprogramCard, renderChannelCard, renderForwardCard, renderLocationCard,
    renderCardMsg, renderVoipCard, renderQuoteCard, renderJielongCard,
    renderAnnounceCard, renderPatCard,
    fmtNum, fmtCompact, fmtDay, daysBetween, statCard, barList, columnChart,
    rankList, section, renderStatsReport, renderProfile,
    snippet, hitRow, renderSearchResults, renderGroupHits, KIND_PREFIX,
  };
});
