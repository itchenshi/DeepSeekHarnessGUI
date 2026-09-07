# DSH GUI

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![license](https://img.shields.io/github/license/itchenshi/DeepSeekHarnessGUI)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/releases)
[![stars](https://img.shields.io/github/stars/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/stargazers)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![GitHub](https://img.shields.io/badge/GitHub-host-blue)](https://github.com/itchenshi/DeepSeekHarnessGUI)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/DeepSeekHarnessGUI)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-green)](https://gitcode.com/itchenshi/DeepSeekHarnessGUI)

DSH GUI 是 [DeepSeek Harness](https://www.deepseek.com/harness/)（开源 Agent 框架，
`@deepseek-ai/dsh`）的非官方桌面外壳。它把 Harness 的 Web UI 装进原生窗口中，
开箱即用、常驻托盘、自动更新，而你依然拥有完整的 Harness 能力。

```
┌────────────────────────────────────────────┐
│  DSH GUI (Electron App Shell)             │
│  ├─ 内嵌窗口 (嵌入 dsh web 的 Harness UI)   │
│  ├─ 系统托盘 (打开窗口 / 设置 / 退出)        │
│  ├─ 更新引擎 (启动/周期检查 + 三档策略)      │
│  └─ 数据目录 (默认 ~/.dsh，可切换并迁移)     │
└────────────────────────────────────────────┘
```

## 🔗 多平台仓库

| 平台 | 地址 | 克隆 |
|---|---|---|
| GitHub（主仓库） | https://github.com/itchenshi/DeepSeekHarnessGUI | `git clone https://github.com/itchenshi/DeepSeekHarnessGUI.git` |
| Gitee（镜像） | https://gitee.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitee.com/itchenshi/DeepSeekHarnessGUI.git` |
| GitCode（镜像） | https://gitcode.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitcode.com/itchenshi/DeepSeekHarnessGUI.git` |

三平台代码同步更新；安装包以 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 为准。

## ✨ 特性

- **不依赖外部浏览器**：壳进程启动 `dsh web --no-open --port 0`，解析 stdout 中的
  带认证 loopback URL，加载到内嵌 Electron 窗口。
- **每次都用最新版 Harness**：启动时与运行中按间隔（默认 1 小时）检查 npm registry
  的 `latest`，发现新版按策略处理：**询问后再更新（默认）/ 静默更新 / 仅提示**；
  更新安装到应用私有目录，完成后右下角弹出**持久角标**。
- **每次启动都是新的**：内嵌窗口使用内存会话（cookies/登录态不落盘），每次启动
  全新 spawn dsh 子进程，退出时连进程树一起清理。
- **数据目录可控**：默认跟随系统 `~/.dsh`，可切换为应用目录（`<userData>/dsh-home`）；
  切换时自动检测源目录数据并询问是否**移动**（停引擎 → 迁移 → 按新目录重启）。
- **外观跟随 Harness**：启动时读取 `$DSH_HOME/settings.yaml` 的
  `ui-theme.preference`（light / dark / system），按它设置窗口与各页面主题。
- **主窗口启动即最大化**，隐藏时无普通尺寸闪烁。
- **系统托盘**：右键菜单「打开窗口 / 设置 / 退出」；关闭窗口默认**隐藏到托盘**，
  也可设“直接退出”（退出时托盘一并移除）。
- **模态设置窗口**：设置窗打开期间主窗口不可操作、不可关闭。
- **跨平台**：Windows / macOS / Linux；应用图标取自 Harness 官网 favicon
  （品牌蓝 `#4D6BFE`），随包提供各尺寸。
- **零额外配置的运行时**：免安装、免系统 Node 也可运行——打包时捆绑便携 Node
  （≥ v23，引擎 zstd 依赖）。

## 📸 截图（待补充）

> 替换下方占位：主窗口 / 设置窗口 / 托盘菜单 / 首次启动状态页。

```
主窗口截图  设置窗口截图
托盘菜单截图  首次启动状态页截图
```

## 🚀 快速开始

前置（**仅开发/源码运行需要**）：已安装 [Node.js](https://nodejs.org/) **≥ 23**
（DeepSeek Harness 引擎依赖 Node 23+ 的 zstd API；含 npm）。
打包产物自带便携 Node，终端用户无需安装任何运行时。

```sh
npm install        # 安装 electron / 构建依赖
npm start          # 启动 DSH GUI
```

首次启动会自动联网安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度）；
之后只有 Harness 发布新版本时才需要再次安装。

## ⚙️ 更新设置（默认值）

| 设置项 | 默认 | 说明 |
|---|---|---|
| 更新策略 | **询问后再更新** | 静默更新 / 询问后再更新 / 仅提示不自动更新 |
| 检查更新 | 开 | 关闭后不查询 registry，直接用本地引擎（首次无引擎仍做一次性安装） |
| 检查间隔 | **1 小时** | 启动时距上次检查不足间隔则跳过；运行期间按间隔周期检查 |
| 数据目录 | **跟随系统 ~/.dsh** | 切换时若源目录有数据会询问是否移动 |
| 关闭窗口 | **隐藏到托盘** | 另一选项为“直接退出”（关窗即退出，移除托盘） |

设置持久化于 `<userData>/settings.json`，修改即保存；也可从菜单
`设置 → 打开设置窗口…`（模态）或托盘「设置」进入。

## 📦 架构与数据

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

DeepSeek Harness 的全部用户数据都在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 模型 / 系统 / 插件设置 | `<DSH_HOME>/settings.yaml`（含 `ui-theme.preference`） |
| 会话历史 | `<DSH_HOME>/sessions/<编码项目路径>/<会话id>/session.jsonl.zstd` |
| 工作区记录 | `<DSH_HOME>/storages/`（工作区业务文件仍在真实目录） |
| profile 配置与覆盖层 | `<DSH_HOME>/profiles/web/...` |
| 凭证 / 附件 / 匿名 ID | `<DSH_HOME>/credentials…` 等 |

## 🔧 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_SHELL_NODE` | 指定运行引擎的 node 可执行文件（默认优先捆绑 Node） |
| `DSH_SHELL_HOME` | 覆盖本次启动的 `DSH_HOME`（测试隔离用） |
| `DSH_SHELL_USERDATA` | 重定向整个 userData（引擎/设置/npm 缓存） |
| `DSH_SHELL_REGISTRY_URL` | 版本检查源（如 `https://registry.npmmirror.com/@deepseek-ai/dsh/latest`） |
| `DSH_SHELL_AUTOQUIT_MS` | UI 加载成功后 N 毫秒优雅退出（CI / 冒烟测试） |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | 测试钩子 |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | 打包时捆绑的 Node 版本与下载镜像 |
| `DSH_NODE_ARCH` / `DSH_NODE_PLATFORM` | 覆盖捆绑 Node 的目标平台/架构（如 CI 在 Apple Silicon 上交叉打包 x64 macOS 应用时设 `DSH_NODE_ARCH=x64`） |

## 🛠 打包

```sh
npm run make-icons    # 渲染各尺寸图标（build/、src/）
npm run bundle:node   # 下载当前平台便携 Node 到 resources/node
npm run dist          # 合并构建 win + linux（注意平台限制，见下）
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS 安装包
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg（需 macOS）
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

- **程序目录命名**：electron-builder 的 `*-unpacked` 目录由
  `scripts/fix-unpacked.mjs` 改名为 `DSH-GUI-WIN` / `DSH-GUI-MAC` / `DSH-GUI-LINUX`，
  并同步生成同名 **`.zip`**（解压即程序目录）。
- **捆绑 Node**：由 `scripts/bundle-node.mjs` 按平台下载（默认 v26；引擎的会话
  持久化需要 Node ≥ 23 的 zstd API），`scripts/after-pack.js` 在封包前完整拷入
  应用（不能用 `extraResources`——它会丢弃 `node_modules`，导致捆绑 Node 缺 npm）。
  npm 安装引擎时若捆绑 Node 无 npm，会自动回退到宿主 Node 的 npm-cli。
- **平台限制**：AppImage 的 `mksquashfs` 仅 Linux/macOS 可执行，所以在 Windows 上
  运行 `npm run dist` 时 linux 步骤会报 `ENOENT`；请在对应平台或 CI/Docker
  （如 `electronuserland/builder`）中构建各平台产物。

## 🗂 目录结构

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

## 🧪 测试

```sh
npm start                                   # 运行应用
# Windows 端到端（真实 WM_CLOSE 验证关闭/托盘/模态行为）：
powershell -File scripts/smoke-close.ps1 -Mode quit   # “直接退出”模式
powershell -File scripts/smoke-close.ps1 -Mode tray   # “隐藏到托盘”模式
powershell -File scripts/smoke-modal.ps1              # 模态设置窗
```

## ❓ 常见问题

- **首次启动较慢 / 状态页显示“正在下载并安装…”**：正在自动安装 DeepSeek Harness
  引擎，仅首次发生。
- **`npm run dist` 在 Windows 上报 `mksquashfs ENOENT`**：AppImage 只能在
  Linux/macOS（或 Docker/CI）构建，见「打包 → 平台限制」。
- **数据目录切换后看不到原来的会话**：切换时若源目录有数据会询问是否移动；
  选“仅切换”时数据保留在原位置。
- **想让配置/会话完全随应用目录走**：在设置中把数据目录切到“应用目录”，
  并确认迁移完成；备份/迁移/删除整包即可。
- **与官方 CLI 的关系**：本壳只是启动器/外壳，运行的仍是官方
  `@deepseek-ai/dsh`；任何 Harness 能力问题请参考 [DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

## 🏷 推荐 Topics（仓库元数据，已同步勾选于 GitHub「Settings → Topics」）

`deepseek` · `deepseek-harness` · `electron` · `ai-agent` · `agent-framework` · `desktop-app` · `cross-platform` · `automation`

## 📄 许可

[MIT](LICENSE) · 本项目为独立开源外壳，与 DeepSeek Harness 官方项目无隶属关系；
DeepSeek Harness 本身为 [MIT](https://github.com/deepseek-ai/deepseek-harness) 许可。