/* mod-audit / worker.js
 *
 * 分析整个整合包：解压、class 解析、元数据解析都在这里跑，主线程只收
 * progress / mod / const / done 四类消息并负责绘图。
 *
 * 常量扫描不再"分析完再重读一遍 jar"，而是 collect 在分析每个 jar 时
 * 顺手把已经解压好的 zip 交给 onConstants，由它作为异步任务扫描。
 * 好处：每个 jar 只读一次、只解压一次；节点也仍然是先出来、常量后到。
 *
 * 前提：页面通过 app:// 这类「标准 scheme」加载。file:// 下 Chromium 禁止创建 Worker，
 * 那种情况由主线程的降级路径处理（见 app.js）。
 */
'use strict';

importScripts('analyzer.js');

// analyzer 会给每个 mod 挂 reopen（一个函数，用来重读 jar 字节）。
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
          if (mod) self.postMessage({ type: 'mod', mod: cloneable(mod) });
        },
        // 分析过程中顺带跑常量扫描：复用同一个 zip，不重新读盘
        onConstants: async function (mod, zip) {
          var r = await self.ModAudit.scanZipConstants(zip, {});
          mod.constStrings = r.strings;
          mod.constTotal = r.total;
          mod.constEntries = r.entries;
          self.postMessage({ type: 'const', file: mod.file, entries: r.entries, total: r.total });
        }
      }
    );

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
