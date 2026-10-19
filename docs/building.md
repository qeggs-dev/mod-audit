# 安装、运行与构建

本仓库只包含**源码与构建脚本**，不含 `node_modules`、构建产物、缓存或任何本机配置。

## 直接运行（无需安装）

双击仓库根目录的 `index.html` 即可。没有任何构建步骤，也不需要起本地服务器——所有文件都是相对引用，`file://` 下能正常工作。

浏览器要求：支持 `DecompressionStream` 的版本（Chrome 103+ / Firefox 113+ / Safari 16.4+）。

## 命令行

```bash
node cli.js <游戏目录 | 版本目录 | mods目录> [--list]
node cli.js <目录> --out 报告.txt
node cli.js <目录> --json
node cli.js <目录> --export report.md [--lite]
```

只看 Node 版本，无第三方依赖。建议先跑 `--list` 确认它认到的目录与版本。

## 构建桌面安装包

```bash
cd desktop
npm install          # 首次或改依赖后
npm run setup        # Windows: NSIS → desktop/release/
npm run setup:linux  # Linux: AppImage
```

Linux 上可直接跑仓库里的脚本，它会检查环境、设好镜像并调用正确的命令：

```bash
bash scripts/build-linux.sh
```

**必须走 `npm run setup*`**，它会先执行 `node build-app.js` 把前端文件复制进 `desktop/app/`。直接调用 `electron-builder` 会跳过这步，把旧前端打进包里。

### 网络受限时

electron 二进制与 NSIS 组件都不在 npm registry 上，需要单独的镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install --registry=https://registry.npmmirror.com
```

### 两个环境坑

- **`ELECTRON_RUN_AS_NODE=1`** 会让 `electron.exe` 以 Node 模式启动：`require('electron')` 返回可执行文件路径而不是 API，应用会**秒退且退出码为 0**（看起来像成功）。构建或启动前清掉该变量。
- **`winCodeSign` 内含 macOS 文件符号链接**：非管理员或未开 Windows 开发者模式时解压失败，后果是 `rcedit` 不执行、exe 保留 Electron 默认图标与 `ProductName=Electron`。

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows x64 | ✅ 已实际构建并验证 | NSIS 安装包 |
| Linux x64 | ✅ 配置与脚本就绪 | AppImage，用 `scripts/build-linux.sh` |
| macOS | ❌ 不提供 | dmg 依赖 macOS 独有工具（`hdiutil`、`codesign`），无法在非 macOS 上产出 |

**macOS 用户**：直接打开 `index.html`（网页版功能完整，只是不能「一键打开 mods 文件夹」），或按上面的流程在 Mac 上自行构建。

## 部署到 GitHub Pages（在线版）

网页版是**纯静态**的：所有资源都是相对路径，没有构建步骤，也不需要服务器或任何后端。因此可以整个仓库直接挂在 GitHub Pages 上。

1. 仓库 **Settings → Pages → Build and deployment**
2. Source 选 **Deploy from a branch**
3. Branch 选 `main`，目录选 **`/ (root)`**，保存
4. 等一两分钟，地址形如 `https://<用户名>.github.io/<仓库名>/`

几点说明：

- 根目录的 `.nojekyll` 是**必需**的，它阻止 GitHub 用 Jekyll 处理这些文件（否则以下划线开头的路径会被吞掉）。
- 站点入口就是仓库根目录的 `index.html`，和本地双击打开的是同一份文件，**没有单独的构建产物**。
- `docs/` 里的 `.md` 在站点上会以纯文本形式可访问，但不会被渲染成页面——它们主要是给仓库首页的 README 链接用的。
- 在线版与桌面版的唯一差别：**「点击 mod 数打开 mods 文件夹」不可用**（浏览器拿不到本地路径），其余功能完全一致。
- 仓库需要是 **public**（私有仓库的 Pages 需要付费计划）。

## 图标

`desktop/build/icon-src.png` 是生图产物，`desktop/make-icon.py` 负责裁方形、切圆角（超采样遮罩 + LANCZOS）并生成多尺寸 `icon.ico`：

```bash
cd desktop
python make-icon.py build/icon-src.png 0.215   # 第二个参数是圆角比例
```
