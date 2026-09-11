# DSH GUI v0.3.0：插件的「安装」和「启用」拆开了，用量插件连 DeepSeek 余额一起看

> 掘金 · 完整文章（复制即发）
> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI / https://gitcode.com/itchenshi/DeepSeekHarnessGUI
> 开源许可：MIT · 非官方独立项目 · 与 DeepSeek Harness 官方无隶属关系
> 版本：v0.3.0 · 2026-09-11

![DSH GUI 主窗口](主窗口.png)

## v0.2.0 之后，问题出在哪

先说清楚这个壳是什么：DSH GUI 是 DeepSeek Harness（开源 Agent 框架 `@deepseek-ai/dsh`）的**非官方 Electron 桌面壳**。它启动时 `spawn` 引擎的 `dsh web --no-open --port 0`，从 stdout 里解析出那个带认证 token 的 loopback URL，再加载进内嵌窗口——**官方引擎一行没改**，壳只负责「怎么跑得舒服」。

v0.2.0 把多语言、主题同步、插件目录补齐了。v0.3.0 这版则集中在四件事上：图标在 Windows 上终于到处都能显示、打包不再每轮重新下载 Node / Electron、插件的两个状态被拆开、用量插件从「只看 OpenCode Go」变成「看模型用量与余量」。

## 一、模型用量与余量：一次请求，两段互不拖累

`dsh-opencode-go-usage` 正式更名为 **`dsh-model-usage`（模型用量与余量）**，因为它不再只管一家。宿主侧通过引擎的凭证接缝 `ctx.credentials` 解析密钥，并在**同源**路由 `/model-usage` 上一次返回两段：

- `opencode-go`：套餐用量百分比（滚动 / 周 / 月 + 重置时间），取 `OPENCODE_GO_API_KEY` 调 `GET https://opencode.ai/zen/go/v1/usage`；
- `deepseek`：账户余额（总 / 赠送 / 充值），取 `DEEPSEEK_API_KEY` 调 `GET https://api.deepseek.com/user/balance`。

关键在于**每段各自报告自己的 `ok` / `reason`**，而不是整块成功或整块失败：

```json
{
  "sections": {
    "opencode-go": { "ok": true,  "usedPercent": 12.5, "reason": null },
    "deepseek":    { "ok": false, "reason": "no-key", "balance": null }
  }
}
```

只配了其中一个密钥时，另一半退化成诊断文案（`no-key` / `unauthorized`…），能用的那半照常显示。两段各自 60s 缓存、失败后 30s 内不重试。provider→段 的映射由宿主下发（`opencodeGo.providers` / `deepseek.providers` 均可配），页内不再硬编码；默认 DeepSeek 路由取引擎 `dsh-llm-deepseek` **实际注册**的 `deepseek-official`。**两条上游请求都在宿主侧完成，密钥绝不下发浏览器。**

顺带一个升级细节：目录条目改名后，profile 里会残留旧包名的 bundle 登记与 `dependencies`，而引擎自己的 reconcile 会把「依赖里能解析、且声明了 `dsh.bundle`」的包**重新登记回 bundles**——最初的迁移只摘了 bundles，结果旧包被引擎装回来，两个页内控件同时加载、用量显示两遍。现在改为 bundles 和 dependencies 一起摘、摘完再查一遍，并把「原本装着 → 新版同样装上」「原本禁用 → 新版同样禁用」的选择一起搬过去。

![DSH 侧边栏](DSH侧边栏.png)

## 二、插件的「安装」与「启用」是两个正交状态

这是 v0.3.0 改动最大的一块。以前设置窗口只有一个勾选框，勾=装；现在拆成两个，各管一件事，而且**都与 Harness 页面的插件市场实时互相同步**：

- **「安装」勾选框**＝安装/卸载状态镜像。装了即勾、没装即不勾，勾选立即安装、取消立即卸载（走市场同一套 `dsh plugin` 机制：从 profile 摘掉、保留本地文件）。
- **「启用」开关**＝加载/禁用状态镜像。关掉**不卸载**，只是让引擎不加载它；文件与登记都保留，开启即恢复加载。

「启用」不是自己写文件实现的，而是**直接调用插件市场自己的接口**：`POST <引擎>/dsh-market/toggle`，请求体 `{ "name": "<插件名>", "enabled": true|false }`，并**显式带上 `Origin` 头**过市场的同源校验。

走同一条路径的好处是**语义完全一致**：在线生效时机、保护规则、`restart` / `refresh` 信号都与市场页面上的那个开关相同。具体表现：

- 引擎侧**立即生效**（市场用 loader 句柄在线切换，不需要重启）；
- 带**客户端半体**的插件（比如模型用量与余量）禁用后，页面里已经加载的那半不会自己消失——市场正是为此返回 `refresh: true`。设置窗口做了等价处理：切换成功后出现「**刷新页面**」按钮，点一下页面就与引擎实际组合对齐；
- 市场拒绝的情况（宿主基础设施禁止开关、市场自身不可关、插件未安装）**原样上报原因，不回退写文件**——那等于绕过它的保护；
- 市场不可用时（未安装 / 引擎没跑 / 老版本没这条路由）才退回直接写 profile 用户补丁层 `cordis.patch.yml` 的 `- id: <rowId>` + `disabled: true|false`，并同步市场 `.dsh-market/state.json`。在 `patchReload: live` 的 web profile 上这条路同样由引擎在线重组合，实测约 0.7s 生效，只是缺 `restart` / `refresh` 信号。

另外两个配套修复合起来看才完整：

- **「市场里禁用了，引擎其实还在加载」的根因是 UTF-8 BOM**。profile 的 `cordis.patch.yml` 带 BOM，而 Node 的 `readFileSync(..., 'utf8')` 不像 .NET / PowerShell 那样剥掉它——首行成了 `\uFEFF# 注释`，注释正则匹配不到，市场 `patch.js` 的 append 保护既认不出空的 `[]` 占位、又把末行判成流式结构，于是**拒绝写入禁用行**。现象就是：`state.json` 记了 disabled、补丁层永远为空、引擎照常加载、设置窗口也无从显示。现在读写补丁层一律先剥 BOM、写回不带 BOM（顺带把文件修好，市场自己的开关之后也能正常写入）。
- **状态不一致自动对账**：市场已禁用但补丁层还没落下时（此时引擎其实仍会加载它），启动维护与「修复 / 重试」会补写成真正的禁用行，设置窗口同时显示一行说明原因；对账尊重补丁层已有的 `disabled: false`。「立即同步」也更名为「修复 / 重试」，以当前已安装集合为目标，只增不删，绝不卸载用户手动装的东西。

安装/卸载是真实耗时的（pnpm + 引擎子进程），所以进行中会显示**进度条 + 阶段文案**并整体锁定所有勾选框与按钮——既消灭「点了没反应」的观感，也避免两个操作并发改同一个 profile 造成锁冲突。插件目录保持四项、展示顺序固定：**插件市场 dsh-market、最近会话恢复 dsh-gui-last-session、模型用量与余量 dsh-model-usage、OpenCode 会话头 dsh-opencode-go-session**（加固版）。

![设置窗口：第三方插件](设置.png)

## 三、Windows 图标：一个 `.ico` 里的三种格式约束

图标这事看着小，踩的坑很典型。electron-builder 此前从 PNG 转出的 ICO 全是 **PNG 压缩帧**（Vista+ 格式），而老解析器只认未压缩 BMP：Maye 这类 .NET Framework 快速启动工具调用 `ExtractAssociatedIcon`，读出来是一片空白。现在 `scripts/make-icons.mjs` 直接把官网 favicon 渲染成 `build/icon.ico`，帧格式按尺寸分工：

- **16 / 24 / 32 / 48 / 64 / 128 用未压缩 BMP 帧**——旧解析器只认这种；
- **256 用 PNG 帧**——BMP 在 256 尺寸上不可靠，Windows「更改图标」对话框会直接拒绝整个文件、报「文件不包含图标」；
- **BMP 帧的 AND 掩码必须用紧凑 1bpp 长度**——若按 `w*h`（32bpp 行距）生成，electron-builder 嵌入 exe 时会把它截断成 1bpp，DIB 头声明的 `biSizeImage` 与实际载荷长度就对不上，严格解析器照样拒收。源码 `.ico` 直接写 1bpp 掩码，保证「DIB 头 / 载荷 / 组条目」三者自洽。

已在真实 exe 上验证：`PrivateExtractIcons` 的 16/24/32/48/64/128/256 全尺寸可用、`ExtractIconEx` 1 组、`SHGetFileInfo` 正常、`ExtractAssociatedIcon` 显示白底 + 品牌蓝。仓库里也留了两个自查工具：`node scripts/ico-info.cjs build/icon.ico` 检查任意 .ico 的帧构成与长度自洽性，`scripts/exe-icon-info.cjs` 检查 exe 内嵌的 `RT_ICON` / `RT_GROUP_ICON` 有无悬空条目。

> 改完图标记得重装或重建快捷方式：Windows 资源管理器与 Maye 会缓存旧图标；仍显示旧的，重启资源管理器或删掉 `%LocalAppData%\IconCache.db` 即可。

## 四、打包提速：重复打包 0 下载，断网也能构建

这部分是给贡献者的。以前每轮 `dist:win` 都要重新拉 Node 发行包和 `electron-vXX.zip`，慢且依赖网络。

- **便携 Node 归档缓存**：`resources/.node-cache/` 存放压缩包并配 **SHA-256 sidecar** 自校验（损坏自动作废重下）。若 `resources/node` 已就位且 `version.txt` 的版本/平台与目标一致，`scripts/bundle-node.mjs` 直接什么都不做——重复打包 0 下载 0 解压；即使删掉 `resources/node` 也能从缓存复用。需要强制重来时用 `--force` 或 `DSH_NODE_REFRESH=1`。
- **Electron 发行 zip 本地缓存**：新增 `scripts/ensure-electron.mjs`，首次从镜像（默认 npmmirror，`DSH_ELECTRON_MIRROR` 可换）下载，并**用官方 `SHASUMS256.txt` 校验**后落盘 `resources/.electron-cache/dist.zip`（`.info` 记录版本/平台/SHA-256，命中即跳过）。`npm run dist:win` 通过 `--config.electronDist` 把这个 zip 直接喂给 electron-builder，彻底绕开 `@electron/get`——不再有每轮的 `Downloading electron-vXX.zip`，不再拉 `SHASUMS256.txt`，断网也能重复打包。

两个缓存目录都已进 `.gitignore`。

![Harness 设置页](DSH设置.png)

## 五、稳定性与设置窗口精简

顺手修掉的几类「坏安装挡启动」：

- **profile bundle 自愈**：引擎 spawn 前逐条对账 `dsh.profile.bundles`——可解析且声明了 `dsh.bundle` 的保留（含引擎自带的 `dsh-base` / `dsh-web-app`，从安装锚点解析、永不被误动）；不可解析但依赖声明还在的先按引擎报错里的处方跑 `dsh plugin install` 补装，仍失败才修剪；完全无依赖声明的 stale 登记（如 `dshmarket`）直接修剪。写回用「临时文件 + rename」原子写，失败只记日志、绝不抛错。实测在引擎 `0.1.5-rc.1` 上，`cannot resolve profile bundle "dshmarket"` 导致启动失败——修剪后正常启动。
- 这类 stale 登记引擎自己的 reconcile 清不掉，`dsh plugin remove` 又会因依赖已不在而报 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`，只能由 GUI 在 spawn 前修剪。
- **引擎安装改为「临时前缀 + 原子替换」**：装进 `<ENGINE_DIR>.stage`，成功后整体换入（旧树先挪走、失败自动还原），避免增量安装留下过期 hoist 残留、新依赖沉进 nested `node_modules` 后引擎在根解析不到 client-ui 包。启动时还会做一次树结构自检，发现混合残留就按当前版本走一次干净重装（24h 冷却防误判）。

设置窗口本身也做了减法：移除「启动后自动回到最近对话」勾选项（功能仍默认生效，由 `dsh-gui-last-session` 插件实现）、移除「语言」「外观」两栏——语言和主题统一在 **Harness 页面（引擎设置）** 里改，DSH GUI 外壳保持「跟随引擎」（`appearance: engine` + `locale: system`，watch `settings.yaml` 热跟随），页面里改、外壳自动同步、无需重启。布局变成左列三行（关闭窗口 / 数据目录 / 引擎更新）、右列纵贯三行的第三方插件。`settings.json` 里的 `autoPlugins` 字段随之废弃。

## 快速开始

源码运行（需 Node ≥ 23，Harness 引擎依赖 Node 23+ 的 zstd API）：

```sh
npm install
npm start
```

首次启动会联网自动安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度），之后只有引擎发布新版本时才需要再装。

普通用户直接用打包产物即可：**安装包与便携包自带便携 Node v26，无需安装任何运行时**。Windows（NSIS 安装包 + 便携 zip + 解压即用的 `DSH-GUI-WIN.zip`）、macOS（Intel / Apple Silicon）、Linux（AppImage + zip），下载见 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases)（三平台仓库互为镜像，安装包以 GitHub 为准）。升级直接覆盖安装，数据目录与会话记录不受影响；若桌面图标还是旧的，重启一次资源管理器刷新缓存。

![设置窗口（English）](设置-english.png)

## 写在最后

v0.3.0 里最值得一说的地方其实不是新功能，而是「安装」与「启用」这件事的拆解方式：**不自己发明一套状态，而是复用插件市场自己的开关接口**，让在线生效时机、保护规则、`refresh` 信号天然一致，只在市场不可用时才退化到写 profile 补丁层。这样用户在任何一侧操作，另一侧看到的都是引擎的真实状态，而不是壳的一厢情愿。

取舍还是那一条：**壳只做官方引擎没空做的「体验活」，内核永远 100% 官方**。

你在 Harness 里装过哪些插件？希望「模型用量与余量」再支持哪家的用量或余额？评论区聊聊。

**建议标签**：`#DeepSeek` `#Electron` `#开源` `#AI编程` `#桌面应用`
