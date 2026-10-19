/* mod-audit / analyzer.js
 * 纯 JS，零依赖。浏览器用 <script src="analyzer.js"> 引入（挂到 window.ModAudit），Node 用 require 引入。
 * 只读字节，永不执行被分析的代码。
 *
 * 负责：解 ZIP → 读加载器元数据（含 jar-in-jar 嵌套）→ 找 mixin 配置 → 解析 mixin 类注解 → 建目标表 → 出检查结论
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(true);
  else root.ModAudit = factory(false);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (isNode) {
  'use strict';

  const MAX_ENTRY = 64 * 1024 * 1024;   // 单个条目解压上限
  const MAX_TOTAL = 512 * 1024 * 1024;  // 单个 jar 解压总量上限（防 zip 炸弹）
  const MAX_JSON = 4 * 1024 * 1024;     // 单个 json 读取上限
  const MAX_NESTED = 40;                // 单个 jar 里最多展开多少个嵌套 jar
  const MAX_DEPTH = 2;                  // 嵌套 jar 递归深度

  const decoder = new TextDecoder('utf-8');
  function utf8(b) { return decoder.decode(b); }

  /* JSON 容错：现实里有 mod 把裸控制字符写进字符串，JSON.parse 会炸 */
  function tryParseJson(text) {
    if (text == null) return null;
    try { return JSON.parse(text); } catch (e) { /* 走修复分支 */ }
    try { return JSON.parse(text.replace(/[\x00-\x1F]+/g, ' ')); } catch (e) { return null; }
  }

  /* =====================================================================
   * 1. 解压（浏览器用 DecompressionStream，Node 用 zlib）
   * ===================================================================== */
  function inflateRaw(bytes) {
    if (isNode) {
      const zlib = require('zlib');
      return Promise.resolve(new Uint8Array(zlib.inflateRawSync(bytes)));
    }
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('浏览器过旧：缺少 DecompressionStream（需 Chrome 103+/Firefox 113+/Safari 16.4+）'));
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(b => new Uint8Array(b));
  }

  function unzip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 0x10000 - 22);
    for (let i = bytes.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 结尾记录，不是合法的 jar');

    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('Zip64 暂不支持');

    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录损坏');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    let spent = 0;
    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.compSize === 0xffffffff || e.uncompSize === 0xffffffff) throw new Error('Zip64 条目暂不支持: ' + name);
      if (e.uncompSize > MAX_ENTRY) throw new Error('条目过大，已跳过: ' + name);
      spent += e.uncompSize;
      if (spent > MAX_TOTAL) throw new Error('单 jar 解压总量超限（疑似 zip 炸弹）');
      const at = e.localOffset;
      if (dv.getUint32(at, true) !== 0x04034b50) throw new Error('本地文件头损坏: ' + name);
      const ln = dv.getUint16(at + 26, true);
      const le = dv.getUint16(at + 28, true);
      const start = at + 30 + ln + le;
      const raw = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return await inflateRaw(raw);
      throw new Error('不支持的压缩方式 ' + e.method + ': ' + name);
    }

    return { entries, read };
  }

  /* =====================================================================
   * 2. 类文件解析（只取常量池 + 注解 + 方法表）
   * ===================================================================== */
  function parseClass(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    const u1 = () => { const v = dv.getUint8(p); p += 1; return v; };
    const u2 = () => { const v = dv.getUint16(p); p += 2; return v; };
    const u4 = () => { const v = dv.getUint32(p); p += 4; return v; };

    if (u4() !== 0xCAFEBABE) throw new Error('不是 class 文件');
    u2(); u2(); // minor, major

    const cpCount = u2();
    const cp = new Array(cpCount);
    for (let i = 1; i < cpCount; i++) {
      const tag = u1();
      switch (tag) {
        case 1: { const len = u2(); cp[i] = { tag, s: utf8(bytes.subarray(p, p + len)) }; p += len; break; }
        case 3: case 4: cp[i] = { tag, v: u4() }; break;
        case 5: case 6: cp[i] = { tag }; u4(); u4(); i++; break; // long/double 占两个槽
        case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, idx: u2() }; break;
        case 15: cp[i] = { tag, kind: u1(), idx: u2() }; break;
        case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: u2(), b: u2() }; break;
        default: throw new Error('未知常量池 tag ' + tag);
      }
    }

    const utf8Of = (i) => (cp[i] && cp[i].tag === 1 ? cp[i].s : null);
    const classNameOf = (i) => (cp[i] && cp[i].tag === 7 ? utf8Of(cp[i].idx) : null);

    function parseAnnotation() {
      const type = utf8Of(u2());
      const pairs = {};
      const n = u2();
      for (let i = 0; i < n; i++) {
        const key = utf8Of(u2());
        pairs[key] = parseElementValue();
      }
      return { type: descToClassName(type), pairs };
    }
    function parseElementValue() {
      const tag = String.fromCharCode(u1());
      switch (tag) {
        case 's': return utf8Of(u2());
        case 'B': case 'C': case 'D': case 'F': case 'I': case 'J': case 'S': case 'Z': {
          const idx = u2();
          const cv = cp[idx];
          // Integer 常量在常量池里已带值；解出来 priority / require / cancellable 才读得到
          return { constIdx: idx, value: cv && (cv.tag === 3 || cv.tag === 4) ? cv.v : null };
        }
        case 'e': { const t = utf8Of(u2()); const v = utf8Of(u2()); return { enumType: t, enumValue: v }; }
        case 'c': return { classDesc: utf8Of(u2()) };
        case '@': return parseAnnotation();
        case '[': { const n = u2(); const arr = []; for (let i = 0; i < n; i++) arr.push(parseElementValue()); return arr; }
        default: throw new Error('未知注解值 tag ' + tag);
      }
    }
    function parseAnnotations() {
      const n = u2();
      const out = [];
      for (let i = 0; i < n; i++) out.push(parseAnnotation());
      return out;
    }

    u2(); // access flags
    const thisClass = classNameOf(u2());
    u2(); // super
    const interfaces = [];
    for (let i = u2(); i > 0; i--) interfaces.push(classNameOf(u2()));

    function readMembers() {
      const count = u2();
      const out = [];
      for (let i = 0; i < count; i++) {
        u2(); // access
        const name = utf8Of(u2());
        const desc = utf8Of(u2());
        let anns = [];
        const attrCount = u2();
        for (let j = 0; j < attrCount; j++) {
          const attrName = utf8Of(u2());
          const len = u4();
          const start = p;
          // mixin 的注解是 CLASS retention，所以要看 RuntimeInvisibleAnnotations
          if (attrName === 'RuntimeInvisibleAnnotations' || attrName === 'RuntimeVisibleAnnotations') {
            anns = anns.concat(parseAnnotations());
          }
          p = start + len;
        }
        out.push({ name, desc, annotations: anns });
      }
      return out;
    }

    const fields = readMembers();
    const methods = readMembers();

    let classAnns = [];
    const attrCount = u2();
    for (let i = 0; i < attrCount; i++) {
      const attrName = utf8Of(u2());
      const len = u4();
      const start = p;
      if (attrName === 'RuntimeInvisibleAnnotations' || attrName === 'RuntimeVisibleAnnotations') {
        classAnns = classAnns.concat(parseAnnotations());
      }
      p = start + len;
    }

    return { name: thisClass, interfaces, methods, fields, annotations: classAnns };
  }

  function descToClassName(desc) {
    if (!desc) return '';
    if (desc.startsWith('L') && desc.endsWith(';')) return desc.slice(1, -1).replace(/\//g, '.');
    return desc.replace(/\//g, '.');
  }

  /** @Mixin(targets="a/b/C") 是字符串形式，必须归一化成点分名，否则和其它 mod 配不上 */
  function normTargetName(s) {
    if (typeof s !== 'string') return s;
    let x = s.trim();
    if (x.length > 2 && x.startsWith('L') && x.endsWith(';')) x = x.slice(1, -1);
    return x.replace(/\//g, '.');
  }

  /* =====================================================================
   * 3. 元数据解析
   * ===================================================================== */
  function parseManifest(text) {
    const out = {};
    let lastKey = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith(' ')) { if (lastKey) out[lastKey] += line.slice(1); continue; }
      const i = line.indexOf(':');
      if (i < 0) continue;
      lastKey = line.slice(0, i).trim();
      out[lastKey] = line.slice(i + 1).trim();
    }
    return out;
  }

  // TOML 子集：够读 mods.toml / neoforge.mods.toml
  function parseToml(text) {
    const rootObj = {};
    let cur = rootObj;
    const lines = text.split(/\r?\n/);

    const pathOf = (s) => s.split('.').map(x => x.trim().replace(/^["']|["']$/g, ''));
    const newTable = (path) => {
      const parts = pathOf(path);
      let node = rootObj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      const last = parts[parts.length - 1];
      if (!node[last] || typeof node[last] !== 'object' || Array.isArray(node[last])) node[last] = {};
      return node[last];
    };
    const newArrayTable = (path) => {
      const parts = pathOf(path);
      let node = rootObj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      const last = parts[parts.length - 1];
      if (!Array.isArray(node[last])) node[last] = [];
      const obj = {};
      node[last].push(obj);
      return obj;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('[[')) {
        const end = line.indexOf(']]');
        if (end < 0) continue;
        cur = newArrayTable(line.slice(2, end));
        continue;
      }
      if (line.startsWith('[')) {
        const end = line.indexOf(']');
        if (end < 0) continue;
        cur = newTable(line.slice(1, end));
        continue;
      }

      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
      const rest = line.slice(eq + 1).trim();

      if (rest.startsWith('"""') || rest.startsWith("'''")) {
        const q = rest.slice(0, 3);
        let body = rest.slice(3);
        while (!body.includes(q) && i + 1 < lines.length) body += '\n' + lines[++i];
        const endIdx = body.indexOf(q);
        cur[key] = endIdx >= 0 ? body.slice(0, endIdx) : body;
        continue;
      }

      let val = rest;
      let inStr = null;
      for (let k = 0; k < val.length; k++) {
        const c = val[k];
        if (inStr) {
          if (c === '\\' && inStr === '"') { k++; continue; }
          if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'") {
          inStr = c;
        } else if (c === '#') {
          val = val.slice(0, k);
          break;
        }
      }
      cur[key] = parseTomlValue(val.trim());
    }
    return rootObj;
  }

  function parseTomlValue(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try { return JSON.parse(v); } catch (e) { return v.slice(1, -1); }
    }
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(s => parseTomlValue(s.trim()));
    }
    return v;
  }

  // Forge 的 mods.toml 里会出现 ${file.jarVersion}，用 MANIFEST 的 Implementation-Version 替换
  function substituteJarVersion(obj, ver) {
    if (!ver) return obj;
    try {
      const json = JSON.stringify(obj).replace(/\$\{file\.jarVersion\}/g, JSON.stringify(ver).slice(1, -1));
      return JSON.parse(json);
    } catch (e) { return obj; }
  }

  /* ---- 版本号与区间 ---- */
  function cmpVer(a, b) {
    const pa = String(a).split(/[.\-+_]/).map(x => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.\-+_]/).map(x => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function parseMavenRange(r) {
    const m = /^([\[(])\s*([^,\]]*)\s*,\s*([^)\]]*)\s*([\])])$/.exec(r || '');
    if (!m) return null;
    return { lo: m[2] || null, loInc: m[1] === '[', hi: m[3] || null, hiInc: m[4] === ']' };
  }
  function inMavenRange(ver, r) {
    if (!r.lo && !r.hi) return true;
    if (r.lo) {
      const c = cmpVer(ver, r.lo);
      if (c < 0) return false;
      if (!r.loInc && c === 0) return false;
    }
    if (r.hi) {
      const c = cmpVer(ver, r.hi);
      if (c > 0) return false;
      if (!r.hiInc && c === 0) return false;
    }
    return true;
  }

  function inFabricPredicate(ver, pred) {
    if (!pred || pred.trim() === '*' || pred.trim() === '') return true;
    for (const raw of pred.trim().split(/\s+/)) {
      const t = raw.trim();
      if (!t || t === '*') continue;
      let m;
      if ((m = /^>=\s*(.+)$/.exec(t))) { if (cmpVer(ver, m[1]) < 0) return false; continue; }
      if ((m = /^<=\s*(.+)$/.exec(t))) { if (cmpVer(ver, m[1]) > 0) return false; continue; }
      if ((m = /^>\s*(.+)$/.exec(t))) { if (cmpVer(ver, m[1]) <= 0) return false; continue; }
      if ((m = /^<\s*(.+)$/.exec(t))) { if (cmpVer(ver, m[1]) >= 0) return false; continue; }
      if ((m = /^~(.+)$/.exec(t))) {
        const base = m[1].split('.');
        if (cmpVer(ver, m[1]) < 0) return false;
        const hi = base.slice(0, 2).join('.') + '.' + (parseInt(base[2] || '0', 10) + 1000);
        if (cmpVer(ver, hi) >= 0) return false;
        continue;
      }
      if ((m = /^=?\s*([\w.\-]+)[.\*]$/.exec(t))) {
        if (!String(ver).startsWith(m[1] + '.')) return false;
        continue;
      }
      if (cmpVer(ver, t) !== 0) return false;
    }
    return true;
  }

  function versionSatisfies(ver, range, style) {
    if (!range) return true;
    if (style === 'fabric') return inFabricPredicate(ver, range);
    const r = parseMavenRange(range);
    if (r) return inMavenRange(ver, r);
    return inFabricPredicate(ver, range);
  }

  /** 从一个版本区间里猜一个具体的 MC 版本（用来在版本 json 缺失时推定） */
  function guessVersionFromRange(range, style) {
    if (!range) return null;
    if (style === 'forge') {
      const r = parseMavenRange(range);
      if (r && r.lo) return r.lo;
    }
    const m = />=\s*([\w.\-]+)/.exec(range) || /^~([\w.\-]+)/.exec(range) || /^([\d][\w.\-]*)/.exec(range);
    return m ? m[1] : null;
  }

  /* ---- version.json ---- */
  const NON_MOD_IDS = new Set(['minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric-loader', 'fabric', 'java', 'javafml', 'lowcodefml', 'mcp']);

  function parseVersionJson(text) {
    const o = tryParseJson(text);
    if (!o) return null;
    const libs = (o.libraries || []).map(l => (l && l.name) || '');
    const pick = (pred) => libs.find(pred) || null;

    let loader = 'unknown', loaderVer = null;
    // 注意：必须带冒号，否则 net.minecraftforge:forge 会匹配到 forgespi
    const neo = pick(n => n.startsWith('net.neoforged:neoforge:'));
    const forge = pick(n => n.startsWith('net.minecraftforge:forge:'));
    const fabric = pick(n => n.startsWith('net.fabricmc:fabric-loader:'));
    if (neo) { loader = 'neoforge'; loaderVer = neo.split(':')[2] || null; }
    else if (forge) { loader = 'forge'; loaderVer = forge.split(':')[2] || null; }
    else if (fabric) { loader = 'fabric'; loaderVer = fabric.split(':')[2] || null; }
    else if (libs.some(n => /^net\.neoforged/.test(n))) { loader = 'neoforge'; }
    else if (libs.some(n => /^net\.minecraftforge/.test(n))) { loader = 'forge'; }
    else if (o.mainClass && /fabric/i.test(o.mainClass)) { loader = 'fabric'; }

    // 优先级：clientVersion（加载器/启动器写的真实 MC 版本）> inheritsFrom > id
    // 实测版本目录里 id 常带加载器后缀（"1.21.11-rc1-Fabric 0.20.0"），真版本在 clientVersion
    let mcVersion = o.clientVersion || o.inheritsFrom || null;
    let mcSource = o.clientVersion ? 'clientVersion' : (o.inheritsFrom ? 'inheritsFrom' : null);
    // id 兜底：既接受 1.21.10 / 26.1 这种，也接受 25w35a 这种周快照
    if (!mcVersion && o.id && /^(\d+\.\d+|\d{2}w\d{2}[a-z])/i.test(String(o.id))) { mcVersion = o.id; mcSource = 'id'; }
    if (!mcVersion && forge) {
      const m = /^[^:]+:[^:]+:(\d+\.\d+(?:\.\d+)?)/.exec(forge);
      if (m) { mcVersion = m[1]; mcSource = 'forge-lib'; }
    }
    if (!mcVersion && neo) {
      const m = /^[^:]+:[^:]+:(\d+)\.(\d+)/.exec(neo);
      if (m) { mcVersion = '1.' + m[1] + '.' + m[2]; mcSource = 'neoforge-lib'; }
    }

    // 版本 json 里还能读到不少元信息，一并带出去（根节点面板用）
    const javaMajor = (o.javaVersion && o.javaVersion.majorVersion) || null;
    const assetIndex = (o.assetIndex && o.assetIndex.id) || null;
    const clientDl = (o.downloads && o.downloads.client) || null;

    return {
      id: o.id || null,
      loader, loaderVersion: loaderVer,
      mcVersion, mcSource,
      mainClass: o.mainClass || null,
      javaMajor,
      assetIndex,
      libraryCount: (o.libraries || []).length,
      clientSize: clientDl ? (clientDl.size || null) : null,
      clientSha1: clientDl ? (clientDl.sha1 || null) : null,
      releaseTime: o.releaseTime || null,
      type: o.type || null
    };
  }

  /* =====================================================================
   * 4. mixin 解析
   * ===================================================================== */
  /* 注入器对「目标」的所有权分类：这才是决定两个 mod 撞不撞的东西 */
  const CLAIM = {
    Overwrite: 'body',             // 整个方法体
    Redirect: 'exclusive',         // 单条指令，独占
    ModifyConstant: 'exclusive',
    WrapOperation: 'chain',        // 单条指令，可嵌套替换
    WrapWithCondition: 'value',
    ModifyExpressionValue: 'value',
    ModifyReturnValue: 'value',
    ModifyArgs: 'value',
    ModifyArg: 'value',
    ModifyVariable: 'value',
    Inject: 'add'                  // 纯插入
  };
  const CLAIM_WEIGHT = { body: 3, exclusive: 2, chain: 2, value: 1, add: 0 };
  const KIND_WEIGHT = {};          // 给 UI 着色用，由 CLAIM 派生，避免两套标准
  Object.keys(CLAIM).forEach(k => { KIND_WEIGHT[k] = CLAIM_WEIGHT[CLAIM[k]]; });

  function annInt(p) {
    if (p == null) return null;
    if (typeof p === 'number') return p;
    if (typeof p === 'object' && typeof p.value === 'number') return p.value;
    return null;
  }
  function annBool(p) {
    if (p === true) return true;
    if (typeof p === 'object' && typeof p.value === 'number') return p.value !== 0;
    return false;
  }

  /** 归一化 @At.target，用来判断「是不是同一条指令」。刻意保留 owner，不去掉 */
  function normAt(t) {
    if (!t) return null;
    return String(t).replace(/\s+/g, '');
  }

  function extractInjections(cls) {
    const ann = cls.annotations.find(a => a.type === 'org.spongepowered.asm.mixin.Mixin');
    if (!ann) return { targets: [], points: [], priority: null };

    const priority = annInt(ann.pairs.priority);
    const targets = [];
    const v = ann.pairs.value;
    if (Array.isArray(v)) for (const e of v) if (e && e.classDesc) targets.push(descToClassName(e.classDesc));
    if (typeof v === 'string') targets.push(descToClassName(v));
    const t = ann.pairs.targets;
    if (Array.isArray(t)) for (const e of t) if (typeof e === 'string') targets.push(normTargetName(e));
    else if (typeof t === 'string') targets.push(normTargetName(t));

    const points = [];
    for (const m of cls.methods) {
      for (const a of m.annotations) {
        const simple = a.type.split('.').pop();
        if (!CLAIM.hasOwnProperty(simple)) continue;

        let methods = [];
        const mv = a.pairs.method;
        if (typeof mv === 'string') methods.push(mv);
        else if (Array.isArray(mv)) for (const e of mv) if (typeof e === 'string') methods.push(e);
        if (!methods.length && simple === 'Overwrite') methods = [m.name];

        // @At：以前解析了却被丢掉，而它正是「同不同一条指令」的唯一依据
        const ats = Array.isArray(a.pairs.at) ? a.pairs.at : (a.pairs.at ? [a.pairs.at] : []);
        const at = ats[0] || null;
        const atValue = at && at.pairs && typeof at.pairs.value === 'string' ? at.pairs.value : null;
        const atTarget = at && at.pairs && typeof at.pairs.target === 'string' ? at.pairs.target : null;
        const atOrdinal = at && at.pairs ? annInt(at.pairs.ordinal) : null;
        const require = annInt(a.pairs.require);
        const cancellable = annBool(a.pairs.cancellable);

        for (const mm of methods) {
          const lp = mm.indexOf('(');
          const name = (lp >= 0 ? mm.slice(0, lp) : mm).trim();
          if (!name) continue;
          const selDesc = lp >= 0 ? mm.slice(lp) : null;
          points.push({
            kind: simple,
            method: name,
            // 选择器自带描述符就用它；@Overwrite 用混入方法自身的描述符
            desc: selDesc || (simple === 'Overwrite' ? (m.desc || null) : null),
            mixinMethod: m.name,
            atValue, atTarget, atOrdinal,
            priority, require, cancellable,
            wildcard: name === '*' || name.indexOf('*') >= 0
          });
        }
      }
    }
    return { targets, points, priority };
  }

  /**
   * 配对打分：输入是「同一个 目标方法(+描述符) 上的所有注入」，只回答
   * 「这两个 mod 之间会不会出事」。单模组自身的问题不在这里判。
   */
  function grade(entries) {
    const mods = new Set(entries.map(e => e.mod));
    if (mods.size < 2) return null;

    const by = (f) => entries.filter(f);
    const ow = by(e => e.kind === 'Overwrite');

    if (ow.length >= 2) {
      return {
        level: 'high', kind: 'overwrite-pair',
        title: '@Overwrite 重叠：可能有一方的实现被跳过',
        why: 'Mixin 的已知行为是打 WARN 后跳过后者（不是崩溃），但实际以谁为准取决于运行时，静态分析无法确认',
        hint: 'priority：' + ow.map(e => e.mod + '(' + (e.priority == null ? '默认 1000' : e.priority) + ')').join(' vs ') +
          '（数字大的一方更可能被跳过）'
      };
    }

    if (ow.length === 1) {
      const anchored = entries.filter(e => e.kind !== 'Overwrite' && e.atTarget);
      if (anchored.length) {
        return {
          level: 'med', kind: 'overwrite-vs-anchored',
          title: '方法体可能被 @Overwrite 整个换掉，而另有注入锚在具体指令上',
          why: '那条指令可能已不在（导致 0/N），也可能仍落在替换后的方法体里；静态上分不出来'
        };
      }
      return null;   // @Overwrite + HEAD/TAIL：可共存，不再连线
    }

    const ex = by(e => CLAIM[e.kind] === 'exclusive');
    // 锚点 = @At 的 (value, target, ordinal) 三元组。
    // 只比 target 会把「同一方法里 ordinal=0 和 ordinal=1 的两处调用」误判成抢同一处。
    const anchorKey = (e) => {
      const t = normAt(e.atTarget);
      if (!t) return null;
      const ord = e.atOrdinal == null ? 0 : e.atOrdinal;   // 没写 ordinal 等价于 0（取第一处）
      return (e.atValue || 'INVOKE') + '|' + t + '|' + ord;
    };
    const exAnchors = ex.map(anchorKey).filter(Boolean);
    const dup = exAnchors.filter((a, i) => exAnchors.indexOf(a) !== i);
    if (dup.length) {
      return {
        level: 'high', kind: 'anchor-clash',
        title: '@Redirect / @ModifyConstant 可能抢同一条指令',
        why: '同一锚点上的独占注入可能互相顶掉，常见后果是 "Critical injection failure (0/1)"；静态分析只能提示风险，不能确认运行时是否真的如此',
        hint: '冲突指令：' + [...new Set(dup)].join('  /  ')
      };
    }

    const wrapClash = by(e => e.kind === 'WrapOperation').some(w => {
      const wk = anchorKey(w);
      return !!wk && ex.some(e => anchorKey(e) === wk);
    });
    if (wrapClash) {
      return {
        level: 'high', kind: 'wrap-vs-redirect',
        title: '@WrapOperation 与 @Redirect 可能抢同一条指令',
        why: 'WrapOperation 在 order=1000 应用、Redirect 在 order=10000；按这个顺序 wrap 可能先把指令搬走，使 Redirect 找不到目标'
      };
    }

    // 独占但锚点不同 → 可共存，不再连线
    if (ex.length) return null;

    // 低档（灰蓝「可共存」）已移除：这类关系数量占绝大多数，但信息量低，
    // 且渲染开销集中在它们身上。cancellable / additive 的信息仍能在
    // 注入点面板与右侧详情里看到，只是不再连成线。
    return null;
  }

  /* =====================================================================
   * 5. 从 jar 里读元数据（顶层 + 嵌套 jar 复用）
   * ===================================================================== */
  async function readJarMeta(zip, readText) {
    const has = (n) => zip.entries.has(n);
    const out = {
      loaders: [], ids: [], mcRange: null,
      forgeDeps: [], forgeIncompatible: [], mixinsDecl: [], depends: {}, provides: []
    };

    // ---- Fabric 签名 ----
    if (has('fabric.mod.json')) {
      const meta = tryParseJson(await readText('fabric.mod.json'));
      if (meta) {
        out.loaders.push('fabric');
        out.ids.push({ id: meta.id || null, version: meta.version || null, name: meta.name || meta.id || null, source: 'fabric' });
        if (typeof meta.description === 'string') out.desc = meta.description;
        else if (meta.description && typeof meta.description === 'object') {
          out.desc = meta.description.zh_cn || meta.description.en_us || Object.values(meta.description)[0] || null;
        }
        const mc = meta.depends && meta.depends.minecraft;
        if (typeof mc === 'string' && !out.mcRange) out.mcRange = { style: 'fabric', range: mc };
        // Fabric 的 provides：这个模组额外「提供」哪些 modId。
        // 依赖解析认它，漏读会把「有人提供」误判成「缺依赖」。
        if (Array.isArray(meta.provides)) {
          for (const p of meta.provides) {
            if (typeof p === 'string' && p && out.provides.indexOf(p) < 0) out.provides.push(p);
          }
        }
        for (const c of normalizeFabricMixins(meta.mixins)) out.mixinsDecl.push(c);
        out.depends = Object.assign(out.depends, meta.depends || {});
      }
    }

    // ---- Forge / NeoForge 签名 ----
    // 注意：两者可以和 fabric 签名同时存在（多加载器通用包），所以不能用 else if。
    // 另：NeoForge ≤1.20.4 用的也是 META-INF/mods.toml，靠这个区分不出来，故当作同一 family。
    const tomlPath = has('META-INF/neoforge.mods.toml') ? 'META-INF/neoforge.mods.toml'
      : (has('META-INF/mods.toml') ? 'META-INF/mods.toml' : null);
    if (tomlPath) {
      const family = tomlPath.indexOf('neoforge') >= 0 ? 'neoforge' : 'forge';
      let toml = parseToml((await readText(tomlPath)) || '');
      const manifestTxt = has('META-INF/MANIFEST.MF') ? (await readText('META-INF/MANIFEST.MF')) : null;
      if (manifestTxt) {
        const mf = parseManifest(manifestTxt);
        toml = substituteJarVersion(toml, mf['Implementation-Version']);
        out.manifest = mf;
      }
      out.loaders.push(family);
      out.tomlPath = tomlPath;

      const modsArr = Array.isArray(toml.mods) ? toml.mods : [];
      for (const m of modsArr) {
        if (!m || !m.modId) continue;
        out.ids.push({ id: String(m.modId), version: m.version || null, name: m.displayName || m.modId, source: family });
        if (!out.desc && typeof m.description === 'string') out.desc = m.description;
      }

      const deps = toml.dependencies || {};
      for (const key of Object.keys(deps)) {
        const arr = Array.isArray(deps[key]) ? deps[key] : [];
        for (const d of arr) {
          if (!d) continue;
          if (d.modId === 'minecraft' && d.versionRange && !out.mcRange) {
            out.mcRange = { style: 'forge', range: String(d.versionRange) };
          }
          if (!d.modId) continue;
          // NeoForge 用 type="required|optional|incompatible|discouraged" 取代了旧的 mandatory 布尔
          const type = d.type ? String(d.type).toLowerCase() : null;
          const mandatory = type ? (type === 'required') : (d.mandatory !== false && String(d.mandatory) !== 'false');
          if (type === 'incompatible') {
            out.forgeIncompatible.push({ modId: String(d.modId), range: d.versionRange ? String(d.versionRange) : null });
            continue;
          }
          out.forgeDeps.push({
            modId: String(d.modId),
            mandatory,
            type,
            range: d.versionRange ? String(d.versionRange) : null
          });
        }
      }
    }

    // 同一个 modId 可能从两套元数据里各读一次，去重
    const seen = new Set();
    out.ids = out.ids.filter(i => {
      if (!i.id) return true;
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
    if (!out.ids.length) out.ids.push({ id: null, version: null, name: null, source: null });

    // ---- 客户端 / 服务端归属 ----
    // 优先级：Fabric environment（明确声明）> displayTest（强暗示）> 入口点 > 类引用（启发式）
    if (out.fabricEnv === 'client') out.side = { value: 'client', source: 'fabric.mod.json environment' };
    else if (out.fabricEnv === 'server') out.side = { value: 'server', source: 'fabric.mod.json environment' };
    else if (out.fabricEnv === '*') out.side = { value: 'both', source: 'fabric.mod.json environment=*' };
    else if (out.displayTest && /^IGNORE_(ALL|SERVER)_VERSION$/i.test(out.displayTest)) out.side = { value: 'client', source: 'displayTest=' + out.displayTest };
    else if (out.displayTest && /^MATCH_VERSION$/i.test(out.displayTest)) out.side = { value: 'both', source: 'displayTest=MATCH_VERSION' };
    else if (out.hasMainEntry && !out.hasClientEntry) out.side = { value: 'server', source: '仅有 main 入口点' };
    else if (out.hasClientEntry && !out.hasMainEntry) out.side = { value: 'client', source: '仅有 client 入口点' };
    else if (out.hasClientEntry && out.hasMainEntry) out.side = { value: 'both', source: '同时有 main 与 client 入口' };
    else {
      // 元数据没给结论时，看类文件引用了哪一侧的 Minecraft 类（启发式，不是定论）
      let clientRefs = 0, serverRefs = 0, scanned = 0;
      const dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('latin1') : null;
      for (const p of zip.entries.keys()) {
        if (!/\.class$/.test(p)) continue;
        if (scanned >= 60) break;
        scanned++;
        try {
          const s = dec ? dec.decode(await zip.read(p)) : '';
          if (s.indexOf('net/minecraft/client/') >= 0) clientRefs++;
          if (s.indexOf('net/minecraft/server/') >= 0) serverRefs++;
        } catch (e) { }
      }
      if (clientRefs && !serverRefs) out.side = { value: 'client', source: '类引用（' + clientRefs + '/' + scanned + ' 个类引用 client 包）' };
      else if (serverRefs && !clientRefs) out.side = { value: 'server', source: '类引用（' + serverRefs + '/' + scanned + ' 个类引用 server 包）' };
      else if (clientRefs && serverRefs) out.side = { value: 'both', source: '类引用（两侧都有）' };
      else out.side = { value: 'unknown', source: null };
    }
    return out;
  }

  function normalizeFabricMixins(mixins) {
    if (!mixins) return [];
    const list = Array.isArray(mixins) ? mixins : [mixins];
    const out = [];
    for (const it of list) {
      if (typeof it === 'string') out.push(it);
      else if (it && typeof it.config === 'string') out.push(it.config);
    }
    return out;
  }

  /* =====================================================================
   * 6. 单个 jar 的分析（含嵌套 jar 的 modId 收集）
   * ===================================================================== */
  async function analyzeJar(name, bytes) {
    const mod = {
      file: name,
      loader: 'unknown',
      ids: [],
      nested: [],
      mcRange: null,
      namespace: null,
      mixinConfigs: [],
      targets: [],
      problems: [],
      error: null
    };

    let zip;
    try { zip = unzip(bytes); }
    catch (e) { mod.error = '无法解压: ' + e.message; return mod; }

    const has = (n) => zip.entries.has(n);
    const readText = async (n) => {
      const e = zip.entries.get(n);
      if (!e) return null;
      if (e.uncompSize > MAX_JSON) return null;
      return utf8(await zip.read(n));
    };

    const meta = await readJarMeta(zip, readText);

    // 代码量：class 条目数与解压后字节数（用来给节点定大小 / 排序）
    let klass = 0, klassBytes = 0;
    for (const e of zip.entries.values()) {
      if (!/\.class$/i.test(e.name)) continue;
      klass++;
      klassBytes += e.uncompSize;
    }
    // 任取一个 class 读 major 号 → 该 mod 的编译目标 Java（比任何声明都准）
    let javaMajor = null;
    try {
      const anyClass = Array.from(zip.entries.keys()).find(n => n.endsWith('.class'));
      if (anyClass) {
        const cb = await zip.read(anyClass);
        if (cb && cb.length > 8) {
          const major = ((cb[6] & 0xff) << 8) | (cb[7] & 0xff);
          if (major >= 45 && major <= 99) javaMajor = major - 44;   // 65 → Java 21
        }
      }
    } catch (e) { }
    mod.javaMajor = javaMajor;

    mod.code = { classes: klass, bytes: klassBytes };
    mod.jarSize = bytes.length;
    mod.desc = meta.desc ? String(meta.desc).replace(/\s+/g, ' ').trim().slice(0, 180) : '';

    // 注意：不从文件名猜 MC 版本。文件名是任意的，猜出来的值没法当成事实，
    // 宁可在报表里显示「未声明」。可信来源只有 mods.toml 里的 minecraft 依赖区间。

    mod.loaders = meta.loaders || [];
    mod.loader = mod.loaders.length ? mod.loaders.join('+') : 'unknown';
    mod.ids = meta.ids;
    mod.mcRange = meta.mcRange;
    mod.side = meta.side || { value: 'unknown', source: null };
    mod.forgeDeps = meta.forgeDeps || [];
    mod.forgeIncompatible = meta.forgeIncompatible || [];
    mod.depends = meta.depends || {};
    mod.provides = meta.provides || [];
    mod.manifest = meta.manifest;
    // 命名空间取决于它是给谁的：纯 Fabric 包用 Yarn 名，Forge/NeoForge 用 Mojmap 名
    const L = mod.loaders;
    mod.namespace = (!L.length) ? 'unknown'
      : ((L.indexOf('fabric') >= 0 && L.indexOf('forge') < 0 && L.indexOf('neoforge') < 0) ? 'yarn' : 'mojmap');

    // ---- 嵌套 jar（jar-in-jar）：只收 modId，不收 mixin ----
    mod.nested = await collectNestedIds(zip, readText, 0);

    // ---- mixin 配置 ----
    const declared = new Set(meta.mixinsDecl || []);
    const mf = mod.manifest || (has('META-INF/MANIFEST.MF') ? parseManifest((await readText('META-INF/MANIFEST.MF')) || '') : {});
    if (mf['MixinConfigs']) {
      for (const s of String(mf['MixinConfigs']).split(',')) {
        const t = s.trim();
        if (t) declared.add(t);
      }
    }

    const configPaths = new Set(declared);
    for (const ent of zip.entries.values()) {
      if (!/\.json$/i.test(ent.name)) continue;
      if (/^(assets|data)\//i.test(ent.name)) continue;
      if (ent.uncompSize > MAX_JSON) continue;
      configPaths.add(ent.name);
    }

    for (const cfgPath of configPaths) {
      if (!zip.entries.has(cfgPath)) {
        if (declared.has(cfgPath)) mod.problems.push('声明了 mixin 配置但 jar 里没有: ' + cfgPath);
        continue;
      }
      const cfg = tryParseJson(await readText(cfgPath));
      if (!cfg || typeof cfg.package !== 'string') continue;
      if (!Array.isArray(cfg.mixins) && !Array.isArray(cfg.client) && !Array.isArray(cfg.server)) continue;

      const cfgInfo = { file: cfgPath, pkg: cfg.package, mixinCount: 0, missingClasses: [] };
      const mixinNames = [];
      for (const key of ['mixins', 'client', 'server']) {
        if (Array.isArray(cfg[key])) for (const mn of cfg[key]) if (typeof mn === 'string') mixinNames.push(mn);
      }
      cfgInfo.mixinCount = mixinNames.length;

      for (const mn of mixinNames) {
        const clsPath = cfg.package.replace(/\./g, '/') + '/' + mn.replace(/\./g, '/') + '.class';
        if (!has(clsPath)) { cfgInfo.missingClasses.push(mn); continue; }
        let cls;
        try { cls = parseClass(await zip.read(clsPath)); }
        catch (err) { cfgInfo.missingClasses.push(mn + '（解析失败）'); continue; }
        const ex = extractInjections(cls);
        for (const tcls of ex.targets) {
          for (const pt of ex.points) {
            mod.targets.push({
              cls: tcls, method: pt.method, desc: pt.desc,
              kind: pt.kind, mixin: cls.name || mn, config: cfgPath,
              namespace: mod.namespace,
              atValue: pt.atValue, atTarget: pt.atTarget, atOrdinal: pt.atOrdinal,
              priority: pt.priority, require: pt.require, cancellable: pt.cancellable,
              wildcard: pt.wildcard
            });
          }
        }
      }
      mod.mixinConfigs.push(cfgInfo);
    }

    if (!mod.ids.length) mod.ids.push({ id: null, version: null, name: null });
    return mod;
  }

  async function collectNestedIds(zip, readText, depth) {
    if (depth >= MAX_DEPTH) return [];
    const out = [];
    const names = [...zip.entries.keys()].filter(n => /^META-INF\/(jars|jarjar)\/[^/]+\.jar$/i.test(n));
    for (const n of names.slice(0, MAX_NESTED)) {
      try {
        const bytes = await zip.read(n);
        if (!bytes) continue;
        const inner = unzip(bytes);
        const readInner = async (p) => {
          const e = inner.entries.get(p);
          if (!e || e.uncompSize > MAX_JSON) return null;
          return utf8(await inner.read(p));
        };
        const m = await readJarMeta(inner, readInner);
        for (const id of m.ids) {
          if (!id.id) continue;
          out.push({ id: id.id, version: id.version, name: id.name, from: n, depth: depth });
        }
        // 再下一层（少见，但有些 bundle 套 bundle）
        const deeper = await collectNestedIds(inner, readInner, depth + 1);
        out.push(...deeper);
      } catch (e) { /* 单个嵌套 jar 失败不影响整体 */ }
    }
    return out;
  }

  /* =====================================================================
   * 7. 汇总与检查
   * ===================================================================== */
  /**
   * 流式收集：每分析完一个 jar 就回调一次，UI 可以边算边画。
   * hooks.onMod(mod | null, index, total)   mod 为 null 表示这个 jar 读取失败
   * hooks.onProgress(index, total, name)
   */
  async function collect(input, hooks) {
    const jars = input.jars || [];
    const mods = [];
    const errors = [];
    const h = hooks || {};

    for (let i = 0; i < jars.length; i++) {
      const j = jars[i];
      if (h.onProgress) h.onProgress(i + 1, jars.length, j.name);
      let mod = null;
      try {
        const bytes = await j.getBytes();
        mod = await analyzeJar(j.name, bytes);
        mods.push(mod);
      } catch (e) {
        errors.push({ file: j.name, error: e.message });
      }
      if (h.onMod) h.onMod(mod, i + 1, jars.length);
    }
    return { mods, errors };
  }

  function summarize(mods, errors, instance) {
    // ---- 实例的 MC 版本：version.json → 各 mod 声明的一致推断 ----
    let mcVersion = instance && instance.mcVersion ? instance.mcVersion : null;
    let mcSource = mcVersion ? (instance.mcSource || 'version.json') : null;
    if (!mcVersion) {
      const tally = new Map();
      for (const m of mods) {
        if (!m.mcRange) continue;
        const v = guessVersionFromRange(m.mcRange.range, m.mcRange.style);
        if (v) tally.set(v, (tally.get(v) || 0) + 1);
      }
      let best = null, bestN = 0;
      for (const [v, n] of tally) if (n > bestN) { best = v; bestN = n; }
      if (best && bestN >= Math.max(2, Math.floor(mods.length * 0.25))) {
        mcVersion = best;
        mcSource = '推定（' + bestN + ' 个 mod 的声明一致）';
      }
    }

    const issues = [];
    // 统一严重度（4 = 可能直接起不来；3 = 很可能失败；2 = 可能被跳过；1 = 静态提示）
    const SEV = {
      'missing-dep': 4, 'dup-modid': 4, 'loader-mismatch': 4, 'declared-incompatible': 4,
      'pair-anchor-clash': 3, 'pair-wrap-vs-redirect': 3,
      'pair-overwrite-pair': 2, 'pair-overwrite-vs-anchored': 2
    };
    const add = (level, kind, title, detail, modsList) => issues.push({
      level, kind, title, detail, mods: modsList || [],
      severity: SEV[kind] || (level === 'high' ? 3 : level === 'med' ? 2 : 1)
    });

    // --- modId → 文件（含嵌套 id，但嵌套的单独标出来，不参与「重复安装」判定）---
    const byId = new Map();
    const byNestedId = new Map();
    for (const m of mods) {
      for (const id of m.ids) {
        if (!id.id) continue;
        if (!byId.has(id.id)) byId.set(id.id, []);
        byId.get(id.id).push({ file: m.file, version: id.version });
      }
      for (const n of m.nested) {
        if (!byNestedId.has(n.id)) byNestedId.set(n.id, []);
        byNestedId.get(n.id).push({ file: m.file, version: n.version, from: n.from });
      }
      // provides 也算「有人满足这个 id」，否则依赖它会误报缺失
      for (const p of (m.provides || [])) {
        if (!byId.has(p)) byId.set(p, []);
        byId.get(p).push({ file: m.file, version: null, provided: true });
      }
    }
    const knownIds = new Set([...byId.keys(), ...byNestedId.keys()]);
    // Fabric 与 Forge 的 modId 常有 - / _ 差异（cloth-config vs cloth_config），比较时归一化
    const normId = (s) => String(s).toLowerCase().replace(/-/g, '_');
    const knownNorm = new Set([...knownIds].map(normId));
    const hasId = (id) => knownIds.has(id) || knownNorm.has(normId(id));

    // 加载器匹配：按 jar 携带的**签名集合**判定，而不是按主程序/单一身份判定。
    // 一个 jar 可以同时是 fabric + forge（多加载器通用包），也可以靠 Connector 之类在别处加载。
    const instLoader = instance && instance.loader && instance.loader !== 'unknown' ? instance.loader : null;
    const hasConnector = knownIds.has('connector') || knownIds.has('sinytraconnector') || knownIds.has('connectormod')
      || Array.from(knownIds).some(k => /connect/i.test(k));
    const loaderList = (m) => (m.loaders && m.loaders.length ? m.loaders : []);
    /** 这个 jar 能不能在实例上跑 */
    const compatible = (m) => {
      if (!instLoader) return true;
      const L = loaderList(m);
      if (!L.length) return true;                       // 没有元数据，无法判断，不冤报
      if (L.indexOf(instLoader) >= 0) return true;
      if (instLoader === 'neoforge' && L.indexOf('forge') >= 0) return true;   // NeoForge 1.20.x 能加载 Forge mod
      if (hasConnector && instLoader === 'neoforge' && L.indexOf('fabric') >= 0) return true; // Sinytra Connector
      return false;
    };
    const isLoaderMismatch = (m) => !compatible(m);

    // 命名空间由「它会被哪个加载器加载」决定，而不是由 jar 自己带几套签名决定：
    // 一个 fabric+neoforge 通用包装在 Fabric 实例上，走的是 Yarn 名 + refmap，不是 Mojmap
    const instNs = instLoader === 'fabric' ? 'yarn' : (instLoader ? 'mojmap' : null);
    for (const m of mods) {
      const L2 = loaderList(m);
      const ns = (instNs && compatible(m)) ? instNs
        : (L2.length === 1 && L2[0] === 'fabric' ? 'yarn' : (L2.length ? 'mojmap' : 'unknown'));
      m.namespace = ns;
      for (const t of m.targets) t.namespace = ns;
    }

    // --- (1) 同一个 modId 装了多份 ---
    for (const [id, list] of byId) {
      if (list.length > 1) {
        add('high', 'dup-modid', '同一个 modId 出现在多个 jar：' + id,
          list.map(x => '  ' + x.file + '  (' + (x.version || '版本未知') + ')').join('\n') +
          '\n  （可能是重复安装；也可能其中一个是数据/资源包，或加装版沿用了同一个 id）',
          list.map(x => x.file));
      }
    }

    // --- (1b) 加载器不匹配（按签名集合判定）
    const unknownJars = mods.filter(m => !m.loaders || !m.loaders.length).map(m => m.file);
    if (unknownJars.length) {
      add('low', 'unknown-loader', unknownJars.length + ' 个 jar 没有可识别的加载器元数据',
        unknownJars.slice(0, 10).map(f => '  ' + f).join('\n') +
        (unknownJars.length > 10 ? '\n  …' : '') +
        '\n  （常见原因：Fabric/Forge 元数据缺失、或这个 jar 只是个资源包）', []);
    }
    for (const m of mods) {
      if (!isLoaderMismatch(m)) continue;
      const id = (m.ids[0] && m.ids[0].id) || m.file;
      add('high', 'loader-mismatch', '加载器不匹配：' + id + ' 只带 [' + loaderList(m).join('+') + '] 签名，实例是 ' + instLoader,
        '  ' + m.file + '\n  这个 jar 不会被加载；它的依赖也不再单独检查', [m.file]);
    }

    // --- (2) 硬依赖缺失（含 jar-in-jar 提供的）---
    const missing = new Map();
    for (const m of mods) {
      if (!compatible(m)) continue;
      const deps = m.forgeDeps || [];
      for (const d of deps) {
        if (!d.mandatory) continue;
        if (NON_MOD_IDS.has(d.modId)) continue;
        if (hasId(d.modId)) continue;
        if (!missing.has(d.modId)) missing.set(d.modId, []);
        missing.get(d.modId).push('  ' + m.file + (d.range ? '  需要 ' + d.range : ''));
      }
      // Fabric 的 depends
      const fd = m.depends || {};
      for (const k of Object.keys(fd)) {
        if (NON_MOD_IDS.has(k)) continue;
        if (hasId(k)) continue;
        if (!missing.has(k)) missing.set(k, []);
        missing.get(k).push('  ' + m.file + '  需要 ' + JSON.stringify(fd[k]));
      }
    }
    for (const [id, who] of missing) {
      add('high', 'missing-dep', '缺少硬依赖：' + id,
        who.slice(0, 12).join('\n') + (who.length > 12 ? '\n  …还有 ' + (who.length - 12) + ' 处' : ''), who);
    }

    // --- (2b) 声明「不兼容」的对方确实装了 ---
    for (const m of mods) {
      const selfIds = new Set(m.ids.map(x => x.id).filter(Boolean).map(normId));
      for (const n of m.nested) if (n.id) selfIds.add(normId(n.id));
      const self = (m.ids[0] && m.ids[0].id) || m.file;
      for (const d of m.forgeIncompatible || []) {
        if (!hasId(d.modId)) continue;
        // 自己就提供那个 id（或把它 jar-in-jar 捆在同一个包里）→ 不算冲突
        if (selfIds.has(normId(d.modId))) continue;
        const providers = (byId.get(d.modId) || []).concat(byNestedId.get(d.modId) || []);
        add('high', 'declared-incompatible', '声明了不兼容，但对方确实装了：' + self + ' ↔ ' + d.modId,
          '  ' + m.file + (d.range ? '\n  声明的范围: ' + d.range : '') +
          '\n  对方的提供者: ' + providers.map(x => x.file).join(', '),
          [m.file].concat(providers.map(x => x.file)));
      }
    }

    // --- (3) 目标重叠：先按方法分组，全员都带描述符时再按描述符切（避免重载被误合并）---
    const methodGroups = new Map();
    for (const m of mods) {
      for (const t of m.targets) {
        const key = t.namespace + '|' + t.cls + '#' + t.method;
        if (!methodGroups.has(key)) methodGroups.set(key, []);
        methodGroups.get(key).push({ mod: m, t });
      }
    }

    const overlaps = { high: [], med: [], low: [] };
    const lowKinds = new Map();

    for (const [key, list] of methodGroups) {
      const allHaveDesc = list.every(x => !!x.t.desc);
      const buckets = new Map();
      if (allHaveDesc) {
        for (const x of list) {
          if (!buckets.has(x.t.desc)) buckets.set(x.t.desc, []);
          buckets.get(x.t.desc).push(x);
        }
      } else {
        buckets.set('', list);
      }

      for (const [dkey, sub] of buckets) {
        if (sub.length < 2) continue;
        const entries = sub.map(x => ({
          mod: (x.mod.ids[0] && x.mod.ids[0].id) || x.mod.file,
          file: x.mod.file,
          kind: x.t.kind,
          atValue: x.t.atValue,
          atTarget: x.t.atTarget,
          atOrdinal: x.t.atOrdinal,
          priority: x.t.priority,
          require: x.t.require,
          cancellable: x.t.cancellable
        }));
        const g = grade(entries);
        if (!g) continue;

        const [ns, clsAndMethod] = key.split('|');
        const label = clsAndMethod + (dkey || '');
        const detail = sub.map((x, i) => {
          const bits = [entries[i].mod, x.t.kind];
          if (x.t.atValue) bits.push('@' + x.t.atValue);
          if (x.t.atTarget) bits.push(normAt(x.t.atTarget));
          if (x.t.priority != null && x.t.priority !== 1000) bits.push('prio ' + x.t.priority);
          if (x.t.require === 0) bits.push('require=0');
          return '  ' + bits.join(' · ') + '   (' + x.mod.file + ')';
        }).join('\n');

        const item = {
          key: label, ns,
          count: new Set(entries.map(e => e.mod)).size,
          detail: detail,
          files: sub.map(x => x.mod.file)
        };
        overlaps[g.level].push({ item, g });
      }
    }

    for (const it of overlaps.high) {
      add('high', 'pair-' + it.g.kind, it.g.title + '：' + it.item.key,
        (it.g.why ? '  原因: ' + it.g.why + '\n' : '') +
        (it.g.hint ? '  ' + it.g.hint + '\n' : '') + it.item.detail,
        it.item.files);
    }

    overlaps.med.sort((a, b) => b.item.count - a.item.count);
    const MED_SHOW = 40;
    for (const it of overlaps.med.slice(0, MED_SHOW)) {
      add('med', 'pair-' + it.g.kind, it.g.title + '：' + it.item.key,
        (it.g.why ? '  原因: ' + it.g.why + '\n' : '') + it.item.detail,
        it.item.files);
    }
    if (overlaps.med.length > MED_SHOW) {
      add('med', 'pair-more', '另有 ' + (overlaps.med.length - MED_SHOW) + ' 处中等风险配对未展开',
        '  用 --json 看全部', []);
    }

    // 低危按「判定原因」折叠：保留分类计数，不再堆几十条
    for (const it of overlaps.low) {
      const k = it.g.kind;
      if (!lowKinds.has(k)) lowKinds.set(k, { title: it.g.title, n: 0, samples: [] });
      const rec = lowKinds.get(k);
      rec.n++;
      if (rec.samples.length < 4) rec.samples.push('  ' + it.item.key + '  (' + it.item.count + ' 个 mod)');
    }
    for (const [k, rec] of lowKinds) {
      add('low', 'pair-' + k, rec.n + ' 处 — ' + rec.title,
        rec.samples.join('\n') + (rec.n > rec.samples.length ? '\n  …' : '') +
        '\n  用 --json 看全部', []);
    }

    // --- (4) mixin 配置里列的类缺失（单模组问题，折叠成一条低危）---
    const missingCls = [];
    for (const m of mods) {
      for (const c of m.mixinConfigs) {
        if (c.missingClasses.length) missingCls.push({ m, c });
      }
    }
    if (missingCls.length) {
      add('low', 'mixin-class-missing', missingCls.length + ' 个 mixin 配置里有类在 jar 中找不到',
        missingCls.slice(0, 5).map(x => '  ' + x.m.file + ' → ' + x.c.file +
          ' (' + x.c.missingClasses.length + ' 个)').join('\n') +
        (missingCls.length > 5 ? '\n  …' : '') +
        '\n  常见于按加载器分文件、或该 mixin 类被打进嵌套 jar', []);
    }

    // --- (5) 声明的 MC 版本与实例不符（单模组问题，且区间写法误报多，折叠成低危）---
    let mismatches = 0;
    const mcBad = [];
    if (mcVersion) {
      for (const m of mods) {
        if (!m.mcRange) continue;
        if (versionSatisfies(mcVersion, m.mcRange.range, m.mcRange.style)) continue;
        mismatches++;
        mcBad.push('  ' + ((m.ids[0] && m.ids[0].id) || m.file) +
          '  声明 ' + m.mcRange.range);
      }
      if (mcBad.length) {
        add('low', 'mc-version-mismatch', mcBad.length + ' 个 mod 声明的 MC 区间不含实例版本（多为区间写法保守所致）',
          '  实例(推定): ' + mcVersion + '\n' +
          mcBad.slice(0, 8).join('\n') + (mcBad.length > 8 ? '\n  …' : ''), []);
      }
    }

    // 同档内按"真实世界里的崩溃优先级"排：元数据关系在前，注入关系居中，单模组问题最后
    const levelWeight = { high: 0, med: 1, low: 2 };
    const RANK = {
      'missing-dep': 10,
      'dup-modid': 20,
      'loader-mismatch': 30,
      'pair-anchor-clash': 40,
      'pair-wrap-vs-redirect': 42,
      'pair-overwrite-pair': 50,
      'pair-overwrite-vs-anchored': 55,
      'declared-incompatible': 60
    };
    issues.sort((a, b) => (levelWeight[a.level] - levelWeight[b.level]) ||
      ((RANK[a.kind] || 90) - (RANK[b.kind] || 90)));

    const issueCounts = { high: 0, med: 0, low: 0 };
    for (const i of issues) issueCounts[i.level] = (issueCounts[i.level] || 0) + 1;

    // 有些 Forge mod 的注入目标直接写 SRG 名（m_12345_），和 Mojmap 名（acquire）无法自动对齐
    let srgTargets = 0;
    for (const m of mods) for (const t of m.targets) if (/^[mfi]_\d+_$/.test(t.method)) srgTargets++;

    return {
      instance,
      mcVersion,
      mcSource,
      mods,
      errors,
      issues,
      issueCounts,
      stats: {
        jars: mods.length,
        failed: errors.length,
        byLoader: countBy(mods, m => m.loader),
        mixinConfigs: mods.reduce((s, m) => s + m.mixinConfigs.length, 0),
        targets: mods.reduce((s, m) => s + m.targets.length, 0),
        nestedIds: byNestedId.size,
        srgTargets,
        overlap: { high: overlaps.high.length, med: overlaps.med.length, low: overlaps.low.length },
        mcMismatch: mismatches
      }
    };
  }

  async function analyze(input, onProgress) {
    const { mods, errors } = await collect(input, { onProgress });
    return summarize(mods, errors, (input && input.instance) || null);
  }

  function countBy(arr, f) {
    const o = {};
    for (const x of arr) { const k = f(x); o[k] = (o[k] || 0) + 1; }
    return o;
  }

  /* =====================================================================
   * 8. 文本报告
   * ===================================================================== */
  function renderText(r, opts) {
    const verbose = !!(opts && opts.verbose);
    const L = [];
    const P = (s) => L.push(s == null ? '' : s);
    const bar = '='.repeat(62);

    P(bar);
    P(' mod-audit 报告');
    P(bar);
    P('静态分析：以下所有结论都是「可能」，不是运行时事实；本分析器不保证准确。');
    P('');
    const inst = r.mcVersion
      ? r.mcVersion + (r.mcSource && r.mcSource !== 'version.json' ? '（' + r.mcSource + '）' : '')
      : '?';
    P('实例: ' + inst + ' / ' + (r.instance ? r.instance.loader : '?') +
      (r.instance && r.instance.loaderVersion ? ' ' + r.instance.loaderVersion : ''));
    P('jar: ' + r.stats.jars + (r.stats.failed ? '（' + r.stats.failed + ' 个读取失败）' : '') +
      '   加载器: ' + Object.keys(r.stats.byLoader).map(k => k + '=' + r.stats.byLoader[k]).join(', '));
    P('mixin 配置: ' + r.stats.mixinConfigs + '  注入点: ' + r.stats.targets +
      '  jar 内嵌套 modId: ' + r.stats.nestedIds);
    P('发现: 高危 ' + r.issueCounts.high + ' / 需要注意 ' + r.issueCounts.med + ' / 提示 ' + r.issueCounts.low +
      '    (目标重叠: 高危 ' + r.stats.overlap.high + ' / 中 ' + r.stats.overlap.med + ' / 低 ' + r.stats.overlap.low + ')');
    if (r.stats.srgTargets) {
      P('注意: 有 ' + r.stats.srgTargets + ' 条注入目标用的是 SRG 名（m_/f_/i_ 开头的数字），' +
        '和 Mojmap 名不是同一串字符串，同一方法可能因此被漏报成两份。');
    }
    P('');

    for (const [level, label] of [['high', '高危'], ['med', '需要注意'], ['low', '提示']]) {
      const list = r.issues.filter(i => i.level === level);
      if (!list.length) continue;
      P('---- ' + label + '（' + list.length + '） ----');
      let n = 0;
      for (const i of list) {
        P('');
        P('[' + (++n) + '] ' + i.title);
        if (i.detail) for (const line of String(i.detail).split('\n')) P(line);
      }
      P('');
    }

    if (r.errors.length) {
      P('---- 读取失败 ----');
      for (const e of r.errors) P('  ' + e.file + ': ' + e.error);
      P('');
    }

    const ranked = r.mods
      .map(m => ({ m, n: m.targets.length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, verbose ? 100 : 15);
    if (ranked.length) {
      P('---- 改动最多的 mod（注入点条数） ----');
      for (const { m, n } of ranked) {
        const id = (m.ids[0] && m.ids[0].id) || m.file;
        P('  ' + String(n).padStart(4) + '  ' + id + '   [' + m.loader + ']  ' + m.file);
      }
      P('');
    }

    P(bar);
    P('说明: 这里只判「两个 mod 之间」的关系，不判单个 mod 自身的问题。');
    P('      判据是注入器对目标的所有权分类 + @At 的 (value, target, ordinal) 是否相同。');
    P('      @Overwrite 重叠的已知表现是后者被跳过（不是崩），但以谁为准取决于运行时，静态无法确认；');
    P('      @Redirect / @ModifyConstant 抢同一锚点则可能触发 injection failure。');
    P('      以上都只是「可能导致找不到注入点」的提示：不代表运行时一定崩，也不代表一定正常。');
    P('      跨命名空间（Yarn 名 vs Mojmap 名）不互相比较；jar-in-jar 里的 mod 只登记 id，不参与注入归因。');
    P(bar);
    return L.join('\n');
  }

  /**
   * 英文报表：给 LLM 读的。刻意压缩 —— 短键、短行、不重复长句。
   */
  const KIND_EN = {
    'missing-dep': 'missing hard dep',
    'dup-modid': 'duplicate mod id',
    'loader-mismatch': 'loader mismatch',
    'declared-incompatible': 'declared incompatible but present',
    'pair-anchor-clash': 'same @At anchor (exclusive injectors)',
    'pair-wrap-vs-redirect': 'WrapOperation vs Redirect, same anchor',
    'pair-overwrite-pair': '@Overwrite overlap',
    'pair-overwrite-vs-anchored': '@Overwrite vs anchored injection',
    'pair-overwrite-vs-headtail': '@Overwrite vs HEAD/TAIL',
    'pair-anchor-different': 'exclusive injectors, different anchors',
    'pair-cancellable': 'cancellable @Inject',
    'pair-additive': 'additive injections',
    'mixin-class-missing': 'mixin class missing in jar',
    'mc-version-mismatch': 'declared MC range mismatch',
    'unknown-loader': 'unknown loader metadata',
    'dup-mixin-class': 'duplicate mixin class',
    'refmap-missing': 'refmap missing'
  };
  const SEV_EN = {
    4: 'may fail to launch',
    3: 'likely injection failure',
    2: 'may be skipped or overwritten',
    1: 'coexist (low)'
  };

  function shortTarget(it) {
    var t = String(it.title || '');
    var i = t.lastIndexOf('：');
    if (i >= 0) return t.slice(i + 1).trim();
    return (it.mods && it.mods[0]) || '';
  }

  function shortMods(it, max) {
    var m = it.mods || [];
    var names = [];
    for (var i = 0; i < m.length; i++) {
      var n = String(m[i]).replace(/\.jar$/i, '');
      if (names.indexOf(n) < 0) names.push(n);   // 同一个 mod 多次注入会重复，去重
    }
    if (!names.length) return '-';
    if (names.length <= (max || 2)) return names.join(', ');
    return names.slice(0, max || 2).join(', ') + ' +' + (names.length - (max || 2));
  }

  const PAIR_EDGE_LABEL = {
    'pair-anchor-clash': 'same @At anchor',
    'pair-wrap-vs-redirect': 'wrap vs redirect, same anchor',
    'pair-overwrite-pair': 'both @Overwrite',
    'pair-overwrite-vs-anchored': '@Overwrite vs anchored',
    'pair-anchor-different': 'coexists, different anchors',
    'pair-cancellable': 'coexists, cancellable',
    'pair-additive': 'coexists'
  };
  const PAIR_SEV = {
    'pair-anchor-clash': 4,
    'pair-wrap-vs-redirect': 3,
    'pair-overwrite-pair': 2,
    'pair-overwrite-vs-anchored': 2
  };

  /** 报表结尾的 Mermaid 关系图：节点=模组，边=关系（用文字标注，不依赖颜色） */
  function buildGraphSection(r, opts) {
    // 不传 = 全量，不截断
    var MAX_NODES = (opts && opts.maxNodes) || Infinity;
    var MAX_EDGES = (opts && opts.maxEdges) || Infinity;
    var out = [];
    var byFile = new Map();
    (r.mods || []).forEach(m => byFile.set(m.file, m));

    // modId → mod（含 jar 内嵌套提供的 id）
    var byId = new Map();
    (r.mods || []).forEach(m => {
      (m.ids || []).forEach(x => { if (x.id && !byId.has(x.id)) byId.set(x.id, m); });
      (m.nested || []).forEach(x => { if (x.id && !byId.has(x.id)) byId.set(x.id, m); });
    });

    var nodeIds = new Map();
    var nodeLines = [];
    var edgeDefs = [];

    // 1) 冲突边
    (r.issues || []).forEach(it => {
      if (!it.kind || it.kind.indexOf('pair-') !== 0) return;
      // 同一个 mod 的多条注入会让文件重复出现，先去重再取两端，否则会画出自环
      var uniq = [];
      (it.mods || []).forEach(f => { if (uniq.indexOf(f) < 0) uniq.push(f); });
      if (uniq.length < 2) return;
      edgeDefs.push({
        sev: PAIR_SEV[it.kind] || 1,
        from: uniq[0], to: uniq[1],
        label: PAIR_EDGE_LABEL[it.kind] || 'relation',
        style: '-->'
      });
    });

    // 2) 依赖边（A requires B）
    (r.mods || []).forEach(m => {
      var deps = [];
      (m.forgeDeps || []).forEach(d => { if (d && d.modId && d.mandatory) deps.push(String(d.modId)); });
      Object.keys(m.depends || {}).forEach(k => deps.push(k));
      deps.forEach(d => {
        if (NON_MOD_IDS.has(d)) return;
        var p = byId.get(d);
        if (!p || p.file === m.file) return;
        edgeDefs.push({ sev: 0, from: m.file, to: p.file, label: 'requires', style: '-.->' });
      });
    });

    edgeDefs.sort((a, b) => b.sev - a.sev);
    var nodeCount = 0;
    var edgeLines = [];
    var dropped = 0;
    var seenEdge = new Set();   // 同一个 mod 的多个依赖可能解析到同一个提供者，去重

    function idOf(file) {
      if (nodeIds.has(file)) return nodeIds.get(file);
      if (nodeCount >= MAX_NODES) return null;
      var m = byFile.get(file);
      var label = (m && m.ids && m.ids[0] && m.ids[0].id) || String(file).replace(/\.jar$/i, '');
      var nid = 'n' + nodeCount;
      nodeIds.set(file, nid);
      nodeCount++;
      nodeLines.push('  ' + nid + '["' + String(label).replace(/"/g, "'") + '"]');
      return nid;
    }

    edgeDefs.forEach(e => {
      if (edgeLines.length >= MAX_EDGES) { dropped++; return; }
      var dedupeKey = e.from + '|' + e.to + '|' + e.label;
      if (seenEdge.has(dedupeKey)) return;
      var a = idOf(e.from);
      if (!a) { dropped++; return; }
      var b = idOf(e.to);
      if (!b) { dropped++; return; }
      seenEdge.add(dedupeKey);
      edgeLines.push('  ' + a + ' ' + e.style + '|"' + e.label + '"| ' + b);
    });

    if (!nodeLines.length) {
      out.push('## relations graph');
      out.push('(no inter-mod relations found)');
      return out;
    }

    out.push('## relations graph');
    out.push('Solid arrow = possible conflict (the edge label names the kind).');
    out.push('Dashed arrow = prerequisite: A requires B. Only mods with at least one relation appear.');
    if (dropped) out.push('Truncated: ' + dropped + ' more relation(s) not drawn (node cap ' + MAX_NODES + ', edge cap ' + MAX_EDGES + ').');
    out.push('');
    out.push('```mermaid');
    out.push('graph LR');
    nodeLines.forEach(l => out.push(l));
    edgeLines.forEach(l => out.push(l));
    out.push('```');
    return out;
  }

  /** 类名修改表：外层是类，内层是改它的模组（Markdown 无序列表） */
  function buildClassTable(r, opts) {
    var MIN_MODS = 2;
    var MAX_CLASSES = (opts && opts.maxClasses) || Infinity;   // 不传 = 全量
    var byClass = new Map();   // cls → Map(modName → Set(method))

    (r.mods || []).forEach(m => {
      var name = (m.ids && m.ids[0] && m.ids[0].id) || String(m.file).replace(/\.jar$/i, '');
      (m.targets || []).forEach(t => {
        if (!t.cls) return;
        var mm = byClass.get(t.cls);
        if (!mm) { mm = new Map(); byClass.set(t.cls, mm); }
        var set = mm.get(name);
        if (!set) { set = new Set(); mm.set(name, set); }
        if (t.method) set.add(t.method);
      });
    });

    var rows = [];
    byClass.forEach((mm, cls) => {
      if (mm.size < MIN_MODS) return;
      rows.push({ cls: cls, mods: mm, n: mm.size });
    });
    rows.sort((a, b) => b.n - a.n || (a.cls < b.cls ? -1 : 1));

    var out = [];
    out.push('## class modification table');
    out.push('Outer item = target class, inner items = mods that patch it (methods shown after the dash).');
    if (rows.length > MAX_CLASSES) {
      out.push('Showing top ' + MAX_CLASSES + ' of ' + rows.length + ' classes that are patched by 2+ mods.');
    } else {
      out.push(rows.length + ' classes are patched by 2+ mods.');
    }
    out.push('');

    rows.slice(0, MAX_CLASSES).forEach(row => {
      out.push('- `' + row.cls + '`');
      var entries = [];
      row.mods.forEach((methods, name) => entries.push({ name: name, methods: Array.from(methods) }));
      entries.sort((a, b) => b.methods.length - a.methods.length || (a.name < b.name ? -1 : 1));
      entries.forEach(e => {
        var ms = e.methods.slice(0, 3).join(', ');
        if (e.methods.length > 3) ms += ', +' + (e.methods.length - 3);
        out.push('  - ' + e.name + (ms ? ' — ' + ms : ''));
      });
    });
    return out;
  }

  function renderEnglish(r, opts) {
    opts = opts || {};
    const L = [];
    const inst = r.instance
      ? (r.mcVersion || '?') + ' / ' + r.instance.loader + (r.instance.loaderVersion ? ' ' + r.instance.loaderVersion : '')
      : '?';

    L.push('# mod-audit static report');
    L.push('');
    L.push('STATIC ANALYSIS. Every line below is a *possibility*, not a runtime fact.');
    L.push('The analyzer is heuristic and not guaranteed correct. Use it to narrow suspicion, not to conclude.');
    L.push('');
    L.push('- instance: ' + inst);
    L.push('- jars: ' + r.stats.jars + ' | mixin configs: ' + r.stats.mixinConfigs + ' | injection targets: ' + r.stats.targets);
    L.push('- loader mix: ' + Object.keys(r.stats.byLoader).map(k => k + '=' + r.stats.byLoader[k]).join(', '));
    L.push('- srg-named targets (may be under-reported): ' + (r.stats.srgTargets || 0));
    L.push('');

    // 按严重度倒序分节
    const bySev = {};
    (r.issues || []).forEach(it => {
      const s = it.severity || (it.level === 'high' ? 3 : it.level === 'med' ? 2 : 1);
      (bySev[s] = bySev[s] || []).push(it);
    });

    L.push('## summary');
    L.push([4, 3, 2, 1].map(s => 'L' + s + '=' + ((bySev[s] || []).length)).join(' '));
    L.push('');

    [4, 3, 2, 1].forEach(s => {
      const list = bySev[s];
      if (!list || !list.length) return;
      L.push('## L' + s + ' (' + list.length + ') — ' + SEV_EN[s]);
      L.push('| kind | where | mods |');
      L.push('|---|---|---|');
      list.forEach(it => {
        const kind = KIND_EN[it.kind] || it.kind;
        L.push('| ' + kind + ' | ' + String(shortTarget(it)).replace(/\|/g, '/') +
          ' | ' + shortMods(it) + ' |');
      });
      L.push('');
    });

    if (r.errors && r.errors.length) {
      L.push('## read errors (' + r.errors.length + ')');
      r.errors.forEach(e => L.push('- ' + e.file + ': ' + e.error));
      L.push('');
    }

    // 让 LLM 知道这些级别怎么来的
    L.push('## grading rules');
    L.push('- injection ownership: overwrite=whole body, redirect/modifyconstant=one exclusive instruction,');
    L.push('  wrapoperation=one chainable instruction, modifyarg/modifyvariable/etc=value only, inject=insert only');
    L.push('- anchor identity = (@At value, target, ordinal); same anchor + exclusive pair => likely conflict');
    L.push('- @Overwrite overlap: later-applied one is skipped (WARN only, usually not a crash)');
    L.push('- dependency edges are prerequisites, not conflicts');

    // 结尾的关系图（用文字标注，不依赖颜色）
    L.push('');
    buildGraphSection(r, opts).forEach(x => L.push(x));

    // 再跟一张类名修改表
    L.push('');
    buildClassTable(r, opts).forEach(x => L.push(x));
    return L.join('\n');
  }

  return {
    analyze,
    collect,
    summarize,
    analyzeJar,
    grade,
    CLAIM,
    normAt,
    renderText,
    renderEnglish,
    parseClass,
    parseToml,
    parseManifest,
    parseVersionJson,
    unzip,
    tryParseJson,
    _internal: { cmpVer, versionSatisfies, extractInjections, guessVersionFromRange, KIND_WEIGHT, CLAIM, grade, normAt }
  };
});
