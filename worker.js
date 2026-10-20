/* mod-audit / worker.js
 *
 * 把分析整套搬到 Worker 里：解压、class 解析、常量池扫描、元数据解析都在这里跑，
 * 主线程只收 progress / mod / done 三类消息并负责绘图。
 *
 * 前提：页面通过 app:// 这类「标准 scheme」加载。file:// 下 Chromium 禁止创建 Worker，
 * 那种情况由主线程的降级路径处理（见 app.js）。
 */
'use strict';

importScripts('analyzer.js');

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
          if (mod) self.postMessage({ type: 'mod', mod: mod });
        }
      }
    );

    self.postMessage({ type: 'done', mods: res.mods, errors: res.errors, instance: res.instance });
  } catch (e) {
    self.postMessage({ type: 'error', message: (e && e.message) || String(e) });
  }
};
