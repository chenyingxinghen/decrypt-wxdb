// emoticons.js — 微信内置表情（“小黄脸”）纯逻辑层（无 DOM 依赖，浏览器与 Node 测试共用）
// 微信把内置表情以方括号记号（如 [旺柴] [捂脸] [玫瑰]）内嵌在**纯文本**消息里，
// 本模块负责把这些记号从文本中切出来，并给出可显示的 Unicode 近似字符。
//
// 设计原则：
//   1) **白名单**：只有名字在 TABLE 里的 [xxx] 才算表情，其余（用户自己打的方括号、
//      应用生成的标记如 [图片]）原样保留为普通文本 —— 宁可漏认，不可错认。
//   2) **宁缺毋滥**：微信自有、Unicode 无对应物的表情（旺柴 / 吃瓜 / 让我看看 / 裂开 /
//      苦涩 / Emm / 社会社会 / 加油 …）一律映射为 ''，由渲染层显示为带名字的小胶囊，
//      **绝不**硬套一个语义不符的 emoji。
//   3) **不做 HTML 转义**：splitTokens 返回原始值，转义由调用方（render.js 的 esc）负责；
//      render() 是便利封装，escapeFn 缺失时用内置最小转义器兜底，永不吐出未转义文本。
//
// 暴露：浏览器 → window.WeMemoEmoticons；Node → module.exports。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WeMemoEmoticons = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 名字表来源（权威）─────────────────────────────────────────────────────
  // 下面两张表**不是**凭记忆写的，而是从本机微信 4.1.12.55 本体里直接抽出来的：
  //   · 经典 105 枚：Weixin.dll 内嵌的 cn|tw|en 三段管道分隔名字表（偏移 ~152241681）
  //   · 新增 45 枚 ：XEditor.bin → xeditor_app.dll 内的明文 <newemoji> XML
  //     （同一张表也以 zlib 压缩形式存在于 Weixin.dll 的 Qt 资源 `:/emoji/newemoji-config.xml`）
  // fileName 形如 smiley_17b.png 的记录说明该表情是经典表情改名（17 = 冷汗 → 囧），
  // 已归并到同一个正名下。因此繁体/英文别名都是微信自己发出的字面量，无一处臆测。
  // 共 146 个正名 + 228 个别名 = 374 个记号。

  // ── 简体正名 → Unicode 近似（'' = 无忠实对应，渲染为文字胶囊）────────────────
  // 顺序即微信表情面板顺序：经典 105（小黄脸→手势→物件→早期动画）+ 后续新增 41。
  const BASE = {
    '微笑': '🙂', '撇嘴': '😕', '色': '😍', '发呆': '😳', '得意': '😎', '流泪': '😢', '害羞': '😊', '闭嘴': '🤐',
    '睡': '😴', '大哭': '😭', '尴尬': '😬', '发怒': '😡', '调皮': '😜', '呲牙': '😁', '惊讶': '😮', '难过': '😔',
    '酷': '😎', '囧': '', '抓狂': '😫', '吐': '🤮', '偷笑': '🤭', '愉快': '😄', '白眼': '🙄', '傲慢': '😤',
    '饥饿': '', '困': '😪', '惊恐': '😱', '流汗': '😓', '憨笑': '😃', '悠闲': '😌', '奋斗': '💪', '咒骂': '🤬',
    '疑问': '🤔', '嘘': '🤫', '晕': '😵', '疯了': '', '衰': '', '骷髅': '💀', '敲打': '', '再见': '👋',
    '擦汗': '😅', '抠鼻': '', '鼓掌': '👏', '糗大了': '', '坏笑': '😏', '左哼哼': '', '右哼哼': '', '哈欠': '🥱',
    '鄙视': '😒', '委屈': '🥺', '快哭了': '😥', '阴险': '', '亲亲': '😘', '吓': '', '可怜': '🥺', '菜刀': '🔪',
    '西瓜': '🍉', '啤酒': '🍺', '篮球': '🏀', '乒乓': '🏓', '咖啡': '☕', '饭': '🍚', '猪头': '🐷', '玫瑰': '🌹',
    '凋谢': '🥀', '嘴唇': '💋', '爱心': '❤️', '心碎': '💔', '蛋糕': '🎂', '闪电': '⚡', '炸弹': '💣', '刀': '🗡️',
    '足球': '⚽', '瓢虫': '🐞', '便便': '💩', '月亮': '🌙', '太阳': '☀️', '礼物': '🎁', '拥抱': '🤗', '强': '👍',
    '弱': '👎', '握手': '🤝', '胜利': '✌️', '抱拳': '', '勾引': '', '拳头': '✊', '差劲': '', '爱你': '',
    'NO': '', 'OK': '👌', '爱情': '💑', '飞吻': '😘', '跳跳': '', '发抖': '', '怄火': '', '转圈': '',
    '磕头': '', '回头': '', '跳绳': '', '投降': '', '激动': '', '乱舞': '', '献吻': '', '左太极': '', '右太极': '',
    '奸笑': '😏', '嘿哈': '', '捂脸': '🤦', '机智': '', '茶': '🍵', '红包': '🧧', '蜡烛': '🕯️', '耶': '✌️',
    '皱眉': '😟', '鸡': '🐔', '福': '', '發': '', '小狗': '🐶', '吃瓜': '', '加油': '', '汗': '😓', '天啊': '',
    'Emm': '', '社会社会': '', '旺柴': '', '好的': '', '打脸': '', '哇': '😲', '加油加油': '', '翻白眼': '🙄',
    '666': '', '让我看看': '', '叹气': '😮‍💨', '苦涩': '', '裂开': '', '脸红': '😳', '笑脸': '😄', '破涕为笑': '😂',
    '烟花': '🎆', '庆祝': '🎉', '恐惧': '😨', '无语': '😑', '失望': '😞', '生病': '🤒', '合十': '🙏', '爆竹': '🧨'
  };

  const ALIAS = {
    // 繁体字形（微信繁体表情包用的是另一套措辞，并非逐字转换）
    '發呆': '发呆', '流淚': '流泪', '閉嘴': '闭嘴', '尷尬': '尴尬', '發怒': '发怒', '調皮': '调皮', '驚訝': '惊讶',
    '難過': '难过', '饑餓': '饥饿', '累': '困', '驚恐': '惊恐', '大笑': '憨笑', '悠閑': '悠闲', '奮鬥': '奋斗',
    '咒罵': '咒骂', '疑問': '疑问', '噓': '嘘', '暈': '晕', '瘋了': '疯了', '骷髏頭': '骷髅', '再見': '再见',
    '摳鼻': '抠鼻', '羞辱': '糗大了', '壞笑': '坏笑', '鄙視': '鄙视', '陰險': '阴险', '親親': '亲亲', '嚇': '吓',
    '可憐': '可怜', '籃球': '篮球', '飯': '饭', '豬頭': '猪头', '枯萎': '凋谢', '愛心': '爱心', '閃電': '闪电',
    '炸彈': '炸弹', '甲蟲': '瓢虫', '太陽': '太阳', '禮物': '礼物', '擁抱': '拥抱', '強': '强', '勝利': '胜利',
    '拳頭': '拳头', '差勁': '差劲', '愛你': '爱你', '愛情': '爱情', '飛吻': '飞吻', '發抖': '发抖', '噴火': '怄火',
    '轉圈': '转圈', '磕頭': '磕头', '回頭': '回头', '跳繩': '跳绳', '激動': '激动', '亂舞': '乱舞', '獻吻': '献吻',
    '左太極': '左太极', '右太極': '右太极', '吼嘿': '嘿哈', '掩面': '捂脸', '機智': '机智', '蠟燭': '蜡烛', '歐耶': '耶',
    '皺眉': '皱眉', '小雞': '鸡', '吃西瓜': '吃瓜', '一言難盡': 'Emm', '失敬失敬': '社会社会', '打臉': '打脸',
    '加油！': '加油加油', '讓我看看': '让我看看', '嘆息': '叹气', '難受': '苦涩', '崩潰': '裂开', '臉紅': '脸红', '笑臉': '笑脸',
    '破涕為笑': '破涕为笑', '煙花': '烟花', '慶祝': '庆祝', '恐懼': '恐惧', '無語': '无语', '冷汗': '囧',
    // 微信英文版名称
    'Smile': '微笑', 'Grimace': '撇嘴', 'Drool': '色', 'Scowl': '发呆', 'CoolGuy': '得意', 'Sob': '流泪',
    'Shy': '害羞', 'Silent': '闭嘴', 'Sleep': '睡', 'Cry': '大哭', 'Awkward': '尴尬', 'Angry': '发怒',
    'Tongue': '调皮', 'Grin': '呲牙', 'Surprise': '惊讶', 'Frown': '难过', 'Ruthless': '酷',
    'Blush': '囧', 'Scream': '抓狂', 'Puke': '吐', 'Chuckle': '偷笑', 'Joyful': '愉快', 'Slight': '白眼',
    'Smug': '傲慢', 'Hungry': '饥饿', 'Drowsy': '困', 'Panic': '惊恐', 'Sweat': '流汗', 'Laugh': '憨笑',
    'Commando': '悠闲', 'Determined': '奋斗', 'Scold': '咒骂', 'Shocked': '疑问', 'Shhh': '嘘',
    'Dizzy': '晕', 'Tormented': '疯了', 'Toasted': '衰', 'Skull': '骷髅', 'Hammer': '敲打',
    'Wave': '再见', 'Speechless': '擦汗', 'NosePick': '抠鼻', 'Clap': '鼓掌', 'Shame': '糗大了',
    'Trick': '坏笑', 'Bah！L': '左哼哼', 'Bah！R': '右哼哼', 'Yawn': '哈欠', 'Pooh-pooh': '鄙视',
    'Shrunken': '委屈', 'TearingUp': '快哭了', 'Sly': '阴险', 'Kiss': '亲亲', 'Wrath': '吓',
    'Whimper': '可怜', 'Cleaver': '菜刀', 'Watermelon': '西瓜', 'Beer': '啤酒', 'Basketball': '篮球',
    'PingPong': '乒乓', 'Coffee': '咖啡', 'Rice': '饭', 'Pig': '猪头', 'Rose': '玫瑰', 'Wilt': '凋谢',
    'Lips': '嘴唇', 'Heart': '爱心', 'BrokenHeart': '心碎', 'Cake': '蛋糕', 'Lightning': '闪电',
    'Bomb': '炸弹', 'Dagger': '刀', 'Soccer': '足球', 'Ladybug': '瓢虫', 'Poop': '便便', 'Moon': '月亮',
    'Sun': '太阳', 'Gift': '礼物', 'Hug': '拥抱', 'ThumbsUp': '强', 'ThumbsDown': '弱', 'Shake': '握手',
    'Peace': '胜利', 'Fight': '抱拳', 'Beckon': '勾引', 'Fist': '拳头', 'Pinky': '差劲', 'RockOn': '爱你',
    'Nuh-uh': 'NO', 'InLove': '爱情', 'Blowkiss': '飞吻', 'Waddle': '跳跳', 'Tremble': '发抖',
    'Aaagh!': '怄火', 'Twirl': '转圈', 'Kotow': '磕头', 'Dramatic': '回头', 'JumpRope': '跳绳',
    'Surrender': '投降', 'Hooray': '激动', 'Meditate': '乱舞', 'Smooch': '献吻', 'TaiChi L': '左太极',
    'TaiChi R': '右太极', 'Smirk': '奸笑', 'Hey': '嘿哈', 'Facepalm': '捂脸', 'Smart': '机智', 'Tea': '茶',
    'Packet': '红包', 'Candle': '蜡烛', 'Yeah!': '耶', 'Concerned': '皱眉', 'Salute': '抱拳',
    'Chick': '鸡', 'Blessing': '福', 'Bye': '再见', 'Rich': '發', 'Pup': '小狗', 'Onlooker': '吃瓜',
    'GoForIt': '加油', 'Sweats': '汗', 'OMG': '天啊', 'Respect': '社会社会', 'Doge': '旺柴',
    'NoProb': '好的', 'MyBad': '打脸', 'Wow': '哇', 'KeepFighting': '加油加油', 'Boring': '翻白眼',
    'Awesome': '666', 'LetMeSee': '让我看看', 'Sigh': '叹气', 'Hurt': '苦涩', 'Broken': '裂开',
    'Flushed': '脸红', 'Happy': '笑脸', 'Lol': '破涕为笑', 'Fireworks': '烟花', 'Party': '庆祝',
    'Terror': '恐惧', 'Duh': '无语', 'LetDown': '失望', 'Sick': '生病', 'Worship': '合十',
    'Firecracker': '爆竹'
  };

  /** 记号名 → Unicode（'' 表示无忠实对应）。别名与正名共享同一个值。*/
  const TABLE = {};
  (function build() {
    for (const k in BASE) if (Object.prototype.hasOwnProperty.call(BASE, k)) TABLE[k] = BASE[k];
    for (const k in ALIAS) {
      if (!Object.prototype.hasOwnProperty.call(ALIAS, k)) continue;
      const canon = ALIAS[k];
      // 正名不存在的别名直接丢弃，避免把普通文本误判成表情
      if (!canon || !Object.prototype.hasOwnProperty.call(BASE, canon)) continue;
      if (Object.prototype.hasOwnProperty.call(TABLE, k)) continue; // 正名优先，别名不覆盖
      TABLE[k] = BASE[canon];
    }
  }());

  // 记号名的最大长度（用于快速剪枝，避免把超长方括号内容当候选）
  let MAX_NAME = 0;
  for (const k in TABLE) if (k.length > MAX_NAME) MAX_NAME = k.length;

  /** 该名字是否为已知的微信内置表情。*/
  function hasToken(name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TABLE, name);
  }

  /** 取该表情的 Unicode 字符；未知或无对应物时返回 ''。*/
  function emojiFor(name) {
    return hasToken(name) ? TABLE[name] : '';
  }

  /** 取别名对应的简体正名；本身即正名或未知时原样返回。*/
  function canonical(name) {
    if (typeof name !== 'string') return '';
    if (Object.prototype.hasOwnProperty.call(BASE, name)) return name;
    const c = Object.prototype.hasOwnProperty.call(ALIAS, name) ? ALIAS[name] : null;
    return (c && Object.prototype.hasOwnProperty.call(BASE, c)) ? c : name;
  }

  /**
   * 把文本切成 [{t:'text', v}, {t:'emo', v:名字, e:Unicode}] 段序列。
   * - 仅当 [xxx] 的 xxx 命中 TABLE 时才成为 emo 段；否则整段方括号并入相邻文本段。
   * - 不做任何 HTML 转义，返回的是原始值。
   * - 对空串 / [] / 不闭合 / 嵌套方括号 / 超长输入都安全，整体线性时间。
   */
  function splitTokens(text) {
    const s = (text == null) ? '' : String(text);
    const out = [];
    const n = s.length;
    let last = 0;   // 尚未产出的文本起点
    let i = 0;      // 下一次找 '[' 的起点
    let close = -1; // 已知的 ']' 位置缓存（单调推进，保证线性时间）
    while (i < n) {
      const open = s.indexOf('[', i);
      if (open < 0) break;
      if (close <= open) close = s.indexOf(']', open + 1);
      if (close < 0) break;                     // 后面再无闭合方括号，剩余全是文本
      const len = close - open - 1;
      if (len > 0 && len <= MAX_NAME) {
        const name = s.slice(open + 1, close);
        // 名字里不允许再有 '['，否则 "[a[微笑]" 会被当成名字 "a[微笑"
        if (name.indexOf('[') < 0 && Object.prototype.hasOwnProperty.call(TABLE, name)) {
          if (open > last) out.push({ t: 'text', v: s.slice(last, open) });
          out.push({ t: 'emo', v: name, e: TABLE[name] });
          last = close + 1;
          i = last;
          continue;
        }
      }
      i = open + 1;                             // 本次不匹配，从下一个字符继续找
    }
    if (last < n) out.push({ t: 'text', v: s.slice(last) });
    return out;
  }

  // 兜底转义器：调用方未传 escapeFn 时使用，绝不吐出未转义文本
  function defaultEscape(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 便利封装：渲染为 HTML 字符串。
   * - 有 Unicode 对应 → <span class="wx-emo" title="[名字]">🙂</span>
   * - 无 Unicode 对应 → <span class="wx-emo none" title="[名字]">名字</span>
   * - 其余文本一律经 escapeFn（缺失时用内置最小转义器）。
   */
  function render(text, escapeFn) {
    const esc = (typeof escapeFn === 'function') ? escapeFn : defaultEscape;
    const segs = splitTokens(text);
    let html = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.t === 'text') { html += esc(seg.v); continue; }
      // seg.v 来自 TABLE 白名单（纯中英文，无特殊字符），title 仍走转义以求稳妥
      const title = esc('[' + seg.v + ']');
      html += seg.e
        ? `<span class="wx-emo" title="${title}">${seg.e}</span>`
        : `<span class="wx-emo none" title="${title}">${esc(seg.v)}</span>`;
    }
    return html;
  }

  return { TABLE, BASE, ALIAS, hasToken, emojiFor, canonical, splitTokens, render, defaultEscape };
});
