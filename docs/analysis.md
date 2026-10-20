# 检查能力与边界

## 它检查什么

| 检查 | 说明 |
|---|---|
| **@Overwrite 撞车** | 两个 mod 都 `@Overwrite` 同一方法。这是唯一真正互斥的注入类型 |
| **目标重叠（中）** | 同一方法上有 `Redirect` / `ModifyConstant` / `WrapOperation` 这类会挪走指令的注入，同时还有别人依赖那块位置 |
| **目标重叠（低）** | 多个 mod 同时 `@Inject`，通常可共存，折叠成一条 |
| **缺硬依赖** | 含 jar-in-jar 提供的 modId |
| **声明不兼容但对方装了** | NeoForge 的 `type="incompatible"` |
| **同一个 modId 多个 jar** | 重复安装 |
| **加载器不匹配** | jar 携带的签名集合里没有实例的加载器（Forge/NeoForge 视为同一 family；装了 Sinytra Connector 时 Fabric mod 在 NeoForge 上豁免） |
| **声明的 MC 版本不含实例版本** | 装错版本 |

## 它不检查什么（重要）

- **语义冲突查不出来。** 两个注入都成功、但结果不对，静态分析永远看不出来。这个工具只能缩小"关掉谁试试"的范围。
- **跨命名空间不互相比较。** Fabric 的注入目标写 Yarn 名，Forge/NeoForge 写 Mojmap 名，两者不可比。
- **SRG 名会被漏报。** 有些 Forge mod 直接写 `m_12345_`，和同一方法的 Mojmap 名不是同一串字符串。报告开头会给出这类目标的条数。
- **jar-in-jar 里的 mod 只登记 id**，它们的注入不参与归因。
- **`@Overwrite` 之外的"互相挪目标"只能靠重叠分组提示**，不是结论。

## 实际踩过的坑（读代码时有用）

1. **NeoForge 用 `type="required|optional|incompatible|discouraged"` 取代了旧 Forge 的 `mandatory` 布尔。** 漏了会得出"Create 硬依赖 journeymap"这种荒谬结论。
2. **jar-in-jar 是"缺依赖"误报的头号来源。** Create 捆着 Flywheel，`create-aeronautics-bundled` 捆着 aeronautics/offroad/simulated，全在 `META-INF/jarjar/` 下；Fabric 侧在 `META-INF/jars/`。
3. **整合包的 `<名>.json` 常被启动器合并过，没有 `inheritsFrom`**，所以读不到 MC 版本。做法是从各 mod 声明的 `minecraft` 依赖区间取一致推断，报告里标"推定"。
4. **`net.minecraftforge:forge` 会匹配到 `net.minecraftforge:forgespi`**，库里匹配必须带冒号。
5. **mixin 的注解是 `CLASS` retention**，在 `RuntimeInvisibleAnnotations` 里。只读 `RuntimeVisibleAnnotations` 会得到"所有 mod 都没注入"。
6. **现代工具链大量省略 refmap。** 早期有条"声明了 refmap 但文件不存在"的检查，实测全是误报，**已删除**。
7. **`mods.toml` 里会出现 `${file.jarVersion}`**，要用 MANIFEST 的 `Implementation-Version` 替换。
8. **少数 jar 的 `fabric.mod.json` 含裸控制字符**，严格 JSON 解析会炸，有容错分支。
9. **一个 jar 可以同时携带多套加载器签名。** 用"第一个匹配"的写法会把 `Towns-and-Towers-1.12-Fabric+Forge.jar` 这类通用包误判成单一身份。判定依据必须是签名集合。
10. **NeoForge ≤1.20.4 用的也是 `META-INF/mods.toml`**，光看文件名区分不出 Forge 与 NeoForge，故两者当同一 family。
11. **命名空间跟"它会被谁加载"走，不跟签名集合走。** 同一个通用包装在 Fabric 实例上用 Yarn 名 + refmap；按签名判会让这类 jar 被错误剔除（实测 FO 包重叠数从 76 掉到 66）。

## 版本号处理

- **Forge / NeoForge 同源**：Maven `VersionRange` + `ComparableVersion`。裸版本号（`versionRange = "1.21.11"`）表示**无约束、匹配一切**，不是精确匹配；空的 `versionRange` 在 Forge 上等于 `UNBOUNDED`，**对任何版本都返回 false**（已知缺陷，本工具不照抄）。
- **Fabric 自成一套**：`VersionPredicate`（`>=` `<` `~` `^` `x` `*`，空格=AND、数组=OR）+ 自有比较器，**没有限定词权重表**（纯字典序，故 `1.0-sp < 1.0`，与 Maven 相反）。
- **依赖比较前必须按 modId 分派已安装版本**：`minecraft` → MC 版本、`forge`/`neoforge` → loader 版本、`[modLoader] loaderVersion` → 语言提供器版本（如 `46.0`），三套不可混用。
- **Fabric 的 MC 版本会被归一化**（`26w14a` → `26.1.1-alpha.26.14.a`），归一化表是 77 分支硬编码，本工具只还原少数几条，因此 Fabric 模组的版本判定应视为「未校验」。

## 文件

- `analyzer.js` —— 核心，零依赖，浏览器与 Node 通用。接口：`collect()`（流式）/ `summarize()` / `analyze()`
- `version.js` —— 统一的版本表示与比较（`parse` / `cmp` / `parseConstraint` / `satisfies`）
- `index.html` + `app.css` + `app.js` —— 前端，`file://` 直接打开，无构建步骤
- `worker.js` —— 把 `analyzer.js` 的整套分析放进 Web Worker，主线程只负责绘制
