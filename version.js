/* mod-audit / version.js
 *
 * 统一的版本表示与比较。三家加载器的差异被收敛到两个分派点：
 *   - verParse / verCmp           ← 比较语义（Maven ComparableVersion vs Fabric SemanticVersion）
 *   - verParseConstraint          ← 区间/谓词语法（Maven VersionRange vs Fabric VersionPredicate）
 *
 * 对外只有五个入口：
 *   V.parse(raw, family)              → 版本值
 *   V.cmp(a, b)                       → -1 / 0 / 1（跨家族返回 null）
 *   V.parseConstraint(raw, family)    → 约束
 *   V.satisfies(version, constraint)  → bool
 *   V.text(version)                   → 显示字符串
 *
 * 家族目前支持：'maven'（Forge / NeoForge）。'fabric' 已预留但未实现，
 * 解析时返回 { unsupported: true }，调用方必须显式处理，不许当成"匹配"。
 */
(function (root) {
  'use strict';

  /* ============================== Maven 语义 ============================== */

  // 限定词权重：alpha < beta < milestone < rc < snapshot < 正式 < sp
  // 别名只有四个：ga/final/release → 正式，cr → rc（a/b/m 不是别名）
  var MV_RANK = {
    alpha: 0, beta: 1, milestone: 2, rc: 3, snapshot: 4, '': 5, sp: 6
  };
  var MV_ALIAS = { ga: '', final: '', release: '', cr: 'rc' };

  var NUM = 0, STR = 1;

  function mvQual(tok) {
    var t = tok;
    if (MV_ALIAS[t] !== undefined) t = MV_ALIAS[t];
    if (MV_RANK[t] !== undefined) return { kind: STR, rank: MV_RANK[t], sub: 0, name: t };
    // 未知限定词：排在正式之后（rank 用 6 之后的位置），再按字典序
    var m = /^([a-z_]+)?(\d*)$/.exec(t);
    var base = m && m[1] ? m[1] : t;
    var sub = m && m[2] ? +m[2] : 0;
    if (MV_RANK[base] !== undefined) return { kind: STR, rank: MV_RANK[base], sub: sub, name: base };
    return { kind: STR, rank: 7, sub: sub, name: t };
  }

  /* 解析成 token 数组。
     - '-' 或 '_' 后接数字时插入一个 MARK token（它比任何数字都小），
       这样 1.0-1 < 1.0.1 成立，而 1.0-alpha1 == 1.0-alpha-1 也成立。
     - '+' 之后是 build 元数据，不参与比较。
     - 数字↔字母的交界是一个词边界。 */
  var MARK = { kind: 2 };   // 2 = MARK

  function mvTokenize(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    var buildAt = s.indexOf('+');
    if (buildAt >= 0) s = s.slice(0, buildAt);

    var toks = [];
    var i = 0;
    var n = s.length;
    while (i < n) {
      var c = s[i];
      if (c === '.' || c === '-') {
        // '-' + 数字 → 分隔标记；其余只当词边界
        var nx = s[i + 1] || '';
        var prev = toks.length ? toks[toks.length - 1] : null;
        var prevIsNum = prev && prev.kind === NUM;
        // 只有「数字-数字」才需要分隔标记：1.0-1 < 1.0.1
        // alpha-1 不能插标记，否则 1.0-alpha1 != 1.0-alpha-1
        if (c === '-' && prevIsNum && nx >= '0' && nx <= '9') toks.push(MARK);
        i++;
        continue;
      }
      if (c === '_') { i++; continue; }
      if (c >= '0' && c <= '9') {
        var j = i;
        while (j < n && s[j] >= '0' && s[j] <= '9') j++;
        toks.push({ kind: NUM, val: parseInt(s.slice(i, j), 10) });
        i = j;
        continue;
      }
      var k = i;
      while (k < n && /[a-z_]/.test(s[k])) k++;
      var word = s.slice(i, k);
      toks.push(mvQual(word));
      i = k;
    }
    return toks;
  }

  function mvCmpTok(a, b) {
    if (a === undefined) a = mvDefOf(b);
    if (b === undefined) b = mvDefOf(a);
    // MARK 介于两者之间：限定词 < MARK < 数字
    // 于是 1.0-1 < 1.0.1（对数字小）而 1.0-1 > 1.0-alpha（对限定词大）
    if (a === MARK && b === MARK) return 0;
    if (a === MARK) return b.kind === STR ? 1 : -1;
    if (b === MARK) return a.kind === STR ? -1 : 1;
    // 数字 > 限定词
    if (a.kind === NUM && b.kind !== NUM) return 1;
    if (b.kind === NUM && a.kind !== NUM) return -1;
    if (a.kind === NUM && b.kind === NUM) return a.val === b.val ? 0 : (a.val < b.val ? -1 : 1);
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    if (a.sub !== b.sub) return a.sub < b.sub ? -1 : 1;
    return a.name === b.name ? 0 : (a.name < b.name ? -1 : 1);
  }
  // 缺位补什么：对着数字补 0，对着限定词补「正式」
  function mvDefOf(other) {
    if (!other) return { kind: NUM, val: 0 };
    return other.kind === NUM ? { kind: NUM, val: 0 } : mvQual('');
  }

  function mvCmp(a, b) {
    var n = Math.max(a.toks.length, b.toks.length);
    for (var i = 0; i < n; i++) {
      var c = mvCmpTok(a.toks[i], b.toks[i]);
      if (c !== 0) return c;
    }
    return 0;
  }

  /* ============================== Maven 区间 ============================== */

  function mvParseConstraint(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return { family: 'maven', mode: 'none', clauses: [], raw: s };   // Forge 的 UNBOUNDED：什么都不匹配
    if (s === '*') return { family: 'maven', mode: 'any', clauses: [], raw: s };

    var clauses = [];          // 并集：多个 clause
    var andTerms = [];         // clause 内部：交集（Maven 里少见，留接口）
    var rest = s;
    var any = false;

    while (rest.length) {
      rest = rest.replace(/^\s*/, '');
      if (!rest.length) break;
      var open = rest[0];
      if (open !== '[' && open !== '(') {
        // 裸版本：按「枚举精确版本」解释（本项目的产品语义）。
        // 注意这与 Maven 真实语义相反——Maven 里裸版本是无约束、匹配一切，
        // 但样本库里裸写法（如 "1.21.1"）几乎都是作者想表达「就是这个版本」。
        // 逗号分隔的多个裸版本按枚举并集处理。
        rest.split(',').forEach(function (piece) {
          var one = piece.trim();
          if (!one || /^\$\{.*\}$/.test(one)) return;      // 占位符不算数
          clauses.push({ lo: one, hi: one, loIncl: true, hiIncl: true });
        });
        rest = '';
        break;
      }
      var closeAt = -1;
      for (var i = 1; i < rest.length; i++) {
        if (rest[i] === ']' || rest[i] === ')') { closeAt = i; break; }
      }
      if (closeAt < 0) return { family: 'maven', mode: 'error', error: 'Unbounded range: ' + rest, raw: s };

      var body = rest.slice(1, closeAt);
      var hiOp = rest[closeAt];
      var loIncl = open === '[';
      var hiIncl = hiOp === ']';
      var commaAt = body.indexOf(',');

      if (commaAt < 0) {
        // [1.20.1] → 精确
        var one = body.trim();
        if (!one) return { family: 'maven', mode: 'error', error: 'Empty range', raw: s };
        clauses.push({ lo: one, hi: one, loIncl: true, hiIncl: true });
      } else {
        var loTxt = body.slice(0, commaAt).trim();
        var hiTxt = body.slice(commaAt + 1).trim();
        if (loTxt && hiTxt) {
          var a = verParse(loTxt, 'maven'), b = verParse(hiTxt, 'maven');
          if (a && b && verCmp(a, b) === 0 && loIncl && hiIncl) {
            return { family: 'maven', mode: 'error', error: 'Range cannot have identical boundaries', raw: s };
          }
        }
        clauses.push({ lo: loTxt || null, hi: hiTxt || null, loIncl: loIncl, hiIncl: hiIncl });
      }
      rest = rest.slice(closeAt + 1);
    }

    if (any) return { family: 'maven', mode: 'any', clauses: [], raw: s };
    if (!clauses.length) return { family: 'maven', mode: 'none', clauses: [], raw: s };
    // 逗号分隔/多段区间之间是「并集」：每个区间各自一个 clause（clause 之间 OR）
    return { family: 'maven', mode: 'ranges', clauses: clauses.map(function (r) { return { and: [r] }; }), raw: s };
  }

  /* ============================ Fabric（预留） ============================ */

  function fabricUnsupported(raw) {
    return { family: 'fabric', mode: 'unsupported', clauses: [], raw: String(raw == null ? '' : raw) };
  }

  /* ============================== 对外接口 ============================== */

  function verParse(raw, family) {
    var fam = family || 'maven';
    if (fam === 'fabric') {
      // Fabric 的归一化表未完整还原，宁可返回 null 也不假装能比
      return null;
    }
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    var toks = mvTokenize(s);
    if (!toks.length) return null;
    return { family: 'maven', raw: s, toks: toks };
  }

  function verCmp(a, b) {
    if (!a || !b) return null;
    if (a.family !== b.family) return null;   // 跨家族不可比，调用方必须自己处理
    if (a.family === 'maven') return mvCmp(a, b);
    return null;
  }

  function verText(v) {
    if (!v) return '';
    return v.raw;
  }

  function verParseConstraint(raw, family) {
    var fam = family || 'maven';
    if (fam === 'fabric') return fabricUnsupported(raw);
    return mvParseConstraint(raw);
  }

  function verSatisfies(version, c) {
    if (!c) return null;
    if (c.mode === 'unsupported') return null;
    if (c.mode === 'error') return null;
    if (c.mode === 'any') return true;
    if (!version) return null;
    if (version.family !== c.family) return null;

    for (var i = 0; i < c.clauses.length; i++) {
      var clause = c.clauses[i];
      var ok = true;
      for (var j = 0; j < clause.and.length; j++) {
        var r = clause.and[j];
        if (!oneRange(r, version)) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  function oneRange(r, v) {
    if (r.lo) {
      var lo = verParse(r.lo, v.family);
      if (!lo) return null;
      var cl = verCmp(v, lo);
      if (cl === null) return null;
      if (r.loIncl ? cl < 0 : cl <= 0) return false;
    }
    if (r.hi) {
      var hi = verParse(r.hi, v.family);
      if (!hi) return null;
      var ch = verCmp(v, hi);
      if (ch === null) return null;
      if (r.hiIncl ? ch > 0 : ch >= 0) return false;
    }
    return true;
  }


  /* ============================== Fabric 谓词 ============================== */

  // Fabric 版本：主体是点分数字（可含 x/X/* 通配），"-" 后是预发布串，'+' 后忽略。
  // 空预发布（"26.2-"）表示「该版本的第一个预发布」，比任何具名预发布都小。
  function fabParse(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    var plus = s.indexOf('+');
    if (plus >= 0) s = s.slice(0, plus);
    var dash = s.indexOf('-');
    var main = dash >= 0 ? s.slice(0, dash) : s;
    var pre = dash >= 0 ? s.slice(dash + 1) : null;
    if (main === '') return null;
    var comps = main.split('.');
    for (var i = 0; i < comps.length; i++) {
      if (!/^(\d+|[xX*])$/.test(comps[i])) return null;
    }
    return { comps: comps, pre: pre, raw: s };
  }

  function fabWildcard(p) {
    if (!p) return false;
    return p.comps.some(function (c) { return /^[xX*]$/.test(c); });
  }

  /* 转成 app 侧可直接比较的元组：空预发布用 'preempty' 表示（比 alpha 还小）。 */
  function fabTuple(p) {
    if (!p) return null;
    var out = [];
    for (var i = 0; i < p.comps.length; i++) {
      if (/^[xX*]$/.test(p.comps[i])) break;
      out.push(parseInt(p.comps[i], 10));
    }
    if (p.pre !== null) {
      if (p.pre === '') out.push('preempty');
      else {
        // 预发布按 . 或 - 切，数字段保持数字（与 Fabric 的 token 规则一致）
        p.pre.split(/[.-]/).forEach(function (tok) {
          if (tok === '') return;
          out.push(/^\d+$/.test(tok) ? parseInt(tok, 10) : tok);
        });
      }
    }
    return out.length ? out : null;
  }

  function fabBump(p) {
    // 把通配位 +1，得到上界（不含）
    var comps = p.comps.map(function (c) { return /^[xX*]$/.test(c) ? '0' : c; });
    for (var i = comps.length - 1; i >= 0; i--) {
      var n = parseInt(comps[i], 10);
      comps[i] = String(n + 1);
      for (var j = i + 1; j < comps.length; j++) comps[j] = '0';
      break;
    }
    return fabTuple({ comps: comps, pre: null });
  }

  /* 解析 Fabric 谓词字符串 → 区间集合（以字符串形式返回上下界，交给调用方转元组）。
     支持：>=, <=, >, <, =, ~, ^, 以及 "1.2.x" 这类通配、空格 AND 与 "*" / 空串。 */
  function fabRange(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '' || s === '*') return { kind: 'any' };
    var terms = s.split(/\s+/).filter(Boolean);
    var lo = null, hi = null, loIncl = true, hiIncl = false;

    function tighten(nlo, nhi, nloIncl, nhiIncl) {
      if (nlo) { lo = nlo; loIncl = nloIncl; }
      if (nhi) { hi = nhi; hiIncl = nhiIncl; }
    }

    for (var i = 0; i < terms.length; i++) {
      var tok = terms[i];
      if (tok === '*') continue;
      var m = /^(>=|<=|>|<|=|~|\^)(.*)$/.exec(tok);
      var op = m ? m[1] : '=';
      var body = m ? m[2] : tok;
      if (!body) return { kind: 'unsupported' };
      var p = fabParse(body);
      if (!p) return { kind: 'unsupported' };

      if (fabWildcard(p)) {
        if (op !== '=') return { kind: 'unsupported' };   // 通配只允许 = 或无运算符
        var real = p.comps.filter(function (c) { return !/^[xX*]$/.test(c); });
        if (!real.length) return { kind: 'any' };
        var base = { comps: real, pre: '', raw: body };  // 基版本预发布置空（含全部预发布）
        var baseT = fabTuple(base);
        // 通配展开：26.x → [26, 27) / 1.21.x → [1.21-, 1.22) / 1.21.5.x → [1.21.5-, 1.21.6)
        tighten(baseT, fabBump(base), true, false);
        continue;
      }

      var self = fabTuple(p);
      if (op === '=') { tighten(self, self, true, true); }
      else if (op === '>=') { tighten(self, null, true, false); }
      else if (op === '>') { tighten(self, null, false, false); }
      else if (op === '<=') { tighten(null, self, true, true); }
      else if (op === '<') { tighten(null, self, true, false); }
      else if (op === '~' || op === '^') {
        // ~1.21 → [1.21, 1.22)   ^1.21 → [1.21, 2)
        var keep = op === '~' ? Math.min(2, p.comps.length) : 1;
        var upperComps = [];
        for (var k = 0; k < keep; k++) upperComps.push(/^[xX*]$/.test(p.comps[k]) ? '0' : p.comps[k]);
        var lastIdx = upperComps.length - 1;
        upperComps[lastIdx] = String(parseInt(upperComps[lastIdx], 10) + 1);
        tighten(self, fabTuple({ comps: upperComps, pre: null }), true, false);
      }
    }
    if (!lo && !hi) return { kind: 'any' };
    return { kind: 'range', lo: lo, hi: hi, loIncl: loIncl, hiIncl: hiIncl };
  }

  var api = {
    parse: verParse,
    cmp: verCmp,
    text: verText,
    parseConstraint: verParseConstraint,
    satisfies: verSatisfies,
    fabricRange: fabRange,
    fabricTuple: fabTuple,
    fabricParse: fabParse
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V = api;

})(typeof window !== 'undefined' ? window : globalThis);
