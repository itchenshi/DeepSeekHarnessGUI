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
│  ├─ 系统托盘 (打开窗口 / GUI 更新 / 设置)    │
│  ├─ 引擎更新 (每 30 分钟 + 三档策略)        │
│  └─ 数据目录 (默认 ~/.dsh，可切换并迁移)     │
└────────────────────────────────────────────┘
```

## 🔗 多平台仓库

| 平台 | 地址 | 克隆 |
|---|---|---|
| GitHub（主仓库） | https://github.com/itchenshi/DeepSeekHarnessGUI | `git clone https://github.com/itchenshi/DeepSeekHarnessGUI.git` |
| Gitee（镜像） | https://gitee.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitee.com/itchenshi/DeepSeekHarnessGUI.git` |
| GitCode（镜像） | https://gitcode.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitcode.com/itchenshi/DeepSeekHarnessGUI.git` |

三平台仓库互为镜像；安装包以 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 为准。

---

## ✨ 功能总览（按分类）

### 🪟 桌面窗口与系统托盘

- **内嵌窗口**：壳进程启动 `dsh web --no-open --port 0`，解析 stdout 中的带认证
  loopback URL，加载到内嵌 Electron 窗口。不依赖外部浏览器。
- **主窗口启动即最大化**，隐藏时无普通尺寸闪烁。
- **系统托盘**：右键菜单「打开窗口 / 检查 DSH GUI 更新… / 设置 / 退出」；
  关闭窗口默认**隐藏到托盘**，也可设「直接退出」（退出时托盘一并移除）。
- **窗口标题显示应用版本**：标题为 `DSH GUI v<应用版本>`；托盘提示同时给出
  GUI 版本与引擎版本。

### ⚡ 引擎生命周期管理

- **每次都用最新版 Harness**：启动时与运行中按**固定间隔 30 分钟**检查 npm
  registry 的版本表（更新频率不可调），发现新版按策略处理：**询问后再更新
  （默认）/ 静默更新 / 仅提示**；更新安装到应用私有目录，完成后右下角弹出
  **持久角标**。
- **GUI 与引擎更新分家**：托盘「检查 DSH GUI 更新…」查 GitHub Releases，
  有新版本时打开下载页；引擎更新由 GUI 后台按设置策略自动处理。
- **GUI 托管的引擎重启**：dsh 由 DSH GUI 作为子进程托管，页面/插件内建的
  “重启”无法重启它。需要重启使插件（或引擎自身）生效时，用设置窗口「重启
  引擎使生效」、页面桥 `window.__dshGui.restartEngine()`，或直接重启 DSH GUI；
  引擎就绪后意外退出时 GUI 会自动重拉（连续 3 次仍失败则停止并提示）。
- **第三方插件引起的启动失败自动恢复**：刚自动安装的插件若导致 dsh 无法启动，
  会自动剔除并取消勾选；疑似插件导致的失败会弹出诊断对话框，可一键禁用并重启。

### 🔌 第三方插件管理

- **设置窗口「第三方插件」区**：勾选后，DSH GUI 每次启动会用引擎自带的
  `dsh plugin` 把这些社区插件安装并挂载到 Harness Web（npm 包需可访问网络）。
- **内置候选目录（经核实的社区插件）**：插件市场（dsh-market）、增强侧栏
  （dsh-better-sidebar）、智能体团队（dsh-agent-teams）、OpenCode 会话头
  （dsh-opencode-go-session，加固版）。
- **卸载**：请用 dsh-market 或 `dsh plugin remove` 手动处理，GUI 不做自动卸载。
- **安全提示（设置页原文）**：第三方插件等于以你的权限运行第三方代码——
  默认关闭，勾选前请自行审阅源码。

### 🔐 数据、凭证与隐私

- **数据目录可控**：默认跟随系统 `~/.dsh`，可切换为应用目录（`<userData>/dsh-home`）；
  切换时自动检测源目录数据并询问是否**移动**（停引擎 → 迁移 → 按新目录重启）。
- **每次启动都是新的**：内嵌窗口使用内存会话（cookies/登录态不落盘），每次
  启动全新 spawn dsh 子进程，退出时连进程树一起清理。
- **会话历史保留**：`<DSH_HOME>/sessions/` 下的会话数据、`storages/` 工作区
  记录均在用户数据目录内，随数据目录迁移。

### 🌐 多语言与外观

- **多语言界面**：设置窗口「语言」可选 跟随系统（默认）/ 中文 / English；
  跟随系统时按操作系统语言解析。
- **外观跟随 Harness**：启动时读取 `$DSH_HOME/settings.yaml` 的
  `ui-theme.preference`（light / dark / system），按它设置窗口与各页面主题。
- **语言双向同步**：设置会同时应用到 GUI（设置窗口/托盘菜单/对话框）与
  Harness 页面，引擎侧经由 `settings.yaml` 的 `locale.preference` 热发布切换，
  无需重启。

### 💬 会话体验

- **启动后自动回到最近一次对话**：记录最后使用的会话，重启 DeepSeek Harness
  后自动切回（可在 GUI 设置窗口关闭该行为）。

### 🎛 设置与持久化

- **模态设置窗口**：设置窗打开期间主窗口不可操作、不可关闭；可从菜单
  `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。
- **设置持久化**：`<userData>/settings.json`，修改即保存。

---

## ⚙️ 设置项（按功能分类）

### 引擎更新

| 设置项 | 默认 | 说明 |
|---|---|---|
| 引擎更新策略 | **询问后再更新** | 静默更新 / 询问后再更新 / 仅提示不自动更新 |
| 版本通道 | **npm latest** | 跟随 npm `latest` 标签；另有“跳过 alpha”“含全部预发布” |
| 自动检查 | 开 | 关闭后不查询 registry，直接用本地引擎（首次无引擎仍做一次性安装） |
| 检查间隔 | **固定 30 分钟** | 不可调整；可随时点「立即检查引擎更新」 |

### 第三方插件

| 设置项 | 默认 | 说明 |
|---|---|---|
| 第三方插件自动安装 | **关闭** | 每次启动用引擎 `dsh plugin` 安装并挂载到 web profile（需联网；卸载走 dsh-market / `dsh plugin remove`） |

### 数据与桌面

| 设置项 | 默认 | 说明 |
|---|---|---|
| 数据目录 | **跟随系统 ~/.dsh** | 切换时若源目录有数据会询问是否移动 |
| 关闭窗口 | **隐藏到托盘** | 另一选项为“直接退出”（关窗即退出，移除托盘） |
| 自动回到最近对话 | **开** | 重启后自动切回上次使用的会话 |

### 语言

| 设置项 | 默认 | 说明 |
|---|---|---|
| 语言 | **跟随系统** | 中文 / English / 跟随系统；同步应用到 GUI 与内嵌 Harness 页面 |

> 设置持久化于 `<userData>/settings.json`，修改即保存；GUI 设置窗口可从菜单
> `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。

---

## 🚀 快速开始

前置（**仅开发/源码运行需要**）：已安装 [Node.js](https://nodejs.org/) **≥ 23**
（DeepSeek Harness 引擎依赖 Node 23+ 的 zstd API；含 npm）。打包产物自带便携
Node，终端用户无需安装任何运行时。

```sh
npm install        # 安装 electron / 构建依赖
npm start          # 启动 DSH GUI
```

首次启动会自动联网安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度）；
之后只有 Harness 发布新版本时才需要再次安装。

---

## 📦 架构与数据

```
启动
 └─ 单实例锁 → 读 settings.json → 读 Harness 外观(ui-theme.preference)
     → 建窗口(最大化,内存会话)
         └─ boot()
             ├─ 解析 Node：捆绑便携版 → $DSH_SHELL_NODE → 系统 PATH
             ├─ 需要时检查更新(npm registry) → 按策略安装/提示
             ├─ 启动前：按设置自动安装已勾选的第三方插件（`dsh plugin`，幂等）
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

### 目录结构

```
├─ src/                   # 应用源码（main 进程 / 页面 / 工具模块）
│  ├─ main.js             # 主进程：更新引擎、窗口、托盘、设置、数据迁移
│  ├─ plugin-manager.js   # 第三方插件管理（catalog + dsh plugin 安装对账）
│  ├─ engine-patch.js     # 对引擎客户端的小补丁（幂等；“重启回最近会话”页内逻辑）
│  ├─ preload.js          # 设置窗口 IPC 桥
│  ├─ workspace-preload.js# 主窗口窄桥（记录/读取最近一次会话）
│  ├─ settings.html       # 设置窗口（模态）
│  ├─ status.html         # 启动/更新状态页（跟随 Harness 主题）
│  ├─ notice.html         # 持久更新角标
│  └─ home-migrate.js     # 数据目录检测与迁移（纯 Node，可单测）
├─ plugins/               # 仓库内置的本地插件（打包进 app.asar）
│  └─ dsh-opencode-go-session/   # OpenCode 会话头（加固版，本地 file 安装）
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

---

## 🔧 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_SHELL_NODE` | 指定运行引擎的 node 可执行文件（默认优先捆绑 Node） |
| `DSH_SHELL_HOME` | 覆盖本次启动的 `DSH_HOME`（测试隔离用） |
| `DSH_SHELL_USERDATA` | 重定向整个 userData（引擎/设置/npm 缓存） |
| `DSH_SHELL_REGISTRY_URL` | 版本检查源（完整 packument 地址，如 `https://registry.npmmirror.com/@deepseek-ai/dsh`） |
| `DSH_SHELL_AUTOQUIT_MS` | UI 加载成功后 N 毫秒优雅退出（CI / 冒烟测试） |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | 测试钩子 |
| `DSH_SHELL_TEST_AUTODISABLE` | =1 时跳过「启动失败自动禁用插件」钩子（测试用） |
| `DSH_SHELL_TEST_BREAK_PLUGIN` | 设置后强制制造插件启动失败，用于验证失败自动剔除/诊断流程（测试用） |
| `DSH_SHELL_PAGE_DEBUG` | =1 时把内嵌页面 console 转发到主进程日志，并输出页面桥探针结果（调试用） |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | 打包时捆绑的 Node 版本与下载镜像 |
| `DSH_NODE_ARCH` / `DSH_NODE_PLATFORM` | 覆盖捆绑 Node 的目标平台/架构（如 CI 在 Apple Silicon 上交叉打包 x64 macOS 应用时设 `DSH_NODE_ARCH=x64`） |

---

## 🛠 打包

### 打包

```sh
npm run make-icons    # 渲染各尺寸图标（build/、src/）
npm run bundle:node   # 下载当前平台便携 Node 到 resources/node
npm run dist          # 合并构建 win + linux（注意平台限制，见下）
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS 安装包 + 便携 zip
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg（需 macOS）
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

- **程序目录命名**：electron-builder 的 `*-unpacked` 目录由
  `scripts/fix-unpacked.mjs` 改名为 `DSH-GUI-WIN` / `DSH-GUI-MAC` /
  `DSH-GUI-LINUX`，并同步生成同名 **`.zip`**（解压即程序目录）。
- **捆绑 Node**：由 `scripts/bundle-node.mjs` 按平台下载（默认 v26；引擎的会话
  持久化需要 Node ≥ 23 的 zstd API），`scripts/after-pack.js` 在封包前完整拷入
  应用（不能用 `extraResources`——它会丢弃 `node_modules`，导致捆绑 Node 缺 npm）。
  npm 安装引擎时若捆绑 Node 无 npm，会自动回退到宿主 Node 的 npm-cli。
- **平台限制**：AppImage 的 `mksquashfs` 仅 Linux/macOS 可执行，所以在 Windows 上
  运行 `npm run dist` 时 linux 步骤会报 `ENOENT`；请在对应平台或 CI/Docker
  （如 `electronuserland/builder`）中构建各平台产物。

---

## 🧪 测试

```sh
npm start                                   # 运行应用
# 引擎补丁工具纯函数单测：
node src/test/engine-patch.test.cjs
# Windows 端到端（真实 WM_CLOSE 验证关闭/托盘/模态行为）：
powershell -File scripts/smoke-close.ps1 -Mode quit   # “直接退出”模式
powershell -File scripts/smoke-close.ps1 -Mode tray   # “隐藏到托盘”模式
powershell -File scripts/smoke-modal.ps1              # 模态设置窗
```

---

## ❓ 常见问题

- **首次启动较慢 / 状态页显示“正在下载并安装…”**：正在自动安装 DeepSeek Harness
  引擎，仅首次发生。
- **`npm run dist` 在 Windows 上报 `mksquashfs ENOENT`**：AppImage 只能在
  Linux/macOS（或 Docker/CI）构建，见「打包 → 平台限制」。
- **数据目录切换后看不到原来的会话**：切换时若源目录有数据会询问是否移动；
  选“仅切换”时数据保留在原位置。
- **切换语言后部分界面没变**：语言选择会实时重绘 GUI（设置窗口 / 托盘菜单）并写入引擎
  `settings.yaml` 的 `locale.preference`；内嵌 Harness 页面会跟随引擎 locale 热发布
  即时切换。若页面未立即刷新，稍等片刻或重启应用即可。
- **想让配置/会话完全随应用目录走**：在设置中把数据目录切到“应用目录”，
  并确认迁移完成；备份/迁移/删除整包即可。
- **与官方 CLI 的关系**：本壳只是启动器/外壳，运行的仍是官方
  `@deepseek-ai/dsh`；任何 Harness 能力问题请参考 [DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

---

## 🏷 推荐 Topics（仓库元数据，已同步勾选于 GitHub「Settings → Topics」）

`deepseek` · `deepseek-harness` · `electron` · `ai-agent` · `agent-framework` · `desktop-app` · `cross-platform` · `automation`

## 📄 许可

[MIT](LICENSE) · 本项目为独立开源外壳，与 DeepSeek Harness 官方项目无隶属关系；
DeepSeek Harness 本身为 [MIT](https://github.com/deepseek-ai/deepseek-harness) 许可。