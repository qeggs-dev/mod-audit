/* mod-audit / app.js —— 节点图视图（ComfyUI 风卡片节点）
 * 只读文件、不上传、不执行被分析代码。
 */
(function () {
  'use strict';

  var A = window.ModAudit;
  if (!A) {
    var err = document.getElementById('boot-error');
    if (err) {
      err.style.display = 'flex';
      err.textContent = '加载 analyzer.js 失败。请确认它与 index.html 在同一个目录。';
    }
    return;
  }

  var KW = (A._internal && A._internal.KIND_WEIGHT) || {};
  var FAM_COLOR = { fabric: '#6ea8fe', neoforge: '#ffb454', forge: '#46d39a' };
  var NON_MOD = ['minecraft', 'fabricloader', 'fabric-loader', 'fabric', 'forge', 'neoforge',
    'java', 'javafml', 'lowcodefml', 'mcp'];

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function famColor(loaders) {
    var L = loaders || [];
    if (!L.length) return '#5f6779';
    if (L.length > 1) return '#b98cff';
    return FAM_COLOR[L[0]] || '#5f6779';
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return '110,140,200';
    return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16);
  }

  function fmtKB(b) {
    if (!b) return '0';
    if (b < 1024) return Math.round(b) + 'B';
    if (b < 1048576) return Math.round(b / 1024) + 'K';
    return (b / 1048576).toFixed(1) + 'M';
  }

  /* 圆角矩形路径（自己实现，不依赖 ctx.roundRect） */
  function rrPath(ctx, x, y, w, h, tl, tr, br, bl) {
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr); else ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - br);
    if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br); else ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + bl, y + h);
    if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl); else ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl); else ctx.lineTo(x, y);
    ctx.closePath();
  }

  function fitText(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    var s = String(text);
    while (s.length > 2 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /* 发光贴图缓存：径向渐变，比每帧 createRadialGradient 便宜得多 */
  var glowCache = {};
  function glowSprite(rgb) {
    if (glowCache[rgb]) return glowCache[rgb];
    var S = 96;
    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(' + rgb + ',0.42)');
    grd.addColorStop(0.40, 'rgba(' + rgb + ',0.20)');
    grd.addColorStop(0.68, 'rgba(' + rgb + ',0.07)');
    grd.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    glowCache[rgb] = c;
    return c;
  }

  /* 卡片尺寸（世界坐标单位，随缩放一起变） */
  var TITLE_H = 21;
  var BODY_LINES = 3;
  var LINE_H = 12.5;
  var PAD = 8;
  var CARD_H = TITLE_H + PAD * 2 + LINE_H * BODY_LINES;   // ≈ 80

  function severity(kinds, addKind) {
    var all = new Set(kinds);
    if (addKind) all.add(addKind);
    if (all.has('Overwrite')) return 2;
    var max = 0;
    all.forEach(function (k) { if ((KW[k] || 0) > max) max = KW[k] || 0; });
    return max >= 2 ? 1 : 0;
  }

  /* 严重度梯队：4 起不来 / 3 很可能失败 / 2 可能被跳过 / 1 静态提示 / 0 无 */
  var SEV_COLOR = {
    4: '255,92,92',    // 红
    3: '255,159,69',   // 橙
    2: '255,209,102',  // 黄
    1: '127,141,179',  // 灰蓝
    0: '146,158,192'
  };
  var PAIR_RANK = {
    'anchor-clash': 3,
    'wrap-vs-redirect': 3,
    'overwrite-pair': 2,
    'overwrite-vs-anchored': 2
  };

  /* 连线归类：图例筛选按这个键多选 */
  function edgeKindOf(e) {
    if (e.type === 'dep') return 'dep';
    if (e.type === 'issue') return 'r4';
    if (e.type === 'root') return 'root';
    return e.sev >= 4 ? 'r4' : e.sev === 3 ? 'r3' : e.sev === 2 ? 'r2' : 'r1';
  }

  /* 加载器归类：标题条颜色筛选按这个键多选 */
  function loaderKeyOf(loaders) {
    var L = loaders || [];
    if (!L.length) return 'unknown';
    if (L.length > 1) return 'multi';
    return L[0];
  }

  var FOCUS_LABEL = {
    r4: '可能起不来',
    r3: '很可能失败',
    r2: '可能被跳过',
    r1: '静态上可共存',
    dep: '前置依赖'
  };
  var LOADER_LABEL = { fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge', multi: '多加载器', unknown: '未知' };

  /* =====================================================================
   * 节点图
   * ===================================================================== */
  function Graph(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = [];
    this.edges = new Map();
    this.buckets = new Map();     // 目标方法 → Map(节点i → Set(注入类型))
    this.byId = new Map();        // modId → 节点i
    this.depQueue = [];           // 待解析的依赖边
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.selected = -1;
    this.hovered = -1;
    this.drag = null;
    this.panStart = null;
    this.w = 400; this.h = 300; this.dpr = 1;

    /* 物理：节点之间**没有**拉力。边只是视觉连线，不参与受力。
       位置由自动排版（黄金角螺旋）决定，只有被拖的节点受力，其余只受碰撞分离影响。 */
    this.damping = 0.86;
    this.gap = 10;                // 卡片之间至少留的缝
    this.spiralR0 = 200;          // 排版起始半径（避开根节点）
    // 每张卡片占的面积必须 ≥ 卡片脚印：π·K² ≥ (W+2gap)(H+2gap)，再留 15% 余量
    this.spiralK = Math.sqrt(((144 + 20) * (CARD_H + 20)) / Math.PI) * 1.15;   // ≈ 86

    this.onSelect = null;
    this.look = { glow: 14, rim: 1.5, edge: 1 };
    this.edgeFocus = new Set();    // 图例多选：r4/r3/r2/r1/dep
    this.loaderFocus = new Set();  // 标题条颜色多选
    this.critFocus = false;        // 高危高亮模式
    this.critT = 0;                // 高亮强度（0..1，每帧向 critTarget 逼近 → 先快后慢）
    this.searchQuery = '';         // 搜索关键字
    this._match = null;            // 命中的节点索引集合；null = 没在搜索
    this.cameraOn = true;
    this._camHold = 0;
    this._settleFrames = 0;        // 新节点加入后先跑这么多帧分离，之后没速度就完全跳过物理
    this._hintTick = 0;
    this._drawn = 0;

    this._resize();
    var self = this;
    if (window.ResizeObserver) {
      new ResizeObserver(function () { self._resize(); }).observe(canvas.parentElement);
    }
    window.addEventListener('resize', function () { self._resize(); });
    this._bind();
    requestAnimationFrame(function () { self._tick(); });
  }

  Graph.prototype._resize = function () {
    var box = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(240, box.width);
    this.h = Math.max(200, box.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  };

  Graph.prototype.reset = function () {
    this.nodes = [];
    this.edges = new Map();
    this.buckets = new Map();
    this.byId = new Map();
    this.depQueue = [];
    this.selected = -1;
    this.hovered = -1;
    this.drag = null;
    this.panStart = null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.edgeFocus.clear();
    this.loaderFocus.clear();
    this._edgeT = {};
    this._loaderT = {};
    this.critFocus = false;
    this.critT = 0;
    this.searchQuery = '';
    this._match = null;
    if (this.onSelect) this.onSelect(null);
  };

  /** 搜索：默认匹配 id / 文件名 / 概要 / 加载器，命中以外的节点会被压暗。
   *  支持 领域:关键词 限定范围；领域不认识时整串当关键词。 */
  /* 搜索支持的领域：写成 "领域:关键词" 只在该领域里搜。
     不写前缀、或前缀不是已知领域时，整串拿去匹配所有领域。 */
  var SEARCH_FIELDS = {
    id:      function (nd) { return nd.id || ''; },
    name:    function (nd) { return nd.id || ''; },
    file:    function (nd) { return nd.file || ''; },
    jar:     function (nd) { return nd.file || ''; },
    desc:    function (nd) { return nd.desc || ''; },
    loader:  function (nd) { return (nd.mod && nd.mod.loaders || []).join(' '); },
    str:     function (nd) { return (nd.mod && nd.mod.constStrings || []).join('\n'); },
    const:   function (nd) { return (nd.mod && nd.mod.constStrings || []).join('\n'); }
  };

  Graph.prototype.setSearch = function (q) {
    var raw = String(q == null ? '' : q).trim();
    this.searchQuery = raw.toLowerCase();
    if (!this.searchQuery) { this._match = null; this.searchField = null; return 0; }

    // 解析 "领域:关键词"；只有领域已注册才算数，否则整串都是关键词
    var field = null, term = raw;
    var mm = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(raw);
    if (mm) {
      var key = mm[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(SEARCH_FIELDS, key)) {
        field = key;
        term = mm[2].trim();
      }
    }
    this.searchField = field;
    this.searchTerm = term.toLowerCase();
    if (!this.searchTerm) { this._match = null; return 0; }

    var m = new Set();
    for (var i = 0; i < this.nodes.length; i++) {
      var nd = this.nodes[i];
      if (nd.isRoot) continue;
      var hay;
      if (field) {
        hay = SEARCH_FIELDS[field](nd);
      } else {
        hay = '';
        for (var k in SEARCH_FIELDS) hay += SEARCH_FIELDS[k](nd) + ' ';
      }
      if (String(hay).toLowerCase().indexOf(this.searchTerm) >= 0) m.add(i);
    }
    this._match = m;
    return m.size;
  };

  /** 回车：把镜头移到命中的那一簇，并选中第一个 */
  Graph.prototype.focusMatches = function () {
    if (!this._match || !this._match.size) return;
    var self = this, xs = 0, ys = 0, n = 0, first = -1;
    this._match.forEach(function (i) {
      var nd = self.nodes[i];
      if (!nd) return;
      xs += nd.x; ys += nd.y; n++;
      if (first < 0) first = i;
    });
    if (!n) return;
    this.zoom = Math.max(this.zoom, 0.9);
    this.pan.x = this.w / 2 - (xs / n) * this.zoom;
    this.pan.y = this.h / 2 - (ys / n) * this.zoom;
    if (this.onCameraManual) this.onCameraManual();
    if (first >= 0) this.select(first);
  };

  /* ---------- 根节点：模组加载器 ---------- */
  Graph.prototype.setRoot = function (info) {
    var label = info && info.label ? info.label : '模组加载器';
    var sub = info && info.sub ? info.sub : '?';
    var w = 190, h = 96;
    var root = {
      i: 0,
      isRoot: true,
      id: '__loader__',
      label: label,
      sub: sub,
      desc: '',
      file: '',
      mod: null,
      clsN: 0, codeBytes: 0, targetsN: 0,
      w: w, h: h,
      x: 0, y: 0, vx: 0, vy: 0,
      deg: 0, sev: 0,
      fill: '#8ea2c8',
      rgb: '142,162,200'
    };
    this.nodes.push(root);
    this.byId.set('__loader__', 0);
    this.pan = { x: this.w / 2, y: this.h / 2 };
    this.zoom = 1;
  };

  Graph.prototype._refreshRoot = function () {
    if (!this.nodes.length || !this.nodes[0].isRoot) return;
    this.nodes[0].sub = Math.max(0, this.nodes.length - 1) + ' 个 mod';
  };

  Graph.prototype._tick = function () {
    var self = this;
    this._step();
    this._camera();
    this._draw();
    requestAnimationFrame(function () { self._tick(); });
  };

  /** 摄像机缓慢跟随：把全部节点框进视野 */
  Graph.prototype._camera = function () {
    if (!this.cameraOn || this.nodes.length < 2) return;
    if (this.drag || this.panStart) return;
    if (this._camHold > 0) { this._camHold--; return; }

    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, i, nd;
    for (i = 0; i < this.nodes.length; i++) {
      nd = this.nodes[i];
      if (nd.x - nd.w / 2 < minX) minX = nd.x - nd.w / 2;
      if (nd.x + nd.w / 2 > maxX) maxX = nd.x + nd.w / 2;
      if (nd.y - nd.h / 2 < minY) minY = nd.y - nd.h / 2;
      if (nd.y + nd.h / 2 > maxY) maxY = nd.y + nd.h / 2;
    }

    var pad = 90;
    var tw = Math.max(200, maxX - minX) + pad;
    var th = Math.max(140, maxY - minY) + pad;
    var target = Math.max(0.08, Math.min(1.4, Math.min(this.w / tw, this.h / th)));

    var ease = 0.035;
    this.zoom += (target - this.zoom) * ease;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.pan.x += ((this.w / 2 - cx * this.zoom) - this.pan.x) * ease;
    this.pan.y += ((this.h / 2 - cy * this.zoom) - this.pan.y) * ease;
  };

  /* ---------- 物理 ---------- */
  Graph.prototype._step = function () {
    var N = this.nodes, n = N.length;
    if (n < 2) return;
    if (this.drag) return;          // 拖动是直接改位置，物理完全让位
    var i;

    // 没有任何速度、也不处于刚加入的分离期 → 整个物理步进直接跳过
    if (this._settleFrames <= 0) {
      var moving = false;
      for (i = 0; i < n; i++) { if (N[i].vx || N[i].vy) { moving = true; break; } }
      if (!moving) return;
    }
    if (this._settleFrames > 0) this._settleFrames--;

    for (i = 0; i < n; i++) {
      var nd = N[i];
      if (nd.isRoot) { nd.x = 0; nd.y = 0; nd.vx = 0; nd.vy = 0; continue; }
      nd.vx *= this.damping;
      nd.vy *= this.damping;
      if (Math.abs(nd.vx) < 0.02) nd.vx = 0;
      if (Math.abs(nd.vy) < 0.02) nd.vy = 0;
      nd.x += nd.vx;
      nd.y += nd.vy;
    }

    /* 卡片分离：矩形重叠就把彼此推开 */
    this._separate();
  };

  Graph.prototype._separate = function () {
    var N = this.nodes, n = N.length, gap = this.gap, passes = 1;
    for (var p = 0; p < passes; p++) {
      for (var i = 0; i < n; i++) {
        var a = N[i];
        var ahw = a.w / 2, ahh = a.h / 2;
        for (var j = i + 1; j < n; j++) {
          var b = N[j];
          var ox = ahw + b.w / 2 + gap - Math.abs(b.x - a.x);
          if (ox <= 0) continue;
          var oy = ahh + b.h / 2 + gap - Math.abs(b.y - a.y);
          if (oy <= 0) continue;

          var push = 0.5 * Math.min(ox, oy) * 0.9;
          var sxa = 0, sxb = 0, sya = 0, syb = 0;
          if (ox < oy) {
            var dirx = (b.x - a.x) < 0 ? -1 : 1;
            sxa = -dirx * push; sxb = dirx * push;
          } else {
            var diry = (b.y - a.y) < 0 ? -1 : 1;
            sya = -diry * push; syb = diry * push;
          }
          if (!a.isRoot) { a.x += sxa; a.y += sya; }
          if (!b.isRoot) { b.x += sxb; b.y += syb; }
        }
      }
    }
  };

  /* ---------- 建图 ---------- */
  Graph.prototype.addMod = function (mod) {
    if (!mod) return;
    var id = (mod.ids && mod.ids[0] && mod.ids[0].id) || String(mod.file).replace(/\.jar$/i, '');
    var idx = this.nodes.length;
    // 自动排版：黄金角螺旋，加载到谁就先占下一个位置，不管顺序
    var slot = (this.nodes[0] && this.nodes[0].isRoot) ? idx - 1 : idx;
    var ang = slot * 2.399963;
    var rad = this.spiralR0 + Math.sqrt(slot + 0.6) * this.spiralK;

    var clsN = (mod.code && mod.code.classes) || 0;
    var codeBytes = (mod.code && mod.code.bytes) || (mod.jarSize || 0);
    var tCount = (mod.targets || []).length;
    var fill = famColor(mod.loaders);

    var node = {
      i: idx,
      id: id,
      label: id,
      file: mod.file,
      mod: mod,
      desc: mod.desc || '',
      clsN: clsN,
      codeBytes: codeBytes,
      targetsN: tCount,
      w: 144,
      h: CARD_H,
      x: Math.cos(ang) * rad,
      y: Math.sin(ang) * rad,
      vx: 0, vy: 0,
      deg: 0,
      sev: 0,
      fill: fill,
      rgb: hexToRgb(fill)
    };
    this.nodes.push(node);
    this._settleFrames = Math.max(this._settleFrames, 40);

    // 登记 id（含 jar 内嵌套提供的 id）
    (mod.ids || []).forEach(function (x) { if (x.id && !this.byId.has(x.id)) this.byId.set(x.id, idx); }, this);
    (mod.nested || []).forEach(function (x) { if (x.id && !this.byId.has(x.id)) this.byId.set(x.id, idx); }, this);

    var self = this;

    // 目标边
    (mod.targets || []).forEach(function (t) {
      var key = t.namespace + '|' + t.cls + '#' + t.method;
      var bucket = self.buckets.get(key);
      if (!bucket) { bucket = new Map(); self.buckets.set(key, bucket); }

      var entry = {
        mod: idx, kind: t.kind,
        atValue: t.atValue, atTarget: t.atTarget, atOrdinal: t.atOrdinal,
        priority: t.priority, require: t.require, cancellable: t.cancellable
      };

      // 用和分析器完全相同的配对判定（A.grade），避免图上的颜色和报告打架
      bucket.forEach(function (oEntries, oIdx) {
        var g = null;
        try { g = A.grade(oEntries.concat([entry])); } catch (e) { g = null; }
        var sev = g ? (PAIR_RANK[g.kind] || 1) : 0;
        self._linkTarget(oIdx, idx, sev);
      });

      var list = bucket.get(idx);
      if (!list) { list = []; bucket.set(idx, list); }
      list.push(entry);
    });

    // 根节点边
    if (this.nodes.length && this.nodes[0].isRoot) this._link(0, idx, 'root');

    // 依赖边（前置资源）——先把已知的连上，未到的排队
    var deps = [];
    (mod.forgeDeps || []).forEach(function (d) { if (d && d.modId) deps.push(String(d.modId)); });
    Object.keys(mod.depends || {}).forEach(function (k) { deps.push(k); });
    (mod.ids || []).forEach(function (x) { if (x.id) deps.push(x.id); });

    var seen = {};
    for (var i = 0; i < deps.length; i++) {
      var dep = deps[i];
      if (!dep || NON_MOD.indexOf(dep) >= 0) continue;
      if (seen[dep]) continue;
      seen[dep] = 1;
      this.depQueue.push({ i: idx, dep: dep });
    }
    this._resolveDeps();
    this._refreshRoot();
    if (this.searchQuery) this.setSearch(this.searchQuery);
  };

  Graph.prototype._link = function (a, b, type, sev, from, to) {
    // 端点必须是合法节点索引：依赖可能指向没有成为节点的 mod（jar-in-jar 只登记 id），
    // 那时 a/b 会是 undefined，Math.min 得到 NaN，就会画出一条「选谁都不亮的孤儿线」。
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return;
    if (a === b) return;
    if (!this.nodes[a] || !this.nodes[b]) return;
    var lo = Math.min(a, b), hi = Math.max(a, b);
    var key = type.charAt(0) + '|' + lo + ':' + hi;
    var e = this.edges.get(key);
    if (!e) { e = { a: lo, b: hi, type: type, w: 0, sev: 0 }; this.edges.set(key, e); }
    // 依赖边有方向：from = 需要方，to = 被依赖方（画箭头用）
    if (from != null) { e.from = from; e.to = to; }
    e.w += 1;
    if (sev && sev > e.sev) e.sev = sev;
    if (sev) {
      if (this.nodes[lo] && sev > this.nodes[lo].sev) this.nodes[lo].sev = sev;
      if (this.nodes[hi] && sev > this.nodes[hi].sev) this.nodes[hi].sev = sev;
    }
    if (this.nodes[lo]) this.nodes[lo].deg = (this.nodes[lo].deg || 0) + 1;
    if (this.nodes[hi]) this.nodes[hi].deg = (this.nodes[hi].deg || 0) + 1;
  };

  Graph.prototype._linkTarget = function (a, b, sev) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return;
    if (a === b) return;
    if (!this.nodes[a] || !this.nodes[b]) return;
    var lo = Math.min(a, b), hi = Math.max(a, b);
    var key = 't|' + lo + ':' + hi;
    var e = this.edges.get(key);
    if (!e) { e = { a: lo, b: hi, type: 'target', w: 0, sev: 0 }; this.edges.set(key, e); }
    e.w += 1;
    if (sev > e.sev) e.sev = sev;
    if (this.nodes[lo] && sev > this.nodes[lo].sev) this.nodes[lo].sev = sev;
    if (this.nodes[hi] && sev > this.nodes[hi].sev) this.nodes[hi].sev = sev;
    if (this.nodes[lo]) this.nodes[lo].deg++;
    if (this.nodes[hi]) this.nodes[hi].deg++;
  };

  Graph.prototype._resolveDeps = function () {
    for (var k = this.depQueue.length - 1; k >= 0; k--) {
      var q = this.depQueue[k];
      var p = this.byId.get(q.dep);
      if (p === undefined) continue;
      this.depQueue.splice(k, 1);
      if (p === q.i) continue;
      this._link(p, q.i, 'dep', 0, q.i, p);   // from = 需要方，to = 被依赖方
    }
  };

  Graph.prototype.othersFor = function (idx, key) {
    var bucket = this.buckets.get(key);
    if (!bucket) return [];
    var out = [];
    bucket.forEach(function (list, oIdx) {
      if (oIdx === idx) return;
      var nd = this.nodes[oIdx];
      if (!nd) return;
      var kinds = [];
      for (var i = 0; i < list.length; i++) if (kinds.indexOf(list[i].kind) < 0) kinds.push(list[i].kind);
      out.push({ node: nd, kinds: kinds });
    }, this);
    return out;
  };

  Graph.prototype._idxOfFile = function (f) {
    for (var i = 0; i < this.nodes.length; i++) if (this.nodes[i].file === f) return i;
    return -1;
  };

  Graph.prototype.applyIssues = function (report) {
    var self = this;
    var byFile = new Map();

    (report.issues || []).forEach(function (it) {
      var sev = it.severity || (it.level === 'high' ? 3 : it.level === 'med' ? 2 : 1);
      var files = it.mods || [];

      files.forEach(function (f) {
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(it);
      });

      // 多方关系（重复安装 / 声明不兼容）直接画成一条边，红色那种
      if (it.kind === 'dup-modid' || it.kind === 'declared-incompatible') {
        var uniq = [];
        files.forEach(function (f) { if (uniq.indexOf(f) < 0) uniq.push(f); });
        var idxs = uniq.map(function (f) { return self._idxOfFile(f); })
          .filter(function (x) { return x >= 0; });
        for (var i = 0; i < idxs.length; i++) {
          for (var j = i + 1; j < idxs.length; j++) {
            self._link(idxs[i], idxs[j], 'issue', sev);
          }
        }
      }
    });

    this.nodes.forEach(function (nd) {
      if (nd.isRoot) return;
      var list = byFile.get(nd.file) || [];
      nd.issues = list;
      list.forEach(function (it) {
        var s = it.severity || 2;
        if (s > nd.sev) nd.sev = s;
      });
    });
  };

  /* ---------- 绘制 ---------- */
  Graph.prototype._grid = function (ctx) {
    var step = 46 * this.zoom;
    if (step < 9) return;
    var W = this.w, H = this.h;
    var ox = this.pan.x % step, oy = this.pan.y % step;
    if (ox > 0) ox -= step;
    if (oy > 0) oy -= step;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.026)';
    ctx.beginPath();
    for (var x = ox; x <= W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (var y = oy; y <= H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    var big = step * 5;
    var bx = this.pan.x % big, by = this.pan.y % big;
    if (bx > 0) bx -= big;
    if (by > 0) by -= big;
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.beginPath();
    for (var x2 = bx; x2 <= W; x2 += big) { ctx.moveTo(x2 + 0.5, 0); ctx.lineTo(x2 + 0.5, H); }
    for (var y2 = by; y2 <= H; y2 += big) { ctx.moveTo(0, y2 + 0.5); ctx.lineTo(W, y2 + 0.5); }
    ctx.stroke();
  };

  Graph.prototype._draw = function () {
    var ctx = this.ctx, W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this._grid(ctx);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    var sel = this.selected;
    var N = this.nodes;
    var invZoom = 1 / this.zoom;
    var look = this.look;

    /* 视口裁剪：只画「可视范围 125%」内的东西（四周各留 12.5% 缓冲） */
    var vw = this.w / this.zoom, vh = this.h / this.zoom;
    var vcx = (this.w / 2 - this.pan.x) / this.zoom;
    var vcy = (this.h / 2 - this.pan.y) / this.zoom;
    var vis = {
      l: vcx - vw * 0.625, r: vcx + vw * 0.625,
      t: vcy - vh * 0.625, b: vcy + vh * 0.625
    };
    var i0;
    for (i0 = 0; i0 < N.length; i0++) {
      var q = N[i0];
      q._vis = (q.x + q.w / 2 >= vis.l && q.x - q.w / 2 <= vis.r &&
        q.y + q.h / 2 >= vis.t && q.y - q.h / 2 <= vis.b);
    }

    /* 按镜头距离降精度：0 只有色块 / 1 +色条描边 / 2 +渐变光 / 3 +阴影光晕与正文 */
    var detail = this.zoom >= 0.9 ? 3 : this.zoom >= 0.5 ? 2 : this.zoom >= 0.25 ? 1 : 0;
    var drawn = 0;

    /* ---- 边 ---- */
    var focus = this.edgeFocus;
    var lfocus = this.loaderFocus;
    var crit = this.critFocus;
    var critT = this.critT || 0;
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // 指数逼近目标值：起步快、尾巴长，就是「先快后慢」
    var critGoal = crit ? 1 : 0;
    if (Math.abs(critGoal - critT) > 0.002) {
      critT += (critGoal - critT) * 0.2;
      this.critT = critT;
    } else if (critT !== critGoal) {
      critT = critGoal;
      this.critT = critGoal;
    }
    var match = this._match;

    /* 筛选强度缓动：按「每一类」分别逼近 0/1。
       从「只看 r4」切到「只看 r3」时就是交叉淡出淡入，而不是硬切。 */
    if (!this._edgeT) this._edgeT = {};
    if (!this._loaderT) this._loaderT = {};
    var edgeT = this._edgeT, loaderT = this._loaderT;
    var eStrength = 0, lStrength = 0;

    ['r4', 'r3', 'r2', 'r1', 'dep', 'root'].forEach(function (k) {
      var goal = focus.has(k) ? 1 : 0;
      var v = edgeT[k] || 0;
      if (Math.abs(goal - v) > 0.004) v += (goal - v) * 0.18;
      else v = goal;
      edgeT[k] = v;
      if (v > eStrength) eStrength = v;
    });
    ['fabric', 'neoforge', 'forge', 'multi', 'unknown'].forEach(function (k) {
      var goal = lfocus.has(k) ? 1 : 0;
      var v = loaderT[k] || 0;
      if (Math.abs(goal - v) > 0.004) v += (goal - v) * 0.18;
      else v = goal;
      loaderT[k] = v;
      if (v > lStrength) lStrength = v;
    });

    /* 先把每个节点的有效不透明度算出来，连线要用：
       两端只要有一个被压暗，线就跟着压暗（取较小值）。 */
    var nbrPre = this._neighbors(sel);
    var nodeDim = new Array(N.length);
    for (var di = 0; di < N.length; di++) {
      var dn = N[di];
      var dSel = di === sel, dHov = di === this.hovered;
      var dIso = !dn.isRoot && !dn.deg;
      var dHit = !match || match.has(di) || dn.isRoot;
      var da = (dSel || dHov) ? 1 : (sel >= 0 && !nbrPre.has(di) ? 0.28 : (dIso ? 0.55 : 1));
      if (!dHit && !dSel && !dHov) da *= 0.1;
      if (lStrength > 0.004 && !dn.isRoot && !dSel && !dHov) {
        var oL = loaderT[loaderKeyOf(dn.mod && dn.mod.loaders)] || 0;
        da *= 1 - lStrength * 0.93 * (1 - oL);
      }
      if (critT > 0.01 && !dn.isRoot && !dSel && !dHov && dn.sev < 3) da *= (1 - critT * 0.93);
      nodeDim[di] = da;
    }

    this.edges.forEach(function (e) {
      var a = N[e.a], b = N[e.b];
      if (!a || !b) return;   // 无效端点（历史脏数据）直接跳过，避免画出无法高亮的线
      if (!a || !b) return;
      // 两端都在视口外、且线段包围盒也不相交 → 跳过
      if (!a._vis && !b._vis) {
        if (Math.max(a.x, b.x) < vis.l || Math.min(a.x, b.x) > vis.r) return;
        if (Math.max(a.y, b.y) < vis.t || Math.min(a.y, b.y) > vis.b) return;
      }
      var hot = sel >= 0 && (e.a === sel || e.b === sel);
      var dim = sel >= 0 && !hot;

      var rgb, alpha, width;

      if (e.type === 'root') {
        rgb = '150,166,198';
        alpha = 0.14;
        width = 0.8;
      } else if (e.type === 'dep') {
        rgb = '70,211,154';
        alpha = hot ? 0.95 : 0.5;
        width = 1.15;
      } else if (e.type === 'issue') {
        rgb = SEV_COLOR[e.sev] || SEV_COLOR[4];
        alpha = 0.85;
        width = 1.9;
      } else {
        rgb = SEV_COLOR[e.sev] || SEV_COLOR[0];
        alpha = ({ 4: 0.82, 3: 0.7, 2: 0.58, 1: 0.32, 0: 0.26 })[e.sev] || 0.26;
        width = 0.9 + Math.log(e.w + 1) * 0.85;
      }

      if (dim) alpha *= 0.16;
      else if (hot) alpha = Math.min(1, alpha * 1.5 + 0.2);

      // 图例多选：按各自缓动强度做交叉淡入淡出
      if (eStrength > 0.004) {
        var ownE = edgeT[edgeKindOf(e)] || 0;
        alpha *= 1 - eStrength * 0.93 * (1 - ownE);
      }
      // 搜索：两端都没命中的连线一起压暗
      if (match && !match.has(e.a) && !match.has(e.b)) alpha *= 0.1;

      // 连线入场缓动：比节点稍晚开始，逐条淡入
      if (e._t0 === undefined) e._t0 = now + 120 + (e.w || 0) * 2;
      var ep = (now - e._t0) / 520;
      if (ep < 0) ep = 0;
      if (ep < 1) alpha *= (1 - Math.pow(1 - ep, 2.4));

      // 高危高亮时连线一起收：不沾高危节点的线也淡下去，跟着 critT 缓动
      if (critT > 0.01) {
        var ca = N[e.a], cb = N[e.b];
        var touchesCrit = (ca && ca.sev >= 3) || (cb && cb.sev >= 3);
        if (!touchesCrit) alpha *= (1 - critT * 0.93);
      }

      // 端点被压暗时，线跟着压暗（两端取较小值）
      var dA = nodeDim[e.a], dB = nodeDim[e.b];
      if (dA != null && dB != null) alpha *= Math.min(dA, dB);
      else if (dA != null) alpha *= dA;
      else if (dB != null) alpha *= dB;

      // 选中某个节点时，与它无关的连线降到背景层：改用同心圆涟漪
      // （从边的中点扩散、到最大半径后回收），把注意力让给焦点关系。
      if (dim && alpha > 0.02) {
        var rmx = (a.x + b.x) / 2, rmy = (a.y + b.y) / 2;
        var Rmax = 20 * invZoom;
        var rphase = (now / 1500) % 1;
        ctx.setLineDash([]);
        for (var ri = 0; ri < 3; ri++) {
          var rt = (rphase + ri / 3) % 1;
          var rr = (2 + rt * Rmax) * 1;
          var ra = alpha * 1.35 * (1 - rt) * (1 - rt);
          if (ra <= 0.012) continue;
          ctx.beginPath();
          ctx.arc(rmx, rmy, rr, 0, 6.2832);
          ctx.strokeStyle = 'rgba(' + rgb + ',' + ra + ')';
          ctx.lineWidth = Math.max(0.5, 1.05 * look.edge) * invZoom;
          ctx.stroke();
        }
      }

      // 高亮的边：能量从选中节点出发冲向另一端。
      // 记下「开始高亮」的时刻，作为这一趟冲击的起点；不再高亮时清空。
      if (hot) {
        if (e._hotT0 == null) { e._hotT0 = now; e._hitFired = false; }
      } else if (e._hotT0 != null) {
        e._hotT0 = null;
        e._hitFired = false;
      }

      ctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')';
      ctx.lineWidth = Math.max(0.55, width * look.edge) * invZoom;

      if (e.type === 'dep') ctx.setLineDash([6 * invZoom, 5 * invZoom]);
      else if (e.type === 'issue') ctx.setLineDash([3 * invZoom, 3 * invZoom]);
      else ctx.setLineDash([]);

      ctx.beginPath();
      if (e.type === 'root') {
        // 根边用轻微曲线，避免全是直线放射太硬
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var nx = -(b.y - a.y), ny = (b.x - a.x);
        var len = Math.sqrt(nx * nx + ny * ny) || 1;
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx + nx / len * 12, my + ny / len * 12, b.x, b.y);
      } else {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      /* 高亮边：用「蒙版扫过」表达能量推进——
         亮区靠近出发点、暗区靠近目标端，亮暗分界随时间向目标推进；
         抵达瞬间销毁蒙版、点亮目标节点，并在「卡片边缘与连线的交点」炸开。 */
      if (hot && e._hotT0 != null) {
        var srcN = (e.a === sel) ? a : b;
        var dstN = (e.a === sel) ? b : a;
        var dstIdx = (e.a === sel) ? e.b : e.a;
        var sp = (now - e._hotT0) / 520;
        var spc = sp < 0 ? 0 : (sp > 1 ? 1 : sp);

        if (!e._hitFired) {
          // 蒙版：一层压暗膜覆盖「当前位置 → 终点」这一段（初始覆盖整条），
          // 随动画向终点收缩；被揭开的部分则用亮色重描，形成"亮区向终点推进"。
          var mxP = srcN.x + (dstN.x - srcN.x) * spc;
          var myP = srcN.y + (dstN.y - srcN.y) * spc;
          ctx.save();
          ctx.setLineDash([]);

          // 只有「仍被遮住」的那段需要额外绘制：
          // 未被覆盖的部分直接露出原来那条线（保持原有颜色与透明度）。
          if (spc < 0.999) {
            ctx.strokeStyle = 'rgba(6,8,12,0.62)';
            ctx.lineWidth = Math.max(1.6, (width + 2.4) * look.edge) * invZoom;
            ctx.beginPath();
            ctx.moveTo(mxP, myP);
            ctx.lineTo(dstN.x, dstN.y);
            ctx.stroke();
          }
          ctx.restore();
          if (spc >= 1) {
            e._hitFired = true;
            var tn0 = N[dstIdx];
            if (tn0) tn0._hitAt = now;
            var vx = dstN.x - srcN.x, vy = dstN.y - srcN.y;
            var vlen = Math.sqrt(vx * vx + vy * vy) || 1;
            var ux = vx / vlen, uy = vy / vlen;
            var hwI = dstN.w / 2, hhI = dstN.h / 2;
            var tdX = Math.abs(ux) < 1e-6 ? 1e9 : hwI / Math.abs(ux);
            var tdY = Math.abs(uy) < 1e-6 ? 1e9 : hhI / Math.abs(uy);
            var tdI = Math.min(tdX, tdY);
            e._impactPt = { x: dstN.x - ux * tdI, y: dstN.y - uy * tdI, ang: Math.atan2(uy, ux) };
            e._impactAt = now;
          }
        } else if (e._impactPt) {
          var age = now - (e._impactAt || now);
          var idur = 420;
          if (age >= 0 && age < idur) {
            var ip = age / idur;
            var px = e._impactPt.x, py = e._impactPt.y, ang0 = e._impactPt.ang;
            ctx.save();
            ctx.setLineDash([]);
            ctx.strokeStyle = 'rgba(255,255,255,' + (0.85 * (1 - ip)) + ')';
            ctx.lineWidth = Math.max(0.9, 1.8 * invZoom);
            ctx.beginPath();
            ctx.arc(px, py, (3 + ip * 20) * invZoom, 0, 6.2832);
            ctx.stroke();
            var shards = 7;
            for (var si2 = 0; si2 < shards; si2++) {
              var spread = (si2 / (shards - 1) - 0.5) * 1.75;
              var sa = ang0 + spread;
              var dist = (6 + ip * 26) * invZoom;
              var sz = (1.6 + 1.6 * (1 - ip)) * invZoom;
              ctx.save();
              ctx.translate(px + Math.cos(sa) * dist, py + Math.sin(sa) * dist);
              ctx.rotate(sa);
              ctx.fillStyle = 'rgba(' + rgb + ',' + (0.9 * (1 - ip)) + ')';
              ctx.fillRect(-sz, -sz * 0.55, sz * 2, sz * 1.1);
              ctx.restore();
            }
            ctx.restore();
          }
        }
      }

      if (e.type === 'dep' && e.from != null && e.to != null) {
        var nF = N[e.from], nT = N[e.to];
        if (nF && nT) {
          var ax = nT.x - nF.x, ay = nT.y - nF.y;
          var alen = Math.sqrt(ax * ax + ay * ay) || 1;
          var ux2 = ax / alen, uy2 = ay / alen;

          // 求射线与目标卡片矩形边界的交点
          var hw = nT.w / 2 + 2, hh = nT.h / 2 + 2;
          var tX = Math.abs(ux2) < 1e-6 ? 1e9 : hw / Math.abs(ux2);
          var tY = Math.abs(uy2) < 1e-6 ? 1e9 : hh / Math.abs(uy2);
          var td = Math.min(tX, tY);
          var tipX = nT.x - ux2 * td, tipY = nT.y - uy2 * td;

          var size = 8 * invZoom;          // 屏幕上恒定大小
          var halfW = size * 0.5;
          var bx2 = tipX - ux2 * size, by2 = tipY - uy2 * size;
          var px2 = -uy2, py2 = ux2;       // 垂直方向

          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(bx2 + px2 * halfW, by2 + py2 * halfW);
          ctx.lineTo(bx2 - px2 * halfW, by2 - py2 * halfW);
          ctx.closePath();
          ctx.fillStyle = 'rgba(' + rgb + ',' + Math.min(1, alpha + 0.3) + ')';
          ctx.fill();
        }
      }
    });

    /* ---- 节点卡片 ---- */
    var nbr = this._neighbors(sel);

    for (var i = 0; i < N.length; i++) {
      var nd = N[i];
      if (!nd._vis) continue;          // 视口外直接不画
      drawn++;
      var isSel = i === sel, isHov = i === this.hovered;
      var isolated = !nd.isRoot && !nd.deg;
      var hit = !match || match.has(i) || nd.isRoot;
      var alpha = (isSel || isHov) ? 1
        : (sel >= 0 && !nbr.has(i) ? 0.28 : (isolated ? 0.55 : 1));
      if (!hit && !isSel && !isHov) alpha *= 0.1;

      // 标签颜色筛选：同样走缓动
      if (lStrength > 0.004 && !nd.isRoot && !isSel && !isHov) {
        var ownL = loaderT[loaderKeyOf(nd.mod && nd.mod.loaders)] || 0;
        alpha *= 1 - lStrength * 0.93 * (1 - ownL);
      }
      // 高危高亮：只留 sev>=3 的节点。只看 critT、不看开关状态——
      // 否则关掉那一刻 crit 变 false，遮罩立刻失效，淡出就被跳过了。
      if (critT > 0.01 && !nd.isRoot && !isSel && !isHov && nd.sev < 3) {
        alpha *= (1 - critT * 0.93);
      }

      // 冲击到达后的短暂点亮：目标节点在"被打到"之前保持原样
      if (nd._hitAt != null) {
        var sinceHit = now - nd._hitAt;
        if (sinceHit >= 0 && sinceHit < 260) alpha = Math.min(1, alpha + 0.6 * (1 - sinceHit / 260));
      }

      // 「贴上去」入场：缩放 + 轻微过冲，逐张错开
      if (nd._t0 === undefined) nd._t0 = now + drawn * 14;
      var ap = (now - nd._t0) / 440;
      if (ap < 0) ap = 0;
      if (ap > 1) ap = 1;
      var apE = 1 - Math.pow(1 - ap, 3);          // 先快后慢
      var overshoot = Math.sin(Math.PI * ap) * 0.035;
      var k = 0.86 + 0.14 * apE + overshoot;
      var fade = Math.min(1, ap * 1.7);

      ctx.save();
      if (ap < 1) {
        ctx.translate(nd.x, nd.y);
        ctx.scale(k, k);
        ctx.translate(-nd.x, -nd.y);
      }
      this._drawCard(ctx, nd, {
        alpha: alpha * fade,
        selected: isSel,
        hovered: isHov,
        matched: hit && !!match,
        glow: look.glow,
        rim: look.rim,
        invZoom: invZoom,
        zoom: this.zoom,
        detail: detail
      });
      if (ap < 1) ctx.restore();
    }
    this._drawn = drawn;

    ctx.restore();

    if ((++this._hintTick % 20) === 0) updateHint(this);
  };

  Graph.prototype._drawCard = function (ctx, nd, o) {
    var x = nd.x, y = nd.y, w = nd.w, h = nd.h;
    var left = x - w / 2, top = y - h / 2;
    var rad = 9;
    var rgb = nd.sev >= 2 ? (SEV_COLOR[nd.sev] || nd.rgb) : nd.rgb;
    var isRoot = !!nd.isRoot;

    ctx.globalAlpha = o.alpha;

    /* 发光：径向渐变贴图（真正的渐变，不是一块平色） */
    if (o.glow > 0 && o.detail >= 2) {
      var sprite = glowSprite(rgb);
      var R = Math.max(w, h) * (0.85 + o.glow * 0.045);
      var gAlpha = (isRoot ? 0.75 : nd.sev >= 3 ? 0.95 : nd.sev === 2 ? 0.85 : o.selected ? 0.9 : 0.55)
        * Math.min(1.6, 0.45 + o.glow / 16);
      ctx.globalAlpha = o.alpha * gAlpha;
      ctx.drawImage(sprite, x - R, y - R, R * 2, R * 2);
      ctx.globalAlpha = o.alpha;

      if ((nd.sev > 0 || o.selected || o.hovered || isRoot) && o.detail >= 3) {
        ctx.save();
        ctx.shadowColor = 'rgba(' + rgb + ',' + (nd.sev >= 2 ? 0.85 : o.selected ? 0.75 : 0.45) + ')';
        ctx.shadowBlur = Math.max(6, o.glow * (nd.sev >= 3 ? 1.3 : 1));
        rrPath(ctx, left, top, w, h, rad, rad, rad, rad);
        ctx.fillStyle = 'rgba(20,24,32,0.98)';
        ctx.fill();
        ctx.restore();
      }
    }

    /* 卡片底（灰） */
    rrPath(ctx, left, top, w, h, rad, rad, rad, rad);
    ctx.fillStyle = 'rgba(28,32,42,0.97)';
    ctx.fill();

    /* 顶部高亮条：颜色 = 加载器 / 风险 */
    var th = isRoot ? 26 : TITLE_H;
    var fams = (!isRoot && nd.mod && nd.mod.loaders) ? nd.mod.loaders : [];
    if (fams.length > 1) {
      // 多加载器：标题条按加载器等分上色（2 种各半、3 种各三分之一），
      // 交界处用斜线切开；顺序按「谁在这个 mod 里占的代码更多」排。
      // 分不出主次时（差距 < 80%），左端画一条竖灰条表示顺序未知。
      ctx.save();
      rrPath(ctx, left, top, w, th, rad, rad, 0, 0);
      ctx.clip();
      var cols = fams.slice(0, 3).map(function (l) { return FAM_COLOR[l] || '#5f6779'; });
      var n = cols.length;
      var segW = w / n;
      ctx.globalAlpha = o.alpha * 0.92;
      // 先整条铺第一种颜色，再用「平行四边形」覆盖右侧各段。
      // 关键：交界必须是斜的（填充形状是斜的），而不是矩形硬边 + 另画一条斜线。
      ctx.fillStyle = cols[0];
      ctx.fillRect(left, top, w, th);
      for (var si = 1; si < n; si++) {
        var bx = left + si * segW;
        ctx.beginPath();
        ctx.moveTo(bx + th / 2, top);
        ctx.lineTo(left + w, top);
        ctx.lineTo(left + w, top + th);
        ctx.lineTo(bx - th / 2, top + th);
        ctx.closePath();
        ctx.fillStyle = cols[si];
        ctx.fill();
      }
      // 顺序未知：左端一条竖灰条，宽度 ≈ 一个圆角
      if (nd.mod && nd.mod.orderKnown === false) {
        ctx.globalAlpha = o.alpha * 0.95;
        ctx.fillStyle = 'rgba(150,155,168,0.92)';
        ctx.fillRect(left, top, rad, th);
      }
      ctx.restore();    } else {
      rrPath(ctx, left, top, w, th, rad, rad, 0, 0);
      ctx.fillStyle = 'rgba(' + rgb + ',0.92)';
      ctx.fill();
    }
    // 顶部一条细亮边，让色条有立体感（低精度下省略）
    if (o.detail >= 2) {
      rrPath(ctx, left + 1, top + 1, w - 2, Math.max(2, th * 0.34), rad, rad, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fill();
    }

    /* 风险点 */
    if (nd.sev > 0 && !isRoot && o.detail >= 2) {
      ctx.beginPath();
      ctx.arc(left + w - 10, top + th / 2, 3, 0, 6.2832);
      ctx.fillStyle = 'rgba(20,23,30,0.85)';
      ctx.fill();
    }

    /* 边框 */
    rrPath(ctx, left, top, w, h, rad, rad, rad, rad);
    ctx.lineWidth = (o.rim > 0 ? o.rim : 1);
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (nd.sev ? 0.75 : 0.28) + ')';
    ctx.stroke();

    /* 选中外框 */
    if (o.selected || o.hovered) {
      rrPath(ctx, left - 4, top - 4, w + 8, h + 8, rad + 3, rad + 3, rad + 3, rad + 3);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = o.selected ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.26)';
      ctx.stroke();
    }

    /* 搜索命中：蓝色描边圈 */
    if (o.matched) {
      rrPath(ctx, left - 3, top - 3, w + 6, h + 6, rad + 2, rad + 2, rad + 2, rad + 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(91,157,255,0.85)';
      ctx.stroke();
    }

    /* ---- 文字：缩放分级 ---- */
    var screenW = w * o.zoom;
    var innerW = w - PAD * 2;

    if (screenW < 32) { ctx.globalAlpha = 1; return; }

    if (screenW < 110 && !isRoot) {
      // 缩得小：只留色块，名字挂到卡片下方用固定屏幕字号，保证总览时还能读
      ctx.globalAlpha = o.alpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '600 ' + (9.5 * o.invZoom) + 'px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(202,212,234,0.82)';
      ctx.fillText(fitText(ctx, nd.label, nd.w * 1.2), nd.x, nd.y + h / 2 + 3 * o.invZoom);
      ctx.globalAlpha = 1;
      return;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var titleSize = isRoot ? 11 : w * 0.075;
    ctx.font = '700 ' + titleSize + 'px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = (function () {
      // 标题字色跟着色条亮度走：亮底用深字，暗底用白字。
      // 多加载器分色条最容易出现「深字压在深色半边」的情况。
      var c = (fams && fams.length > 1) ? (FAM_COLOR[fams[0]] || '#5f6779') : null;
      if (!c) return 'rgba(12,15,20,0.92)';
      var r0 = parseInt(c.slice(1, 3), 16) || 0;
      var g0 = parseInt(c.slice(3, 5), 16) || 0;
      var b0 = parseInt(c.slice(5, 7), 16) || 0;
      var lum = (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
      return lum < 0.55 ? 'rgba(255,255,255,0.95)' : 'rgba(12,15,20,0.92)';
    })();
    ctx.fillText(fitText(ctx, nd.label, innerW - 12), left + PAD, top + th / 2 + 0.5);

    /* ---- 文字：正文（灰底详细内容） ---- */
    var by = top + th + PAD;
    ctx.textBaseline = 'top';

    if (isRoot) {
      ctx.font = '500 ' + (w * 0.058) + 'px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(168,180,204,0.92)';
      ctx.fillText(fitText(ctx, nd.sub, innerW), left + PAD, by);
      ctx.font = '400 ' + (w * 0.05) + 'px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(120,132,156,0.85)';
      ctx.fillText('根节点 · 所有 mod 都由它加载', left + PAD, by + LINE_H);
    } else {
      var l1 = nd.targetsN ? (nd.targetsN + ' 注入 · ' + nd.clsN + ' 类') : '无注入点';
      ctx.font = '600 ' + (w * 0.066) + 'px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = nd.targetsN ? 'rgba(206,216,236,0.95)' : 'rgba(126,136,158,0.9)';
      ctx.fillText(fitText(ctx, l1, innerW), left + PAD, by);

      ctx.font = '500 ' + (w * 0.062) + 'px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(138,150,176,0.9)';
      ctx.fillText(fitText(ctx, fmtKB(nd.codeBytes) + ' 代码', innerW), left + PAD, by + LINE_H);

      if (nd.desc) {
        ctx.font = '400 ' + (w * 0.056) + 'px -apple-system, "Segoe UI", sans-serif';
        ctx.fillStyle = 'rgba(112,124,148,0.88)';
        ctx.fillText(fitText(ctx, nd.desc, innerW), left + PAD, by + LINE_H * 2);
      }
    }

    ctx.globalAlpha = 1;
  };

  Graph.prototype._neighbors = function (sel) {
    var s = new Set();
    if (sel < 0) return s;
    this.edges.forEach(function (e) {
      if (e.a === sel) s.add(e.b);
      else if (e.b === sel) s.add(e.a);
    });
    return s;
  };

  Graph.prototype._toWorld = function (clientX, clientY) {
    var r = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.pan.x) / this.zoom,
      y: (clientY - r.top - this.pan.y) / this.zoom
    };
  };

  Graph.prototype._hit = function (w) {
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var nd = this.nodes[i];
      if (Math.abs(w.x - nd.x) <= nd.w / 2 + 4 && Math.abs(w.y - nd.y) <= nd.h / 2 + 4) return i;
    }
    return -1;
  };

  Graph.prototype.select = function (i) {
    if (this.selected === i) return;
    this.selected = i;
    if (this.onSelect) this.onSelect(i >= 0 ? this.nodes[i] : null);
  };

  Graph.prototype.fit = function () {
    if (!this.nodes.length) { this.zoom = 1; this.pan = { x: 0, y: 0 }; return; }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    this.nodes.forEach(function (nd) {
      minX = Math.min(minX, nd.x - nd.w / 2); maxX = Math.max(maxX, nd.x + nd.w / 2);
      minY = Math.min(minY, nd.y - nd.h / 2); maxY = Math.max(maxY, nd.y + nd.h / 2);
    });
    var pad = 60;
    var z = Math.min(
      (this.w - pad * 2) / Math.max(1, maxX - minX),
      (this.h - pad * 2) / Math.max(1, maxY - minY),
      1.3
    );
    this.zoom = Math.max(0.08, z);
    this.pan.x = this.w / 2 - ((minX + maxX) / 2) * this.zoom;
    this.pan.y = this.h / 2 - ((minY + maxY) / 2) * this.zoom;
    this._camHold = 150;
  };

  Graph.prototype._bind = function () {
    var self = this, c = this.canvas;

    c.addEventListener('pointerdown', function (ev) {
      c.setPointerCapture(ev.pointerId);
      var w = self._toWorld(ev.clientX, ev.clientY);
      var hit = self._hit(w);
      if (hit >= 0) {
        self.select(hit);
        var nd = self.nodes[hit];
        if (!nd.isRoot) {
          // 记下「指针到卡片中心」的偏移，之后 1:1 跟随
          self.drag = { i: hit, ox: nd.x - w.x, oy: nd.y - w.y };
          nd.vx = 0; nd.vy = 0;
        }
        c.classList.add('grabbing');
      } else {
        self.panStart = { x: ev.clientX, y: ev.clientY, px: self.pan.x, py: self.pan.y };
        c.classList.add('grabbing');
        self.select(-1);
        // 点击空白处关闭「高危高亮」
        if (self.critFocus) {
          self.critFocus = false;
          if (self.onFilterClear) self.onFilterClear();
        }
        if (self.onCameraManual) self.onCameraManual();
      }
    });

    c.addEventListener('pointermove', function (ev) {
      if (self.drag) {
        var w = self._toWorld(ev.clientX, ev.clientY);
        var nd = self.nodes[self.drag.i];
        nd.x = w.x + self.drag.ox;
        nd.y = w.y + self.drag.oy;
        nd.vx = 0; nd.vy = 0;
        return;
      }
      if (self.panStart) {
        self.pan.x = self.panStart.px + (ev.clientX - self.panStart.x);
        self.pan.y = self.panStart.py + (ev.clientY - self.panStart.y);
        return;
      }
      var w2 = self._toWorld(ev.clientX, ev.clientY);
      var hit2 = self._hit(w2);
      if (hit2 !== self.hovered) {
        self.hovered = hit2;
        c.classList.toggle('pointing', hit2 >= 0);
      }
    });

    function up() {
      var wasDragging = !!self.drag;
      self.drag = null;
      self.panStart = null;
      c.classList.remove('grabbing');
      // 放下后可能压到别人，跑几帧分离把它们推开
      if (wasDragging) self._settleFrames = Math.max(self._settleFrames, 24);
    }
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    c.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var r = c.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      var k = Math.exp(-ev.deltaY * 0.0013);
      var nz = Math.min(3.4, Math.max(0.06, self.zoom * k));
      self.pan.x = mx - (mx - self.pan.x) * (nz / self.zoom);
      self.pan.y = my - (my - self.pan.y) * (nz / self.zoom);
      self.zoom = nz;
      if (self.onCameraManual) self.onCameraManual();
    }, { passive: false });

    c.addEventListener('dblclick', function () { self.fit(); });
  };

  /* =====================================================================
   * 侧边栏
   * ===================================================================== */
  var graph;
  var currentReport = null;
  var currentInstance = null;   // 根节点信息面板用：加载器 / MC 版本
  var isLoading = false;      // 加载中：点画布不该弹文件选择框
  var loadToken = 0;          // 每次加载一个令牌；新加载会让旧的那次作废
    var activeWorker = null;    // 正在跑分析的 Worker（新加载时终止）
    var lastFiles = null;       // 最近一次投放的文件列表（给 Worker 用）
  var hintEl = null;
  var HINT_IDLE = '拖卡片 = 移动 · 滚轮 = 缩放 · 拖空白 = 平移 · 双击 = 自适应';

  /* 侧边栏切换的时间线：
     缓出：内容元素从下往上逐个向下淡出 → 标题淡出 → 换标题（高度过渡）
     缓入：换内容 → 标题淡入 → 内容元素从上到下逐个向上淡入 */
  var sideSeq = 0, sideTimer = 0, sideTimer2 = 0, sideFreshTimer = 0;
  var injFreshTimer = 0;
  var pendingHead = null;   // sideHeader() 只暂存，真正写入由队列在换内容那一刻执行

  function applyHead(html) {
    var head = document.getElementById('side-head');
    if (!head) return;
    var fromH = head.offsetHeight;
    head.innerHTML = html;
    var toH = head.offsetHeight;

    head.style.transition = 'none';
    head.style.overflow = 'hidden';
    head.style.height = fromH + 'px';
    head.style.opacity = '0';
    head.style.transform = 'translateY(-4px)';
    void head.offsetHeight;                       // 强制重排，让下一步能过渡
    head.style.transition = 'height .16s var(--ease-soft), opacity .13s ease, transform .13s ease';
    head.style.height = toH + 'px';
    head.style.opacity = '1';
    head.style.transform = 'none';

    setTimeout(function () {
      head.style.height = '';
      head.style.overflow = '';
      head.style.transition = '';
      head.style.opacity = '';
      head.style.transform = '';
    }, 200);
  }

  var sideQueue = {
    set html(value) {
      var body = $('#side-body');
      var head = document.getElementById('side-head');
      if (!body) return;
      var seq = ++sideSeq;
      clearTimeout(sideTimer);
      clearTimeout(sideTimer2);

      var kids = body.children;
      var n = kids.length;
      for (var i = 0; i < n; i++) {
        // 越靠下的元素越早开始淡出
        kids[i].style.setProperty('--d', ((n - 1 - i) * 16) + 'ms');
      }
      body.classList.add('leaving');
      var outMs = n ? Math.min(180, 90 + (n - 1) * 10) : 30;

      sideTimer = setTimeout(function () {
        if (seq !== sideSeq) return;
        // 内容淡出后，标题再淡出
        if (head) head.classList.add('head-out');
        sideTimer2 = setTimeout(function () {
          if (seq !== sideSeq) return;
          // 换标题（带高度过渡）
          if (head && pendingHead !== null) {
            applyHead(pendingHead);
            pendingHead = null;
          }
          if (head) head.classList.remove('head-out');
          // 换内容
          body.classList.remove('leaving');
          body.innerHTML = value;
          var fresh = body.children;
          for (var j = 0; j < fresh.length; j++) {
            fresh[j].style.setProperty('--d', (j * 22) + 'ms');
          }
          body.classList.remove('fresh');
          void body.offsetWidth;
          body.classList.add('fresh');
          // 播完就摘掉 .fresh：留着的话 animation 的 both 填充会持续占用透明度，
          // 下次淡出时浏览器不会把它当成可过渡的起点，于是退化成硬切
          clearTimeout(sideFreshTimer);
          sideFreshTimer = setTimeout(function () {
            body.classList.remove('fresh');
          }, Math.min(fresh.length, 20) * 22 + 420);
          body.dispatchEvent(new CustomEvent('sidebodyupdated'));
        }, head ? 90 : 0);
      }, outMs);
    }
  };

  function updateHint(g) {
    if (!hintEl) return;
    var total = g.nodes.length;
    if (!total) { hintEl.textContent = HINT_IDLE; return; }
    var tags = [];
    g.edgeFocus.forEach(function (k) { tags.push(FOCUS_LABEL[k] || k); });
    g.loaderFocus.forEach(function (k) { tags.push(LOADER_LABEL[k] || k); });
    if (g.critFocus) tags.push('高危');
    hintEl.textContent = '已绘制 ' + g._drawn + ' / ' + total + ' 个节点 · 缩放 ' +
      g.zoom.toFixed(2) + (tags.length ? ' · 筛选：' + tags.join(' / ') : '') +
      ' · 拖拽移动 · 滚轮缩放';
  }

  function sideHeader(kicker, title, sub, sub2) {
    // 只暂存，由 sideQueue 在「换内容那一刻」写入，标题才不会提前跳高度
    pendingHead =
      '<div class="kicker">' + esc(kicker) + '</div>' +
      '<h3>' + esc(title) + '</h3>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      (sub2 ? '<div class="sub" style="color:var(--fg-mute)">' + esc(sub2) + '</div>' : '');
  }

  function renderIdle() {
    var inst = currentReport
      ? (currentReport.mcVersion || '?') + ' / ' + (currentReport.instance ? currentReport.instance.loader : '?')
      : '还没开始';

    sideHeader('概览', '拖动一个节点查看详情', inst);
    sideQueue.html =
      '<div class="section-title">怎么用</div>' +
      '<div class="empty">' +
      '拖 <b>整个游戏目录</b>（或 <b>mods</b> 文件夹）到左侧。<br>' +
      '中间的方块是<b>模组加载器</b>，周围是各个 mod；卡片颜色条 = 加载器，<br>' +
      '<b>线是算出来的，不能拆</b>；卡片可以随便拖。' +
      '</div>' +
      '<div class="section-title">连线（可多选，再次点击取消）</div>' +
      '<div class="legend">' +
      legendLine('255,92,92', '红 · 可能直接起不来：缺依赖 / 重复安装 / 加载器不匹配 / 声明不兼容', 'r4') +
      legendLine('255,159,69', '橙 · 很可能失败：抢同一条指令', 'r3') +
      legendLine('255,209,102', '黄 · 可能被跳过或被覆盖：@Overwrite 重叠', 'r2') +
      legendLine('70,211,154', '绿虚线 + 箭头 · 前置依赖（箭头指向被依赖方）', 'dep') +
      '</div>' +
      '<div class="section-title">标签颜色（可多选）</div>' +
      '<div class="legend">' +
      legendDot('#6ea8fe', 'Fabric', 'fabric') +
      legendDot('#ffb454', 'NeoForge', 'neoforge') +
      legendDot('#46d39a', 'Forge', 'forge') +
      legendDot('#b98cff', '多加载器（标题条按加载器分色）', 'multi') +
      '</div>' +
      '<div class="empty">卡片标题条下方灰区：注入点 / 类数 / 代码大小 / 模组概要。没有任何连线的卡片会淡下去。<br>连线仅用于表达关系，不参与节点排布；节点位置由自动排版决定，手动拖拽可覆盖。</div>' +
      '<div class="section-title">操作</div>' +
      '<div class="empty">拖拽卡片＝移动位置 · 滚轮＝缩放 · 拖空白＝平移 · 双击空白＝自适应 · Esc＝取消选中<br>右上角可切换摄像机跟随、调整发光线宽，以及导出精简 / 全量报表。</div>';

    // 图例与其它交互统一由 sidebodyupdated 事件在内容写入后绑定
  }

  function legendDot(color, text, loaderKey) {
    return '<div class="row' + (loaderKey ? ' legend-item' : '') + '"' +
      (loaderKey ? ' data-loader="' + loaderKey + '"' : '') +
      '><span class="swatch" style="background:' + color + '"></span>' + esc(text) + '</div>';
  }
  function legendLine(rgb, text, kind) {
    return '<div class="row' + (kind ? ' legend-item' : '') + '"' +
      (kind ? ' data-edge="' + kind + '"' : '') +
      '><span class="bar" style="background:rgba(' + rgb + ',0.9)"></span>' + esc(text) + '</div>';
  }

  /** 图例点击 → 多选筛选取并集（再次点击取消） */
  function bindLegend() {
    var body = document.getElementById('side-body');
    if (!body || !graph) return;
    var edgeRows = body.querySelectorAll('[data-edge]');
    var loaderRows = body.querySelectorAll('[data-loader]');

    function refresh() {
      for (var i = 0; i < edgeRows.length; i++) {
        edgeRows[i].classList.toggle('active', graph.edgeFocus.has(edgeRows[i].getAttribute('data-edge')));
      }
      for (var j = 0; j < loaderRows.length; j++) {
        loaderRows[j].classList.toggle('active', graph.loaderFocus.has(loaderRows[j].getAttribute('data-loader')));
      }
    }

    function bind(rows, attr, set) {
      for (var i = 0; i < rows.length; i++) {
        (function (row) {
          row.addEventListener('click', function () {
            var key = row.getAttribute(attr);
            if (set.has(key)) set.delete(key); else set.add(key);
            refresh();
            updateHint(graph);
          });
        })(rows[i]);
      }
    }

    bind(edgeRows, 'data-edge', graph.edgeFocus);
    bind(loaderRows, 'data-loader', graph.loaderFocus);
    refresh();
  }

  function stat(k, v) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  /* 根节点（模组加载器）的信息面板：只展示能从版本 json / jar 里读到的事实 */
  function renderRoot(node) {
    var inst = currentInstance || {};
    var r = currentReport || {};
    var stats = r.stats || {};
    var counts = r.issueCounts || {};

    sideHeader('根节点 · 模组加载器', node.label || '未知', node.sub || '', '所有 mod 都由它加载');

    // 各加载器下的 mod 数
    var byLoader = {};
    (graph.nodes || []).forEach(function (nd) {
      if (nd.isRoot || !nd.mod) return;
      var keys = (nd.mod.loaders && nd.mod.loaders.length) ? nd.mod.loaders : ['unknown'];
      keys.forEach(function (k) { byLoader[k] = (byLoader[k] || 0) + 1; });
    });

    // 版本 json 缺失时，退回 jar 里能读到的信息：多数派加载器 + 最常见的 MC 区间下界
    var loaderVote = {}, mcVote = {};
    (graph.nodes || []).forEach(function (nd) {
      if (nd.isRoot || !nd.mod) return;
      (nd.mod.loaders || []).forEach(function (k) { loaderVote[k] = (loaderVote[k] || 0) + 1; });
      var txt = mcRangeText(nd.mod);
      var rr = parseVerRange(txt);
      if (rr) {
        var lo = verText(rr.lo);
        mcVote[lo] = (mcVote[lo] || 0) + 1;
      }
    });
    function topKey(o) {
      var best = null, n = -1;
      Object.keys(o).forEach(function (k) { if (o[k] > n) { n = o[k]; best = k; } });
      return best;
    }
    var loaderGuess = topKey(loaderVote);
    var mcGuess = topKey(mcVote);
    var loaderShown = inst.loader || (loaderGuess ? LOADER_LABEL[loaderGuess] || loaderGuess : null);
    var mcShown = inst.mcVersion || mcGuess;

    var html = '';
    html += '<div class="section-title">加载器</div><div class="stats">' +
      stat('类型', loaderShown ? loaderShown + (inst.loader ? '' : '（jar 推断）') : '未识别') +
      stat('版本', inst.loaderVersion || '未声明') +
      stat('MC 版本', mcShown ? mcShown + (inst.mcVersion ? '' : '（jar 推断）') : '未识别') +
      '</div>';

    html += '<div class="section-title">实例统计</div><div class="stats">' +
      stat('mod', stats.jars || 0) +
      stat('注入点', stats.targets || 0) +
      stat('类', stats.classes || 0) +
      stat('高危', counts.high || 0) +
      '</div>';

    // 版本 json 里读到的其它元信息
    var extra = [];
    if (inst.javaMajor) extra.push(stat('Java', 'Java ' + inst.javaMajor));
    if (inst.libraryCount != null) extra.push(stat('库', inst.libraryCount + ' 个'));
    if (inst.assetIndex) extra.push(stat('资源索引', inst.assetIndex));
    if (inst.clientSize) extra.push(stat('客户端 jar', fmtKB(inst.clientSize)));
    if (extra.length) html += '<div class="section-title">版本元信息</div><div class="stats">' + extra.join('') + '</div>';

    if (inst.mainClass) {
      html += '<div class="section-title">启动主类</div>' +
        '<div class="empty" style="font-family:ui-monospace,monospace">' + esc(inst.mainClass) + '</div>';
    }

    var lk = Object.keys(byLoader).sort(function (a, b) { return byLoader[b] - byLoader[a]; });
    if (lk.length) {
      html += '<div class="section-title">按加载器分布</div><div class="kinds">';
      lk.forEach(function (k) {
        html += '<span class="kind">' + esc(LOADER_LABEL[k] || k) + ' ×' + byLoader[k] + '</span>';
      });
      html += '</div>';
    }

    // 适配的 MC 版本：统计各 mod 声明的 mcRange
    var rangeHits = {};
    (graph.nodes || []).forEach(function (nd) {
      if (nd.isRoot || !nd.mod) return;
      var txt = mcRangeText(nd.mod);
      if (!txt) return;
      rangeHits[txt] = (rangeHits[txt] || 0) + 1;
    });
    var rs = Object.keys(rangeHits).sort(function (a, b) { return rangeHits[b] - rangeHits[a]; }).slice(0, 8);
    if (rs.length) {
      html += '<div class="section-title">模组声明的 MC 版本区间</div><div class="kinds">';
      rs.forEach(function (k) {
        html += '<span class="kind">' + esc(k) + ' ×' + rangeHits[k] + '</span>';
      });
      html += '</div>';
    }

    html += '<div class="section-title">说明</div>' +
      '<div class="empty">以上全部来自版本 json 与各 jar 的元数据，不是运行时读取。'
      + '每条从根出发的线代表一个被它加载的 mod；点任意卡片查看该 mod 的修改清单。</div>';

    sideQueue.html = html;
  }

  function renderNode(node) {
    if (!node) { renderIdle(); return; }

    if (node.isRoot) {
      renderRoot(node);
      return;
    }

    var mod = node.mod;
    var id = (mod.ids && mod.ids[0] && mod.ids[0].id) || mod.file;
    var ver = mod.ids && mod.ids[0] && mod.ids[0].version;
    var loaders = (mod.loaders || []).join(' + ') || '未知';

    sideHeader('选中节点', id, (ver ? 'v' + ver : '无版本号') + ' · ' + loaders, mod.file);

    var targets = mod.targets || [];
    var kinds = {};
    targets.forEach(function (t) { kinds[t.kind] = (kinds[t.kind] || 0) + 1; });
    var clsSet = new Set(targets.map(function (t) { return t.cls; }));

    var html = '';
    if (mod.desc) html += '<div class="moddesc">' + esc(mod.desc) + '</div>';
    html += '<div class="statgrid">' +
      stat('注入点', targets.length) +
      stat('mixin 配置', (mod.mixinConfigs || []).length) +
      stat('目标类', clsSet.size) +
      stat('代码大小', fmtKB(mod.code ? mod.code.bytes : mod.jarSize)) +
      stat('class 数', mod.code ? mod.code.classes : 0) +
      stat('嵌套 mod', (mod.nested || []).length) +
      '</div>';

    if (targets.length) {
      html += '<div class="section-title">注入类型（点选可筛选）</div><div class="kinds">';
      html += '<span class="kind clickable on" data-filter-kind="">全部</span>';
      Object.keys(kinds).sort(function (a, b) { return (KW[b] || 0) - (KW[a] || 0); }).forEach(function (k) {
        html += '<span class="kind clickable w' + (KW[k] || 0) + '" data-filter-kind="' + esc(k) + '">' +
          esc(k) + ' ×' + kinds[k] + '</span>';
      });
      html += '</div>';
    }

    var groups = new Map();
    targets.forEach(function (t) {
      var key = t.namespace + '|' + t.cls + '#' + t.method;
      var g = groups.get(key);
      if (!g) { g = { key: key, cls: t.cls, method: t.method, kinds: new Set() }; groups.set(key, g); }
      g.kinds.add(t.kind);
    });
    var list = Array.from(groups.values());
    list.forEach(function (g) { g.sev = severity(g.kinds); g.others = graph.othersFor(node.i, g.key); });
    list.sort(function (a, b) {
      if (b.sev !== a.sev) return b.sev - a.sev;
      if (b.others.length !== a.others.length) return b.others.length - a.others.length;
      return a.key < b.key ? -1 : 1;
    });

    html += '<div class="section-title">修改清单（' + list.length + ' 处）</div>';
    if (!list.length) {
      html += '<div class="empty">这个 jar 里没找到注入点。<br>可能是纯资源/数据包，或者它用的不是 Mixin。</div>';
    } else {
      var LIMIT = 40;
      html += rowsHtml(list.slice(0, LIMIT), node);
      if (list.length > LIMIT) {
        html += '<details class="group"><summary>展开其余 ' + (list.length - LIMIT) + ' 处</summary>' +
          rowsHtml(list.slice(LIMIT), node) + '</details>';
      }
    }

    var issues = node.issues || [];
    if (issues.length) {
      html += '<div class="section-title">相关问题</div>';
      issues.slice(0, 8).forEach(function (it) {
        html += '<div class="issue high"><div class="t">' + esc(it.title) + '</div></div>';
      });
    }

    sideQueue.html = html;
    $('#side-body').scrollTop = 0;

  }

  /** 侧边栏内容的交互绑定。
      内容是被 sideQueue 延迟写入的，同步绑定会绑到旧 DOM 上，所以改由
      sidebodyupdated 事件统一触发。 */
  function bindSideExtras() {
    var host = document.getElementById('side-body');
    if (!host) return;

    host.querySelectorAll('.others-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var box = btn.nextElementSibling;
        if (!box) return;
        var open = box.classList.toggle('open');
        btn.textContent = open ? '收起' : ('还有 ' + btn.getAttribute('data-n') + ' 个 mod 也改这里');
      });
    });

    host.querySelectorAll('.other').forEach(function (row) {
      row.addEventListener('click', function () {
        var idx = parseInt(row.getAttribute('data-goto'), 10);
        if (!isNaN(idx)) graph.select(idx);
      });
    });

    // 注入类型标签：点击 → 打开注入点面板并按该类型过滤
    host.querySelectorAll('.kind[data-kind]').forEach(function (tag) {
      tag.classList.add('clickable');
      tag.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openInjectionPanel({ kind: tag.getAttribute('data-kind') });
      });
    });

    // 「注入类型」筛选：选中若干类型 → 下方修改清单自动筛选
    bindKindFilter(host);
  }

  /* 条目入场：先撑开高度给出空位，再淡入并向左归位 */
  function enterRow(el) {
    if (!el || el.style.display !== 'none') return;
    if (el._anim) { el._anim.forEach(function (a) { try { a.cancel(); } catch (e) { } }); }
    el._anim = [];
    el.style.display = '';
    el.style.boxSizing = 'border-box';
    var h = el.offsetHeight;
    el.style.overflow = 'hidden';
    el.style.height = '0px';
    var a1 = el.animate([{ height: '0px' }, { height: h + 'px' }],
      { duration: 130, easing: 'ease-out', fill: 'forwards' });
    el._anim.push(a1);
    a1.onfinish = function () {
      el.style.height = h + 'px';
      var a2 = el.animate([
        { opacity: 0, transform: 'translateX(-14px)' },
        { opacity: 1, transform: 'none' }
      ], { duration: 200, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' });
      el._anim.push(a2);
      a2.onfinish = function () {
        el.style.height = ''; el.style.overflow = ''; el.style.opacity = ''; el.style.transform = '';
        if (el._anim) el._anim.forEach(function (a) { try { a.cancel(); } catch (e) { } });
        el._anim = null;
      };
    };
  }

  /* 条目退出：先淡出并向右滑出，再收起高度 */
  function exitRow(el) {
    if (!el || el.style.display === 'none') return;
    if (el._anim) { el._anim.forEach(function (a) { try { a.cancel(); } catch (e) { } }); }
    el._anim = [];
    var h = el.offsetHeight;
    el.style.boxSizing = 'border-box';
    el.style.overflow = 'hidden';
    var a1 = el.animate([
      { opacity: 1, transform: 'none', height: h + 'px' },
      { opacity: 0, transform: 'translateX(16px)', height: h + 'px' }
    ], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    el._anim.push(a1);
    a1.onfinish = function () {
      var a2 = el.animate([{ height: h + 'px' }, { height: '0px' }],
        { duration: 130, easing: 'ease-out', fill: 'forwards' });
      el._anim.push(a2);
      a2.onfinish = function () {
        el.style.display = 'none';
        el.style.height = ''; el.style.overflow = ''; el.style.opacity = ''; el.style.transform = '';
        if (el._anim) el._anim.forEach(function (a) { try { a.cancel(); } catch (e) { } });
        el._anim = null;
      };
    };
  }

  function bindKindFilter(host) {
    var chips = host.querySelectorAll('.kind[data-filter-kind]');
    if (!chips.length) return;
    var rows = Array.prototype.slice.call(host.querySelectorAll('.mod-row'));
    var selected = new Set();

    function sync() {
      rows.forEach(function (row) {
        var kinds = (row.getAttribute('data-kinds') || '').split(',');
        var match = selected.size === 0 ||
          kinds.some(function (k) { return selected.has(k); });
        var shown = row.style.display !== 'none';
        if (match && !shown) enterRow(row);
        else if (!match && shown) exitRow(row);
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var k = chip.getAttribute('data-filter-kind');
        if (!k) selected.clear();
        else if (selected.has(k)) selected.delete(k);
        else selected.add(k);
        chips.forEach(function (c) {
          var ck = c.getAttribute('data-filter-kind');
          c.classList.toggle('on', ck ? selected.has(ck) : selected.size === 0);
        });
        sync();
      });
    });
  }

  function rowsHtml(list, node) {
    var out = '';
    list.forEach(function (g, i) {
      var kindsHtml = '';
      Array.from(g.kinds).sort(function (a, b) { return (KW[b] || 0) - (KW[a] || 0); }).forEach(function (k) {
        kindsHtml += '<span class="kind clickable w' + (KW[k] || 0) + '" data-kind="' + esc(k) + '">' + esc(k) + '</span>';
      });
      var othersHtml = '';
      if (g.others.length) {
        othersHtml = '<button class="others-toggle" data-n="' + g.others.length + '">' +
          '还有 ' + g.others.length + ' 个 mod 也改这里</button>' +
          '<div class="others">' +
          g.others.map(function (o) {
            return '<div class="other" data-goto="' + o.node.i + '">' +
              '<span class="oid">' + esc(o.node.id) + '</span>' +
              '<span class="okind">' + esc(o.kinds.join(', ')) + '</span></div>';
          }).join('') + '</div>';
      }
      out += '<div class="mod-row" data-kinds="' + esc(Array.from(g.kinds).join(',')) + '">' +
        '<div class="target">' + esc(g.cls) + '<span class="cls">#' + esc(g.method) + '</span></div>' +
        '<div class="kinds">' + kindsHtml + '</div>' + othersHtml + '</div>';
    });
    return out;
  }

  /* =====================================================================
   * 全局面板
   * ===================================================================== */
  /* ---------------- 注入点面板 ---------------- */
  var injRows = [];

  function collectInjections() {
    var out = [];
    (graph.nodes || []).forEach(function (nd) {
      if (nd.isRoot || !nd.mod) return;
      (nd.mod.targets || []).forEach(function (t) {
        out.push({
          cls: t.cls, method: t.method, desc: t.desc || '',
          kind: t.kind, atValue: t.atValue, atTarget: t.atTarget, atOrdinal: t.atOrdinal,
          priority: t.priority, require: t.require, cancellable: t.cancellable,
          mod: nd.id, file: nd.file, node: nd.i,
          key: t.namespace + '|' + t.cls + '#' + t.method
        });
      });
    });
    return out;
  }

  function injectionDetailHTML(r) {
    var parts = [];
    var bucket = graph.buckets.get(r.key);
    if (bucket) {
      bucket.forEach(function (entries, idx) {
        var nd = graph.nodes[idx];
        if (!nd) return;
        var kinds = [];
        entries.forEach(function (e) { if (kinds.indexOf(e.kind) < 0) kinds.push(e.kind); });
        parts.push(esc(nd.id) + ' <span style="color:var(--fg-mute)">(' + esc(kinds.join(', ')) + ')</span>');
      });
    }
    var rows = [
      ['目标类', r.cls],
      ['方法', r.method + (r.desc || '')],
      ['注入类型', r.kind],
      ['锚点', (r.atValue || '-') + (r.atTarget ? ' → ' + r.atTarget : '')],
      ['序号', r.atOrdinal == null ? '-' : String(r.atOrdinal)],
      ['priority', r.priority == null ? '默认 1000' : String(r.priority)],
      ['require', r.require == null ? '-' : String(r.require)],
      ['cancellable', r.cancellable ? 'true' : 'false'],
      ['所属模组', r.mod],
      ['文件', r.file]
    ];
    var html = '<dl>';
    rows.forEach(function (kv) {
      html += '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
    });
    html += '</dl>';
    if (parts.length) {
      html += '<div class="section-title">同一目标上的其他注入</div><div class="empty">' + parts.join('<br>') + '</div>';
    }
    html += '<div class="empty" style="margin-top:12px;color:var(--fg-mute)">' +
      '这里是注解级结构（@Mixin / @Inject / @At 的声明值），不是反汇编字节码。</div>';
    return html;
  }

  /** 列表页 → 详情页：第一次整页左滑，之后只换卡片 */
  function showInjectionDetail(r) {
    var body = document.querySelector('.sheet-body.split');
    var box = document.getElementById('inj-detail');
    var back = document.getElementById('inj-back');
    if (!body || !box) return;

    if (!body.classList.contains('detail-open')) {
      box.innerHTML = '<div class="card-inner">' + injectionDetailHTML(r) + '</div>';
      box.scrollTop = 0;
      body.classList.add('detail-open');   // 列表收窄；卡片延迟 0.31s 后才向左就位
      if (back) back.style.display = '';
      return;
    }

    // 已展开：列表不动，旧卡片向右淡出 → 换内容 → 新卡片从右侧进入
    var old = box.firstElementChild;
    if (old) old.classList.add('swap-out');
    setTimeout(function () {
      box.innerHTML = '<div class="card-inner">' + injectionDetailHTML(r) + '</div>';
      box.scrollTop = 0;
      var fresh = box.firstElementChild;
      if (fresh) {
        fresh.classList.add('swap-out');   // 先置于出场态
        requestAnimationFrame(function () { fresh.classList.remove('swap-out'); });
      }
    }, 160);
  }

  function renderInjectionList() {
    var qEl = document.getElementById('inj-q');
    var q = qEl ? String(qEl.value || '').trim().toLowerCase() : '';
    var list = injRows.filter(function (r) {
      if (!q) return true;
      var hay = (r.cls + ' ' + r.method + ' ' + r.mod + ' ' + r.kind + ' ' + (r.atTarget || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var MAX = 600;
    var html = '';
    list.slice(0, MAX).forEach(function (r, n) {
      html += '<div class="inj-row" data-i="' + injRows.indexOf(r) + '" style="--i:' + Math.min(24, n) + '">' +
        '<span class="cls">' + esc(r.cls) + '#' + esc(r.method) + '</span>' +
        '<span class="k">' + esc(r.kind) + '</span></div>';
    });
    var box = document.getElementById('inj-list');
    box.innerHTML = html || '<div class="empty">没有匹配的注入点</div>';
    box.classList.remove('fresh');
    void box.offsetWidth;         // 强制重排，让入场动画能重播
    box.classList.add('fresh');
    clearTimeout(injFreshTimer);
    injFreshTimer = setTimeout(function () {
      box.classList.remove('fresh');   // 同上：动画放完必须摘掉，否则淡出变硬切
    }, Math.min(list.length, 24) * 15 + 460);
    document.getElementById('inj-count').textContent =
      list.length + ' / ' + injRows.length + (list.length > MAX ? '（显示前 ' + MAX + '）' : '');
    box.querySelectorAll('.inj-row').forEach(function (row) {
      row.addEventListener('click', function () {
        box.querySelectorAll('.inj-row.on').forEach(function (x) { x.classList.remove('on'); });
        row.classList.add('on');
        showInjectionDetail(injRows[+row.getAttribute('data-i')]);
      });
    });
  }

  function openInjectionPanel(opts) {
    if (!currentReport) return;
    injRows = collectInjections();
    var body = document.querySelector('.sheet-body.split');
    if (body) body.classList.remove('detail-open');
    var back = document.getElementById('inj-back');
    if (back) back.style.display = 'none';
    document.getElementById('inj-detail').innerHTML = '<div class="empty">选择左侧任意一条查看详情</div>';

    // 从侧边栏的类型标签进来时，预填过滤条件
    var q = document.getElementById('inj-q');
    if (q) q.value = (opts && opts.kind) ? opts.kind : '';

    // 恢复滚动（关闭时被临时关掉，避免滚动条在淡出中闪一帧）
    var listBox = document.getElementById('inj-list');
    if (listBox) listBox.style.overflowY = '';

    renderInjectionList();
    document.getElementById('tool').classList.add('on');
  }

  /* ---------------- 文字右键菜单：复制 / 搜索 ---------------- */
  var ctxText = '';
  var ctxTimer = 0;

  function ctxEl() { return document.getElementById('ctx-menu'); }

  function hideCtx() {
    var m = ctxEl();
    if (m) m.classList.remove('on');
  }

  /** 取出光标位置处的那一小段文字；按钮/输入框内返回空串 */
  function textAtPoint(x, y) {
    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim()) return String(sel).trim().slice(0, 500);

    var node = null;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) node = r.startContainer;
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (p) node = p.offsetNode;
    }
    if (!node) return '';
    var el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return '';
    // 按钮与输入控件不弹菜单
    if (el.closest('button, input, textarea, select, .tool')) return '';
    var t = (node.nodeType === 3 ? node.textContent : el.textContent) || '';
    return t.trim().slice(0, 500);
  }

  function showCtx(x, y) {
    var m = ctxEl();
    if (!m) return;
    m.classList.add('on');
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }

  function ctxCopy() {
    var item = ctxEl() && ctxEl().querySelector('[data-act="copy"]');
    function done() {
      if (!item) return;
      item.textContent = '已复制';
      item.classList.add('done');
      clearTimeout(ctxTimer);
      ctxTimer = setTimeout(function () {
        item.textContent = '复制';
        item.classList.remove('done');
        hideCtx();
      }, 700);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = ctxText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { }
      ta.remove();
      done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ctxText).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function ctxSearch() {
    // 桌面版由主进程交给系统默认浏览器，浏览器版新开标签页
    window.open('https://www.bing.com/search?q=' + encodeURIComponent(ctxText), '_blank', 'noopener');
    hideCtx();
  }

  function bindContextMenu() {
    var m = ctxEl();
    if (!m) return;

    document.addEventListener('contextmenu', function (ev) {
      var text = textAtPoint(ev.clientX, ev.clientY);
      if (!text) { hideCtx(); return; }     // 空白 / 按钮 / 输入框 → 保留系统菜单
      ev.preventDefault();
      ctxText = text;
      showCtx(ev.clientX, ev.clientY);
    });

    m.addEventListener('click', function (ev) {
      var act = ev.target && ev.target.getAttribute('data-act');
      if (act === 'copy') ctxCopy();
      else if (act === 'search') ctxSearch();
    });

    document.addEventListener('mousedown', function (ev) {
      if (!m.contains(ev.target)) hideCtx();
    }, true);
    window.addEventListener('resize', hideCtx);
    window.addEventListener('scroll', hideCtx, true);
  }

  /* ---------------- 版本统计 ---------------- */
  /* mcRange 在分析器里是 { style, range } 对象，不是字符串 */
  function mcRangeText(mod) {
    var r = mod && mod.mcRange;
    if (!r) return null;
    if (typeof r === 'string') return r;
    if (typeof r.range === 'string') return r.range;
    return null;
  }
  /* 版本一律用「数字元组」表示：27 → [27]，26.1 → [26,1]，1.21.11 → [1,21,11]。
     不再假设"最多三段、每段两位"这种硬编码进制。 */
  /* 版本比较照搬 Maven ComparableVersion 的规则：
     数字段按数值比；限定词按固定次序 alpha < beta < milestone < rc < snapshot < 正式 < sp，
     未知限定词排在已知之后；数字段整体小于同位置的限定词。 */
  var QUAL_RANK = { preempty: -1, 
    alpha: 0, a: 0,
    beta: 1, b: 1,
    milestone: 2, m: 2,
    rc: 3, cr: 3, preview: 3,
    snapshot: 4,
    '': 5, ga: 5, final: 5, release: 5,
    sp: 6
  };
  function qualParts(q) {
    var m = /^([A-Za-z]+)(\d*)$/.exec(String(q || ''));
    if (!m) return { rank: 7, sub: 0, text: String(q || '').toLowerCase() };
    var k = m[1].toLowerCase();
    var rank = QUAL_RANK[k];
    return { rank: rank === undefined ? 7 : rank, sub: m[2] ? +m[2] : 0, text: k };
  }
  function verParts(s) {
    var str = String(s || '').trim();
    // 周快照：25w35a → [25, 35, 'a']，这样周次能按数值比较，字母后缀也保留次序
    var wk = /^(\d{2})w(\d{2})([a-z])$/i.exec(str);
    if (wk) return [+wk[1], +wk[2], wk[3].toLowerCase()];

    var m = /^(\d+(?:\.\d+)*)(?:[-._]?([A-Za-z][A-Za-z0-9]*))?/.exec(str);
    if (!m) return null;
    var out = m[1].split('.').map(Number);
    if (m[2]) out.push(m[2]);          // 限定词作为一个段，交给 cmpVer 处理
    return out;
  }
  function segCmp(x, y) {
    var xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) return x === y ? 0 : (x < y ? -1 : 1);
    // 数字段 < 限定词（Maven: IntegerItem < StringItem）
    if (xn && !yn) return -1;
    if (!xn && yn) return 1;
    var a = qualParts(x), b = qualParts(y);
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    if (a.sub !== b.sub) return a.sub < b.sub ? -1 : 1;
    return a.text === b.text ? 0 : (a.text < b.text ? -1 : 1);
  }
  function cmpVer(a, b) {
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = a[i], y = b[i];
      if (x === undefined) x = typeof y === 'number' ? 0 : '';   // 缺位：数字补 0，限定词补「正式」
      if (y === undefined) y = typeof x === 'number' ? 0 : '';
      var c = segCmp(x, y);
      if (c !== 0) return c;
    }
    return 0;
  }
  function verText(a) {
    var out = '';
    for (var i = 0; i < a.length; i++) {
      if (typeof a[i] === 'string') out += '-' + a[i];
      else out += (out ? '.' : '') + a[i];
    }
    return out;
  }

  /** 各种区间写法归一成 {lo,hi}，闭区间，边界是元组（可比较，不做数值编码） */
  function parseVerRange(str) {
    if (!str) return null;
    var s = String(str).trim();
    var m = /^[\[\(]\s*([^,\]\)]+?)\s*,\s*([^\]\)]+?)\s*([\]\)])$/.exec(s);
    if (m) {
      var lo = verParts(m[1]), hi = verParts(m[2]);
      if (!lo || !hi) return null;
      return { lo: lo, hi: hi };     // 开闭区间在半开处差一个补丁号，观感上无需区分
    }
    m = /^>=\s*([\d.]+)\s+<\s*([\d.]+)/.exec(s);
    if (m) return { lo: verParts(m[1]), hi: verParts(m[2]) };

    // ---- Fabric 版本谓词 ----
    // ~1.21  → [1.21, 1.21.*]（同次版本内）
    m = /^~\s*([\d.]+)$/.exec(s);
    if (m) { var t1 = verParts(m[1]); return t1 ? { lo: t1, hi: t1.concat(99) } : null; }
    // ^1.21 → [1.21, 2.0)（同大版本内）
    m = /^\^\s*([\d.]+)$/.exec(s);
    if (m) {
      var t2 = verParts(m[1]);
      if (!t2) return null;
      var next = [(t2[0] || 0) + 1, 0];
      return { lo: t2, hi: next };
    }
    // 通配：26.2.x / 1.21.* → 该次版本下的全部补丁号
    m = /^(\d+(?:\.\d+)*)\.(?:x|\*)$/i.exec(s);
    if (m) {
      var tb = verParts(m[1]);
      return tb ? { lo: tb, hi: tb.concat(99) } : null;
    }
    // 任意版本
    if (s === '*') return { lo: [0], hi: [999999] };
    // ---- Maven 单点区间：[1.20.1] ----
    m = /^\[\s*([^,\]]+)\s*\]$/.exec(s);
    if (m) { var t3 = verParts(m[1]); return t3 ? { lo: t3, hi: t3 } : null; }

    var one = verParts(s);
    if (one) return { lo: one, hi: one };
    return null;
  }

  function verSection(title, rows, openEnded) {
    if (!rows.length) {
      return '<div class="ver-sec"><h4>' + esc(title) + '</h4><div class="empty">没有可用的数据</div></div>';
    }

    // 坐标只用「名次」：把所有出现过的边界值排序，按序号定位。
    // 这样只比较大小关系，没有模组覆盖的区间会被自然压缩掉。
    var bounds = [];
    rows.forEach(function (r) {
      if (!bounds.some(function (b) { return cmpVer(b, r.lo) === 0; })) bounds.push(r.lo);
      if (!bounds.some(function (b) { return cmpVer(b, r.hi) === 0; })) bounds.push(r.hi);
    });
    bounds.sort(cmpVer);
    var N = bounds.length;

    function rank(v) {
      var loI = 0, hiI = N - 1, ans = 0;
      while (loI <= hiI) {
        var mid = (loI + hiI) >> 1;
        if (cmpVer(bounds[mid], v) <= 0) { ans = mid; loI = mid + 1; } else hiI = mid - 1;
      }
      return ans;
    }
    function pct(v) { return N <= 1 ? 0 : rank(v) / (N - 1) * 100; }
    // Java 那栏的刻度是版本号×10000，直接除回去；MC 才需要 x.y.z
    function labelOf(v) { if (v == null) return "-"; return openEnded ? String(Array.isArray(v) ? v[0] : v) : verText(v); }

    var lo = null, hi = null;
    rows.forEach(function (r) {
      if (!lo || cmpVer(r.lo, lo) > 0) lo = r.lo;
      if (!hi || cmpVer(r.hi, hi) < 0) hi = r.hi;
    });

    var html = '<div class="ver-sec"><h4>' + esc(title) +
      '　<span style="color:var(--fg-mute);font-weight:400">' + rows.length + ' 个模组</span></h4>';

    if (lo && hi && cmpVer(lo, hi) <= 0) {
      html += '<div style="color:var(--ok,#46d39a);font-size:11.5px;margin-bottom:6px">交集：' +
        esc(labelOf(lo)) + (openEnded ? ' 及以上（class 文件向前兼容）' : ' – ' + esc(labelOf(hi))) +
        '</div>';
    } else {
      html += '<div style="color:var(--danger);font-size:11.5px;margin-bottom:6px">没有交集（各模组要求互相冲突）</div>';
    }

    // 80% 共识：被 >=80% 模组覆盖的版本，覆盖不到的标红
    var consensus = null, missCount = 0;
    if (rows.length > 1) {
      var bestV = null, bestN = -1;
      bounds.forEach(function (v) {
        var n = 0;
        rows.forEach(function (r) { if (cmpVer(r.lo, v) <= 0 && cmpVer(v, r.hi) <= 0) n++; });
        if (n > bestN) { bestN = n; bestV = v; }
      });
      if (bestN < rows.length && bestN / rows.length >= 0.8) consensus = bestV;
    }
    if (consensus != null) {
      rows.forEach(function (r) {
        r.miss = !(cmpVer(r.lo, consensus) <= 0 && cmpVer(consensus, r.hi) <= 0);
        if (r.miss) missCount++;
      });
    }
    if (consensus != null && missCount) {
      html += '<div style="color:var(--danger);font-size:11.5px;margin-bottom:6px">' +
        esc(labelOf(consensus)) + ' 被 ' + Math.round((rows.length - missCount) / rows.length * 100) +
        '% 的模组支持，下面 ' + missCount + ' 个不支持（已标红）</div>';
    }

    html += '<div class="ver-list">';
    rows.forEach(function (r, idx) {
      var l = pct(r.lo);
      var w = Math.max(0.9, pct(r.hi) - pct(r.lo));   // 单点也要有可见宽度

      // 交集段叠在这行自己的条上（覆盖，不是另起一行）
      var green = '';
      if (lo && hi && cmpVer(lo, hi) <= 0) {
        var a = cmpVer(r.lo, lo) > 0 ? r.lo : lo;
        var b = cmpVer(r.hi, hi) < 0 ? r.hi : hi;
        if (cmpVer(a, b) <= 0) {
          green = '<span class="ver-bar green" style="left:' + pct(a).toFixed(3) +
            '%;width:' + Math.max(0.9, pct(b) - pct(a)).toFixed(3) + '%"></span>';
        }
      }
      html += '<div class="ver-row' + (r.miss ? ' miss' : '') + '" style="--i:' + idx + '">' +
        '<span class="vn" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
        '<span class="ver-track">' +
        '<span class="ver-bar" style="left:' + l.toFixed(3) + '%;width:' + w.toFixed(3) + '%"></span>' +
        green +
        '</span>' +
        '<span class="vt">' + esc(r.label) + '</span></div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderVersionPanel() {
    var mods = (graph.nodes || []).filter(function (n) { return !n.isRoot && n.mod; });

    /* 声明分两类：能参与区间计算的，和不能的。
       不能的（无框裸版本、占位符、语法错误、Fabric 谓词等）单独列在末尾，
       不参与交集——否则一个 "1.21.1" 会把整个交集压成一个点。 */
    function rangeKind(raw) {
      var s = String(raw == null ? '' : raw).trim();
      if (!s) return 'empty';
      if (/^\$\{.*\}$/.test(s)) return 'placeholder';
      if (s === '*') return 'star';
      if (s[0] === '[' || s[0] === '(') {
        if (/^[\[\(][^,\]]*,[^,\]]*,[^\]\)]*[\]\)]/.test(s)) return 'error';
        return 'range';
      }
      if (/^[~^<>=]/.test(s)) return 'fabric';
      if (/^\d/.test(s)) return 'bare';
      return 'error';
    }

    var mcRows = [], excluded = [];
    mods.forEach(function (n) {
      var raw = mcRangeText(n.mod);
      if (!raw) return;
      var kind = rangeKind(raw);
      var r = null;
      if (kind === 'range' || kind === 'star') {
        r = parseVerRange(raw);
      } else if (kind === 'fabric' && window.V && V.fabricRange) {
        var fr = V.fabricRange(raw);
        if (fr.kind === 'range') r = { lo: fr.lo, hi: fr.hi };
        else if (fr.kind === 'any') r = { lo: [0], hi: [999999] };
      }
      if (r && r.lo != null && r.hi != null) {
        mcRows.push({ name: n.id, lo: r.lo, hi: r.hi, label: raw });
      } else {
        excluded.push({ name: n.id, raw: raw, kind: kind });
      }
    });
    mcRows.sort(function (a, b) { return cmpVer(a.lo, b.lo) || cmpVer(a.hi, b.hi); });

    var kindName = {
      bare: '无框版本', placeholder: '占位符未展开', error: '语法错误',
      empty: '空声明', fabric: '谓词无法解析'
    };
    var exSummary = {};
    excluded.forEach(function (x) { exSummary[x.kind] = (exSummary[x.kind] || 0) + 1; });
    var exParts = Object.keys(exSummary).map(function (k) { return (kindName[k] || k) + ' ' + exSummary[k]; });
    var total = mcRows.length + excluded.length;
    var ratio = total ? Math.round(mcRows.length / total * 100) : 0;

    var covHtml = '<div class="ver-note" style="font-size:11.5px;color:var(--fg-mute);margin:-2px 0 8px">' +
      '共 ' + total + ' 个声明，参与计算 <b style="color:var(--fg)">' + mcRows.length + '</b>' +
      (excluded.length ? '，排除 <b style="color:var(--warn,#e0a03a)">' + excluded.length + '</b>' : '') +
      '（' + ratio + '% 参与）' +
      (exParts.length ? '　·　' + exParts.join('、') : '') + '</div>';

    var exHtml = '';
    if (excluded.length) {
      exHtml = '<div class="ver-sec" style="margin-top:18px"><h4>未参与计算的声明' +
        '　<span style="color:var(--fg-mute);font-weight:400">' + excluded.length + ' 条</span></h4>' +
        '<div style="font-size:11.5px;color:var(--fg-mute);margin-bottom:6px">' +
        '这些写法无法稳定解析成区间，已排除在交集之外（不代表它们兼容或不兼容）。</div>' +
        '<div style="display:grid;grid-template-columns:minmax(120px,1fr) auto auto;gap:2px 14px;font-size:11.5px">';
      excluded.forEach(function (x) {
        exHtml += '<div style="color:var(--fg)">' + esc(x.name) + '</div>' +
          '<div style="color:var(--fg-mute)">' + esc(kindName[x.kind] || x.kind) + '</div>' +
          '<div style="font-family:var(--mono,monospace);color:var(--fg-dim,#8b93a7)">' + esc(x.raw) + '</div>';
      });
      exHtml += '</div></div>';
    }

    // Java：class 文件向前兼容，所以每个模组的要求都是「至少 Java v」。
    // 只需要一个结论：最高要求是多少、能不能满足实例声明的 Java。
    var javaMods = mods.filter(function (n) { return n.mod.javaMajor; });
    var jMax = 0, jTop = null;
    javaMods.forEach(function (n) {
      if (n.mod.javaMajor > jMax) { jMax = n.mod.javaMajor; jTop = n.id; }
    });
    var instJava = (currentInstance && currentInstance.javaMajor) || null;

    var jHtml = '<div class="ver-sec"><h4>Java 版本（按 class major 推断）' +
      '　<span style="color:var(--fg-mute);font-weight:400">' + javaMods.length + ' 个模组</span></h4>';
    if (!javaMods.length) {
      jHtml += '<div class="empty">没有可用的数据</div></div>';
    } else {
      jHtml += '<div style="font-size:12px;line-height:1.9">';
      jHtml += '最高要求：<b>Java ' + jMax + '</b>' + (jTop ? '（' + esc(jTop) + '）' : '') + '<br>';
      if (instJava) {
        var okJava = instJava >= jMax;
        jHtml += '实例声明：Java ' + instJava + ' → ' +
          (okJava
            ? '<span style="color:var(--ok,#46d39a)">满足</span>'
            : '<span style="color:var(--danger)">不满足，缺 ' + (jMax - instJava) + ' 个版本</span>');
      } else {
        jHtml += '<span style="color:var(--fg-mute)">实例未声明 Java 版本，无法判定是否满足</span>';
      }
      jHtml += '</div>';
      jHtml += '<div class="empty" style="margin-top:8px;color:var(--fg-mute)">' +
        'class 文件向前兼容：用 Java N 编译的类可以在任何 ≥ N 的 JVM 上加载，所以这里只关心最高要求。</div></div>';
    }

    document.getElementById('ver-body').innerHTML =
      covHtml + verSection('MC 版本', mcRows) + exHtml + jHtml;
  }


/* =====================================================================
 * 版本匹配：按加载器分流（只做「这个版本是否满足这个声明」的判定，
 * 不做区间求解/交并运算）。规则来自对 Forge/NeoForge/Fabric 加载器
 * 字节码的实证调查，不是猜的。
 *
 *  - Forge / NeoForge : Maven VersionRange + ComparableVersion
 *  - Fabric           : VersionPredicate + SemanticVersionImpl
 * ===================================================================== */

/* ---------------- 一、Maven ComparableVersion ---------------- */
/* 限定词权重（实证自 maven-artifact 3.5.3/3.6.3/3.8.5/3.9.9）*/
var MVN_QUAL = { alpha: 0, beta: 1, milestone: 2, rc: 3, snapshot: 4, '': 5, sp: 6 };
/* 别名只有这四个；a/b/m 不是别名 */
var MVN_ALIAS = { ga: '', final: '', release: '', cr: 'rc' };

function mvnQualRank(name) {
  var s = MVN_ALIAS[name] !== undefined ? MVN_ALIAS[name] : name;
  if (MVN_QUAL[s] !== undefined) return { known: true, rank: MVN_QUAL[s], name: s };
  return { known: false, rank: 7, name: s };   // 未知限定词：排在 release 之后
}

/** 把版本串切成「嵌套列表」：'.' 同层延续，'-' 或 数字/字母交界 新开子层 */
function mvnTree(str) {
  var s = String(str == null ? '' : str).toLowerCase().replace(/_/g, '-');
  var root = [], cur = root, prev = '';   // prev: 'num' | 'str' | ''
  var i = 0;
  while (i < s.length) {
    var c = s.charAt(i);
    if (c === '.') { i++; prev = ''; continue; }
    if (c === '-') { i++; prev = ''; cur.push({ list: [] }); cur = cur[cur.length - 1].list; continue; }
    var j = i, isNum = /[0-9]/.test(c);
    if (isNum) { while (j < s.length && /[0-9]/.test(s.charAt(j))) j++; }
    else { while (j < s.length && /[a-z]/.test(s.charAt(j))) j++; }
    if (prev && prev !== (isNum ? 'num' : 'str')) {   // 数字↔字母交界 → 新子层
      cur.push({ list: [] }); cur = cur[cur.length - 1].list;
    }
    var tok = s.slice(i, j);
    cur.push(isNum ? { num: parseInt(tok, 10) } : { str: tok });
    prev = isNum ? 'num' : 'str';
    i = j;
  }
  return root;
}

function mvnNorm(list) {
  // 去掉尾部的「零/空」项；子列表递归规范化
  for (var k = 0; k < list.length; k++) if (list[k].list) list[k].list = mvnNorm(list[k].list);
  while (list.length) {
    var last = list[list.length - 1];
    if (last.num !== undefined && last.num === 0) { list.pop(); continue; }
    if (last.list && last.list.length === 0) { list.pop(); continue; }
    if (last.str !== undefined && last.str === '') { list.pop(); continue; }
    break;
  }
  return list;
}

function mvnItemVsNum(item, n) {          // item 与一个整数比较
  if (item.num !== undefined) return item.num === n ? 0 : (item.num < n ? -1 : 1);
  if (item.list) {
    var a = mvnNorm(item.list.map(function (x) { return x; }));
    return mvnCmpList(a, [{ num: n }]);
  }
  return mvnCmpStr(item.str, '');         // 字符串 vs 数字：数字更小
}
function mvnCmpStr(a, b) {
  var qa = mvnQualRank(a), qb = mvnQualRank(b);
  if (qa.rank !== qb.rank) return qa.rank < qb.rank ? -1 : 1;
  if (qa.name === qb.name) return 0;
  return qa.name < qb.name ? -1 : 1;
}
function mvnCmpItem(x, y) {
  if (x.num !== undefined && y.num !== undefined) return x.num === y.num ? 0 : (x.num < y.num ? -1 : 1);
  if (x.num !== undefined) return 1;      // 数字项 > 字符串项
  if (y.num !== undefined) return -1;
  if (x.list && y.list) return mvnCmpList(x.list, y.list);
  if (x.list) return mvnCmpList(x.list, [{ str: y.str }]);
  if (y.list) return -mvnCmpList(y.list, [{ str: x.str }]);
  return mvnCmpStr(x.str, y.str);
}
function mvnCmpList(a, b) {
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    var x = a[i], y = b[i];
    if (x === undefined) x = { num: 0 };      // 缺位补 0（等价于 1.21 == 1.21.0）
    if (y === undefined) y = { num: 0 };
    var c = mvnCmpItem(x, y);
    if (c !== 0) return c;
  }
  return 0;
}
function cmpMaven(a, b) {
  return mvnCmpList(mvnNorm(mvnTree(a)), mvnNorm(mvnTree(b)));
}

/* ---------------- 二、Maven VersionRange ---------------- */
/** 解析 spec → { restrictions:[{lo,hi,loInc,hiInc}], recommended }
    recommended 非空（裸版本 / '*'）时按 Maven 规则「恒满足」 */
function parseMavenRange(spec) {
  var s = String(spec == null ? '' : spec).trim();
  var out = { restrictions: [], recommended: null };
  if (!s) return out;                       // 空串：Forge 的 UNBOUNDED，什么都不匹配
  if (s === '*') { out.recommended = '*'; return out; }

  var rest = s;
  while (rest.length && (rest.charAt(0) === '[' || rest.charAt(0) === '(')) {
    var open = rest.charAt(0);
    var closeIdx = -1;
    for (var i = 1; i < rest.length; i++) {
      var ch = rest.charAt(i);
      if (ch === ']' || ch === ')') { closeIdx = i; break; }
    }
    if (closeIdx < 0) return out;           // 未闭合 → 按解析失败处理（不匹配）
    var body = rest.slice(1, closeIdx);
    var close = rest.charAt(closeIdx);
    rest = rest.slice(closeIdx + 1).replace(/^[\s,]+/, '');

    if (body.indexOf(',') < 0) {            // [1.20.1] 精确单版本
      var v = body.trim();
      if (v) out.restrictions.push({ lo: v, hi: v, loInc: true, hiInc: true });
      continue;
    }
    var parts = body.split(',');
    var lo = parts[0].trim(), hi = (parts[1] || '').trim();
    out.restrictions.push({
      lo: lo || null, hi: hi || null,
      loInc: open === '[', hiInc: close === ']'
    });
  }
  var tail = rest.trim();
  if (tail) out.recommended = tail;         // 裸版本 → 软需求，恒满足
  return out;
}

/** 版本是否满足 Maven spec（加载器判定用） */
function matchesMaven(spec, version) {
  var r = parseMavenRange(spec);
  if (r.recommended) return true;           // 裸版本 / '*'：恒满足（实证行为）
  if (!r.restrictions.length) return false; // 空 spec → UNBOUNDED，恒不满足（Forge 缺陷，照抄）
  for (var i = 0; i < r.restrictions.length; i++) {
    var x = r.restrictions[i], ok = true;
    if (x.lo) { var c1 = cmpMaven(version, x.lo); if (x.loInc ? c1 < 0 : c1 <= 0) ok = false; }
    if (ok && x.hi) { var c2 = cmpMaven(version, x.hi); if (x.hiInc ? c2 > 0 : c2 >= 0) ok = false; }
    if (ok) return true;
  }
  return false;
}

/* ---------------- 三、Fabric SemanticVersion + 谓词 ---------------- */
var FB_WILD = -2147483648;
function fbParse(str, allowWild) {
  var s = String(str == null ? '' : str).trim();
  var build = null, pre = null;
  var plus = s.indexOf('+');
  if (plus >= 0) { build = s.slice(plus + 1); s = s.slice(0, plus); }
  var dash = s.indexOf('-');
  if (dash >= 0) { pre = s.slice(dash + 1); s = s.slice(0, dash); }
  var comps = [];
  var segs = s.split('.');
  for (var i = 0; i < segs.length; i++) {
    var t = segs[i];
    if (t === 'x' || t === 'X' || t === '*') {
      if (!allowWild) return null;
      comps.push(FB_WILD);
      for (var k = i + 1; k < segs.length; k++) comps.push(FB_WILD);   // 首个通配之后全部视为通配
      break;
    }
    if (!/^\d+$/.test(t)) return null;      // 非语义版本 → 由调用方降级
    comps.push(parseInt(t, 10));
  }
  return { comps: comps, pre: pre, build: build };
}
function fbCmpPre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;                 // 无 prerelease 的更大
  if (b === null) return -1;
  var ta = a.split('.').filter(function (x) { return x !== ''; });
  var tb = b.split('.').filter(function (x) { return x !== ''; });
  var n = Math.max(ta.length, tb.length);
  for (var i = 0; i < n; i++) {
    if (i >= ta.length) return -1;          // 先尽者小
    if (i >= tb.length) return 1;
    var x = ta[i], y = tb[i];
    var xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;      // 数字 < 字母
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function fbCmp(a, b) {                       // a,b 均为 fbParse 的结果
  var n = Math.max(a.comps.length, b.comps.length);
  for (var i = 0; i < n; i++) {
    var x = i < a.comps.length ? a.comps[i] : 0;
    var y = i < b.comps.length ? b.comps[i] : 0;
    if (x === FB_WILD || y === FB_WILD) continue;   // 通配位跳过
    if (x !== y) return x < y ? -1 : 1;
  }
  return fbCmpPre(a.pre, b.pre);
}

/** Fabric 谓词：空格分隔 = AND；只做「是否满足」判定 */
function matchesFabric(pred, version) {
  var p = String(pred == null ? '' : pred).trim();
  if (!p || p === '*') return true;
  var terms = p.split(' ').filter(function (t) { return t.trim() && t.trim() !== '*'; });
  if (!terms.length) return true;

  var v = fbParse(version, false);
  if (!v) return false;                     // 版本不是语义版本 → 无法判定（保守：不满足）

  for (var i = 0; i < terms.length; i++) {
    var tok = terms[i].trim(), op = '=';
    var ops = ['>=', '<=', '>', '<', '=', '~', '^'];
    for (var k = 0; k < ops.length; k++) {
      if (tok.indexOf(ops[k]) === 0) { op = ops[k]; tok = tok.slice(ops[k].length); break; }
    }
    var base = fbParse(tok, true);
    if (!base) { if (op === '>' || op === '<') return false; op = '='; }
    if (base && base.comps.indexOf(FB_WILD) >= 0) {
      if (op !== '=') return false;         // 通配只能与 = 同用
      var comps = base.comps.filter(function (c) { return c !== FB_WILD; });
      var lvl = base.comps.length - comps.length;
      if (lvl === 1 && comps.length === 1) op = '^';
      else if (lvl === 1 && comps.length === 2) op = '~';
      else {
        // 4 段通配：>= base- 且 < 末位+1
        var lo = { comps: comps, pre: '', build: null };
        var upComps = comps.slice();
        upComps[upComps.length - 1] = upComps[upComps.length - 1] + 1;
        if (fbCmp(v, lo) < 0) return false;
        if (fbCmp(v, { comps: upComps, pre: null, build: null }) >= 0) return false;
        continue;
      }
      base = { comps: comps, pre: '', build: null };
    }

    var c = base ? fbCmp(v, base) : 0;
    var ok;
    if (op === '=') ok = c === 0;
    else if (op === '>=') ok = c >= 0;
    else if (op === '>') ok = c > 0;
    else if (op === '<=') ok = c <= 0;
    else if (op === '<') ok = c < 0;
    else if (op === '~') {
      ok = c >= 0 && (v.comps[0] || 0) === (base.comps[0] || 0) && (v.comps[1] || 0) === (base.comps[1] || 0);
    } else if (op === '^') {
      ok = c >= 0 && (v.comps[0] || 0) === (base.comps[0] || 0);
    } else ok = false;
    if (!ok) return false;
  }
  return true;
}

/* ---------------- 四、按加载器分流 ---------------- */
/** 这个 mod 是否声明支持某个 MC 版本。
    返回 { known:boolean, ok:boolean|null, why:string } */
function modSupportsMc(mod, mcVersion) {
  if (!mod || !mcVersion) return { known: false, ok: null, why: '缺少版本信息' };
  var loaders = mod.loaders || [];
  var isFabric = loaders.indexOf('fabric') >= 0;
  var isForgeLike = loaders.indexOf('forge') >= 0 || loaders.indexOf('neoforge') >= 0;

  if (isFabric && !isForgeLike) {
    var dep = mod.depends && mod.depends.minecraft;
    if (!dep) return { known: false, ok: null, why: '未声明 minecraft 依赖' };
    var list = Array.isArray(dep) ? dep : [dep];
    for (var i = 0; i < list.length; i++) {
      if (matchesFabric(list[i], mcVersion)) return { known: true, ok: true, why: 'fabric: ' + list[i] };
    }
    return { known: true, ok: false, why: 'fabric: ' + list.join(' | ') };
  }

  var mr = mod.mcRange;
  var spec = typeof mr === 'string' ? mr : (mr && mr.range) || null;
  if (!spec) return { known: false, ok: null, why: '未声明 minecraft 依赖' };
  var ok2 = matchesMaven(spec, mcVersion);
  return { known: true, ok: ok2, why: 'maven: ' + spec };
}
  function renderIssues(report) {
    var body = document.getElementById('sheet-body');
    if (!report) { body.innerHTML = '<div class="empty">还没有结果。</div>'; return; }
    var html = '';
    [['high', '高危'], ['med', '需要注意'], ['low', '提示']].forEach(function (pair) {
      var list = report.issues.filter(function (i) { return i.level === pair[0]; });
      if (!list.length) return;
      html += '<h3 style="font-size:12px;color:var(--fg-mute);letter-spacing:.1em;margin:16px 0 8px">' +
        pair[1] + '（' + list.length + '）</h3>';
      list.forEach(function (it) {
        html += '<div class="issue ' + pair[0] + '"><div class="t">' + esc(it.title) + '</div>' +
          (it.detail ? '<pre>' + esc(it.detail) + '</pre>' : '') + '</div>';
      });
    });
    if (report.errors && report.errors.length) {
      html += '<h3 style="font-size:12px;color:var(--fg-mute);margin:16px 0 8px">读取失败（' +
        report.errors.length + '）</h3>';
      report.errors.forEach(function (e) {
        html += '<div class="issue med"><div class="t">' + esc(e.file) + '</div><pre>' + esc(e.error) + '</pre></div>';
      });
    }
    body.innerHTML = html || '<div class="empty">没有发现问题。</div>';
  }

  /* =====================================================================
   * 目录读取
   * ===================================================================== */
  function readAllEntries(dirEntry) {
    return new Promise(function (resolve, reject) {
      var reader = dirEntry.createReader();
      var out = [];
      (function next() {
        reader.readEntries(function (es) {
          if (!es.length) return resolve(out);
          for (var i = 0; i < es.length; i++) out.push(es[i]);
          next();
        }, reject);
      })();
    });
  }

  function fileOf(entry) {
    return new Promise(function (res, rej) { entry.file(res, rej); });
  }

  function collectJars(dirEntry, path, out) {
    return readAllEntries(dirEntry).then(function (kids) {
      return kids.reduce(function (p, c) {
        return p.then(function () {
          if (c.name.startsWith('.')) return;
          if (c.isDirectory) return collectJars(c, path + c.name + '/', out);
          if (/\.jar$/i.test(c.name)) {
            return fileOf(c).then(function (f) { out.push({ path: path + c.name, file: f }); });
          }
        });
      }, Promise.resolve());
    });
  }

  function collectFromRoot(rootEntry, files) {
    if (rootEntry.name === 'mods') return collectJars(rootEntry, 'mods/', files);

    return readAllEntries(rootEntry).then(function (kids) {
      var chain = Promise.resolve();

      kids.forEach(function (k) {
        if (k.isFile && k.name === rootEntry.name + '.json') {
          chain = chain.then(function () { return fileOf(k); })
            .then(function (f) { files.push({ path: k.name, file: f }); });
        }
      });

      kids.forEach(function (k) {
        if (!k.isDirectory) return;
        if (k.name === 'mods') {
          chain = chain.then(function () { return collectJars(k, 'mods/', files); });
        } else if (k.name === 'versions') {
          chain = chain.then(function () { return readAllEntries(k); }).then(function (vs) {
            var inner = Promise.resolve();
            vs.forEach(function (v) {
              if (!v.isDirectory || v.name.startsWith('.')) return;
              inner = inner.then(function () { return readAllEntries(v); }).then(function (cs) {
                var seq = Promise.resolve();
                cs.forEach(function (c) {
                  if (c.isFile && c.name === v.name + '.json') {
                    seq = seq.then(function () { return fileOf(c); })
                      .then(function (f) { files.push({ path: 'versions/' + v.name + '/' + c.name, file: f }); });
                  } else if (c.isDirectory && c.name === 'mods') {
                    seq = seq.then(function () {
                      return collectJars(c, 'versions/' + v.name + '/mods/', files);
                    });
                  }
                });
                return seq;
              });
            });
            return inner;
          });
        }
      });

      return chain;
    });
  }

  /** 必须在 drop 事件里同步调用 */
  function grabEntries(dt) {
    var entries = [];
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind && items[i].kind !== 'file') continue;
      var e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (e) entries.push(e);
    }
    if (entries.length) return { entries: entries, loose: null };
    var loose = [];
    Array.prototype.forEach.call(dt.files || [], function (f) {
      loose.push({ path: f.name, file: f });
    });
    return { entries: null, loose: loose };
  }

  function filesFromEntries(grab) {
    if (grab.loose) return Promise.resolve(grab.loose);
    var files = [];
    return grab.entries.reduce(function (p, e) {
      return p.then(function () {
        if (e.isDirectory) return collectFromRoot(e, files);
        if (e.isFile) {
          return fileOf(e).then(function (f) { files.push({ path: e.name, file: f }); });
        }
      });
    }, Promise.resolve()).then(function () { return files; });
  }

  function classify(files) {
    var jars = [], versionJsons = [];
    files.forEach(function (f) {
      var segs = f.path.replace(/\\/g, '/').split('/');
      for (var i = 1; i < segs.length - 1; i++) if (segs[i].startsWith('.')) return;
      var base = segs[segs.length - 1];
      if (/\.jar$/i.test(base)) jars.push(f);
      else if (/\.json$/i.test(base)) versionJsons.push(f);
    });
    return { jars: jars, versionJsons: versionJsons };
  }

  /* =====================================================================
   * 主流程
   * ===================================================================== */
  var progressEl, progressBar, statusEl, instChip, btnCam, qInput, qCount;
  var chipMods, chipInj, chipCrit;
  var dirPath = null;          // 已加载目录的真实路径（Electron 才拿得到）
  var dirName = '';
  var lastSignature = '';      // 用来判断「又拖了同一个目录」
  var appVersion = '0.21.0';    // 浏览器版兜底；桌面版以 preload 返回值为准

  function applyTitle(name) {
    document.title = (name ? name + ' · ' : '') + 'mod-audit v' + appVersion;
  }

  function setProgress(cur, total) {
    if (!progressEl) return;
    if (total <= 0) { progressEl.classList.remove('on'); return; }
    progressEl.classList.add('on');
    progressBar.style.width = Math.round((cur / total) * 100) + '%';
  }

  function setStatus(text) {
    if (!statusEl) return;
    if (!text) { statusEl.style.display = 'none'; return; }
    statusEl.style.display = '';
    statusEl.textContent = text;
  }

  function syncCam() {
    if (!btnCam || !graph) return;
    btnCam.textContent = '摄像机：' + (graph.cameraOn ? '跟随' : '解绑');
    btnCam.classList.toggle('on', graph.cameraOn);
  }

  function pickInstance(versionJsons) {
    var chain = Promise.resolve(null);
    versionJsons.forEach(function (v) {
      chain = chain.then(function (found) {
        if (found) return found;
        return v.file.text().then(function (txt) {
          var parsed = A.parseVersionJson(txt);
          if (parsed && (parsed.loader !== 'unknown' || parsed.mcVersion)) return parsed;
          return null;
        }).catch(function () { return null; });
      });
    });
    return chain;
  }

  /* =====================================================================
   * 启动
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    var canvas = document.getElementById('graph');
    var dropzone = document.getElementById('dropzone');

    progressEl = document.getElementById('progress');
    progressBar = progressEl.querySelector('i');
    statusEl = document.getElementById('status');
    instChip = document.getElementById('inst-chip');
    chipMods = document.getElementById('chip-mods');
    chipInj = document.getElementById('chip-inj');
    chipCrit = document.getElementById('chip-crit');

    // 桌面版从主进程取真实版本号，浏览器版用内联兜底值
    if (window.modaudit && window.modaudit.version) {
      window.modaudit.version().then(function (v) {
        if (v) { appVersion = v; applyTitle(dirName || ''); }
      }).catch(function () { });
    }
    applyTitle('');
    btnCam = document.getElementById('btn-cam');
    hintEl = document.getElementById('hint-line');
    qInput = document.getElementById('q');
    qCount = document.getElementById('q-count');

    function applySearch() {
      if (!graph || !qInput) return;
      var n = graph.setSearch(qInput.value);
      if (graph.searchQuery) {
        qCount.textContent = n + ' 个';
        qCount.style.opacity = '1';
      } else {
        qCount.textContent = '';
        qCount.style.opacity = '0';
      }
    }

    if (qInput) {
      qInput.addEventListener('input', applySearch);
      qInput.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter') { applySearch(); graph.focusMatches(); }
        else if (ev.key === 'Escape') { qInput.value = ''; applySearch(); qInput.blur(); }
      });
    }

    graph = new Graph(canvas);
    graph.onSelect = renderNode;
    graph.onCameraManual = function () {
      if (!graph.cameraOn) return;
      graph.cameraOn = false;
      syncCam();
    };
    graph.onFilterClear = function () {
      if (chipCrit) chipCrit.classList.remove('on');
      updateHint(graph);
    };
    renderIdle();

    /* 全屏投放层 */
    var overlay = document.getElementById('drop-overlay');
    var dragDepth = 0;

    function isFileDrag(ev) {
      var dt = ev.dataTransfer;
      if (!dt || !dt.types) return false;
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
      return false;
    }
    function showOverlay(on) {
      dragDepth = on ? Math.max(1, dragDepth) : 0;
      overlay.classList.toggle('on', !!on);
      document.body.classList.toggle('dropping', !!on);
    }

    window.addEventListener('dragenter', function (ev) {
      if (!isFileDrag(ev)) return;
      ev.preventDefault();
      dragDepth++;
      showOverlay(true);
    });
    window.addEventListener('dragover', function (ev) {
      if (!isFileDrag(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (ev) {
      if (!isFileDrag(ev)) return;
      dragDepth--;
      if (dragDepth <= 0) showOverlay(false);
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      showOverlay(false);
      var dt = ev.dataTransfer;
      if (!dt) return;
      var grab = grabEntries(dt);
      Promise.resolve()
        .then(function () { return filesFromEntries(grab); })
        .then(function (files) { return window.run(files); })
        .catch(function (e) { setStatus('出错：' + ((e && e.message) || e)); });
    });

    bindContextMenu();

    // 侧边栏内容被延迟写入，所有交互都在写入完成后再绑
    var sbEl = document.getElementById('side-body');
    if (sbEl) {
      sbEl.addEventListener('sidebodyupdated', function () {
        bindLegend();
        bindSideExtras();
      });
    }

    /* 版本统计窗口 */
    var btnVers = document.getElementById('btn-vers');
    var verEl = document.getElementById('ver');

    // 和注入点一致：单击空白不做任何事，双击才关闭；关闭带淡出
    function closeVers() {
      if (!verEl || !verEl.classList.contains('on')) return;
      verEl.classList.add('closing');   // 退场用更慢的节奏（面板先淡、背景延迟）
      verEl.classList.remove('on');
      setTimeout(function () { verEl.classList.remove('closing'); }, 380);
    }

    if (btnVers) btnVers.addEventListener('click', function () {
      if (!currentReport) return;
      renderVersionPanel();
      verEl.classList.remove('closing');
      verEl.classList.add('on');
    });
    var verClose = document.getElementById('ver-close');
    if (verClose) verClose.addEventListener('click', closeVers);

    /* 未导入时点击画布 → 打开目录选择框 */
    var dirPick = document.getElementById('dir-pick');
    var pickArmed = false;

    function openPicker() {
      if (!dirPick) return;
      pickArmed = false;
      dirPick.value = '';       // 允许再次选同一个目录
      dirPick.click();
    }

    if (dirPick) {
      dirPick.addEventListener('change', function () {
        var list = [];
        for (var i = 0; i < dirPick.files.length; i++) {
          var f = dirPick.files[i];
          list.push({ path: f.webkitRelativePath || f.name, file: f });
        }
        if (!list.length) return;
        Promise.resolve().then(function () { return window.run(list); })
          .catch(function (e) { setStatus('出错：' + ((e && e.message) || e)); });
      });
    }

    // 只有按下与抬起之间没有明显移动，才算「点击」，避免平移收尾时误触发
    var armedAt = null;
    ['dropzone', 'graph'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', function (ev) {
        armedAt = (!currentReport && !isLoading && ev.button === 0) ? { x: ev.clientX, y: ev.clientY } : null;
      });
      el.addEventListener('pointerup', function (ev) {
        if (armedAt && !currentReport && !isLoading) {
          var dx = ev.clientX - armedAt.x, dy = ev.clientY - armedAt.y;
          if (dx * dx + dy * dy < 36) openPicker();
        }
        armedAt = null;
      });
      el.addEventListener('pointercancel', function () { armedAt = null; });
    });

    /* 顶部三个统计 chip */
    if (chipMods) {
      chipMods.addEventListener('click', function () {
        if (!currentReport) {
          setStatus('请先加载一个目录');
          setTimeout(function () { setStatus(''); }, 2200);
          return;
        }
        if (!dirPath) {
          setStatus('当前为浏览器版，无法打开本地文件夹；桌面版可直接打开');
          setTimeout(function () { setStatus(''); }, 2800);
          return;
        }
        if (window.modaudit && window.modaudit.reveal) window.modaudit.reveal(dirPath);
      });
    }
    if (chipInj) chipInj.addEventListener('click', openInjectionPanel);
    if (chipCrit) {
      chipCrit.addEventListener('click', function () {
        if (!currentReport) return;
        graph.critFocus = !graph.critFocus;
        chipCrit.classList.toggle('on', graph.critFocus);
        updateHint(graph);
      });
    }

    /* 注入点面板 */
    var toolEl = document.getElementById('tool');
    var injQ = document.getElementById('inj-q');
    if (injQ) injQ.addEventListener('input', renderInjectionList);
    var injClose = document.getElementById('inj-close');
    var injBack = document.getElementById('inj-back');

    function closeTool() {
      if (!toolEl || !toolEl.classList.contains('on')) return;
      var body = document.querySelector('.sheet-body.split');
      if (body) body.classList.remove('detail-open');   // 下次打开从列表页开始
      if (injBack) injBack.style.display = 'none';

      // 1) 列表从「可见区域的底部」往上逐条向左淡出
      var rows = Array.prototype.slice.call(toolEl.querySelectorAll('.inj-row'));
      var listBox = toolEl.querySelector('#inj-list');
      // 淡出前先关掉滚动：否则滚动条会在 opacity 过渡里被单独重绘，闪一帧。
      // scrollbar-gutter: stable 已预留槽位，所以这里不会引起重排。
      if (listBox) { listBox.style.overflowY = 'hidden'; listBox.scrollTop = 0; }
      var viewBottom = listBox ? listBox.getBoundingClientRect().bottom : window.innerHeight;
      var visible = rows.map(function (r) {
        var rect = r.getBoundingClientRect();
        return { row: r, bottom: rect.bottom, vis: rect.bottom > 0 && rect.top < viewBottom };
      }).filter(function (o) { return o.vis; })
        .sort(function (a, b) { return b.bottom - a.bottom; });   // 屏幕最下面那行最先走

      visible.forEach(function (o, i) {
        o.row.style.setProperty('--out', (Math.min(12, i) * 9) + 'ms');
      });
      rows.forEach(function (r) {
        if (!r.style.getPropertyValue('--out')) r.style.setProperty('--out', '0ms');  // 视口外的不用等
      });
      toolEl.classList.add('rows-out');
      // 行数只影响延迟上限，不把时长线性拉长
      var rowsMs = visible.length ? Math.min(120, 50 + Math.min(12, visible.length - 1) * 9) : 0;

      // 三步有重叠：标题在列表收尾时开始，背景在标题刚起色时跟进
      var headMs = rowsMs;
      var backdropMs = rowsMs + 70;
      var head = toolEl.querySelector('.sheet-head');
      setTimeout(function () {
        if (head) head.classList.add('head-fade');
      }, headMs);
      setTimeout(function () { toolEl.classList.add('backdrop-out'); }, backdropMs);
      setTimeout(function () {
        toolEl.classList.remove('on');
        toolEl.classList.remove('rows-out');
        toolEl.classList.remove('backdrop-out');
        if (head) head.classList.remove('head-fade');
      }, backdropMs + 180);
    }

    if (injClose) injClose.addEventListener('click', closeTool);
    if (injBack) injBack.addEventListener('click', function () {
      var body = document.querySelector('.sheet-body.split');
      if (body) body.classList.remove('detail-open');
      injBack.style.display = 'none';
    });
    if (toolEl) toolEl.addEventListener('click', function (ev) {
      if (ev.target.id !== 'tool') return;
      // 单击空白只做「回到列表」，关闭走右上角按钮或双击
      var body2 = document.querySelector('.sheet-body.split');
      if (body2 && body2.classList.contains('detail-open')) {
        body2.classList.remove('detail-open');
        if (injBack) injBack.style.display = 'none';
      }
    });

    /* 双击空白：在「最顶层」时关闭面板（详情页里双击不算，因为单击已经回到列表） */
    var wasDetailOpen = false;
    if (toolEl) {
      toolEl.addEventListener('pointerdown', function (ev) {
        if (ev.target.id !== 'tool') return;
        var b = document.querySelector('.sheet-body.split');
        wasDetailOpen = !!(b && b.classList.contains('detail-open'));
      });
      toolEl.addEventListener('dblclick', function (ev) {
        if (ev.target.id !== 'tool') return;
        if (wasDetailOpen) { wasDetailOpen = false; return; }   // 双击前在详情页 → 只回到列表
        closeTool();
      });
    }
    if (verEl) {
      verEl.addEventListener('dblclick', function (ev) {
        if (ev.target.id === 'ver') closeVers();   // 与注入点一致：双击空白关闭
      });
    }

    /* 顶部按钮 */
    $('#btn-fit').addEventListener('click', function () {
      graph.cameraOn = true;
      syncCam();
      graph.fit();
    });
    $('#btn-reset').addEventListener('click', function () {
      graph.reset();
      currentReport = null;
      isLoading = false;
      dirPath = null; dirName = ''; lastSignature = '';
      applyTitle('');
      if (chipMods) chipMods.textContent = '— mod';
      if (chipInj) chipInj.textContent = '— 注入点';
      if (chipCrit) { chipCrit.textContent = '— 高危'; chipCrit.classList.remove('on'); }
      instChip.textContent = '等待拖入';
      setStatus('');
      progressEl.classList.remove('on');
      progressBar.style.width = '0%';
      dropzone.classList.remove('hide');
      document.getElementById('stage').classList.add('idle');
      if (qInput) qInput.value = '';
      if (qCount) { qCount.textContent = ''; qCount.style.opacity = '0'; }
      $('#btn-export').disabled = true;
      $('#btn-export-lite').disabled = true;
      var bv2 = document.getElementById('btn-vers');
      if (bv2) bv2.disabled = true;
      renderIdle();
    });
    $('#btn-issues').addEventListener('click', function () {
      renderIssues(currentReport);
      document.getElementById('modal').classList.add('on');
    });

    /* 导出英文报表：精简 = 只留关键；全量 = 不截断（谁改谁 / 谁依赖谁全给） */
    function doExport(lite) {
      if (!currentReport) return;
      var isRaw = !lite;
      var body, mime, ext;
      if (isRaw) {
        // 全量档 = 原始数据转储（JSON），和分析结论完全分开
        body = A.buildRawExport(currentReport, {
          appVersion: appVersion,
          fields: exportFields(),
          strFilter: cfgState.strfilter || []
        });
        mime = 'application/json;charset=utf-8';
        ext = '.json';
      } else {
        body = A.renderEnglish(currentReport, { maxClasses: 40, maxNodes: 40, maxEdges: 60 });
        mime = 'text/markdown;charset=utf-8';
        ext = '.md';
      }
      var blob = new Blob([body], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'mod-audit-' +
        String(currentReport.mcVersion || 'report').replace(/[^\w.-]+/g, '_') +
        (lite ? '-lite' : '-raw') + ext;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
    }
    /* ---------------- 设置面板 ---------------- */
    var CFG_KEY = 'modaudit.cfg';
    function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } }
    var cfgState = loadCfg();
    function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfgState)); } catch (e) { } }

    function exportFields() {
      return {
        base: cfgState['exp.base'] !== false,
        deps: cfgState['exp.deps'] !== false,
        injections: cfgState['exp.injections'] !== false,
        desc: cfgState['exp.desc'] === true,
        code: cfgState['exp.code'] === true,
        consts: cfgState['exp.consts'] === true
      };
    }

    function validateStrFilter() {
      var ta = document.getElementById('cfg-strfilter');
      var errBox = document.getElementById('cfg-strfilter-err');
      if (!ta || !errBox) return [];
      var bad = [], good = [];
      ta.value.split('\n').forEach(function (line) {
        var s = line.trim();
        if (!s) return;
        try { new RegExp(s); good.push(s); } catch (e) { bad.push(s); }
      });
      errBox.textContent = bad.length ? ('非法正则（已忽略）：' + bad.join('  ')) : '';
      cfgState.strfilter = good;
      return good;
    }

    function applyCfgToUI() {
      document.querySelectorAll('[data-cfg]').forEach(function (el) {
        var k = el.getAttribute('data-cfg');
        el.checked = cfgState[k] !== undefined ? !!cfgState[k] : el.defaultChecked;
      });
      var ta = document.getElementById('cfg-strfilter');
      if (ta) ta.value = (cfgState.strfilter || []).join('\n');
      var ts = document.getElementById('cfg-strskip');
      if (ts) ts.value = (cfgState.strSkip || (window.A && A.DEFAULT_STR_SKIP) || []).join('\n');
      ['glow', 'stroke', 'edge'].forEach(function (k) {
        var el = document.getElementById('cfg-' + k);
        if (el && cfgState['style.' + k] != null) el.value = cfgState['style.' + k];
      });
      validateStrFilter();
    }

    var cfgEl = document.getElementById('cfg');
    function openCfg() {
      if (!cfgEl) return;
      applyCfgToUI();
      cfgEl.classList.remove('closing');
      cfgEl.classList.add('on');
    }
    function closeCfg() {
      if (!cfgEl || !cfgEl.classList.contains('on')) return;
      // 退场顺序：最右的块先走（右侧先退、左侧后退）
      var blocks = cfgEl.querySelectorAll('.cfg-block');
      var n = blocks.length;
      blocks.forEach(function (b, i) { b.style.setProperty('--r', String(n - 1 - i)); });
      cfgEl.classList.add('closing');
      setTimeout(function () {
        cfgEl.classList.remove('on');
        cfgEl.classList.remove('closing');
      }, 380);
    }
    var btnCfg = document.getElementById('btn-cfg');
    if (btnCfg) btnCfg.addEventListener('click', openCfg);
    var cfgClose = document.getElementById('cfg-close');
    if (cfgClose) cfgClose.addEventListener('click', closeCfg);
    if (cfgEl) {
      cfgEl.addEventListener('click', function (ev) { if (ev.target.id === 'cfg') closeCfg(); });
      cfgEl.querySelectorAll('[data-cfg]').forEach(function (el) {
        el.addEventListener('change', function () {
          cfgState[el.getAttribute('data-cfg')] = el.checked;
          saveCfg();
        });
      });
      var ta = document.getElementById('cfg-strfilter');
      if (ta) ta.addEventListener('input', function () { validateStrFilter(); saveCfg(); });
      var ts = document.getElementById('cfg-strskip');
      if (ts) ts.addEventListener('input', function () {
        var good = [], bad = [];
        ts.value.split('\n').forEach(function (line) {
          var s = line.trim(); if (!s) return;
          try { new RegExp(s); good.push(s); } catch (e) { bad.push(s); }
        });
        var err = document.getElementById('cfg-strskip-err');
        if (err) err.textContent = bad.length ? ('非法正则（已忽略）：' + bad.join('  ')) : '';
        cfgState.strSkip = good;
        A.setStringFilters({ skip: good });
        saveCfg();
      });
      ['glow', 'stroke', 'edge'].forEach(function (k) {
        var el = document.getElementById('cfg-' + k);
        if (el) el.addEventListener('input', function () { cfgState['style.' + k] = +el.value; saveCfg(); });
      });
    }

    $('#btn-export-lite').addEventListener('click', function () { doExport(true); });
    $('#btn-export').addEventListener('click', function () { doExport(false); });
    $('#sheet-close').addEventListener('click', function () {
      document.getElementById('modal').classList.remove('on');
    });
    document.getElementById('modal').addEventListener('click', function (ev) {
      if (ev.target.id === 'modal') ev.target.classList.remove('on');
    });

    btnCam.addEventListener('click', function () {
      graph.cameraOn = !graph.cameraOn;
      if (graph.cameraOn) graph._camHold = 0;
      syncCam();
    });
    syncCam();

    /* 外观面板 */
    var panel = document.getElementById('panel');
    var LOOK_INPUTS = [
      ['s-glow', 'v-glow', 'glow'],
      ['s-rim', 'v-rim', 'rim'],
      ['s-edge', 'v-edge', 'edge']
    ];
    function applyLookToInputs() {
      LOOK_INPUTS.forEach(function (c) {
        var input = document.getElementById(c[0]);
        var out = document.getElementById(c[1]);
        if (!input || !out) return;
        input.value = graph.look[c[2]];
        out.textContent = graph.look[c[2]];
      });
    }
    function saveLook() {
      try { localStorage.setItem('modaudit.look', JSON.stringify(graph.look)); } catch (e) { }
    }
    LOOK_INPUTS.forEach(function (c) {
      var input = document.getElementById(c[0]);
      var out = document.getElementById(c[1]);
      if (!input || !out) return;
      input.addEventListener('input', function () {
        graph.look[c[2]] = parseFloat(input.value);
        out.textContent = input.value;
        saveLook();
      });
    });
    try {
      var saved = JSON.parse(localStorage.getItem('modaudit.look') || 'null');
      if (saved) {
        Object.keys(graph.look).forEach(function (k) {
          if (typeof saved[k] === 'number' && isFinite(saved[k])) graph.look[k] = saved[k];
        });
      }
    } catch (e) { }
    applyLookToInputs();
    document.getElementById('btn-panel').addEventListener('click', function () {
      panel.classList.toggle('on');
    });
    document.getElementById('btn-look-reset').addEventListener('click', function () {
      graph.look = { glow: 14, rim: 1.5, edge: 1 };
      applyLookToInputs();
      saveLook();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        hideCtx();
        // Esc 也走逐级回退：详情 → 列表 → 关闭
        var split = document.querySelector('.sheet-body.split');
        if (split && split.classList.contains('detail-open')) {
          split.classList.remove('detail-open');
          var backBtn = document.getElementById('inj-back');
          if (backBtn) backBtn.style.display = 'none';
          return;
        }
        document.getElementById('modal').classList.remove('on');
        var t = document.getElementById('tool');
        if (t) t.classList.remove('on');
        graph.select(-1);
      }
    });

    /* 完整流程 */
    window.run = function (files) {
      var picked = classify(files);
      if (!picked.jars.length) {
        setStatus('这个文件夹里没找到 jar');
        return Promise.resolve();
      }
      isLoading = true;
      var token = ++loadToken;
      if (activeWorker) { try { activeWorker.terminate(); } catch (e) { } activeWorker = null; }
      if (A.setStringFilters) A.setStringFilters({ skip: cfgState.strSkip });   // 作废上一次仍在跑的加载

      // 同一个目录重复拖入 → 什么都不做
      var signature = picked.jars.map(function (j) { return j.path; }).sort().join('|');
      if (signature === lastSignature) {
        setStatus('');
        return Promise.resolve();
      }
      lastSignature = signature;

      // 目录名 → 标题；真实路径 → 供「打开文件夹」使用
      var first = picked.jars[0];
      var real = (window.modaudit && window.modaudit.pathOf) ? window.modaudit.pathOf(first.file) : null;
      if (real) {
        dirPath = real.replace(/[\\/][^\\/]+$/, '');
        dirName = /[\\/]mods$/i.test(dirPath)
          ? dirPath.replace(/[\\/]mods$/i, '').split(/[\\/]/).pop()
          : dirPath.split(/[\\/]/).pop();
      } else {
        var segs = first.path.replace(/\\/g, '/').split('/');
        var mi = segs.lastIndexOf('mods');
        dirName = mi > 0 ? segs[mi - 1] : (segs.length > 1 ? segs[0] : 'mods');
        dirPath = null;
      }
      applyTitle(dirName);

      dropzone.classList.add('hide');
      document.getElementById('stage').classList.remove('idle');
      graph.reset();
      currentReport = null;
      if (qInput) qInput.value = '';
      if (qCount) { qCount.textContent = ''; qCount.style.opacity = '0'; }
      setStatus('读取版本信息…');

      var instance = null;

      return pickInstance(picked.versionJsons).then(function (inst) {
        instance = inst;

        if (inst) {
          instChip.innerHTML = '<b>' + esc(inst.mcVersion || '?') + '</b> · ' + esc(inst.loader) +
            (inst.loaderVersion ? ' ' + esc(inst.loaderVersion) : '');
        } else {
          instChip.textContent = '未找到 version.json';
        }

        graph.setRoot({
          label: inst ? (inst.loader + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')) : '模组加载器',
          sub: inst ? (inst.mcVersion || '?') : '?'
        });

        graph.cameraOn = true;
        syncCam();
        graph._camHold = 0;

        // 优先走 Worker：分析全部在后台线程，主线程只画图。
        // file:// 下 Chromium 不允许建 Worker，此时自动退回主线程（网页版双击打开）。
        lastFiles = picked.jars.map(function (j) {
          return { name: j.file.name, file: j.file, paths: j.paths };
        });
        return new Promise(function (resolve, reject) {
          var w = null;
          var canWorker = (typeof Worker !== "undefined") && location.protocol !== "file:";
          if (canWorker) { try { w = new Worker("worker.js"); } catch (e) { w = null; } }
          if (!w) {
            resolve(A.collect({
              instance: inst,
              jars: picked.jars.map(function (j) {
                return {
                  name: j.path,
                  getBytes: function () {
                    return j.file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
                  }
                };
              })
            }, {
              onProgress: function (i, n, name) {
                if (token !== loadToken) throw new Error("__superseded__");
                setProgress(i, n);
                setStatus("分析中 " + i + "/" + n + " · " + (name.length > 34 ? name.slice(0, 33) + "…" : name));
              },
              onMod: function (mod) { if (mod && token === loadToken) graph.addMod(mod); }
            }));
            return;
          }
          if (activeWorker) { try { activeWorker.terminate(); } catch (e) { } }
          activeWorker = w;
          w.onmessage = function (ev) {
            if (token !== loadToken) { try { w.terminate(); } catch (e) { } return; }
            var m = ev.data || {};
            if (m.type === "progress") {
              setProgress(m.i, m.n);
              setStatus("分析中 " + m.i + "/" + m.n + " · " + (m.name && m.name.length > 34 ? m.name.slice(0, 33) + "…" : (m.name || "")));
            } else if (m.type === "mod") {
              if (m.mod) graph.addMod(m.mod);
            } else if (m.type === "done") {
              try { w.terminate(); } catch (e) { }
              if (activeWorker === w) activeWorker = null;
              resolve({ mods: m.mods, errors: m.errors, instance: m.instance });
            } else if (m.type === "error") {
              try { w.terminate(); } catch (e) { }
              if (activeWorker === w) activeWorker = null;
              reject(new Error(m.message || "worker error"));
            }
          };
          w.onerror = function (e) {
            try { w.terminate(); } catch (e2) { }
            if (activeWorker === w) activeWorker = null;
            reject(new Error((e && e.message) || "worker 启动失败"));
          };
          w.postMessage({ type: "start", files: lastFiles, instance: inst, strSkip: cfgState.strSkip || null });
        });
      }).then(function (res) {
        if (token !== loadToken) return null;   // 已被新加载取代，丢弃结果
        setStatus('汇总中…');
        var report = A.summarize(res.mods, res.errors, instance);
        currentReport = report;
        currentInstance = instance;

        graph.applyIssues(report);
        graph._refreshRoot();

        var counts = report.issueCounts || { high: 0, med: 0, low: 0 };
        if (chipMods) {
          chipMods.innerHTML = '<b>' + report.stats.jars + '</b> mod';
          chipInj.innerHTML = '<b>' + report.stats.targets + '</b> 注入点';
          chipCrit.innerHTML = '<b style="color:var(--danger)">' + counts.high + '</b> 高危';
        }
        window.__lastReport = report;
        setStatus('');
        setProgress(1, 1);
        setTimeout(function () { progressEl.classList.remove('on'); }, 400);

        $('#btn-issues').disabled = false;
        $('#btn-fit').disabled = false;
        $('#btn-export').disabled = false;
        $('#btn-export-lite').disabled = false;
        var bv = document.getElementById('btn-vers');
        if (bv) bv.disabled = false;

        // 加载期间用户可能已经点选了节点，别把侧边栏强行刷回空状态
        if (graph.selected >= 0 && graph.nodes[graph.selected]) {
          renderNode(graph.nodes[graph.selected]);
        } else {
          renderIdle();
        }
        isLoading = false;
        return report;
      }).catch(function (e) {
        if (!(e && e.message === '__superseded__')) {
          isLoading = false;
          setStatus('出错：' + ((e && e.message) || e));
        }
        return null;
      });
    };
  });
})();
