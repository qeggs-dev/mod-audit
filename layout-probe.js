#!/usr/bin/env node
/* 排版自检：验证「黄金角螺旋 + 矩形分离」在 92 张卡片下不会叠在一起。
 * 这里用的常量必须和 app.js 里的 spiralR0 / spiralK / 卡片尺寸 / gap 一致。
 */
'use strict';

const R0 = 200, GAP = 10;
const CW = 144, CH = 21 + 8 * 2 + 12.5 * 3;   // 与 app.js 的 CARD_H 同公式
const K = Math.sqrt(((CW + 20) * (CH + 20)) / Math.PI) * 1.15;   // 与 app.js 同公式
const EPS = 0.75;                             // 小于这个量级的重叠视为已贴合
const N = Number(process.argv[2] || 92);
const STAGE_W = 1152, STAGE_H = 900;          // 右侧栏占 384 时的实际画布估计

function place(slot) {
  const a = slot * 2.399963;
  const r = R0 + Math.sqrt(slot + 0.6) * K;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

const pts = [];
for (let i = 0; i < N; i++) pts.push(place(i));

function countOverlaps() {
  let n = 0, worst = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const ox = CW + GAP - Math.abs(pts[i].x - pts[j].x);
      const oy = CH + GAP - Math.abs(pts[i].y - pts[j].y);
      if (ox > EPS && oy > EPS) { n++; worst = Math.max(worst, Math.min(ox, oy)); }
    }
  }
  return { n, worst };
}
function pushApart(iterations) {
  for (let k = 0; k < iterations; k++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const ox = CW + GAP - Math.abs(pts[i].x - pts[j].x);
        if (ox <= 0) continue;
        const oy = CH + GAP - Math.abs(pts[i].y - pts[j].y);
        if (oy <= 0) continue;
        const push = 0.5 * Math.min(ox, oy) * 0.9;
        if (ox < oy) {
          const d = (pts[j].x - pts[i].x) < 0 ? -1 : 1;
          pts[i].x -= d * push; pts[j].x += d * push;
        } else {
          const d = (pts[j].y - pts[i].y) < 0 ? -1 : 1;
          pts[i].y -= d * push; pts[j].y += d * push;
        }
      }
    }
  }
  // 根节点（190x96，中心在原点）也参与分离
  for (let i = 0; i < pts.length; i++) {
    const ox = (190 + CW) / 2 + GAP - Math.abs(pts[i].x);
    const oy = (96 + CH) / 2 + GAP - Math.abs(pts[i].y);
    if (ox > 0 && oy > 0) {
      const push = Math.min(ox, oy);
      if (ox < oy) pts[i].x += (pts[i].x < 0 ? -1 : 1) * push * 0.5;
      else pts[i].y += (pts[i].y < 0 ? -1 : 1) * push * 0.5;
    }
  }
}

const a = countOverlaps();
console.log(`K=${K.toFixed(1)}  卡片=${CW}x${CH.toFixed(1)}  间距参数=${GAP}`);
console.log(`初始：${N} 张卡片，重叠对 ${a.n}，最深 ${a.worst.toFixed(1)}`);

pushApart(160);
const b = countOverlaps();
console.log(`分离 160 轮后：重叠对 ${b.n}，最深 ${b.worst.toFixed(1)}`);

let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
for (const p of pts) {
  minX = Math.min(minX, p.x - CW / 2); maxX = Math.max(maxX, p.x + CW / 2);
  minY = Math.min(minY, p.y - CH / 2); maxY = Math.max(maxY, p.y + CH / 2);
}
const bw = maxX - minX, bh = maxY - minY;
console.log(`包围盒 ${bw.toFixed(0)} x ${bh.toFixed(0)}`);
console.log(`自动取景 zoom ≈ ${Math.min(STAGE_W / (bw + 90), STAGE_H / (bh + 90)).toFixed(2)}`);

if (b.n > 0) { console.error('!! 仍有重叠，排版参数需要调'); process.exit(1); }
console.log('OK');
