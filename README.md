<div align="center">

# mod-audit

![License](https://img.shields.io/github/license/qeggs-dev/mod-audit) ![Stars](https://img.shields.io/github/stars/qeggs-dev/mod-audit) ![Forks](https://img.shields.io/github/forks/qeggs-dev/mod-audit) ![Issues](https://img.shields.io/github/issues/qeggs-dev/mod-audit)

![Last Commit](https://img.shields.io/github/last-commit/qeggs-dev/mod-audit) ![Web Package](https://img.shields.io/badge/Web-Page-blue) ![Static Analysi](https://img.shields.io/badge/Static-Analysis-yellow) ![Minecraft JavaEdition](https://img.shields.io/badge/Minecraft-JavaEdition-red)

---

</div>

MC 整合包冲突分析工具。**纯本地运行，不上传任何文件，不执行任何被分析的代码**——它只是把 jar 当字节读。

> **这是静态分析器：报告里的一切都只是「可能导致问题」的提示，不是运行时事实。本分析器不保证准确。**
> 它的价值是缩小排查范围（从"140 个 mod 里猜"缩到"这 2 个"），不是下判决。

## 快速开始

**在线版**：`https://qeggs-dev.github.io/mod-audit/`（部署方法见 [docs/building.md](docs/building.md#部署到-github-pages在线版)）

**本地网页版**：双击 `index.html`，把整个游戏目录拖进窗口即可（无构建步骤、无需服务器；分析在 Web Worker 里跑，界面不卡）。只会读 `mods` / `versions` / `logs` / `crash-reports` 这几个目录，`.` 开头的目录跳过。

**桌面版**：Windows 提供安装包，Linux 提供 AppImage（构建见 [docs/building.md](docs/building.md)）。**macOS 不提供打包**——请直接用网页版，或在 Mac 上自行构建。


## 文档

| 文档 | 内容 |
|---|---|
| [docs/interaction.md](docs/interaction.md) | 节点图怎么读、视图操作、面板交互、报表导出 |
| [docs/analysis.md](docs/analysis.md) | 检查什么、不检查什么、踩过的坑、版本号处理规则 |
| [docs/building.md](docs/building.md) | 安装包、从源码构建、平台支持、图标流程 |

## 它解决什么问题

绝大多数整合包崩溃不是"某个 mod 自身坏了"，而是**两个 mod 撞上了**——比如都 `@Overwrite` 同一个方法、都往同一条指令上挂 `Redirect`。这类问题**靠读代码可以判断**，所以这个工具只做配对关系，不试图判断单个 mod 的好坏。

判定依据是注入器对目标的**所有权分类**（`CLAIM`）加上 `@At` 的 `(value, target, ordinal)` 三元组是否相同，而不是简单的"类名方法名一样就算冲突"。

## 已知限制

- **Fabric 模组的版本区间无法精确判定**：Fabric 会先归一化 MC 版本（`26w14a` → `26.1.1-alpha.26.14.a`）再比对，归一化表是 77 分支硬编码，本工具只还原了少数几条。遇到 Fabric 模组时，版本判定应视为「未校验」。
- **符号与混淆**：磁盘上的游戏 jar 多为混淆名或 SRG 名，跨加载器对齐不完整。
- **静态分析本质**：看不到运行时，也看不到别的 mod 改过之后的字节码。所有结论都只是「可能导致」。

## 开发说明

**AI 负责细节实现，人工负责 UI 设计、动效设计与程序交互设计。**

**本项目仅为可行性测试，不打算长期维护。** 目的是验证「纯静态、纯本地、可审计地分析整合包冲突」这条路走不走得通，而不是做成持续运营的产品：不承诺修复问题、不承诺跟进新加载器 / 新 MC 版本。代码保持零依赖、无构建的形态，就是为了让它即使停止维护也还能被人接手改动。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

Copyright (c) 2026 Qeggs
