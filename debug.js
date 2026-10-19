#!/usr/bin/env node
/* 一次性诊断脚本：看清楚真实 jar / version.json 里的东西，再决定怎么改分析器。
 * 用法: node debug.js
 */
'use strict';
const fs = require('fs');
const A = require('./analyzer.js');

const BASE_FO = 'D:\\Desktop\\.minecraft\\versions\\Fabulously Optimized';
const BASE_CR = 'D:\\Desktop\\.minecraft\\versions\\Create';
const BASE_GT = 'D:\\Desktop\\.minecraft\\versions\\gtl-llfBuild-3';

const JARS = [
  BASE_FO + '\\mods\\iris-fabric-1.11.4+mc26.2.jar',
  BASE_FO + '\\mods\\entity_model_features-3.3.11-26.2-fabric.jar',
  BASE_FO + '\\mods\\entity_texture_features-7.2.5-26.2-fabric.jar',
  BASE_FO + '\\mods\\modmenu-20.0.3.jar',
  BASE_CR + '\\mods\\garnished-april-foods-26-neoforged.jar',
  BASE_CR + '\\mods\\create-aeronautics-bundled-1.21.1-1.3.0.jar',
  BASE_GT + '\\mods\\create-1.20.1-0.5.1.j.jar'
];
const VJSONS = [
  BASE_CR + '\\Create.json',
  BASE_GT + '\\gtl-llfBuild-3.json',
  BASE_FO + '\\Fabulously Optimized.json'
];

async function dumpJar(p) {
  console.log('\n===== JAR: ' + p.split('\\').pop() + ' =====');
  let bytes;
  try { bytes = fs.readFileSync(p); } catch (e) { console.log('  读不到: ' + e.message); return; }
  let zip;
  try { zip = A.unzip(bytes); } catch (e) { console.log('  解不开: ' + e.message); return; }
  console.log('  条目数: ' + zip.entries.size + '，大小: ' + (bytes.length / 1048576).toFixed(1) + ' MB');

  const all = [...zip.entries.keys()];
  const meta = all.filter(n => /^(fabric\.mod\.json|META-INF\/mods\.toml|META-INF\/neoforge\.mods\.toml|META-INF\/MANIFEST\.MF)$/.test(n));
  console.log('  元数据条目: ' + (meta.join(', ') || '(无)'));

  const refmap = all.filter(n => /refmap/i.test(n));
  console.log('  含 refmap 的条目(' + refmap.length + '): ' + refmap.slice(0, 6).join(', ') + (refmap.length > 6 ? ' …' : ''));

  const cfg = all.filter(n => /\.mixins?\.json$|^mixins[.\w-]*\.json$/i.test(n));
  console.log('  mixin 配置候选(' + cfg.length + '): ' + cfg.slice(0, 6).join(', ') + (cfg.length > 6 ? ' …' : ''));

  const nested = all.filter(n => /^META-INF\/(jars|jarjar)\//i.test(n));
  console.log('  嵌套 jar(' + nested.length + '): ' + nested.slice(0, 6).join(', ') + (nested.length > 6 ? ' …' : ''));

  // 挑一个配置，看它声明的 refmap
  const target = cfg.find(n => !/refmap/i.test(n)) || cfg[0];
  if (target) {
    try {
      const txt = new TextDecoder().decode(await zip.read(target));
      const o = JSON.parse(txt);
      console.log('  [' + target + '] refmap=' + JSON.stringify(o.refmap) + '  package=' + o.package +
        '  mixins=' + (Array.isArray(o.mixins) ? o.mixins.length : 0));
    } catch (e) { console.log('  [' + target + '] 解析失败: ' + e.message); }
  }

  // 元数据内容
  try {
    if (zip.entries.has('fabric.mod.json')) {
      const o = JSON.parse(new TextDecoder().decode(await zip.read('fabric.mod.json')));
      console.log('  fabric.mod.json → id=' + o.id + ' version=' + o.version + ' mixins=' + JSON.stringify(o.mixins));
    }
    for (const p2 of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
      if (!zip.entries.has(p2)) continue;
      const txt = new TextDecoder().decode(await zip.read(p2));
      const o = A.parseToml(txt);
      const mods = (o.mods || []).map(m => m.modId + '@' + m.version);
      console.log('  ' + p2 + ' → mods=' + JSON.stringify(mods));
      const deps = Object.keys(o.dependencies || {});
      console.log('    dependencies keys=' + JSON.stringify(deps.slice(0, 12)));
    }
  } catch (e) { console.log('  元数据解析失败: ' + e.message); }
}

function dumpVer(p) {
  console.log('\n===== VERSION JSON: ' + p.split('\\').pop() + ' =====');
  let o;
  try { o = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log('  读不到/解析失败: ' + e.message); return; }
  console.log('  id=' + o.id + '  inheritsFrom=' + JSON.stringify(o.inheritsFrom) + '  mainClass=' + o.mainClass);
  console.log('  type=' + JSON.stringify(o.type) + '  time=' + o.time);
  const libs = (o.libraries || []).map(l => l.name || '');
  console.log('  libraries 数量=' + libs.length);
  const interesting = libs.filter(n => /fabric|forge|neoforge|minecraft|mojang|cleanroom/i.test(n));
  console.log('  与加载器相关的库: ' + JSON.stringify(interesting.slice(0, 10), null, 1));
  console.log('  parsed → ' + JSON.stringify(A.parseVersionJson(fs.readFileSync(p, 'utf8'))));
}

(async () => {
  for (const j of JARS) await dumpJar(j);
  for (const v of VJSONS) dumpVer(v);
})().catch(e => console.error(e));
