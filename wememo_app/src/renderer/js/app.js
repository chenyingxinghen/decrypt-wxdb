// app.js — 渲染层主逻辑（v3：性能 + 交互优化）
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = {
    sessions: [],
    active: null,
    loadingMsgs: false,
    beforeSeq: null,        // 分页游标：最早一条的 sort_seq
    beforeId: null,         // 分页游标：最早一条的 local_id（sort_seq 不唯一，需复合游标）
    afterSeq: null,         // 向下游标：最新一条的 sort_seq（上下文视图用）
    afterId: null,
    allLoaded: false,
    allNewerLoaded: true,   // 是否已接到最新一条（普通视图首屏即最新，故默认 true）
    contextMode: false,     // 由搜索结果跳转进入的上下文片段视图
    self: '',
    seenIds: new Set(),     // 已渲染消息 uid（翻页去重；不能用 ts，同毫秒可有上百条）
    oldestDay: null,        // 已渲染最老消息的日期（时间线判断）
    newestDay: null,        // 已渲染最新消息的日期（向下补充时的时间线判断）
    isGroup: false,         // 当前会话是否群聊（头部 meta 用）
    ghView: false,          // 会话列表是否处于「公众号」子列表视图
    total: 0,               // 当前会话消息总数（引擎 msg_count）
    loaded: 0,              // 已渲染条数
    bulk: false,            // 批量加载中（跳过逐轮滚动锚定与懒加载注册）
  };

  // ---- 时间格式化（微信风格，输入毫秒时间戳） ----
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

  // 完整时间（消息分隔线 / hover 提示用）：'2026年8月19日 21:14'
  function fmtFull(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const dayOf = (ts) => new Date(ts).toDateString();

  // 渲染纯逻辑层（render.js，浏览器与测试共用）；esc/highlight/renderContent/plainContent 等
  const R = window.WeMemoRender;
  const esc = R.esc;
  const highlight = R.highlight;
  const renderContent = R.renderContent;
  const plainContent = R.plainContent;

  // ---- 轻提示 ----
  let toastTimer = null;
  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  }

  // ---- 剪贴板（file:// 下 execCommand 兜底） ----
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => fallbackCopy(t));
    } else {
      fallbackCopy(t);
    }
  }
  function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败'); }
    ta.remove();
  }

  // ---- 右键菜单 ----
  let ctxMenu = null;
  function hideCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }
  function showCtxMenu(e, m) {
    hideCtxMenu();
    const meta = m.meta || {};
    const items = [
      { label: '复制消息', fn: () => copyText(plainContent(m)) },
    ];
    // 链接/小程序/视频号：可复制链接、在浏览器打开
    const url = meta.url;
    if (url) {
      items.push({ label: '复制链接', fn: () => copyText(url) });
      items.push({ label: '浏览器打开', fn: () => window.wememo.openExternal && window.wememo.openExternal(url) });
    }
    // 引用消息：复制被引用内容
    if (meta.kind === 'quote' && meta.quote) {
      items.push({ label: '复制引用内容', fn: () => copyText(`${meta.quote.name || ''}: ${meta.quote.content || ''}`) });
    }
    items.push({ label: '复制时间', fn: () => copyText(fmtFull(m.ts)) });
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    items.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.textContent = it.label;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); hideCtxMenu(); it.fn(); });
      ctxMenu.appendChild(el);
    });
    document.body.appendChild(ctxMenu);
    // 定位并防止溢出视口
    const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    ctxMenu.style.left = `${x}px`;
    ctxMenu.style.top = `${y}px`;
  }
  document.addEventListener('click', hideCtxMenu);
  window.addEventListener('blur', hideCtxMenu);
  document.addEventListener('contextmenu', hideCtxMenu);

  // ---- 会话渲染 ----
  // 会话摘要兜底：summary 为空时按最后消息类型给出占位（图片/语音等）
  const SUMMARY_FALLBACK = {
    image: '[图片]', voice: '[语音]', video: '[视频]', emoji: '[表情]',
    app: '[链接]', card: '[名片]', location: '[位置]', voip: '[通话]',
  };
  function sessionSummary(s) {
    if (s.summary && s.summary.trim()) return s.summary;
    return SUMMARY_FALLBACK[s.last_type] || '';
  }

  function renderSessions(list, kw) {
    const box = $('sessionList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="list-empty">暂无会话</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'session' + (state.active === s.username ? ' active' : '');
      el.dataset.user = s.username;
      const unreadHtml = s.unread > 0 ? `<span class="unread">${s.unread > 99 ? '99+' : s.unread}</span>` : '';
      // 归档（历史）会话不加标记：仅公众号 / 群聊显示类型标签
      const tag = s.is_gh ? '<span class="tag gh">公众号</span>' :
                  (s.is_group ? '<span class="tag group">群聊</span>' : '');
      const avatar = s.avatar
        ? `<img src="${esc(s.avatar)}" loading="lazy" onerror="this.style.display='none';this.parentNode.textContent='${s.is_group ? '👥' : s.is_gh ? '📣' : '👤'}'" />`
        : `<div class="emoji">${s.is_group ? '👥' : s.is_gh ? '📣' : esc(s.name.slice(0, 1))}</div>`;
      el.innerHTML = `
        <div class="ava">${avatar}</div>
        <div class="info">
          <div class="row1"><div class="name">${tag}${highlight(s.name, kw)}</div><div class="time">${fmtTime(s.last_time)}</div></div>
          <div class="summary">${highlight(sessionSummary(s), kw)}</div>
        </div>
        ${unreadHtml}`;
      el.addEventListener('click', () => {
        if (s.unread > 0) {
          s.unread = 0;
          const u = el.querySelector('.unread');
          if (u) u.remove();
          updateUnreadBadge();
        }
        openChat(s.username, s.name, s.is_group);
      });
      frag.appendChild(el);
    });
    box.appendChild(frag);
  }

  // ---- 公众号聚合（仿微信"订阅号消息"）----
  // 主列表不平铺公众号，而是折叠成一张卡片；点进去是公众号子列表，可返回。
  function ghSessions() {
    return state.sessions.filter((s) => s.is_gh);
  }

  // 会话列表主视图：非公众号会话 + 一张「公众号」聚合卡（按最新公众号消息时间排序）
  function renderChatList() {
    if (state.ghView) return renderGhList();
    const box = $('sessionList');
    const normal = state.sessions.filter((s) => !s.is_gh);
    const ghs = ghSessions();
    $('listTitle').textContent = `最近会话 (${normal.length + (ghs.length ? 1 : 0)})`;
    renderSessions(normal);
    if (!ghs.length) return;
    // 聚合卡：未读求和、最新一条时间与摘要
    const unread = ghs.reduce((a, s) => a + (s.unread || 0), 0);
    const latest = ghs.reduce((a, s) => (s.last_time > a.last_time ? s : a), ghs[0]);
    const card = document.createElement('div');
    card.className = 'session gh-folder';
    card.innerHTML = `
      <div class="ava"><div class="emoji">📣</div></div>
      <div class="info">
        <div class="row1"><div class="name">公众号<span class="gh-count">${ghs.length}</span></div><div class="time">${fmtTime(latest.last_time)}</div></div>
        <div class="summary">${esc(latest.name)}：${esc(sessionSummary(latest))}</div>
      </div>
      ${unread > 0 ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}`;
    card.addEventListener('click', () => { state.ghView = true; renderChatList(); });
    // 插入到与其时间相称的位置（保持整体按时间倒序的观感）
    const items = [...box.querySelectorAll('.session')];
    const before = items.find((el) => {
      const s = state.sessions.find((x) => x.username === el.dataset.user);
      return s && s.last_time < latest.last_time;
    });
    if (before) box.insertBefore(card, before);
    else box.appendChild(card);
  }

  // 公众号子列表（带返回）
  function renderGhList() {
    const box = $('sessionList');
    const ghs = ghSessions();
    $('listTitle').textContent = `公众号 (${ghs.length})`;
    renderSessions(ghs);
    const back = document.createElement('div');
    back.className = 'list-back';
    back.innerHTML = '<span class="back-arrow">‹</span><span>返回最近会话</span>';
    back.addEventListener('click', () => { state.ghView = false; renderChatList(); });
    box.insertBefore(back, box.firstChild);
  }

  function updateUnreadBadge() {
    const total = state.sessions.reduce((a, s) => a + (s.unread || 0), 0);
    const badge = document.querySelector('.tab .badge');
    if (badge) {
      badge.style.display = total ? 'block' : 'none';
      badge.textContent = total > 99 ? '99+' : total;
    }
  }

  // ---- 聊天渲染 ----
  let chatContainer = null;
  function ensureChat() {
    if (chatContainer) return chatContainer;
    chatContainer = document.createElement('div');
    chatContainer.className = 'chat-messages';
    $('chatBody').appendChild(chatContainer);
    bindChatDelegation(chatContainer);   // 消息交互走事件委托（见 bindChatDelegation）
    return chatContainer;
  }

  // ---- 图片懒加载：进入视口后经引擎解密本地 .dat 并显示 ----
  const imgCache = new Map();   // `session|ts|hash` -> dataURL
  let imgObserver = null;
  function getImgObserver() {
    if (!imgObserver) {
      imgObserver = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const el = en.target;
          imgObserver.unobserve(el);        // 仅触发一次，减少回调压力
          if (el.classList.contains('emoji-sticker')) loadSticker(el);
          else loadImg(el);
        });
      }, { root: $('chatBody'), rootMargin: '400px 0px' });
    }
    return imgObserver;
  }
  async function loadImg(el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    const ts = el.dataset.ts, hash = el.dataset.hash;
    const key = `${state.active}|${ts}|${hash}`;
    if (imgCache.has(key)) {
      setImg(el, imgCache.get(key));
      return;
    }
    if (!hash || !state.active) { el.classList.add('miss'); return; }
    try {
      const res = await window.wememo.getImage(state.active, Number(ts) || 0, hash);
      if (res && res.url) {
        imgCache.set(key, res.url);
        setImg(el, res.url);
      } else {
        el.classList.add('miss');   // 本地无对应文件，保留占位
      }
    } catch (e) {
      el.classList.add('miss');
    }
  }
  // 表情 sticker：直接用 cdnurl（http/https，CSP 允许）
  function loadSticker(el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    const src = el.dataset.src;
    if (!src) { el.classList.add('miss'); return; }
    const img = new Image();
    img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.classList.add('shown'); };
    img.onerror = () => el.classList.add('miss');
    img.src = src;
  }
  function setImg(el, url) {
    const img = document.createElement('img');
    img.src = url;
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      // 放大时优先取本地高清版（_h.dat，可达缩略图的数十倍分辨率）；
      // 没有高清就沿用已显示的缩略图
      openLightbox(url, el.dataset.ts, el.dataset.hash);
    });
    el.innerHTML = '';
    el.appendChild(img);
    el.classList.add('shown');
  }

  // ---- 图片灯箱（点击放大；异步换高清） ----
  let lightbox = null;
  const hdCache = new Map();     // `session|ts|hash` -> 高清 dataURL（或 '' 表示无）
  function ensureLightbox() {
    if (!lightbox) {
      lightbox = document.createElement('div');
      lightbox.className = 'lightbox';
      lightbox.innerHTML = '<img /><div class="lb-hint" id="lbHint"></div>';
      lightbox.addEventListener('click', () => lightbox.classList.remove('show'));
      document.body.appendChild(lightbox);
    }
    return lightbox;
  }
  async function openLightbox(url, ts, hash) {
    const lb = ensureLightbox();
    const img = lb.querySelector('img');
    const hint = lb.querySelector('.lb-hint');
    img.src = url;                       // 先显示缩略图，避免等待
    hint.textContent = '';
    hint.className = 'lb-hint';
    lb.classList.add('show');
    if (!hash || !state.active) return;
    const key = `${state.active}|${ts}|${hash}`;
    if (hdCache.has(key)) { applyHd(lb, img, hint, url, hdCache.get(key)); return; }
    hint.textContent = '正在载入原图…';
    const opened = state.active;
    let res;
    try {
      res = await window.wememo.getOriginalImage(state.active, Number(ts) || 0, hash);
    } catch (e) { hint.textContent = ''; return; }
    if (!lb.classList.contains('show') || opened !== state.active) return;
    // res = { url, kind: 'wxgf'|'image'|'none', width, height }
    let hd = '';
    if (res && res.kind === 'wxgf' && res.url && window.WeMemoWxgf) {
      hint.textContent = '正在解码原图…';   // 微信原图是 HEVC 单帧，走 WebCodecs 客户端解码
      try { hd = await window.WeMemoWxgf.decodeDataUrl(res.url, { key }) || ''; } catch (e) { hd = ''; }
      if (!lb.classList.contains('show') || opened !== state.active) return;
    } else if (res && res.kind === 'image' && res.url) {
      hd = res.url;
    }
    const record = { hd, kind: (res && res.kind) || 'none' };
    hdCache.set(key, record);
    applyHd(lb, img, hint, url, record);
  }

  // 根据原图获取结果更新灯箱：有原图则替换，无则如实提示（不伪造）
  function applyHd(lb, img, hint, thumbUrl, record) {
    if (!lb.classList.contains('show')) return;
    if (record.hd && record.hd.length > thumbUrl.length * 1.1) {
      img.src = record.hd;
      hint.textContent = '原图';
      hint.className = 'lb-hint';
      setTimeout(() => { if (hint.textContent === '原图') hint.textContent = ''; }, 1200);
    } else if (record.kind === 'wxgf' && !record.hd) {
      // 原图在本地但客户端 HEVC 解码不可用（缺平台解码器）
      hint.textContent = '原图无法解码，已显示缩略图';
      hint.className = 'lb-hint warn';
    } else if (record.kind === 'none') {
      // 微信只在本地留了缩略图，原图尚未下载。无法替用户去微信点开（微信不支持按消息寻址），
      // 但一旦你在微信里点开原图，来「我 → 数据同步」即可把它同步进来。
      hint.textContent = '仅缩略图 · 在微信中点开原图后，可在「我 → 数据同步」获取';
      hint.className = 'lb-hint warn';
    } else {
      hint.textContent = '';
    }
  }
  // Esc：优先关灯箱，其次关导出对话框（导出进行中不关）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (lightbox && lightbox.classList.contains('show')) {
      lightbox.classList.remove('show');
      return;
    }
    const modal = $('exportModal');
    if (modal && modal.style.display === 'flex') closeExportModal();
  });

  function buildDivider(ts) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="bubble">${fmtFull(ts)}</div>`;
    return div;
  }

  // 消息数据表：uid → 消息对象（事件委托时按 data-uid 反查，避免每条消息挂监听器；
  // 大会话（数万条）下可省下数万个监听器与闭包）
  const msgById = new Map();

  function buildMsg(m) {
    const isSystem = m.type === 'system';
    const el = document.createElement('div');
    el.className = `msg ${isSystem ? 'system' : (m.is_me ? 'me' : 'you')}`;
    el.title = fmtFull(m.ts);   // hover 显示完整时间
    const uid = m.uid || `${m.ts}:${m.id}`;
    el.dataset.uid = uid;
    el.dataset.ts = m.ts;       // 搜索跳转定位用（uid 由 server_id 决定，前端不可预知）
    el.dataset.mid = m.id == null ? '' : m.id;
    msgById.set(uid, m);
    const content = renderContent(m);
    if (isSystem) {
      el.innerHTML = `<div class="bubble">${content}</div>`;
    } else {
      const senderHtml = (!m.is_me && m.sender) ? `<div class="sender">${esc(m.sender)}</div>` : '';
      let avaHtml;
      if (m.is_me) {
        avaHtml = '<div class="emoji">我</div>';
      } else if (m.sender_avatar) {
        avaHtml = `<img src="${esc(m.sender_avatar)}" loading="lazy" onerror="this.style.display='none';this.parentNode.textContent='👤'" />`;
      } else {
        avaHtml = '<div class="emoji">👤</div>';
      }
      el.innerHTML = `
        <div class="mava">${avaHtml}</div>
        <div><div class="content-block">${senderHtml}<div class="bubble">${content}</div></div></div>`;
    }
    return el;
  }

  // 事件委托：整个消息容器只挂 2 个监听器
  function bindChatDelegation(wrap) {
    if (wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    wrap.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.msg[data-uid]');
      if (!el) return;
      const m = msgById.get(el.dataset.uid);
      if (!m) return;
      e.preventDefault();
      showCtxMenu(e, m);
    });
    wrap.addEventListener('click', (e) => {
      // 链接/小程序卡片：打开外部浏览器
      const openable = e.target.closest('[data-url]');
      if (openable) {
        e.stopPropagation();
        const url = openable.getAttribute('data-url');
        if (url && window.wememo.openExternal) window.wememo.openExternal(url);
        return;
      }
      // 图片/表情有自身点击行为（灯箱），不复制
      if (e.target.closest('.img-ph, .emoji-sticker')) return;
      const bubble = e.target.closest('.bubble');
      if (!bubble) return;
      const el = bubble.closest('.msg[data-uid]');
      const m = el && msgById.get(el.dataset.uid);
      if (!m) return;
      e.stopPropagation();
      copyText(plainContent(m));
    });
  }

  function renderMessages(msgs, prepend, keepView) {
    if (!msgs.length) return 0;
    const wrap = ensureChat();
    const frag = document.createDocumentFragment();
    // 向上翻页从已渲染的最早一天续，向下补充从最新一天续（否则会重复插入日期分隔线）
    let prevDay = prepend ? state.oldestDay : (keepView ? state.newestDay : null);
    let firstDay = null;
    let lastDay = null;
    let added = 0;
    msgs.forEach((m) => {
      const uid = m.uid || `${m.ts}:${m.id}`;
      if (state.seenIds.has(uid)) return;      // 翻页去重（uid 全局唯一）
      state.seenIds.add(uid);
      const day = dayOf(m.ts);
      if (day !== prevDay) frag.appendChild(buildDivider(m.ts));  // 跨天时间线
      prevDay = day;
      if (firstDay === null) firstDay = day;
      lastDay = day;
      frag.appendChild(buildMsg(m));
      added += 1;
    });
    if (!frag.childNodes.length) return 0;
    const body = $('chatBody');
    if (prepend) {
      // 批量加载（loadAllMessages）时跳过逐轮滚动锚定：每轮读 scrollHeight 会对不断
      // 增长的列表强制同步布局，累积成近似二次的开销；改由批量结束后统一锚定一次
      if (state.bulk) {
        wrap.prepend(frag);
      } else {
        const prevScrollH = body.scrollHeight;
        wrap.prepend(frag);
        body.scrollTop += body.scrollHeight - prevScrollH;   // 保持可视位置
      }
      if (firstDay) state.oldestDay = firstDay;
    } else {
      wrap.appendChild(frag);
      // keepView：上下文视图向下补充时不跳到底部（普通首屏/新消息才置底）
      if (!keepView) body.scrollTop = body.scrollHeight;
      if (firstDay && !keepView) state.oldestDay = firstDay;
    }
    if (lastDay && !prepend) state.newestDay = lastDay;
    // 注册图片/表情懒加载（仅新增、未注册节点，避免重复 observe）
    // 批量加载时不逐轮注册，结束后统一注册（避免数万节点反复 querySelectorAll）
    if (state.bulk) return added;
    wrap.querySelectorAll('.img-ph:not([data-obs]), .emoji-sticker:not([data-obs])').forEach((el) => {
      el.dataset.obs = '1';
      getImgObserver().observe(el);
    });
    return added;
  }

  // ---- 定位到某条消息（搜索结果跳转）----
  // 与 openChat 的区别：不是从最新一条往上翻，而是取目标消息的前后窗口，
  // 因此需要同时支持"向上翻更早"与"向下翻更新"两个方向。
  async function openChatAt(username, name, isGroup, sortSeq, localId) {
    resetChatState(username, name, isGroup);
    const wrap = ensureChat();
    wrap.innerHTML = '<div class="chat-loading" id="firstLoading"><div class="spinner"></div></div>';
    const opened = username;
    let res = {};
    try {
      res = await window.wememo.getContext(username, sortSeq, localId, { before: 30, after: 30 });
    } catch (e) {
      showChatEmpty('定位失败');
      return;
    }
    if (state.active !== opened) return;
    const msgs = res.messages || [];
    if (!msgs.length) { showChatEmpty('未找到该消息'); return; }
    wrap.innerHTML = '';
    state.contextMode = true;
    state.allNewerLoaded = false;
    renderMessages(msgs, false);
    state.loaded = msgs.length;
    const oldest = msgs[0];
    const newest = msgs[msgs.length - 1];
    state.beforeSeq = oldest.ts;
    state.beforeId = oldest.id;
    state.afterSeq = newest.ts;
    state.afterId = newest.id;
    // 高亮并滚动到目标消息（用 uid 无法预知，按 (ts,id) 匹配 DOM）
    const target = [...wrap.querySelectorAll('.msg[data-uid]')].find((el) =>
      Number(el.dataset.ts) === Number(sortSeq) && Number(el.dataset.mid) === Number(localId));
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    }
    showContextBar();
    window.wememo.getMsgCount(username).then((n) => {
      if (state.active !== username) return;
      state.total = n;
      updateChatMeta();
    }).catch(() => {});
  }

  // 上下文视图提示条：告知只显示了片段，可一键回到最新
  function showContextBar() {
    let bar = $('ctxBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ctxBar';
      bar.className = 'ctx-bar';
      bar.innerHTML = '<span>已定位到该消息（上下文片段）</span><b id="ctxBarBack">回到最新</b>';
      $('chatBody').parentNode.insertBefore(bar, $('chatBody'));
      $('ctxBarBack').addEventListener('click', () => {
        const u = state.active;
        const nm = $('chatName').textContent;
        if (u) openChat(u, nm, state.isGroup);
      });
    }
    bar.style.display = 'flex';
  }
  function hideContextBar() {
    const bar = $('ctxBar');
    if (bar) bar.style.display = 'none';
  }

  // 向下补充更新的消息（仅上下文视图需要；普通视图首屏即最新）
  async function loadNewer(pageSize = PAGE) {
    if (!state.contextMode || !state.active || state.loadingMsgs || state.allNewerLoaded) return 0;
    state.loadingMsgs = true;
    const opened = state.active;
    let added = 0;
    try {
      const res = await window.wememo.getMessagesAfter(
        state.active, state.afterSeq, state.afterId, pageSize);
      if (opened !== state.active) return 0;
      const msgs = res.messages || [];
      if (!msgs.length) {
        state.allNewerLoaded = true;
        hideContextBar();                 // 已接到最新一条，片段提示无意义
      } else {
        const body = $('chatBody');
        const keepTop = body.scrollTop;
        added = renderMessages(msgs, false, true);
        body.scrollTop = keepTop;         // 向下追加不改变当前视口
        state.loaded += added;
        const newest = msgs[msgs.length - 1];
        state.afterSeq = newest.ts;
        state.afterId = newest.id;
      }
      updateChatMeta();
    } catch (e) { /* 静默 */ } finally {
      state.loadingMsgs = false;
    }
    return added;
  }

  // ---- 打开会话 ----
  function resetChatState(username, name, isGroup) {
    state.active = username;
    state.beforeSeq = null;
    state.beforeId = null;
    state.afterSeq = null;
    state.afterId = null;
    state.allLoaded = false;
    state.allNewerLoaded = true;
    state.contextMode = false;
    state.seenIds.clear();
    msgById.clear();          // 释放上一个会话的消息数据（事件委托反查表）
    state.oldestDay = null;
    state.newestDay = null;
    state.total = 0;
    state.loaded = 0;
    state.isGroup = !!isGroup;
    document.querySelectorAll('.session').forEach((el) =>
      el.classList.toggle('active', el.dataset.user === username));
    $('chatName').textContent = name || '';
    $('chatMeta').textContent = isGroup ? '群聊' : '';
    $('chatEmpty').style.display = 'none';   // 进入会话隐藏空态占位
    $('btnToBottom').style.display = 'none';
    $('headActions').style.display = 'flex'; // 会话内显示「全部 / 导出」
    hideTopLoading();                        // 清除可能残留的翻页 loading
    hideContextBar();
    closeFind();                             // 切换会话关闭查找条（跳转定位会随后恢复）
  }

  async function openChat(username, name, isGroup) {
    resetChatState(username, name, isGroup);
    const wrap = ensureChat();
    wrap.innerHTML = '<div class="chat-loading" id="firstLoading"><div class="spinner"></div></div>';
    await loadMore(false);
    // 消息总数（异步，不阻塞首屏）→ 头部显示"已载 N / 共 M 条"
    window.wememo.getMsgCount(username).then((n) => {
      if (state.active !== username) return;
      state.total = n;
      updateChatMeta();
    }).catch(() => {});
  }

  function updateChatMeta() {
    const parts = [];
    if (state.isGroup) parts.push('群聊');
    if (state.total) {
      parts.push(state.allLoaded ? `共 ${state.total} 条`
        : `已载 ${state.loaded} / ${state.total} 条`);
    }
    $('chatMeta').textContent = parts.join(' · ');
  }

  const PAGE = 30;

  async function loadMore(prepend = true, pageSize = PAGE) {
    if (!state.active || state.loadingMsgs || state.allLoaded) return 0;
    state.loadingMsgs = true;
    const opened = state.active;             // 记录本次请求所属会话，防竞态串档
    if (prepend) showTopLoading(true);
    let added = 0;
    try {
      // 复合游标：sort_seq 不唯一（同毫秒可有上百条），必须带 local_id 一起翻页
      const opts = state.beforeSeq
        ? { before_seq: state.beforeSeq, before_id: state.beforeId }
        : {};
      const res = await window.wememo.getMessages(state.active, { limit: pageSize, ...opts });
      // 请求返回时会话已切换 → 丢弃结果，避免把旧会话消息渲染到新会话
      if (opened !== state.active) return 0;
      const msgs = res.messages || [];
      if (prepend) {
        hideTopLoading();                    // 翻页 loading 用完即移除（成功/空都移除）
      } else {
        ensureChat().innerHTML = '';         // 首屏 spinner 清除，再渲染
      }
      if (msgs.length) {
        const oldest = msgs[0];              // 引擎返回旧→新
        const noAdvance = state.beforeSeq === oldest.ts && state.beforeId === oldest.id;
        state.beforeSeq = oldest.ts;
        state.beforeId = oldest.id;
        added = renderMessages(msgs, prepend);
        state.loaded += added;
        // 只有"游标不再推进"才算到底；"页不满"不能作为依据（跨分片去重会使页变短）
        if (noAdvance) state.allLoaded = true;
      } else {
        state.allLoaded = true;              // 空页 = 已到最早
        if (!prepend) showChatEmpty('这里还没有消息');
      }
      updateChatMeta();
    } catch (e) {
      if (prepend) {
        hideTopLoading();
      } else if (opened === state.active) {
        showChatEmpty('消息加载失败');
      }
    } finally {
      state.loadingMsgs = false;
    }
    return added;
  }

  // 加载全部：循环翻页至最早。用大页减少往返；进度写入头部 meta，视口锚定不跳动
  async function loadAllMessages() {
    if (!state.active) return;
    if (state.allLoaded) { toast('已是全部消息'); return; }
    const btn = $('btnLoadAll');
    btn.classList.add('busy');
    const opened = state.active;
    const body = $('chatBody');
    const keepFromBottom = body.scrollHeight - body.scrollTop;
    const BIG = 300;                       // 大页：15k 条约 50 次往返
    // 安全上限：按总数推算所需轮次并留 3 倍余量（异常情况下也不会死循环）
    const maxRounds = Math.max(20, Math.ceil((state.total || 5000) / BIG) * 3);
    let rounds = 0;
    state.bulk = true;                     // 批量模式：跳过逐轮锚定与懒加载注册
    try {
      while (!state.allLoaded && opened === state.active && rounds < maxRounds) {
        // 等待上一次请求结束（loadMore 自身有并发锁）
        while (state.loadingMsgs) await new Promise((r) => setTimeout(r, 20));
        if (state.allLoaded || opened !== state.active) break;
        await loadMore(true, BIG);
        rounds += 1;
        await new Promise((r) => setTimeout(r, 0));   // 让出主线程，界面保持响应
      }
    } finally {
      state.bulk = false;
      btn.classList.remove('busy');
    }
    // 上下文片段视图：向上取完后还要把更新的部分补齐，否则"全部"名不副实
    if (state.contextMode && opened === state.active) {
      let r2 = 0;
      while (!state.allNewerLoaded && opened === state.active && r2 < maxRounds) {
        while (state.loadingMsgs) await new Promise((r) => setTimeout(r, 20));
        if (state.allNewerLoaded || opened !== state.active) break;
        await loadNewer(BIG);
        r2 += 1;
      }
      state.contextMode = false;
      hideContextBar();
    }
    if (opened === state.active) {
      body.scrollTop = body.scrollHeight - keepFromBottom;   // 视口锚定不跳动
      // 统一注册懒加载（批量期间跳过）
      const wrap = ensureChat();
      wrap.querySelectorAll('.img-ph:not([data-obs]), .emoji-sticker:not([data-obs])').forEach((el) => {
        el.dataset.obs = '1';
        getImgObserver().observe(el);
      });
      toast(state.allLoaded ? `已加载全部 ${state.loaded} 条` : `已加载 ${state.loaded} 条`);
    }
  }

  // 会话内空/失败提示（占据消息容器，不复用左侧全局空态）
  function showChatEmpty(text) {
    ensureChat().innerHTML = `<div class="chat-loading">${esc(text)}</div>`;
  }

  let topLoadingEl = null;
  function showTopLoading(prepend) {
    if (!prepend) return;
    if (!topLoadingEl) {
      topLoadingEl = document.createElement('div');
      topLoadingEl.className = 'loadmore';
      topLoadingEl.innerHTML = '<div class="spinner small"></div><span>加载更早消息…</span>';
    }
    ensureChat().prepend(topLoadingEl);
  }
  function hideTopLoading() {
    if (topLoadingEl && topLoadingEl.parentNode) topLoadingEl.parentNode.removeChild(topLoadingEl);
  }

  // ---- 搜索：会话名 + 全库聊天记录内容 ----
  // 内容检索需引擎解码全库（本地库不存明文），首次约数秒并建索引，之后为内存过滤。
  let searchTimer = null;
  let searchSeq = 0;              // 请求序号：只接受最后一次输入的结果
  let searchGroups = [];          // 当前搜索的分组结果（展开更多时复用）
  let searchKw = '';

  function bindSearchResults(box) {
    box.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => {
        const seq = el.dataset.seq ? Number(el.dataset.seq) : 0;
        const id = el.dataset.id ? Number(el.dataset.id) : null;
        if (seq) openChatAt(el.dataset.open, el.dataset.name, el.dataset.group === '1', seq, id);
        else openChat(el.dataset.open, el.dataset.name, el.dataset.group === '1');
      });
    });
    box.querySelectorAll('[data-more]').forEach((el) => {
      el.addEventListener('click', () => {
        const gi = Number(el.dataset.more);
        const g = searchGroups[gi];
        const host = el.closest('.hit-group');
        if (!g || !host) return;
        host.innerHTML = R.renderGroupHits(g, searchKw, { fmtTime });
        bindSearchResults(host);
      });
    });
  }

  async function runSearch(kw) {
    const my = ++searchSeq;
    searchKw = kw;
    const box = $('sessionList');
    $('listTitle').textContent = '搜索中…';
    let names = { sessions: [] };
    try {
      names = await window.wememo.search(kw);
    } catch (e) { /* 忽略 */ }
    if (my !== searchSeq) return;
    // 先出会话名结果（快），再等内容检索（慢）
    box.innerHTML = R.renderSearchResults({ keyword: kw, groups: [], total: 0 },
      { sessions: names.sessions || [], fmtTime })
      + '<div class="hit-note"><div class="spinner small"></div>正在检索聊天记录…</div>';
    bindSearchResults(box);
    let res = { groups: [], total: 0, keyword: kw };
    try {
      res = await window.wememo.searchMessages(kw);
    } catch (e) {
      res = { groups: [], total: 0, keyword: kw, failed: true };
    }
    if (my !== searchSeq) return;
    searchGroups = res.groups || [];
    box.innerHTML = R.renderSearchResults(res, { sessions: names.sessions || [], fmtTime })
      + (res.failed ? '<div class="hit-note">聊天记录检索失败</div>' : '');
    bindSearchResults(box);
    const n = (names.sessions || []).length + (res.total || 0);
    $('listTitle').textContent = `搜索结果 (${R.fmtNum(n)})`;
  }

  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const kw = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (!kw) {
        searchSeq += 1;          // 作废在途请求
        searchGroups = [];
        renderChatList();
        return;
      }
      runSearch(kw);
    }, 250);
  });

  // ---- 加载更多（滚动到顶部触发上一页）----
  // rAF 节流：滚动事件高频触发，合并到下一帧统一读取布局，避免强制回流抖动
  let scrollScheduled = false;
  $('chatBody').addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      const body = $('chatBody');
      // 发现/我：报告页无消息分页，只需更新页内导航高亮
      if (panelNav.items) { syncPanelNav(); return; }
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
      $('btnToBottom').style.display = (nearBottom || !state.active) ? 'none' : 'flex';
      if (body.scrollTop < 60) loadMore(true);
      // 上下文片段视图：向下滚到底部时补充更新的消息（普通视图底部已是最新）
      if (nearBottom && state.contextMode) loadNewer();
    });
  }, { passive: true });

  // ---- 回到底部 ----
  $('btnToBottom').addEventListener('click', () => {
    // 上下文片段视图下"底部"并非最新一条：重新以最新一条打开会话
    if (state.contextMode && !state.allNewerLoaded && state.active) {
      openChat(state.active, $('chatName').textContent, state.isGroup);
      return;
    }
    $('chatBody').scrollTop = $('chatBody').scrollHeight;
  });

  // ---- 加载全部 ----
  $('btnLoadAll').addEventListener('click', loadAllMessages);

  // ---- 会话内查找（Ctrl+F）----
  // 与全局搜索共用引擎索引，但只搜当前会话；命中列表在本地维护，可上下逐条跳转。
  const find = { open: false, kw: '', hits: [], at: -1, total: 0, running: false };

  function openFind() {
    if (!state.active) { toast('请先选择一个会话'); return; }
    find.open = true;
    $('findBar').style.display = 'flex';
    $('findInput').focus();
    $('findInput').select();
  }
  function closeFind() {
    find.open = false;
    find.hits = [];
    find.at = -1;
    $('findBar').style.display = 'none';
    $('findCount').textContent = '';
  }
  function updateFindCount(text) {
    if (text !== undefined) { $('findCount').textContent = text; return; }
    if (!find.hits.length) { $('findCount').textContent = '无结果'; return; }
    // 引擎单会话最多回传 500 条命中，超出时加 "+" 表示还有更多
    const capped = find.total > find.hits.length ? '+' : '';
    $('findCount').textContent = `${find.at + 1}/${find.hits.length}${capped}`;
    $('findCount').title = capped ? `共 ${find.total} 条命中，仅可跳转最近 ${find.hits.length} 条` : '';
  }

  async function runFind(kw) {
    find.kw = kw;
    find.hits = [];
    find.at = -1;
    if (!kw || !state.active) { updateFindCount(''); return; }
    updateFindCount('查找中…');
    const opened = state.active;
    let res = {};
    try {
      res = await window.wememo.searchMessages(kw, { session: state.active, perSession: 500 });
    } catch (e) {
      updateFindCount('查找失败');
      return;
    }
    if (opened !== state.active || find.kw !== kw) return;
    const g = (res.groups || [])[0];
    find.total = g ? g.count : 0;
    find.hits = g ? g.hits.slice().reverse() : [];   // 旧→新，跳转顺序与阅读顺序一致
    if (!find.hits.length) { updateFindCount('无结果'); return; }
    find.at = find.hits.length - 1;                  // 从最近一条命中开始
    await gotoFindHit(0);
  }

  async function gotoFindHit(delta) {
    if (!find.hits.length) return;
    if (delta) {
      find.at = (find.at + delta + find.hits.length) % find.hits.length;
    }
    const h = find.hits[find.at];
    updateFindCount();
    // 命中可能不在已渲染范围内 → 走上下文定位（保持查找条与关键词）
    const el = [...ensureChat().querySelectorAll('.msg[data-uid]')].find((x) =>
      Number(x.dataset.ts) === Number(h.sort_seq) && Number(x.dataset.mid) === Number(h.id));
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
      return;
    }
    const kw = find.kw;
    const hits = find.hits;
    const at = find.at;
    const total = find.total;
    await openChatAt(state.active, $('chatName').textContent, state.isGroup, h.sort_seq, h.id);
    // openChatAt 会重置聊天状态，但查找条应保持
    find.kw = kw;
    find.hits = hits;
    find.at = at;
    find.total = total;
    find.open = true;
    $('findBar').style.display = 'flex';
    updateFindCount();
  }

  let findTimer = null;
  $('btnFindInChat').addEventListener('click', openFind);
  $('findClose').addEventListener('click', closeFind);
  $('findPrev').addEventListener('click', () => gotoFindHit(-1));
  $('findNext').addEventListener('click', () => gotoFindHit(1));
  $('findInput').addEventListener('input', (e) => {
    clearTimeout(findTimer);
    const kw = e.target.value.trim();
    findTimer = setTimeout(() => runFind(kw), 300);
  });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoFindHit(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });

  // ---- 快捷键 ----
  document.addEventListener('keydown', (e) => {
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openFind(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {   // 全局搜索
      e.preventDefault();
      if (currentTab !== 'chat') switchTab('chat');
      $('searchInput').focus();
      $('searchInput').select();
      return;
    }
    if (e.key === 'Escape' && !inInput) {
      if (find.open) { closeFind(); return; }
      if ($('exportModal').style.display === 'flex') { closeExportModal(); return; }
    }
    if (inInput) return;
    // 会话列表上下切换（不打断输入）
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...document.querySelectorAll('#sessionList .session[data-user]')];
      if (!items.length) return;
      e.preventDefault();
      const i = items.findIndex((el) => el.classList.contains('active'));
      const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { next.click(); next.scrollIntoView({ block: 'nearest' }); }
    }
  });

  // ---- 导出 ----
  const exp = { fmt: 'html', scope: 'one', running: false };

  function openExportModal() {
    if (!state.active) { toast('请先选择一个会话'); return; }
    exp.scope = 'one';
    exp.running = false;
    $('exportSub').textContent = `当前会话：${$('chatName').textContent}` +
      (state.total ? `（共 ${state.total} 条）` : '');
    $('exportProgress').style.display = 'none';
    $('exportBar').style.width = '0%';
    $('exportGo').disabled = false;
    $('exportGo').textContent = '选择目录并导出';
    $('exportCancel').textContent = '取消';
    syncSeg('exportFmt', 'fmt', exp.fmt);
    syncSeg('exportScope', 'scope', exp.scope);
    $('exportModal').style.display = 'flex';
  }
  function closeExportModal() {
    if (exp.running) return;              // 导出中不允许关闭，避免误以为已取消
    $('exportModal').style.display = 'none';
  }
  function syncSeg(containerId, attr, value) {
    document.querySelectorAll(`#${containerId} .seg-item`).forEach((el) =>
      el.classList.toggle('active', el.dataset[attr] === value));
  }

  $('btnExport').addEventListener('click', openExportModal);
  $('exportCancel').addEventListener('click', closeExportModal);
  $('exportModal').addEventListener('click', (e) => {
    if (e.target === $('exportModal')) closeExportModal();
  });
  document.querySelectorAll('#exportFmt .seg-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (exp.running) return;
      exp.fmt = el.dataset.fmt; syncSeg('exportFmt', 'fmt', exp.fmt);
    });
  });
  document.querySelectorAll('#exportScope .seg-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (exp.running) return;
      exp.scope = el.dataset.scope; syncSeg('exportScope', 'scope', exp.scope);
    });
  });

  $('exportGo').addEventListener('click', async () => {
    if (exp.running) return;
    const all = exp.scope === 'all';
    exp.running = true;
    $('exportGo').disabled = true;
    $('exportGo').textContent = '导出中…';
    $('exportProgress').style.display = 'block';
    $('exportProgressText').textContent = '等待选择目录…';
    $('exportBar').style.width = '0%';
    try {
      const res = await window.wememo.exportChat({
        all, format: exp.fmt, username: state.active,
      });
      exp.running = false;
      if (res && res.canceled) {                       // 用户取消目录选择
        $('exportProgress').style.display = 'none';
        $('exportGo').disabled = false;
        $('exportGo').textContent = '选择目录并导出';
        return;
      }
      if (!res || !res.ok) {
        $('exportProgressText').textContent = `导出失败：${(res && res.error) || '未知错误'}`;
        $('exportGo').disabled = false;
        $('exportGo').textContent = '重试';
        return;
      }
      // 成功：展示结果并提供「打开所在文件夹」
      $('exportBar').style.width = '100%';
      const target = all ? res.dir : res.path;
      $('exportProgressText').textContent = all
        ? `已导出 ${res.sessions} 个会话、${res.messages} 条消息`
        : `已导出 ${res.count} 条消息`;
      $('exportGo').disabled = false;
      $('exportGo').textContent = '打开所在文件夹';
      $('exportGo').onclick = () => {
        window.wememo.revealPath(target);
        $('exportGo').onclick = null;
        closeExportModal();
      };
      $('exportCancel').textContent = '完成';
      toast(all ? `导出完成：${res.sessions} 个会话` : '导出完成');
    } catch (e) {
      exp.running = false;
      $('exportProgressText').textContent = '导出失败';
      $('exportGo').disabled = false;
      $('exportGo').textContent = '重试';
    }
  });

  // 导出进度事件（引擎推送）
  if (window.wememo.onEvent) {
    window.wememo.onEvent((ev, data) => {
      if (ev !== 'export' || !data || !exp.running) return;
      const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
      $('exportBar').style.width = `${Math.min(pct, 99)}%`;
      $('exportProgressText').textContent = data.scope === 'all'
        ? `(${data.done}/${data.total}) ${data.name || ''}`
        : `已写入 ${data.done} / ${data.total} 条`;
    });
  }

  // ---- 初始化 ----
  // 主导航四个 Tab 的顺序（tabbar 索引 → tab 名），高亮与点击共用同一份定义，
  // 避免两处各写一遍索引映射（历史 bug：高亮用了错位的 indexOf，除「聊天」外全不亮）
  const TABS = ['chat', 'contacts', 'discover', 'me'];
  let currentTab = 'chat';

  function switchTab(tab) {
    currentTab = tab;
    closeFind();                              // 查找条属于会话，切换 Tab 一并关闭
    clearPanelNav();                          // 离开报告页，停止页内滚动追踪
    document.querySelectorAll('.tabbar .tab').forEach((el, i) => {
      el.classList.toggle('active', TABS[i] === tab);
    });
    const titles = { chat: `最近会话 (${state.sessions.length})`, contacts: '通讯录', discover: '发现', me: '我' };
    $('listTitle').textContent = titles[tab];
    $('sessionList').innerHTML = '';
    if (tab === 'chat') {
      renderChatList();
      document.querySelector('.search-box').style.display = '';   // 连同搜索图标一起显示
      $('chatName').textContent = '微忆';
      $('chatMeta').textContent = '';
      resetChat();
    } else {
      // 非会话 Tab：清除聊天区活动状态与浮钮，避免残留
      state.active = null;
      state.seenIds.clear();
      msgById.clear();
      state.oldestDay = null;
      state.newestDay = null;
      state.beforeSeq = null;
      state.beforeId = null;
      state.afterSeq = null;
      state.afterId = null;
      state.allLoaded = false;
      state.allNewerLoaded = true;
      state.contextMode = false;
      state.total = 0;
      state.loaded = 0;
      state.ghView = false;
      hideTopLoading();
      hideContextBar();
      $('btnToBottom').style.display = 'none';
      $('headActions').style.display = 'none';
      document.querySelector('.search-box').style.display = 'none';  // 图标+输入框整体隐藏
      if (tab === 'contacts') loadContacts();
      else if (tab === 'discover') renderDiscover();
      else renderMe();
    }
  }

  function resetChat() {
    const wrap = ensureChat();
    wrap.innerHTML = '';
    $('chatEmpty').style.display = 'flex';
    $('chatName').textContent = '微忆';
    $('chatMeta').textContent = '';
    $('btnToBottom').style.display = 'none';
    $('headActions').style.display = 'none';
    state.active = null;
    state.seenIds.clear();
    msgById.clear();
    state.oldestDay = null;
    state.newestDay = null;
    state.beforeSeq = null;
    state.beforeId = null;
    state.afterSeq = null;
    state.afterId = null;
    state.allLoaded = false;
    state.allNewerLoaded = true;
    state.contextMode = false;
    state.total = 0;
    state.loaded = 0;
    hideTopLoading();
    hideContextBar();
  }

  // ---- 通讯录（带过滤：非好友 / 无记录）----
  // contact 库含大量群成员与陌生人（本机 6071 条中 5373 条），默认隐藏，
  // 需要时可通过顶部开关显示；"无记录"指本地没有该会话的聊天记录。
  const contactFilter = { showNonFriend: false, showNoRecord: false };
  let contactsCache = null;

  function applyContactFilter(items) {
    return items.filter((it) => {
      if (!contactFilter.showNonFriend && !it.friend) return false;
      if (!contactFilter.showNoRecord && !it.has_record) return false;
      return true;
    });
  }

  function renderContacts() {
    const box = $('sessionList');
    const c = contactsCache || { friends: [], groups: [], ghs: [] };
    const f = applyContactFilter(c.friends);
    const g = applyContactFilter(c.groups);
    const h = applyContactFilter(c.ghs);
    const hiddenNonFriend = c.friends.filter((x) => !x.friend).length
      + c.ghs.filter((x) => !x.friend).length;
    const hiddenNoRecord = [...c.friends, ...c.groups, ...c.ghs].filter((x) => !x.has_record).length;
    const chip = (key, label, n) =>
      `<div class="chip${contactFilter[key] ? ' on' : ''}" data-key="${key}">${label}${n ? ` <b>${n}</b>` : ''}</div>`;
    const bar = `<div class="filter-bar">
        <span class="filter-label">显示</span>
        ${chip('showNonFriend', '非好友', hiddenNonFriend)}
        ${chip('showNoRecord', '无记录', hiddenNoRecord)}
      </div>`;
    const sec = (title, items) => {
      if (!items.length) return '';
      let s = `<div class="sidebar-title">${title} (${items.length})</div>`;
      items.forEach((it) => {
        const badge = !it.has_record ? '<span class="c-badge">无记录</span>'
          : (!it.friend ? '<span class="c-badge">非好友</span>' : '');
        s += `<div class="session" data-contact="${esc(it.username)}">
          <div class="ava">${it.avatar ? `<img src="${esc(it.avatar)}" loading="lazy" onerror="this.style.display='none';this.parentNode.textContent='👤'" />` : '<div class="emoji">👤</div>'}</div>
          <div class="info"><div class="name">${esc(it.name)}${badge}</div></div>
        </div>`;
      });
      return s;
    };
    const body = sec('好友', f) + sec('群聊', g) + sec('公众号', h);
    box.innerHTML = bar + (body || '<div class="list-empty">没有符合条件的联系人</div>');
    $('listTitle').textContent = `通讯录 (${f.length + g.length + h.length})`;
    box.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        contactFilter[el.dataset.key] = !contactFilter[el.dataset.key];
        renderContacts();
      });
    });
    box.querySelectorAll('[data-contact]').forEach((el) => {
      el.addEventListener('click', () => {
        const nameEl = el.querySelector('.name');
        const badge = nameEl.querySelector('.c-badge');
        const name = badge ? nameEl.textContent.replace(badge.textContent, '') : nameEl.textContent;
        openChat(el.dataset.contact, name.trim(), el.dataset.contact.includes('@chatroom'));
      });
    });
  }

  async function loadContacts() {
    const box = $('sessionList');
    box.innerHTML = '<div style="padding:30px;text-align:center"><div class="spinner"></div></div>';
    try {
      if (!contactsCache) {
        contactsCache = await window.wememo.getContacts() || { friends: [], groups: [], ghs: [] };
      }
      renderContacts();
    } catch (e) {
      box.innerHTML = '<div class="list-empty">加载失败</div>';
    }
  }

  // ---- 发现页：数据报告（引擎一次聚合扫描，结果引擎侧缓存）----
  // 左栏为章节导航（点击滚动到对应面板），右栏为报告本体。
  // 导航高亮随右栏滚动实时追踪当前所在章节（scroll spy），而不是只在点击时切换。
  const panelNav = { items: null, panels: null, at: -1, byClick: 0 };

  function clearPanelNav() {
    panelNav.items = null;
    panelNav.panels = null;
    panelNav.at = -1;
  }

  // 判定"当前所在章节"：取判定线之上最后一个面板。判定线放在容器顶部下方 90px，
  // 这样面板标题刚滚到视口上沿时就点亮，符合"我正在看这一节"的直觉。
  function syncPanelNav() {
    const items = panelNav.items;
    const panels = panelNav.panels;
    if (!items || !panels || !panels.length) return;
    // 点击导航后的平滑滚动期间不反向覆盖高亮（否则会看到中途章节一路闪过）
    if (panelNav.byClick && Date.now() < panelNav.byClick) return;
    const body = $('chatBody');
    const line = body.getBoundingClientRect().top + 90;
    let idx = 0;
    for (let i = 0; i < panels.length; i += 1) {
      if (panels[i].getBoundingClientRect().top <= line) idx = i;
      else break;
    }
    // 滚到底部时强制选中最后一节：末尾面板可能太矮，永远越不过判定线
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 8) idx = panels.length - 1;
    if (idx === panelNav.at) return;
    panelNav.at = idx;
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
  }

  function buildPanelNav(box, wrap, items, extraHtml) {
    box.innerHTML = items.map((t, i) =>
      `<div class="nav-item${i === 0 ? ' active' : ''}" data-idx="${i}">${esc(t)}</div>`).join('')
      + (extraHtml || '');
    const panels = [...wrap.querySelectorAll('.panel, .stat-grid, .me-card')];
    const navItems = [...box.querySelectorAll('.nav-item[data-idx]')];
    panelNav.items = navItems;
    panelNav.panels = panels;
    panelNav.at = 0;
    panelNav.byClick = 0;
    navItems.forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.idx);
        navItems.forEach((x, j) => x.classList.toggle('active', j === i));
        panelNav.at = i;
        // 平滑滚动期间锁住高亮（约 600ms），滚动结束后交还给 scroll spy
        panelNav.byClick = Date.now() + 600;
        const p = panels[i];
        if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    syncPanelNav();
  }

  function openExportAll(count) {
    exp.scope = 'all';
    exp.running = false;
    $('exportSub').textContent = `全部 ${count} 个会话（逐个文件，耗时较长）`;
    $('exportProgress').style.display = 'none';
    $('exportBar').style.width = '0%';
    $('exportGo').disabled = false;
    $('exportGo').textContent = '选择目录并导出';
    $('exportCancel').textContent = '取消';
    syncSeg('exportFmt', 'fmt', exp.fmt);
    syncSeg('exportScope', 'scope', 'all');
    $('exportModal').style.display = 'flex';
  }

  let statsCache = null;

  async function renderDiscover(force = false) {
    const box = $('sessionList');
    const wrap = ensureChat();
    wrap.innerHTML = '';
    $('chatEmpty').style.display = 'none';
    $('chatName').textContent = '数据报告';
    $('chatMeta').textContent = '正在统计…';
    box.innerHTML = '<div style="padding:30px;text-align:center"><div class="spinner"></div>'
      + '<div class="hint-sm">首次统计需扫描全部消息</div></div>';
    let st;
    try {
      st = (force || !statsCache) ? await window.wememo.getStats(force) : statsCache;
    } catch (e) {
      box.innerHTML = '<div class="list-empty">统计失败</div>';
      $('chatMeta').textContent = '';
      return;
    }
    if (currentTab !== 'discover') return;      // 期间已切换 Tab，丢弃结果
    statsCache = st;
    const report = document.createElement('div');
    report.className = 'report';
    report.innerHTML = R.renderStatsReport(st);
    wrap.appendChild(report);
    $('chatMeta').textContent = `${R.fmtNum(st.msg_total)} 条消息 · ${R.fmtNum(st.session_count)} 个会话`;

    const navs = ['数据总览'];
    if (st.first_day) navs.push('时间跨度');
    if (st.direction_ok) navs.push('收发比例');
    if (st.months && st.months.length) navs.push('按月消息量');
    if (st.years && st.years.length > 1) navs.push('按年消息量');
    if (st.kinds && st.kinds.length) navs.push('消息类型分布');
    if (st.top_sessions && st.top_sessions.length) navs.push('聊得最多的会话');
    buildPanelNav(box, report, navs,
      '<div class="nav-sep"></div>'
      + '<div class="nav-item act" id="navExportAll">导出全部聊天记录</div>'
      + '<div class="nav-item act" id="navRefresh">重新统计</div>');
    $('navExportAll').addEventListener('click', () => openExportAll(st.session_count));
    $('navRefresh').addEventListener('click', () => renderDiscover(true));
    // 排行榜点击直达会话
    report.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => {
        switchTab('chat');
        openChat(el.dataset.open, el.dataset.name, el.dataset.group === '1');
      });
    });
  }

  // ---- 个人主页 ----
  let profileCache = null;
  let appInfoCache = null;

  async function renderMe() {
    const box = $('sessionList');
    const wrap = ensureChat();
    wrap.innerHTML = '';
    $('chatEmpty').style.display = 'none';
    $('chatName').textContent = '我';
    $('chatMeta').textContent = '';
    box.innerHTML = '<div style="padding:30px;text-align:center"><div class="spinner"></div></div>';
    let p = profileCache;
    let info = appInfoCache;
    try {
      if (!p) p = profileCache = await window.wememo.getProfile();
      if (!info && window.wememo.getAppInfo) info = appInfoCache = await window.wememo.getAppInfo();
    } catch (e) {
      box.innerHTML = '<div class="list-empty">加载失败</div>';
      return;
    }
    if (currentTab !== 'me') return;
    const view = document.createElement('div');
    view.className = 'report';
    view.innerHTML = R.renderProfile(p, info || {});
    wrap.appendChild(view);
    $('chatMeta').textContent = p.username || '';
    buildPanelNav(box, view, ['个人信息', '通讯录', '本地数据', '数据同步', '运行环境', '关于']);
    const openDir = (path) => () => window.wememo.openPath && window.wememo.openPath(path);
    if ($('btnOpenDb')) $('btnOpenDb').addEventListener('click', openDir(p.db_root));
    if ($('btnOpenAttach')) $('btnOpenAttach').addEventListener('click', openDir(p.attach_root));
    if ($('btnExportAllMe')) {
      $('btnExportAllMe').addEventListener('click',
        () => openExportAll(state.sessions.length));
    }
    initSyncPanel();
  }

  // ---- 数据同步（微信在线时增量重解密新消息）----
  // 状态由 syncStatus() 廉价轮询填充；后台定时自动同步，也可手动点「立即同步」。
  const sync = { running: false, lastStatus: null, auto: true, timer: 0 };
  try { sync.auto = localStorage.getItem('wememo.autoSync') !== '0'; } catch (e) { /* 默认开 */ }

  // 自动同步节律：每 45s 廉价探一次（只 stat，不解密）；仅当微信在线且确有变化时才重解密。
  // 45s 是「够live」与「别反复解密主库」的折中——微信活跃聊天时约每 45s 增量一次。
  const AUTO_SYNC_MS = 45000;

  function startAutoSync() {
    if (sync.timer) return;
    sync.timer = setInterval(autoSyncTick, AUTO_SYNC_MS);
    // 启动后稍等再探首轮，避开启动时的会话/统计加载高峰
    setTimeout(autoSyncTick, 4000);
  }

  async function autoSyncTick() {
    if (!sync.auto || sync.running) return;
    let st;
    try { st = await window.wememo.syncStatus(); } catch (e) { return; }
    if (currentTab === 'me') paintSyncStatus(st);
    // 只有微信在线且确有变化才自动重解密，避免无谓地反复解密主库
    if (st && st.stale && st.wechat_running) await runSync({ auto: true });
  }

  function fmtSyncTime(epoch) {
    if (!epoch) return '尚未同步';
    const d = new Date(epoch * 1000);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  function paintSyncStatus(st) {
    sync.lastStatus = st;
    const w = $('syncWechat'); const l = $('syncLast'); const s = $('syncState');
    if (!w || !l || !s) return;
    w.textContent = st.wechat_running ? '正在运行' : '未运行';
    w.className = st.wechat_running ? 'ok' : '';
    l.textContent = fmtSyncTime(st.last_sync);
    if (st.error) {
      s.textContent = '无法检查更新：' + st.error;
      s.className = 'sync-state';
    } else if (st.changed_count > 0) {
      s.textContent = sync.auto
        ? `检测到 ${st.changed_count} 个库有更新，正在自动同步…`
        : `检测到 ${st.changed_count} 个库有更新`;
      s.className = 'sync-state stale';
    } else {
      s.textContent = '已是最新，无需同步';
      s.className = 'sync-state fresh';
    }
    // 微信没开时给个温和提示（同步仍可点，只是通常无变化）
    if (!st.wechat_running && !st.changed_count && !st.error) {
      s.textContent = '已是最新（微信未运行，新消息需微信登录后才会写入本地库）';
    }
  }

  async function initSyncPanel() {
    const s = $('syncState');
    if (s) { s.textContent = '正在检查是否有新消息…'; s.className = 'sync-state'; }
    try {
      const st = await window.wememo.syncStatus();
      if (currentTab === 'me') paintSyncStatus(st);
    } catch (e) {
      if (s) s.textContent = '无法检查更新';
    }
    const btn = $('btnSyncNow');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => runSync());   // 不把 click 事件当 opts 传进去
    }
    const auto = $('syncAuto');
    if (auto) {
      auto.checked = sync.auto;                          // 反映持久化偏好（默认开）
      if (!auto.dataset.bound) {
        auto.dataset.bound = '1';
        auto.addEventListener('change', () => {
          sync.auto = auto.checked;
          try { localStorage.setItem('wememo.autoSync', auto.checked ? '1' : '0'); } catch (e) {}
          if (sync.auto) { startAutoSync(); autoSyncTick(); }
        });
      }
    }
  }

  async function runSync(opts) {
    const auto = !!(opts && opts.auto);
    if (sync.running) return;
    sync.running = true;
    const btn = $('btnSyncNow');
    const s = $('syncState');
    if (!auto && btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    if (!auto && s) { s.textContent = '正在读取并解密微信最新数据…'; s.className = 'sync-state'; }
    try {
      const r = await window.wememo.syncRun();
      if (!r || r.error) {
        if (!auto && s) s.textContent = '同步失败：' + ((r && r.error) || '未知错误');
      } else {
        const n = (r.changed || []).length;
        const sk = (r.skipped || []).length;
        if (!auto && s) {
          s.className = 'sync-state fresh';
          s.textContent = n > 0
            ? `已更新 ${n} 个库${sk ? `（${sk} 个跳过）` : ''}，用时 ${r.seconds}s`
            : '已是最新，无需更新';
        }
        if (n > 0) {
          toast(auto ? `自动同步了 ${n} 个库的新消息` : `已同步 ${n} 个库的新消息`);
          // 库已换新：清掉前端各类缓存，重取会话与统计
          statsCache = null; profileCache = null;
          contactsCache = null;
          imgCache.clear(); hdCache.clear();
          await refreshSessions();
        }
      }
      // 同步后刷新一次状态显示（仅在「我」页可见时绘制）
      try {
        const st = await window.wememo.syncStatus();
        if (currentTab === 'me') paintSyncStatus(st);
      } catch (e) { /* 忽略 */ }
    } catch (e) {
      if (!auto && s) s.textContent = '同步失败';
    } finally {
      sync.running = false;
      if (!auto && btn) btn.disabled = false;
    }
  }


  function buildTabbar() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    TABS.forEach((name, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (name === currentTab ? ' active' : '');
      el.title = { chat: '聊天', contacts: '通讯录', discover: '发现', me: '我' }[name];
      el.innerHTML = ICONS[name] + (i === 0 ? '<span class="badge" style="display:none"></span>' : '');
      el.addEventListener('click', () => switchTab(name));
      bar.appendChild(el);
    });
  }

  function buildBoot() {
    $('bootLogo').innerHTML = ICONS.logo;
    $('brandMark').innerHTML = ICONS.chat + '<span>微忆</span>';
    $('searchIcon').innerHTML = ICONS.search;
    $('emptyIcon').innerHTML = ICONS.empty;
  }

  async function refreshSessions() {
    try {
      const res = await window.wememo.listSessions();
      state.sessions = res.sessions || [];
      state.self = res.self || '';
      if (currentTab === 'chat') {
        renderChatList();
      }
      updateUnreadBadge();
      hideBoot();
    } catch (e) {
      showBootGuide({ reason: 'sessions_failed', detail: String((e && e.message) || e) });
    }
  }

  function hideBoot() {
    const b = $('boot');
    b.classList.add('hide');
    setTimeout(() => b.remove(), 450);
  }

  // 把启动失败的「原因码」翻译成用户照着能做的操作建议（含可点的恢复按钮）。
  // 每条 = { title, lead?, steps[], detail?, actions[{label, act, primary}] }
  // act: retry(重试 init) | reset(重新解密) | openDir(打开数据目录)
  function bootGuide(env) {
    const reason = (env && env.reason) || 'unexpected';
    const G = {
      no_wechat_data: {
        title: '没有找到微信数据',
        lead: '这台电脑上没找到可解密的微信聊天数据。',
        steps: [
          '确认本机登录并使用过微信（4.0 及以上版本）',
          '微信数据默认在 C:\\Users\\你的用户名\\xwechat_files',
          '若你把微信数据目录改到了别处，先在微信里恢复默认，或设置后重启本应用',
        ],
        actions: [{ label: '重试', act: 'retry', primary: true },
                  { label: '打开数据目录', act: 'openDir' }],
      },
      decrypt_failed: {
        title: '首次解密未完成',
        lead: (env && env.msg) || '需要从微信客户端提取一次密钥才能解密。',
        steps: [
          '彻底退出微信：任务栏、右下角托盘都要退，确保进程已结束',
          '点下方「退出微信后重试」',
          '应用会自动启动微信并等待——请扫码登录',
          '登录成功后会自动完成解密，无需其它操作',
        ],
        actions: [{ label: '退出微信后重试', act: 'retry', primary: true },
                  { label: '打开数据目录', act: 'openDir' }],
      },
      engine_timeout: {
        title: '正在等待，或引擎无响应',
        lead: '解密引擎迟迟没有回应。',
        steps: [
          '若此刻微信弹出了登录二维码，请先扫码登录，通常随后就会自动继续',
          '若已登录仍卡住，点「重试」',
          '反复出现时，完全关闭本应用后重新打开',
        ],
        actions: [{ label: '重试', act: 'retry', primary: true }],
      },
      store_open_failed: {
        title: '聊天数据似乎不完整',
        lead: '找到了解密数据，但核心库打不开——可能上次只解了一半，或文件损坏。',
        steps: [
          '点「重新解密」：只清空本应用的解密副本并重做，不动微信原始数据',
          '已保存的密钥会保留，通常无需再次扫码登录',
          '若仍失败，打开数据目录看看是否有磁盘空间或权限问题',
        ],
        actions: [{ label: '重新解密', act: 'reset', primary: true },
                  { label: '打开数据目录', act: 'openDir' },
                  { label: '重试', act: 'retry' }],
      },
      sessions_failed: {
        title: '加载会话时出错',
        lead: '数据已就绪，但读取会话列表失败。',
        steps: ['点「重试」通常即可恢复', '若反复失败，可尝试「重新解密」'],
        actions: [{ label: '重试', act: 'retry', primary: true },
                  { label: '重新解密', act: 'reset' }],
      },
      unexpected: {
        title: '启动遇到问题',
        lead: '发生了预期外的错误。',
        steps: ['先点「重试」', '若反复出现，试试「重新解密」，或打开数据目录排查'],
        actions: [{ label: '重试', act: 'retry', primary: true },
                  { label: '重新解密', act: 'reset' },
                  { label: '打开数据目录', act: 'openDir' }],
      },
    };
    const g = G[reason] || G.unexpected;
    // 底层技术细节仅作为可选的小字附注，不喧宾夺主
    if (env && env.detail && !g.detail) g.detail = String(env.detail);
    return g;
  }

  let bootBusy = false;
  function showBootGuide(env) {
    const g = bootGuide(env);
    $('bootSpin').style.display = 'none';
    $('bootBarWrap').style.display = 'none';
    $('bootRetry').style.display = 'none';   // 用引导内自带的按钮，隐藏旧的单一重试键
    const box = $('bootErr');
    box.style.display = 'block';
    box.className = 'err boot-guide';
    const steps = (g.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
    const acts = (g.actions || []).map((a, i) =>
      `<button class="${a.primary ? 'btn-primary' : 'btn-ghost'}" data-act="${a.act}" data-i="${i}">${esc(a.label)}</button>`
    ).join('');
    box.innerHTML =
      `<h3>${esc(g.title)}</h3>`
      + (g.lead ? `<p class="lead">${esc(g.lead)}</p>` : '')
      + (steps ? `<ol>${steps}</ol>` : '')
      + (g.detail ? `<p class="detail">${esc(g.detail)}</p>` : '')
      + `<div class="acts">${acts}</div>`;
    box.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => runBootAction(btn.dataset.act, btn));
    });
  }

  async function runBootAction(act, btn) {
    if (bootBusy) return;
    if (act === 'openDir') { try { await window.wememo.openDataDir(); } catch (e) {} return; }
    bootBusy = true;
    const box = $('bootErr');
    try {
      if (act === 'reset') {
        btn.disabled = true; btn.textContent = '正在清理…';
        let r;
        try { r = await window.wememo.resetData(); } catch (e) { r = null; }
        if (r && r.canceled) { btn.disabled = false; btn.textContent = '重新解密'; return; }
        // 清理后走完整重试（会重新解密/必要时重新提取密钥）
      }
      // retry / reset 之后：回到加载态并重跑 init
      box.style.display = 'none';
      box.className = 'err';
      $('bootSpin').style.display = '';
      $('bootBarWrap').style.display = '';
      $('bootBar').style.width = '0%';
      $('bootSub').textContent = '正在加载你的聊天记忆…';
      bootBusy = false;
      init();
    } catch (e) {
      bootBusy = false;
      showBootGuide({ reason: 'unexpected', detail: String((e && e.message) || e) });
    }
  }

  // ---- 窗口按钮 ----
  let isMax = false;
  function setMaxIcon() {
    $('btnMax').innerHTML = isMax
      ? '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1.5" y="3" width="7.5" height="7.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 1.5h6a.5.5 0 0 1 .5.5v6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  }

  async function init() {
    buildBoot();
    buildTabbar();
    setMaxIcon();
    $('btnMin').addEventListener('click', () => window.wememo.windowAction('min'));
    $('btnMax').addEventListener('click', async () => {
      await window.wememo.windowAction('max');
      isMax = !isMax;
      setMaxIcon();
    });
    $('btnClose').addEventListener('click', () => window.wememo.windowAction('close'));

    // 解密进度事件 → boot 进度条
    let offEvent = null;
    offEvent = window.wememo.onEvent((ev, data) => {
      if (ev !== 'progress' || !data) return;
      const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
      $('bootSub').textContent = `${data.msg || '正在解密'} (${pct}%)`;
      $('bootBar').style.width = pct + '%';
    });

    try {
      const env = await window.wememo.init();
      if (offEvent) offEvent();
      if (!env || !env.found) {
        // 未能就绪：把原因码翻译成用户照着能做的操作建议，而不是甩一句错误
        showBootGuide(env || { reason: 'unexpected' });
        return;
      }
      await refreshSessions();
      // 库就绪后开启后台自动同步（微信在线时定时把新消息增量解密进来）
      startAutoSync();
    } catch (e) {
      if (offEvent) offEvent();
      showBootGuide({ reason: 'unexpected', detail: String((e && e.message) || e) });
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
