/* mod-audit / worker.js
 *
 * 把分析整套搬到 Worker 里：解压、class 解析、常量池扫描、元数据解析都在这里跑，
 * 主线程只收 progress / mod / const / done 四类消息并负责绘图。
 *
 * 常量扫描也在这里做：mod 对象在本线程里带着 reopen，可以直接重读 jar，
 * 不需要像以前那样把结果回挂到主线程的文件句柄上。
 *
 * 前提：页面通过 app:// 这类「标准 scheme」加载。file:// 下 Chromium 禁止创建 Worker，
 * 那种情况由主线程的降级路径处理（见 app.js）。
 */
'use strict';

importScripts('analyzer.js');

// 常量扫描队列：与主分析并行，最多 2 个并发，避免和解压抢 IO
var CONST_LIMIT = 2;
var constQueue = [];
var constActive = 0;

function pumpConst() {
  if (!self.ModAudit.scanConstants) return;
  while (constActive < CONST_LIMIT && constQueue.length) {
    (function (mod) {
      constActive++;
      self.ModAudit.scanConstants([mod], {}).then(function () {
        self.postMessage({
          type: 'const',
          file: mod.file,
          entries: mod.constEntries || [],
          total: mod.constTotal || 0
        });
      }).catch(function () {
        self.postMessage({ type: 'const', file: mod.file, entries: [], total: 0 });
      }).then(function () {
        constActive--;
        pumpConst();
      });
    })(constQueue.shift());
  }
}

// analyzer 会在每个 mod 上挂 reopen（一个函数，用来重读 jar 字节）。
// 函数不能跨线程克隆，直接 postMessage 会抛 DataCloneError
// （"Function object could not be cloned"），所以回传前先剥掉所有函数字段。
function cloneable(v) {
  if (typeof v === 'function') return undefined;   // 函数不能跨线程克隆，直接丢掉
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    var arr = [];
    for (var i = 0; i < v.length; i++) arr.push(cloneable(v[i]));
    return arr;
  }
  var out = {};
  for (var k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    var val = cloneable(v[k]);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

self.onmessage = async function (ev) {
  var msg = ev.data || {};
  if (msg.type !== 'start') return;
  try {
    if (self.ModAudit.setStringFilters) {
      self.ModAudit.setStringFilters({ skip: msg.strSkip || null });
    }
    var jars = (msg.files || []).map(function (j) {
      return {
        name: j.name,
        paths: j.paths || {},
        getBytes: function () {
          return j.file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        }
      };
    });

    var res = await self.ModAudit.collect(
      { instance: msg.instance || null, jars: jars },
      {
        onProgress: function (i, n, name) {
          self.postMessage({ type: 'progress', i: i, n: n, name: name });
        },
        onMod: function (mod) {
          if (!mod) return;
          self.postMessage({ type: 'mod', mod: cloneable(mod) });
          // 一并排队做常量扫描（结果用 const 消息单独回传）
          constQueue.push(mod);
          pumpConst();
        }
      }
    );

    // 等常量队列清空，保证 done 之后主线程拿到的结果齐全
    while (constActive > 0 || constQueue.length) {
      await new Promise(function (r) { setTimeout(r, 30); });
    }

    self.postMessage({
      type: 'done',
      mods: (res.mods || []).map(cloneable),
      errors: (res.errors || []).map(function (e) {
        return { file: (e && e.file) || '', error: (e && e.error) || String(e) };
      }),
      instance: res.instance
    });
  } catch (e) {
    self.postMessage({ type: 'error', message: (e && e.message) || String(e) });
  }
};
