# 【开源】DSH GUI：DeepSeek Harness 桌面壳完整指南（内嵌 Web UI / 自动更新引擎 / 跨平台打包）

> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI
> 开源许可：MIT（独立开源项目，与 DeepSeek Harness 官方项目无隶属关系）

## 目录

- [一、项目简介](#一项目简介)
- [二、核心特性](#二核心特性)
- [三、技术架构与启动流程](#三技术架构与启动流程)
- [四、快速开始](#四快速开始)
- [五、设置项说明](#五设置项说明)
- [六、环境变量](#六环境变量)
- [七、数据目录](#七数据目录)
- [八、打包发布](#八打包发布)
- [九、目录结构](#九目录结构)
- [十、常见问题](#十常见问题)
- [十一、许可与声明](#十一许可与声明)
- [总结](#总结)

## 一、项目简介

**DSH GUI** 是 [DeepSeek Harness](https://www.deepseek.com/harness/)（DeepSeek 开源 Agent 框架，npm 包 `@deepseek-ai/dsh`，技术预览阶段）的非官方桌面外壳。它把 Harness 的 Web UI 装进原生桌面窗口中，开箱即用、常驻系统托盘、自动保持引擎最新，同时保留完整的官方 Harness 能力。

一句话概括：**内核 100% 官方，外壳负责「运行体验」。**

```
┌────────────────────────────────────────────┐
│  DSH GUI (Electron App Shell)             │
│  ├─ 内嵌窗口 (嵌入 dsh web 的 Harness UI)   │
│  ├─ 系统托盘 (打开窗口 / 设置 / 退出)        │
│  ├─ 更新引擎 (启动/周期检查 + 三档策略)      │
│  └─ 数据目录 (默认 ~/.dsh，可切换并迁移)     │
└────────────────────────────────────────────┘
```

## 二、核心特性

### 1. 不依赖外部浏览器

壳进程启动 `dsh web --no-open --port 0`，解析 stdout 中带认证的 loopback URL，加载到内嵌 Electron 窗口。不占用浏览器标签页，认证信息不落地。

### 2. 每次都用最新版 Harness

启动时 + 运行期间（默认间隔 1 小时）检查 npm registry 的 `latest` 版本，发现新版按策略处理：

| 策略 | 说明 |
|---|---|
| **询问后再更新（默认）** | 发现新版后询问用户，确认后安装 |
| 静默更新 | 自动安装，不打扰 |
| 仅提示 | 只提示有新版本，不自动更新 |

更新安装到应用私有目录，完成后右下角弹出**持久角标**提醒。

### 3. 每次启动都是全新的

内嵌窗口使用**内存会话**（cookies / 登录态不落盘），每次启动全新 spawn dsh 子进程，退出时连进程树一起清理。隐私与整洁兼得。

### 4. 数据目录可控

默认跟随系统 `~/.dsh`，可切换为应用目录（`<userData>/dsh-home`）。切换时自动检测源目录数据，询问是否**移动**（停引擎 → 迁移 → 按新目录重启）。

### 5. 外观跟随 Harness

启动时读取 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`（light / dark / system），窗口与各页面主题自动对齐。

### 6. 系统托盘与窗口行为

- 主窗口启动即最大化，隐藏时无尺寸闪烁；
- 托盘右键菜单：「打开窗口 / 设置 / 退出」；
- 关闭窗口默认**隐藏到托盘**，可设置「直接退出」（退出时托盘一并移除）；
- 设置窗口为**模态**：打开期间主窗口不可操作、不可关闭。

### 7. 零配置运行时

打包时捆绑便携 Node（≥ v23，引擎会话持久化依赖 Node 23+ 的 zstd API）。**终端用户免安装 Node、免 npm**，解压即用。

## 三、技术架构与启动流程

技术栈：**Electron + 原生 JavaScript（main 进程 / preload / 页面）**，打包使用 electron-builder，图标源取自 Harness 官网 favicon（品牌蓝 `#4D6BFE`）。

```
启动
 └─ 单实例锁 → 读 settings.json → 读 Harness 外观(ui-theme.preference)
     → 建窗口(最大化,内存会话)
         └─ boot()
             ├─ 解析 Node：捆绑便携版 → $DSH_SHELL_NODE → 系统 PATH
             ├─ 需要时检查更新(npm registry) → 按策略安装/提示
             ├─ spawn node <engine>/lib/bin.js web --no-open --port 0
             ├─ 解析 stdout 的 `dsh web: <url>` → 内嵌加载
             └─ 退出：kill 进程树 + 销毁托盘
```

## 四、快速开始

### 方式 A：源码运行（开发 / contributor）

前置要求：Node.js **≥ 23**（含 npm）。

```sh
npm install        # 安装 electron / 构建依赖
npm start          # 启动 DSH GUI
```

首次启动会自动联网安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度）；之后只有 Harness 发布新版本时才需要再次安装。

### 方式 B：使用打包产物（终端用户）

在 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 或本地 `dist/` 目录获取对应平台产物：

| 平台 | 产物 |
|---|---|
| Windows | `DSH-GUI-WIN/` 目录 + `.zip` + NSIS 安装包 |
| macOS | `DSH-GUI-MAC/` 目录 + `.zip` + `.dmg` |
| Linux | `DSH-GUI-LINUX/` 目录 + `.zip` + `.AppImage` |

解压即用，无需安装任何运行时。

## 五、设置项说明

设置持久化于 `<userData>/settings.json`，修改即保存；可通过菜单 `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。

| 设置项 | 默认 | 说明 |
|---|---|---|
| 更新策略 | **询问后再更新** | 静默更新 / 询问后再更新 / 仅提示不自动更新 |
| 检查更新 | 开 | 关闭后不查询 registry，直接用本地引擎（首次无引擎仍做一次性安装） |
| 检查间隔 | **1 小时** | 启动时距上次检查不足间隔则跳过；运行期间按间隔周期检查 |
| 数据目录 | **跟随系统 ~/.dsh** | 切换时若源目录有数据会询问是否移动 |
| 关闭窗口 | **隐藏到托盘** | 另一选项为「直接退出」（关窗即退出，移除托盘） |

## 六、环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_SHELL_NODE` | 指定运行引擎的 node 可执行文件（默认优先捆绑 Node） |
| `DSH_SHELL_HOME` | 覆盖本次启动的 `DSH_HOME`（测试隔离用） |
| `DSH_SHELL_USERDATA` | 重定向整个 userData（引擎/设置/npm 缓存） |
| `DSH_SHELL_REGISTRY_URL` | 版本检查源（如 `https://registry.npmmirror.com/@deepseek-ai/dsh/latest`） |
| `DSH_SHELL_AUTOQUIT_MS` | UI 加载成功后 N 毫秒优雅退出（CI / 冒烟测试） |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | 测试钩子 |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | 打包时捆绑的 Node 版本与下载镜像 |

## 七、数据目录

DeepSeek Harness 的全部用户数据都在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 模型 / 系统 / 插件设置 | `<DSH_HOME>/settings.yaml`（含 `ui-theme.preference`） |
| 会话历史 | `<DSH_HOME>/sessions/<编码项目路径>/<会话id>/session.jsonl.zstd` |
| 工作区记录 | `<DSH_HOME>/storages/`（工作区业务文件仍在真实目录） |
| profile 配置与覆盖层 | `<DSH_HOME>/profiles/web/...` |
| 凭证 / 附件 / 匿名 ID | `<DSH_HOME>/credentials…` 等 |

## 八、打包发布

```sh
npm run make-icons    # 渲染各尺寸图标（build/、src/）
npm run bundle:node   # 下载当前平台便携 Node 到 resources/node
npm run dist          # 合并构建 win + linux（注意平台限制，见下）
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS 安装包
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg（需 macOS）
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

注意事项：

- 程序目录命名：electron-builder 的 `*-unpacked` 目录由 `scripts/fix-unpacked.mjs` 改名为 `DSH-GUI-WIN` / `DSH-GUI-MAC` / `DSH-GUI-LINUX`，并同步生成同名 `.zip`（解压即程序目录）；
- 捆绑 Node：由 `scripts/bundle-node.mjs` 按平台下载（默认 v26；引擎会话持久化需要 Node ≥ 23 的 zstd API）。`scripts/after-pack.js` 在封包前完整拷入应用（不能用 `extraResources`——它会丢弃 `node_modules`，导致捆绑 Node 缺 npm）；
- **平台限制**：AppImage 的 `mksquashfs` 仅 Linux/macOS 可执行，Windows 上运行 `npm run dist` 的 linux 步骤会报 `ENOENT`；请在对应平台或 CI/Docker（如 `electronuserland/builder`）中构建各平台产物。

## 九、目录结构

```
├─ src/                   # 应用源码（main 进程 / 页面 / 工具模块）
│  ├─ main.js             # 主进程：更新引擎、窗口、托盘、设置、数据迁移
│  ├─ preload.js          # 设置窗口 IPC 桥
│  ├─ settings.html       # 设置窗口（模态）
│  ├─ status.html         # 启动/更新状态页（跟随 Harness 主题）
│  ├─ notice.html         # 持久更新角标
│  └─ home-migrate.js     # 数据目录检测与迁移（纯 Node，可单测）
├─ scripts/               # 构建与测试脚本
│  ├─ make-icons.mjs      # 官网 favicon → 各尺寸图标
│  ├─ bundle-node.mjs     # 便携 Node 下载/解包
│  ├─ fix-unpacked.mjs    # 改名 + 生成 zip
│  ├─ after-pack.js       # electron-builder 钩子：完整拷贝捆绑 Node
│  └─ smoke-close.ps1、smoke-modal.ps1   # Windows E2E 冒烟
├─ resources/icons/       # 官网 favicon 源文件（svg/ico）
├─ electron-builder.yml   # 打包配置（win/mac/linux）
└─ dist/                  # 构建产物（已 gitignore）
```

## 十、常见问题

**Q1：首次启动很慢 / 状态页显示「正在下载并安装…」？**

A：正在自动安装 DeepSeek Harness 引擎，仅首次发生，约 1–2 分钟。

**Q2：`npm run dist` 在 Windows 上报 `mksquashfs ENOENT`？**

A：AppImage 只能在 Linux/macOS（或 Docker/CI）构建，见「打包 → 平台限制」。

**Q3：数据目录切换后看不到原来的会话？**

A：切换时若源目录有数据会询问是否移动；选「仅切换」时数据保留在原位置。

**Q4：想让配置/会话完全随应用目录走？**

A：在设置中把数据目录切到「应用目录」，并确认迁移完成；之后备份/迁移/删除整包即可。

**Q5：与官方 CLI 的关系？**

A：本壳只是启动器/外壳，运行的仍是官方 `@deepseek-ai/dsh`；任何 Harness 能力问题请参考 [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

## 十一、许可与声明

[MIT](LICENSE) · 本项目为独立开源外壳，与 DeepSeek Harness 官方项目无隶属关系；DeepSeek Harness 本身为 [MIT](https://github.com/deepseek-ai/deepseek-harness) 许可。

## 总结

DSH GUI 把 DeepSeek Harness 的「最后一公里」补齐了：开箱即用的桌面体验、自动保持引擎最新、可控的数据目录与干净的会话生命周期。无论你是想在 Windows / macOS / Linux 上无痛使用 Harness 的终端用户，还是对 Electron 外壳 + 子进程托管 + 自动更新机制感兴趣的开发者，都值得 clone 下来看一看。

如果本文对你有帮助，欢迎 **点赞 / 收藏 / 关注**，也欢迎去 GitHub 点个 Star 支持开源，有使用问题直接在 Issues 区反馈。