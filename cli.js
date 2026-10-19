#!/usr/bin/env node
/* mod-audit / cli.js
 *
 * 用法:
 *   node cli.js <游戏目录 | 版本目录 | mods目录> [--json] [--out 报告.txt] [--list]
 *
 * 目录识别规则:
 *   1) <root>/mods 存在           → 就是它
 *   2) <root>/versions/<v>/mods   → 只有一个版本时才用；多个会让你指定
 *   3) <root> 本身是一堆 jar      → 当成 mods 目录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./analyzer.js');

/* ---------------- 目录工具 ---------------- */
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function ls(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }

/** 递归收集 jar，跳过任何以 . 开头的目录（.connector / .fabric 这些是缓存） */
function collectJars(dir, base, out) {
  for (const name of ls(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) collectJars(full, rel, out);
    else if (/\.jar$/i.test(name)) out.push({ name: rel, full, size: st.size });
  }
  return out;
}

function discover(root) {
  const res = {
    root,
    modsDirs: [],
    versionJsons: [],
    logs: [],
    crashReports: [],
    candidates: [],
    warning: null
  };

  // --- mods 目录 ---
  if (isDir(path.join(root, 'mods'))) res.modsDirs.push(path.join(root, 'mods'));

  // --- 版本 json：<root>/<同名>.json，或 <root>/versions/<v>/<v>.json ---
  const rootBase = path.basename(path.resolve(root));
  for (const f of ls(root)) {
    if (f.toLowerCase().endsWith('.json') && path.basename(f, '.json') === rootBase) {
      res.versionJsons.push(path.join(root, f));
    }
  }
  const vroot = path.join(root, 'versions');
  if (isDir(vroot)) {
    for (const v of ls(vroot)) {
      if (v.startsWith('.')) continue;
      const vd = path.join(vroot, v);
      if (!isDir(vd)) continue;
      const hasMods = isDir(path.join(vd, 'mods'));
      if (hasMods) res.candidates.push({ name: v, dir: vd, mods: path.join(vd, 'mods') });
      for (const f of ls(vd)) {
        if (f === v + '.json') res.versionJsons.push(path.join(vd, f));
      }
    }
    // 只有一个版本带 mods → 就用它；多个 → 让人指定，避免把几个整合包混成一份报告
    if (!res.modsDirs.length && res.candidates.length === 1) {
      res.modsDirs.push(res.candidates[0].mods);
    } else if (!res.modsDirs.length && res.candidates.length > 1) {
      res.warning = '发现多个版本目录都带 mods，请直接指定其中一个：\n' +
        res.candidates.map(c => '  ' + c.dir).join('\n');
    }
  }

  // --- root 本身就是 mods 目录 ---
  if (!res.modsDirs.length && !res.warning) {
    const jars = ls(root).filter(f => /\.jar$/i.test(f));
    if (jars.length) res.modsDirs.push(root);
  }

  // --- 兄弟目录里的原版版本 json：<实例>/../1.20.1/1.20.1.json ---
  // 整合包的版本 json 常被启动器合并过（没有 inheritsFrom），原版那个直接给出 MC 版本
  const parent = path.dirname(path.resolve(root));
  if (path.basename(parent) === 'versions') {
    for (const v of ls(parent)) {
      if (!/^\d+\.\d+/.test(v)) continue;
      const p = path.join(parent, v, v + '.json');
      try { if (fs.statSync(p).isFile()) res.versionJsons.push(p); } catch (e) { }
    }
  }

  // --- 日志与崩溃报告（第一版只统计，不解析） ---
  const logsDir = path.join(root, 'logs');
  if (isDir(logsDir)) {
    for (const f of ['latest.log', 'debug.log']) {
      const p = path.join(logsDir, f);
      try { if (fs.statSync(p).isFile()) res.logs.push(p); } catch (e) { }
    }
  }
  const crDir = path.join(root, 'crash-reports');
  if (isDir(crDir)) {
    for (const f of ls(crDir)) {
      if (!/\.txt$/i.test(f)) continue;
      const p = path.join(crDir, f);
      try { res.crashReports.push({ name: f, mtime: fs.statSync(p).mtime }); } catch (e) { }
    }
    res.crashReports.sort((a, b) => b.mtime - a.mtime);
  }

  return res;
}

function loadInstance(versionJsons) {
  for (const p of versionJsons) {
    try {
      const v = A.parseVersionJson(fs.readFileSync(p, 'utf8'));
      if (v && (v.loader !== 'unknown' || v.mcVersion)) return v;
    } catch (e) { }
  }
  for (const p of versionJsons) {
    try {
      const v = A.parseVersionJson(fs.readFileSync(p, 'utf8'));
      if (v) return v;
    } catch (e) { }
  }
  return null;
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  const argv = process.argv.slice(2);
  const flags = { json: false, list: false, out: null, verbose: false, exp: null, lite: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--lite') flags.lite = true;
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--export') flags.exp = argv[++i];
    else positional.push(a);
  }

  if (!positional.length) {
    console.error('用法: node cli.js <游戏目录|版本目录|mods目录> [--json] [--out 报告.txt] [--list]');
    process.exit(2);
  }

  const root = path.resolve(positional[0]);
  if (!isDir(root)) { console.error('不是目录: ' + root); process.exit(2); }

  const disc = discover(root);
  if (disc.warning) { console.error(disc.warning); process.exit(3); }
  if (!disc.modsDirs.length) {
    console.error('在 ' + root + ' 下没找到 mods 目录（也没找到 .jar）。');
    process.exit(3);
  }

  if (flags.list) {
    console.log('root         : ' + root);
    console.log('version json : ' + (disc.versionJsons.join('\n               ') || '(无)'));
    console.log('mods dir     : ' + disc.modsDirs.join('\n               '));
    console.log('logs         : ' + (disc.logs.join(', ') || '(无)'));
    console.log('crash reports: ' + (disc.crashReports.length ? disc.crashReports.length + ' 份' : '(无)'));
  }

  const instance = loadInstance(disc.versionJsons);

  // 收集 jar（多个 mods 目录时合并；相对路径带上目录名避免重名）
  const jars = [];
  const multi = disc.modsDirs.length > 1;
  for (const md of disc.modsDirs) {
    const list = collectJars(md, multi ? path.basename(md) : '', []);
    for (const j of list) {
      jars.push({
        name: j.name,
        getBytes: () => fs.promises.readFile(j.full)
      });
    }
  }

  if (!jars.length) { console.error('mods 目录里没有 jar。'); process.exit(3); }

  const t0 = Date.now();
  const report = await A.analyze({ jars, instance }, (i, n, name) => {
    if (!flags.verbose && i % 20 !== 0 && i !== n) return;
    process.stderr.write('\r分析中 ' + i + '/' + n + '  ' + (name.length > 50 ? name.slice(0, 50) + '…' : name) + '        ');
  });
  process.stderr.write('\r' + ' '.repeat(80) + '\r');

  report.meta = {
    root,
    modsDirs: disc.modsDirs,
    versionJsons: disc.versionJsons,
    logs: disc.logs,
    crashReports: disc.crashReports.map(c => c.name),
    elapsedMs: Date.now() - t0
  };

  // 英文报表：给 LLM 读的，刻意压缩过。--lite 只保留头部结论 + 少量关系
  if (flags.exp) {
    const opts = flags.lite
      ? { maxClasses: 40, maxNodes: 40, maxEdges: 60 }
      : {};
    fs.writeFileSync(flags.exp, A.renderEnglish(report, opts), 'utf8');
    console.log('英文报表已写入: ' + flags.exp + (flags.lite ? '（精简档）' : ''));
  }

  const text = A.renderText(report, { verbose: flags.verbose });
  if (flags.json) {
    // 去掉 target 明细里的重复数据，保持可读
    const slim = JSON.parse(JSON.stringify({
      instance: report.instance,
      mcVersion: report.mcVersion,
      mcSource: report.mcSource,
      stats: report.stats,
      issueCounts: report.issueCounts,
      issues: report.issues,
      errors: report.errors,
      mods: report.mods.map(m => ({
        file: m.file, loader: m.loader, namespace: m.namespace,
        ids: m.ids, mcRange: m.mcRange,
        mixinConfigs: m.mixinConfigs, targetCount: m.targets.length
      })),
      meta: report.meta
    }));
    const out = JSON.stringify(slim, null, 2);
    if (flags.out) fs.writeFileSync(flags.out, out, 'utf8');
    else console.log(out);
  } else {
    if (flags.out) { fs.writeFileSync(flags.out, text + '\n', 'utf8'); console.log('报告已写入: ' + flags.out); }
    else console.log(text);
  }
})().catch(e => { console.error('出错: ' + (e && e.stack || e)); process.exit(1); });
