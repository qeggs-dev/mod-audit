#!/usr/bin/env node
/* 冒烟测试：验证 analyze 的流式重构（collect + summarize）没有破坏原有行为。
 * 用法: node smoke.js [某个整合包版本目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./analyzer.js');

const dir = process.argv[2] || 'D:\\Desktop\\.minecraft\\versions\\Fabulously Optimized';
const modsDir = path.join(dir, 'mods');
if (!fs.existsSync(modsDir)) {
  console.error('找不到 mods 目录: ' + modsDir);
  process.exit(2);
}

const all = fs.readdirSync(modsDir).filter(f => /\.jar$/i.test(f)).slice(0, 5);
console.log('测试 ' + all.length + ' 个 jar');

const seen = [];
A.collect({
  instance: null,
  jars: all.map(n => ({
    name: n,
    getBytes: () => fs.promises.readFile(path.join(modsDir, n))
  }))
}, {
  onProgress: (i, t) => process.stdout.write('  progress ' + i + '/' + t + '\r'),
  onMod: (m) => {
    seen.push(m);
    console.log('  onMod #' + seen.length + ' →',
      m ? ((m.ids[0] && m.ids[0].id) || m.file) : '(读取失败)',
      m ? 'targets=' + m.targets.length : '',
      m ? 'classes=' + (m.code ? m.code.classes : '?') : '',
      m ? 'codeKB=' + Math.round(((m.code && m.code.bytes) || 0) / 1024) : '',
      m ? 'loaders=' + m.loaders.join('+') : '',
      m ? 'desc=' + JSON.stringify((m.desc || '').slice(0, 46)) : '');
  }
}).then(({ mods, errors }) => {
  console.log('collect: mods=' + mods.length + ' errors=' + errors.length + ' 回调=' + seen.length);
  const rep = A.summarize(mods, errors, { loader: 'fabric', mcVersion: '26.2', loaderVersion: 'x' });
  console.log('summarize: jars=' + rep.stats.jars +
    ' mixin配置=' + rep.stats.mixinConfigs +
    ' 注入点=' + rep.stats.targets +
    ' 发现=' + JSON.stringify(rep.issueCounts) +
    ' 重叠=' + JSON.stringify(rep.stats.overlap));
  console.log('--- 报告头 ---');
  console.log(A.renderText(rep).split('\n').slice(0, 9).join('\n'));
  if (rep.stats.jars !== mods.length) { console.error('!! 统计不一致'); process.exit(1); }
  console.log('\nOK');
}).catch(e => { console.error(e); process.exit(1); });
