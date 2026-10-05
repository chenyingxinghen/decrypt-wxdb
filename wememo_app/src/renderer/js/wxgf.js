// wxgf.js — 微信原图（wxgf）客户端解码层
// wxgf = 微信自有壳 + 单帧 HEVC/H.265 Annex-B 帧内码流（概念上类似 HEIC）。
// 引擎侧（imgfile.py）已剥壳，交给渲染层的就是裸 Annex-B 字节流；这里用 WebCodecs
// VideoDecoder（Windows 走 Media Foundation 平台解码器）解成一帧，再画到画布导出 PNG。
// 无 WebCodecs / 无 HEVC 支持时**一律返回 null**，调用方保持显示缩略图即可。
// 暴露：浏览器 → window.WeMemoWxgf；Node → module.exports。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WeMemoWxgf = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIME = 'image/x-wxgf';
  const DATA_URL_PREFIX = 'data:' + MIME + ';base64,';

  // ---------------------------------------------------------------- 基础工具

  /** data:image/x-wxgf;base64,xxx → Uint8Array；不是 wxgf data URL 返回 null。 */
  function fromDataUrl(url) {
    if (typeof url !== 'string' || url.indexOf(DATA_URL_PREFIX) !== 0) return null;
    const b64 = url.slice(DATA_URL_PREFIX.length);
    try {
      if (typeof atob === 'function') {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new Uint8Array(Buffer.from(b64, 'base64'));
    } catch (e) {
      return null;
    }
  }

  function isWxgfUrl(url) {
    return typeof url === 'string' && url.indexOf(DATA_URL_PREFIX) === 0;
  }

  // ---------------------------------------------------------- Annex-B / SPS

  /** 扫描 Annex-B 码流，返回 [{type, start, data}]（data 不含起始码，已去尾部 0）。 */
  function scanNals(buf) {
    const out = [];
    const n = buf.length;
    const starts = [];
    let i = 0;
    while (i < n - 3) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i + 3); i += 3; } else i++;
    }
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k];
      let e = k + 1 < starts.length ? starts[k + 1] - 3 : n;
      while (e > s && buf[e - 1] === 0) e--;
      if (e - s < 2) continue;
      out.push({ type: (buf[s] >> 1) & 0x3f, start: s, data: buf.subarray(s, e) });
    }
    return out;
  }

  /** 去除 emulation prevention byte（00 00 03 → 00 00）。 */
  function rbsp(a) {
    const o = new Uint8Array(a.length);
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      if (i + 2 < a.length && a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 3) {
        o[j++] = 0; o[j++] = 0; i += 2;
      } else o[j++] = a[i];
    }
    return o.subarray(0, j);
  }

  /** 比特读取器（u(n) / ue()，H.265 Exp-Golomb）。 */
  function bitReader(b) {
    return {
      b: b,
      p: 0,
      u(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
          if ((this.p >> 3) >= this.b.length) throw new Error('eof');
          v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1);
          this.p++;
        }
        return v;
      },
      ue() {
        let z = 0;
        while (this.u(1) === 0) { if (++z > 32) throw new Error('bad ue'); }
        return z === 0 ? 0 : (Math.pow(2, z) - 1 + this.u(z));
      },
    };
  }

  /**
   * 解析 SPS NAL（含 2 字节 NAL header）→ profile/tier/level + 尺寸 + 位深。
   * 失败抛异常。
   */
  function parseSps(nal) {
    const r = bitReader(rbsp(nal.subarray(2)));
    r.u(4);                       // sps_video_parameter_set_id
    const maxSub = r.u(3);        // sps_max_sub_layers_minus1
    const nest = r.u(1);          // sps_temporal_id_nesting_flag
    // profile_tier_level
    const space = r.u(2), tier = r.u(1), profile = r.u(5);
    const compat = r.u(32);
    const c1 = r.u(24), c2 = r.u(24);   // 48 bits 约束标志
    const level = r.u(8);
    const sp = [], sl = [];
    for (let i = 0; i < maxSub; i++) { sp.push(r.u(1)); sl.push(r.u(1)); }
    if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.u(2);
    for (let i = 0; i < maxSub; i++) {
      if (sp[i]) { r.u(2); r.u(1); r.u(5); r.u(32); r.u(24); r.u(24); }
      if (sl[i]) r.u(8);
    }
    r.ue();                        // sps_seq_parameter_set_id
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    const w = r.ue(), h = r.ue();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const bdL = r.ue() + 8, bdC = r.ue() + 8;
    const sw = (chroma === 1 || chroma === 2) ? 2 : 1;
    const sh = chroma === 1 ? 2 : 1;
    return {
      space, tier, profile, compat, c1, c2, level, chroma, bdL, bdC, nest, maxSub,
      width: w - sw * (cl + cr), height: h - sh * (ct + cb),
    };
  }

  /** 从 Annex-B 流提取 SPS 信息（找不到/解析失败返回 null）。 */
  function probe(buf) {
    try {
      const nals = scanNals(buf);
      const sps = nals.filter((n) => n.type === 33)[0];
      if (!sps) return null;
      const info = parseSps(sps.data);
      info.nals = nals.map((n) => n.type);
      return info;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- codec 串

  function revBits32(v) {
    let r = 0;
    for (let i = 0; i < 32; i++) r = (r << 1) | ((v >>> i) & 1);
    return r >>> 0;
  }

  /** general_profile_compatibility_flags 的第 bit 位是否置起（bit=profile_idc）。 */
  function compatHas(compat, bit) {
    return ((compat >>> (31 - bit)) & 1) === 1;
  }

  /** general_constraint_indicator_flags 的 6 字节。 */
  function constraintBytes(s) {
    const b = [];
    for (let i = 2; i >= 0; i--) b.push((s.c1 >> (i * 8)) & 0xff);
    for (let i = 2; i >= 0; i--) b.push((s.c2 >> (i * 8)) & 0xff);
    return b;
  }

  /**
   * 按 ISO/IEC 14496-15 附录 E 组装 codec 串（尾部全 0 约束字节省略）。
   * @param prefix 'hev1' | 'hvc1'
   * @param s      SPS 信息
   * @param profileIdc 覆盖 profile（默认取 SPS）
   * @param compatHex  覆盖 compatibility 段（十六进制串，默认由 SPS 反位序推出）
   * @param noConstraint 省略约束字节
   */
  function codecString(prefix, s, profileIdc, compatHex, noConstraint) {
    const p = profileIdc == null ? s.profile : profileIdc;
    const c = compatHex == null ? revBits32(s.compat).toString(16).toUpperCase() : compatHex;
    const cb = constraintBytes(s);
    while (cb.length && cb[cb.length - 1] === 0) cb.pop();
    return prefix + '.' + (s.space ? String.fromCharCode(64 + s.space) : '') + p
      + '.' + c
      + '.' + (s.tier ? 'H' : 'L') + s.level
      + (noConstraint ? '' : cb.map((x) => '.' + x.toString(16).padStart(2, '0').toUpperCase()).join(''));
  }

  // profile → 该 profile 规范的 compatibility 段（codec 串里必须用它，用码流里的
  // 原始反位序值 Chromium 会判不支持）
  const CANON_COMPAT = { 1: '6', 2: '4', 3: 'E', 4: '10' };

  /**
   * 候选 codec 串（按可用性从高到低）。
   * 两个实测踩到的坑：
   *   1. **level 必须取 SPS 里的真实值**——微信原图多为 L120/L150/L180，
   *      写死常见的 L93(3.1) 虽然 isConfigSupported 也返回 true，但真解会失败。
   *   2. **compatibility flags 要用该 profile 的规范值**（Main→6 / Main10→4 /
   *      RExt→10）。直接把码流里的 0x70000000 反位序写成 `.E`，Chromium 判定
   *      为不支持。
   */
  function codecCandidates(sps) {
    if (!sps) return ['hev1.1.6.L150.90'];
    const list = [];
    const seen = Object.create(null);
    const push = (c) => { if (c && !seen[c]) { seen[c] = 1; list.push(c); } };
    const canon = CANON_COMPAT[sps.profile] || CANON_COMPAT[1];
    push(codecString('hev1', sps, sps.profile, canon));
    push(codecString('hvc1', sps, sps.profile, canon));
    push(codecString('hev1', sps, sps.profile, canon, true));   // 不带约束字节
    if (sps.profile !== 1 && compatHas(sps.compat, 1)) {
      push(codecString('hev1', sps, 1, CANON_COMPAT[1]));
    }
    if (sps.profile !== 2 && (compatHas(sps.compat, 2) || sps.bdL > 8)) {
      push(codecString('hev1', sps, 2, CANON_COMPAT[2]));
    }
    push('hev1.1.6.L' + sps.level + '.90');
    push('hev1.1.6.L186.B0');
    return list;
  }

  // -------------------------------------------------- profile 归一化（关键）

  /**
   * 微信原图的 general_profile_idc = 3（Main Still Picture）。
   * 实测 Chromium/Media Foundation **不接受 profile 3 的码流**（configure 通过，
   * decode 立刻 EncodingError: Decoding error）。而 Main Still Picture 本就是
   * Main 的子集，码流里 compatibility flags 也已置起 Main 位，因此把 VPS/SPS 的
   * profile_tier_level 里那一字节改成 profile 1(Main) 后即可正常解码（实测像素
   * 尺寸与 SPS 一致）。此函数就地重写这一个字节。
   *
   * profile_tier_level 的首字节 = profile_space(2)|tier(1)|profile_idc(5)，字节对齐：
   *   VPS: NAL 头 2B + vps_id/层数/reserved 共 4B → 偏移 6
   *   SPS: NAL 头 2B + vps_id/sub_layers/nesting 共 1B → 偏移 3
   * （这两个位置远早于任何 emulation prevention byte，可直接寻址）
   */
  function patchProfile(buf, fromProfile, toProfile) {
    const out = new Uint8Array(buf);
    let n = 0;
    for (const nal of scanNals(out)) {
      let off = -1;
      if (nal.type === 32) off = nal.start + 6;
      else if (nal.type === 33) off = nal.start + 3;
      else continue;
      if (off >= out.length) continue;
      if ((out[off] & 0x1f) !== fromProfile) continue;
      out[off] = (out[off] & 0xe0) | (toProfile & 0x1f);
      n++;
    }
    return n ? out : buf;
  }

  /**
   * 归一化码流：挑出正片序列 + 把 Main Still Picture 改写为 Main。
   * @returns {{stream: Uint8Array, sps: object, alpha: Uint8Array|null}|null}
   */
  function normalize(bytes) {
    if (!bytes || !bytes.length) return null;
    const segs = sequences(bytes);
    const main = pickSequence(segs);
    if (!main) return null;
    const alphaSeg = pickAlpha(segs, main);
    let stream = main.bytes;
    let sps = main.sps;
    if (sps.profile === 3 && compatHas(sps.compat, 1)) {
      stream = patchProfile(stream, 3, 1);
      sps = probe(stream) || sps;
    }
    return { stream, sps, alpha: alphaSeg ? alphaSeg.bytes : null,
             alphaSps: alphaSeg ? alphaSeg.sps : null };
  }

  // ------------------------------------------------------------ hvcC 描述

  /** 由参数集 NAL + SPS 信息组装 hvcC（lengthSizeMinusOne=3）。 */
  function buildHvcC(nals, s) {
    const out = [];
    out.push(1, (s.space << 6) | (s.tier << 5) | s.profile);
    for (let i = 3; i >= 0; i--) out.push((s.compat >>> (i * 8)) & 0xff);
    constraintBytes(s).forEach((b) => out.push(b));
    out.push(s.level);
    out.push(0xf0, 0x00, 0xfc, 0xfc | s.chroma, 0xf8 | (s.bdL - 8), 0xf8 | (s.bdC - 8), 0, 0);
    out.push((((s.maxSub + 1) & 7) << 3) | (s.nest << 2) | 3);
    const groups = [32, 33, 34].map((t) => ({ t, ns: nals.filter((n) => n.type === t) }))
      .filter((g) => g.ns.length);
    out.push(groups.length);
    for (const g of groups) {
      out.push(0x80 | g.t, (g.ns.length >> 8) & 0xff, g.ns.length & 0xff);
      for (const n of g.ns) {
        out.push((n.data.length >> 8) & 0xff, n.data.length & 0xff);
        for (let i = 0; i < n.data.length; i++) out.push(n.data[i]);
      }
    }
    return Uint8Array.from(out);
  }

  /** Annex-B → 4 字节长度前缀（mp4 样式），只保留非参数集 NAL。 */
  function toLengthPrefixed(nals) {
    const keep = nals.filter((n) => n.type < 32 || n.type > 34);
    let total = 0;
    keep.forEach((n) => { total += 4 + n.data.length; });
    const out = new Uint8Array(total);
    let o = 0;
    for (const n of keep) {
      const L = n.data.length;
      out[o++] = (L >>> 24) & 255; out[o++] = (L >>> 16) & 255;
      out[o++] = (L >>> 8) & 255; out[o++] = L & 255;
      out.set(n.data, o); o += L;
    }
    return out;
  }

  /**
   * 切分 Annex-B 里的多个「序列」（每段 = VPS/SPS/PPS + 一帧切片）。
   * 微信带透明通道的原图会写两段：一段 4:0:0 单色（alpha 掩膜，RExt profile 4），
   * 一段 4:2:0 彩色（正片，Main profile）。返回 [{start,end,bytes,sps,payload}]。
   */
  function sequences(buf) {
    const nals = scanNals(buf);
    const segs = [];
    let cur = null;
    for (const n of nals) {
      if (n.type === 32 && cur && cur.slice) { cur.end = n.start - 3; segs.push(cur); cur = null; }
      if (!cur) cur = { start: Math.max(0, n.start - 3), end: buf.length, slice: 0, nals: [] };
      cur.nals.push(n);
      if (n.type <= 31) cur.slice += n.data.length;
    }
    if (cur) segs.push(cur);
    const out = [];
    for (const s of segs) {
      const spsNal = s.nals.filter((n) => n.type === 33)[0];
      if (!spsNal) continue;
      let sps = null;
      try { sps = parseSps(spsNal.data); } catch (e) { continue; }
      out.push({ start: s.start, end: s.end, bytes: buf.subarray(s.start, s.end),
                 sps, payload: s.slice, nals: s.nals });
    }
    return out;
  }

  /** 选出「正片」序列：优先彩色（chroma≠0），同类取切片数据最大的一段。 */
  function pickSequence(segs) {
    if (!segs || !segs.length) return null;
    const color = segs.filter((s) => s.sps.chroma !== 0);
    const pool = color.length ? color : segs;
    return pool.reduce((a, b) => (b.payload > a.payload ? b : a));
  }

  /** 与正片同尺寸的单色序列 = alpha 掩膜（没有返回 null）。 */
  function pickAlpha(segs, main) {
    if (!segs || !main) return null;
    return segs.filter((s) => s !== main && s.sps.chroma === 0
      && s.sps.width === main.sps.width && s.sps.height === main.sps.height)[0] || null;
  }

  // ------------------------------------------------------------ 解码主流程

  const _cache = new Map();      // key → data URL（解码结果，插入序 LRU）
  const _inflight = new Map();   // key → Promise（同一张图并发只解一次）
  const _failed = new Set();     // key → 已知失败，不重试
  const _codecOk = {};           // profile → 已验证可用的 codec 串
  let _supported = null;         // null 未知 / true / false
  let _cacheBytes = 0;
  const CACHE_MAX_BYTES = 48 * 1024 * 1024;
  const CACHE_MAX_ITEMS = 24;

  function hasWebCodecs() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  }

  /** 本环境是否可能支持 HEVC 解码（只做 isConfigSupported 静态查询）。 */
  async function isSupported() {
    if (_supported !== null) return _supported;
    if (!hasWebCodecs()) { _supported = false; return false; }
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: 'hev1.1.6.L93.B0' });
      _supported = !!(r && r.supported);
    } catch (e) {
      _supported = false;
    }
    return _supported;
  }

  // ---- 解码器复用 ----------------------------------------------------------
  // 每张图都新建一个 VideoDecoder 会把平台解码器（Windows = Media Foundation）
  // 反复创建/销毁，实测 145 张连续解码后单张耗时从 ~190ms 退化到 ~1.3s。
  // 因此按 codec 配置复用同一个解码器：configure 一次，之后 decode+flush 循环用。
  // 出错 / 超时就丢弃重建（解码器出错后状态即为 closed）。
  let _pool = null;              // { key, dec, cb }

  function closeDecoder() {
    if (!_pool) return;
    try { if (_pool.dec && _pool.dec.state !== 'closed') _pool.dec.close(); } catch (e) { /* ignore */ }
    _pool = null;
  }

  function _poolGet(cfg) {
    const key = cfg.codec + '|' + (cfg.description ? 'hvcC' : 'annexb');
    if (_pool) {
      if (_pool.key === key && _pool.dec && _pool.dec.state === 'configured' && !_pool.cb) return _pool;
      closeDecoder();
    }
    const p = { key: key, dec: null, cb: null };
    try {
      p.dec = new VideoDecoder({
        output: (frame) => {
          const cb = p.cb;
          p.cb = null;
          if (cb) cb({ frame });
          else { try { frame.close(); } catch (e) { /* ignore */ } }
        },
        error: (e) => {
          const cb = p.cb;
          p.cb = null;
          if (_pool === p) _pool = null;
          try { if (p.dec.state !== 'closed') p.dec.close(); } catch (x) { /* ignore */ }
          if (cb) cb({ error: (e && e.name ? e.name + ': ' : '') + (e && e.message) });
        },
      });
      p.dec.configure(Object.assign({ hardwareAcceleration: 'no-preference' }, cfg));
    } catch (e) {
      return null;
    }
    _pool = p;
    return p;
  }

  // 硬件解码本就是串行的，这里把所有 decode 串成一条队列：既避免并发调用互相
  // 覆盖复用解码器的回调，也让「同时进入视口的多张原图」不会一起抢解码器。
  let _queue = Promise.resolve();

  function decodeChunk(cfg, data) {
    const run = () => _decodeChunkRaw(cfg, data);
    const next = _queue.then(run, run);
    _queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function _decodeChunkRaw(cfg, data) {
    return new Promise((resolve) => {
      const p = _poolGet(cfg);
      if (!p) { resolve({ error: 'configure failed' }); return; }
      let done = false;
      let timer = null;
      const fin = (v) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (p.cb === fin) p.cb = null;
        resolve(v);
      };
      p.cb = fin;
      try {
        p.dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
        p.dec.flush().then(
          () => fin({ error: 'no-frame' }),
          (e) => fin({ error: 'flush: ' + (e && e.message) }),
        );
      } catch (e) {
        closeDecoder();
        fin({ error: 'throw: ' + (e && e.message) });
      }
      timer = setTimeout(() => { closeDecoder(); fin({ error: 'timeout' }); }, 10000);
    });
  }

  async function frameToDataUrl(frame, type, quality) {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    let blob = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const cv = new OffscreenCanvas(w, h);
      const cx = cv.getContext('2d');
      cx.drawImage(frame, 0, 0, w, h);
      blob = await cv.convertToBlob({ type: type || 'image/png', quality: quality });
    } else if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(frame, 0, 0, w, h);
      return cv.toDataURL(type || 'image/png', quality);
    } else {
      return null;
    }
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * 解码 wxgf Annex-B 字节流 → PNG/JPEG data URL；失败返回 null。
   * @param {Uint8Array} bytes  Annex-B 码流（VPS+SPS+PPS+IDR）
   * @param {object} [opts] {type:'image/png'|'image/jpeg', quality}
   */
  async function decodeAnnexB(bytes, opts) {
    const o = opts || {};
    if (!bytes || !bytes.length) return null;
    if (!hasWebCodecs()) return null;

    const norm = normalize(bytes);
    if (!norm) return null;
    const { stream, sps } = norm;

    const cands = codecCandidates(sps);
    const hit = _codecOk[sps.profile];
    if (hit) {
      // 同 profile 已验证可用的 codec 串结构：只把 level/tier 换成本流的，优先尝试
      const tuned = hit.replace(/\.[LH]\d+/, (sps.tier ? '.H' : '.L') + sps.level);
      if (cands.indexOf(tuned) < 0) cands.unshift(tuned);
    }

    for (const codec of cands) {
      let ok = false;
      try { ok = (await VideoDecoder.isConfigSupported({ codec })).supported; } catch (e) { ok = false; }
      if (!ok) continue;
      const r = await decodeChunk({ codec, hardwareAcceleration: 'no-preference' }, stream);
      if (r.frame) {
        _codecOk[sps.profile] = codec;
        try {
          return await frameToDataUrl(r.frame, o.type, o.quality);
        } finally {
          try { r.frame.close(); } catch (e) { /* ignore */ }
        }
      }
    }
    // Annex-B 全败 → 退到 hvcC + 长度前缀（部分平台解码器只吃这种）
    const nals = scanNals(stream);
    for (const codec of cands) {
      if (codec.indexOf('hvc1') !== 0) continue;
      let cfg;
      try { cfg = { codec, description: buildHvcC(nals, sps) }; } catch (e) { continue; }
      let ok = false;
      try { ok = (await VideoDecoder.isConfigSupported(cfg)).supported; } catch (e) { ok = false; }
      if (!ok) continue;
      const r = await decodeChunk(cfg, toLengthPrefixed(nals));
      if (r.frame) {
        try {
          return await frameToDataUrl(r.frame, o.type, o.quality);
        } finally {
          try { r.frame.close(); } catch (e) { /* ignore */ }
        }
      }
    }
    return null;
  }

  /**
   * 便捷入口：吃引擎给的 data URL（`data:image/x-wxgf;base64,...`），
   * 返回可直接 `<img src>` 的 PNG/JPEG data URL；不是 wxgf 或解码失败返回 null。
   * 带结果缓存 + 失败记忆 + 并发合并（同一 key 只解一次）。
   * @param {string} url
   * @param {object} [opts] {key: 缓存键（建议传 file_hash，比整串 url 短得多）,
   *                         type:'image/png'|'image/jpeg', quality}
   */
  async function decodeDataUrl(url, opts) {
    const o = opts || {};
    const bytes = fromDataUrl(url);
    if (!bytes) return null;
    const key = o.key || url;
    if (_cache.has(key)) {
      const v = _cache.get(key);          // 触碰 → 移到队尾（LRU）
      _cache.delete(key);
      _cache.set(key, v);
      return v;
    }
    if (_failed.has(key)) return null;
    if (_inflight.has(key)) return _inflight.get(key);

    const task = (async () => {
      const out = await decodeAnnexB(bytes, o);
      if (out) {
        _cache.set(key, out);
        _cacheBytes += out.length;
        while (_cache.size > CACHE_MAX_ITEMS || _cacheBytes > CACHE_MAX_BYTES) {
          const k = _cache.keys().next().value;
          if (k === undefined) break;
          _cacheBytes -= (_cache.get(k) || '').length;
          _cache.delete(k);
        }
      } else {
        _failed.add(key);
        if (_failed.size > 512) _failed.clear();
      }
      return out;
    })();
    _inflight.set(key, task);
    try {
      return await task;
    } finally {
      _inflight.delete(key);
    }
  }

  function clearCache() {
    _cache.clear();
    _failed.clear();
    _cacheBytes = 0;
    closeDecoder();
  }

  return {
    MIME, DATA_URL_PREFIX, CANON_COMPAT,
    isWxgfUrl, fromDataUrl,
    scanNals, rbsp, bitReader, parseSps, probe, sequences, pickSequence, pickAlpha,
    revBits32, constraintBytes, codecString, codecCandidates, compatHas,
    patchProfile, normalize,
    buildHvcC, toLengthPrefixed,
    hasWebCodecs, isSupported,
    decodeAnnexB, decodeDataUrl, clearCache, closeDecoder,
  };
});
