# 【开源】DSH GUI v0.2.0 发布：DeepSeek Harness 桌面壳迎来插件管理与多语言（附完整使用指南）

> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI / https://gitcode.com/itchenshi/DeepSeekHarnessGUI
> 开源许可：MIT（独立开源项目，与 DeepSeek Harness 官方项目无隶属关系）

## 目录

- [一、v0.2.0 更新速览](#一v020-更新速览)
- [二、项目简介](#二项目简介)
- [三、核心特性（v0.2.0）](#三核心特性v020)
- [四、快速开始](#四快速开始)
- [五、设置项说明](#五设置项说明)
- [六、第三方插件管理](#六第三方插件管理)
- [七、数据目录与隐私](#七数据目录与隐私)
- [八、打包与发布](#八打包与发布)
- [九、常见问题](#九常见问题)
- [总结](#总结)

## 一、v0.2.0 更新速览

| 新能力 | 说明 |
|---|---|
| **第三方插件管理** | 设置窗口内置插件目录，勾选即可自动安装/挂载（含 OpenCode 会话头加固插件） |
| **多语言** | 跟随系统 / 中文 / English，引擎侧 `locale.preference` 热发布，免重启切换 |
| **主题跟随** | 读取 Harness `ui-theme.preference`（light / dark / system）同步窗口与页面 |
| **启动失败自愈** | 插件导致引擎起不来时自动剔除 + 一键禁用重启 |
| **win 便携包** | NSIS 安装包之外新增便携 zip，解压即用 |

## 二、项目简介

**DSH GUI** 是 [DeepSeek Harness](https://www.deepseek.com/harness/)（DeepSeek 开源 Agent 框架，npm 包 `@deepseek-ai/dsh`）的非官方桌面外壳。它把 Harness 的 Web UI 装进原生桌面窗口：开箱即用、常驻系统托盘、自动保持引擎最新——同时因内核仍是官方 `dsh`，**保留了 100% 的 Harness 能力**。

一句话概括：**内核 100% 官方，外壳负责「运行体验」。**

## 三、核心特性（v0.2.0）

### 1. 不依赖外部浏览器

壳进程启动 `dsh web --no-open --port 0`，解析 stdout 中带认证的 loopback URL，加载到内嵌 Electron 窗口。不占用浏览器标签页，认证信息不落地。

### 2. 第三方插件管理（v0.2.0 新增）

设置窗口内置**经核实的社区插件目录**：

- 插件市场（dsh-market）
- 增强侧栏（dsh-better-sidebar）
- 智能体团队（dsh-agent-teams）
- **OpenCode 会话头（dsh-opencode-go-session，加固版）**

勾选后，每次启动自动用引擎 `dsh plugin` 安装并挂载到 Harness Web。其中内置的 OpenCode 会话头插件为发往 OpenCode / OpenCode Go 的请求注入稳定 `x-opencode-session` 头（修复 400 MissingSessionID），并做了安全加固：默认不透明 UUID、头值校验、debugFile 限位脱敏——不把内部会话 ID 外发给第三方。

**启动失败自愈**：若刚自动安装的插件导致 dsh 无法启动，GUI 会自动剔除该插件并取消勾选；疑似插件导致的启动失败会弹出诊断框，一键禁用并重启，不用手动翻日志。

### 3. 每次都用最新版 Harness

启动时 + 运行期间（固定 30 分钟间隔）检查 npm registry 版本表，发现新版按策略处理：

| 策略 | 说明 |
|---|---|
| **询问后再更新（默认）** | 发现新版后询问用户，确认后安装 |
| 静默更新 | 自动安装，不打扰 |
| 仅提示 | 只提示有新版本，不自动更新 |

更新安装到应用私有目录，完成后右下角弹出**持久角标**提醒。

### 4. 多语言（v0.2.0 新增）

设置窗口「语言」支持 **跟随系统（默认）/ 中文 / English**。选择会同时应用到 GUI（设置窗口/托盘菜单/对话框）与 Harness 页面，引擎侧经由 `settings.yaml` 的 `locale.preference` 热发布——**无需重启**。

### 5. 外观跟随 Harness（v0.2.0 增强）

启动时读取 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`（light / dark / system），窗口与各页面主题自动对齐。窗口标题显示 `DSH GUI v<版本>`，托盘提示同时给出 GUI 与引擎版本。

### 6. 每次启动都是全新的

内嵌窗口使用**内存会话**（cookies / 登录态不落盘），每次启动全新 spawn dsh 子进程，退出时连进程树一起清理。隐私与整洁兼得。

### 7. 数据目录可控

默认跟随系统 `~/.dsh`，可切换为应用目录（`<userData>/dsh-home`）。切换时自动检测源目录数据，询问是否**移动**（停引擎 → 迁移 → 按新目录重启）。会话历史、工作区记录均随数据目录迁移。

### 8. 系统托盘与窗口行为

- 主窗口启动即最大化，隐藏时无尺寸闪烁；
- 托盘右键菜单：「打开窗口 / 检查更新… / 设置 / 退出」；
- 关闭窗口默认**隐藏到托盘**，可设置「直接退出」；
- 设置窗口为**模态**：打开期间主窗口不可操作、不可关闭。

### 9. 零配置运行时

打包时捆绑便携 Node（默认 v26；引擎会话持久化依赖 Node ≥ 23 的 zstd API）。**终端用户免安装 Node、免 npm**，Windows / macOS / Linux 解压即用。

## 四、快速开始

### 方式 A：源码运行（开发 / contributor）

前置要求：Node.js **≥ 23**（含 npm）。

```sh
npm install        # 安装 electron / 构建依赖
npm start          # 启动 DSH GUI
```

首次启动会自动联网安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度）；之后只有 Harness 发布新版本时才需要再次安装。

### 方式 B：使用打包产物（终端用户）

在 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 获取对应平台产物：

| 平台 | 产物 |
|---|---|
| Windows | `DSH GUI Setup 0.2.0.exe`（NSIS 安装包）/ `DSH-GUI-WIN.zip`（解压即用） |
| macOS | `DSH GUI 0.2.0.dmg`（Intel）/ `DSH GUI 0.2.0-arm64.dmg`（Apple Silicon） |
| Linux | `DSH GUI 0.2.0.AppImage` / `DSH-GUI-LINUX.zip` |

解压即用，无需安装任何运行时。

## 五、设置项说明

设置持久化于 `<userData>/settings.json`，修改即保存；可通过菜单 `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。

| 分类 | 设置项 | 默认 | 说明 |
|---|---|---|---|
| 引擎更新 | 更新策略 | **询问后再更新** | 静默更新 / 询问后再更新 / 仅提示 |
| 引擎更新 | 版本通道 | **npm latest** | 另可选「跳过 alpha」「含全部预发布」 |
| 引擎更新 | 自动检查 | 开 | 关闭后直接用本地引擎 |
| 引擎更新 | 检查间隔 | **固定 30 分钟** | 不可调；可随时「立即检查引擎更新」 |
| 第三方插件 | 自动安装 | **关闭** | 勾选后每次启动自动安装挂载 |
| 数据与桌面 | 数据目录 | **跟随系统 ~/.dsh** | 切换时询问是否迁移 |
| 数据与桌面 | 关闭窗口 | **隐藏到托盘** | 另一选项「直接退出」 |
| 数据与桌面 | 自动回到最近对话 | 开 | 重启后自动切回上次会话 |
| 语言 | 语言 | **跟随系统** | 中文 / English / 跟随系统 |

## 六、第三方插件管理

- **入口**：设置窗口 → 第三方插件，勾选后每次启动自动安装。
- **安全说明**：第三方插件等于以你的权限运行第三方代码——默认全部关闭，勾选前请自行审阅源码。
- **卸载**：dsh-market 或 `dsh plugin remove` 手动处理，GUI 不做自动卸载。
- **内置加固插件**：`dsh-opencode-go-session` 随仓库分发（不依赖 npm 注册表），为 OpenCode/OpenCode Go 请求加稳定的会话头，修复 400 MissingSessionID 并保持提示缓存亲和；默认用不透明 UUID，杜绝内部会话 ID 泄露。

## 七、数据目录与隐私

DeepSeek Harness 的全部用户数据都在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 模型 / 系统 / 插件设置 | `<DSH_HOME>/settings.yaml`（含 `ui-theme.preference`） |
| 会话历史 | `<DSH_HOME>/sessions/<编码项目路径>/<会话id>/session.jsonl.zstd` |
| 工作区记录 | `<DSH_HOME>/storages/` |
| profile 配置与覆盖层 | `<DSH_HOME>/profiles/web/...` |
| 凭证 / 附件 / 匿名 ID | `<DSH_HOME>/credentials…` 等 |

每次启动使用内存会话（cookies/登录态不落盘），退出时清理整个进程树。

## 八、打包与发布

```sh
npm run dist:win      # Windows → NSIS 安装包 + 便携 zip + 目录 zip
npm run dist:mac      # macOS   → .dmg（需 macOS，含 x64/arm64 变体）
npm run dist:linux    # Linux   → .AppImage + 目录 zip
```

- 三平台产物由 GitHub Actions（`.github/workflows/build-all.yml`）在 tag 构建时自动生成并挂到 Release，构建前自动清理旧 dist，避免混入旧版本安装包；
- 捆绑便携 Node（默认 v26），`scripts/after-pack.js` 完整拷入（不能用 extraResources，会丢 node_modules）；
- Intel macOS 的 Node 通过 `DSH_NODE_ARCH=x64` 在 Apple Silicon runner 上交叉打包；
- AppImage 的 `mksquashfs` 仅 Linux/macOS 可执行，Windows 请用 CI 构建 Linux 包。

## 九、常见问题

**Q1：首次启动很慢 / 状态页显示「正在下载并安装…」？**

A：正在自动安装 DeepSeek Harness 引擎，仅首次发生，约 1–2 分钟。

**Q2：插件勾选后引擎起不来？**

A：v0.2.0 会自动剔除并取消勾选导致启动失败的插件；也可在设置里重新勾选前先手动 `dsh plugin remove` 清理。

**Q3：语言切换后部分界面没变？**

A：引擎侧经由 `settings.yaml` 的 `locale.preference` 热发布，稍等片刻即生效；仍未刷新则重启应用。

**Q4：`npm run dist` 在 Windows 上报 `mksquashfs ENOENT`？**

A：AppImage 只能在 Linux/macOS（或 CI/Docker）构建，Windows 用 `dist:win` 即可。

**Q5：与官方 CLI 的关系？**

A：本壳只是启动器/外壳，运行的仍是官方 `@deepseek-ai/dsh`；任何 Harness 能力问题请参考 [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

## 总结

v0.2.0 让 DSH GUI 从「一个能用的壳」走向「一套完整的桌面体验」：插件管理补齐了 Harness 的扩展能力入口，多语言与主题跟随让窗口真正「属于」你的 Harness，启动失败自愈则把运维负担降到接近零。无论你是想在 Windows / macOS / Linux 上无痛使用 Harness 的终端用户，还是对 Electron 外壳 + 子进程托管 + 插件对账感兴趣的开发者，都值得 clone 下来看一看。

如果本文对你有帮助，欢迎 **点赞 / 收藏 / 关注**，也欢迎去 [GitHub](https://github.com/itchenshi/DeepSeekHarnessGUI) / [Gitee 镜像](https://gitee.com/itchenshi/DeepSeekHarnessGUI) 点个 Star 支持开源，有使用问题直接在 Issues 区反馈。