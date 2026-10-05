// 从 fzstd lib 复制 rhu/dhu 并输出调试信息
const src = require('fs').readFileSync('./package/lib/index.js', 'utf8');
// 直接加载模块内部不可达，改用 monkeypatch：复制关键函数
const { decompress } = require('./package/lib/index.js');

// 手工复刻 rhu/dhu（与 fzstd 完全一致）
var ab = ArrayBuffer, u8 = Uint8Array, u16 = Uint16Array, i16 = Int16Array, i32 = Int32Array;
var msb = function (val) { var bits = 0; for (; (1 << bits) <= val; ++bits); return bits - 1; };
var rb = function (d, b, n) { var i = 0, o = 0; for (; i < n; ++i) o |= d[b++] << (i << 3); return o; };
var rfse = function (dat, bt, mal) {
    var tpos = (bt << 3) + 4;
    var al = (dat[bt] & 15) + 5;
    if (al > mal) throw Error('acc');
    var sz = 1 << al;
    var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
    var buf = new ab(512 + (sz << 2));
    var freq = new i16(buf, 0, 256);
    var dstate = new u16(buf, 0, 256);
    var nstate = new u16(buf, 512, sz);
    var bb1 = 512 + (sz << 1);
    var syms = new u8(buf, bb1, sz);
    var nbits = new u8(buf, bb1 + sz);
    while (sym < 255 && probs > 0) {
        var bits = msb(probs + 1);
        var cbt = tpos >> 3;
        var msk = (1 << (bits + 1)) - 1;
        var val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
        var msk1fb = (1 << bits) - 1;
        var msv = msk - probs - 1;
        var sval = val & msk1fb;
        if (sval < msv) tpos += bits, val = sval;
        else { tpos += bits + 1; if (val > msk1fb) val -= msv; }
        freq[++sym] = --val;
        if (val == -1) { probs += val; syms[--ht] = sym; }
        else probs -= val;
        if (!val) { do { var rbt = tpos >> 3; re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3; tpos += 2; sym += re; } while (re == 3); }
    }
    if (sym > 255 || probs) throw Error('dist');
    var sympos = 0, sstep = (sz >> 1) + (sz >> 3) + 3, smask = sz - 1;
    for (var s = 0; s <= sym; ++s) { var sf = freq[s]; if (sf < 1) { dstate[s] = -sf; continue; } for (i = 0; i < sf; ++i) { syms[sympos] = s; do { sympos = (sympos + sstep) & smask; } while (sympos >= ht); } }
    if (sympos) throw Error('spread');
    for (i = 0; i < sz; ++i) { var ns = dstate[syms[i]]++; var nb = nbits[i] = al - msb(ns); nstate[i] = (ns << nb) - sz; }
    return [(tpos + 7) >> 3, { b: al, s: syms, n: nbits, t: nstate }];
};
var rhu = function (dat, bt) {
    var i = 0, wc = -1;
    var buf = new u8(292), hb = dat[bt];
    var hw = buf.subarray(0, 256);
    var rc = buf.subarray(256, 268);
    var ri = new u16(buf.buffer, 268);
    if (hb < 128) {
        var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
        bt += hb;
        var epos = ebt << 3;
        var lb = dat[bt];
        if (!lb) throw Error('lb');
        var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
        var fpos = (++bt << 3) - 8 + msb(lb);
        for (;;) {
            fpos -= btr1;
            if (fpos < epos) break;
            var cbt = fpos >> 3;
            st1 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
            hw[++wc] = fdt.s[st1];
            fpos -= btr2;
            if (fpos < epos) break;
            cbt = fpos >> 3;
            st2 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
            hw[++wc] = fdt.s[st2];
            btr1 = fdt.n[st1]; st1 = fdt.t[st1];
            btr2 = fdt.n[st2]; st2 = fdt.t[st2];
        }
        if (++wc > 255) throw Error('wc');
    }
    else {
        wc = hb - 127;
        for (; i < wc; i += 2) { var byte = dat[++bt]; hw[i] = byte >> 4; hw[i + 1] = byte & 15; }
        ++bt;
    }
    var wes = 0;
    for (i = 0; i < wc; ++i) { var wt = hw[i]; if (wt > 11) throw Error('wt'); wes += wt && (1 << (wt - 1)); }
    var mb = msb(wes) + 1, ts = 1 << mb, rem = ts - wes;
    if (rem & (rem - 1)) throw Error('rem');
    hw[wc++] = msb(rem) + 1;
    for (i = 0; i < wc; ++i) { var wt = hw[i]; ++rc[hw[i] = wt && (mb + 1 - wt)]; }
    var hbuf = new u8(ts << 1);
    var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
    ri[mb] = 0;
    for (i = mb; i > 0; --i) { var pv = ri[i]; fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << (mb - i))); }
    if (ri[0] != ts) throw Error('ts');
    for (i = 0; i < wc; ++i) { var bits = hw[i]; if (bits) { var code = ri[bits]; fill(syms, i, code, ri[bits] = code + (1 << (mb - bits))); } }
    return [bt, { n: nb, b: mb, s: syms }];
};
var fill = function (v, n, s, e) { for (; s < e; ++s) v[s] = n; return v; };

// 取帧
const sqlite3 = require('node:sqlite');
const db = new sqlite3.DatabaseSync('G:/ai_proj/decrypt_wxdb/deliverables/decrypted_master/message/message_0.db.plain', { readOnly: true });
const row = db.prepare("select local_type, message_content from Msg_a6a562a09a678f360d9de541570514c5 where local_type=3 and length(message_content)>0 limit 1").get();
const dat = row.message_content;
// 帧头: ss=1, 帧内容大小
const flg = dat[4], ss = (flg >> 5) & 1, fcf = flg >> 6;
const fsb = fcf ? (1 << fcf) : ss;
let bt = 6 - ss + (flg & 3 ? ((flg & 3) == 3 ? 4 : (flg & 3)) : 0) + fsb;
console.log('literals header at bt=', bt, 'byte=', dat[bt]);
const b3 = dat[bt], lbt = b3 & 3, sf = (b3 >> 2) & 3;
console.log('lbt', lbt, 'sf', sf);
// 手工解字面量头 (sf<2 分支)
let lss = b3 >> 4, lcs = 0;
bt++;
lss |= ((dat[bt] & 63) << 4);
lcs = (dat[bt] >> 6) | (dat[bt + 1] << 2);
bt++;
bt++;
console.log('lss', lss, 'lcs', lcs, 'huff table at bt=', bt);
const [bt2, hu] = rhu(dat, bt);
console.log('huff table consumed to', bt2, 'mb', hu.b);
console.log('huff syms:', Array.from(hu.s).join(','));
console.log('huff nb  :', Array.from(hu.n).join(','));
