# 运行与部署

本仓库只有网页应用本体：`index.html` + `app.css` + `app.js` + `analyzer.js` + `version.js` + `worker.js` + `icon.png`。没有构建步骤，没有依赖，没有后端。

## 直接运行

双击 `index.html` 即可，不需要服务器。

浏览器要求：支持 `DecompressionStream` 的版本（Chrome 103+ / Firefox 113+ / Safari 16.4+）。

`file://` 下有一个限制：Chromium 不允许从 `file://` 页面创建 Web Worker，所以**分析会退回主线程**，界面在分析期间可能卡顿。用下面的在线版或任意静态服务器打开就没有这个问题。

## 部署到 GitHub Pages（推荐）

1. 仓库 **Settings → Pages → Build and deployment**
2. Source 选 **Deploy from a branch**
3. Branch 选 `main`，目录选 **`/ (root)`**
4. 等一两分钟，地址形如 `https://<用户名>.github.io/<仓库名>/`

说明：

- 站点入口就是仓库根目录的 `index.html`，**没有单独的构建产物**，改完 push 即生效。
- 通过 `https://` 访问时 `location.protocol !== 'file:'`，于是 `app.js` 会启用 Web Worker——分析在后台线程跑，界面不阻塞。
- 在线版与本地双击打开的唯一功能差异：「点击 mod 数打开 mods 文件夹」不可用（浏览器拿不到本地路径）。
- 仓库需要是 public（私有仓库的 Pages 需要付费计划）。

## 任意静态服务器

任何能把目录原样提供的服务器都行（`python -m http.server`、`npx serve`、Nginx 等），因为所有资源都是相对路径。

## 一张图理解运行方式

```
index.html
  ├─ app.js          界面 / 画布 / 交互
  ├─ analyzer.js     解析 jar（被主线程直接加载，也作为 Worker 里的依赖）
  ├─ version.js      版本比较与区间解析
  └─ worker.js       可选：把 analyzer 拉进 Worker 跑，主线程只收消息
```

`app.js` 里的判定：

```js
var canWorker = (typeof Worker !== 'undefined') && location.protocol !== 'file:';
```

不满足就退回主线程，所以 `file://` 和 `https://` 两种打开方式都能用，只是后者体验更好。
