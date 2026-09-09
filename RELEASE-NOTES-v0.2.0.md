# 🚀 DSH GUI v0.2.0

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

**发布说明：** 自 v0.1.0 以来的首个功能大版本，新增第三方插件管理、多语言、主题跟随等能力。

---

## ✨ 主要更新

### 🔌 第三方插件管理（新增）
- 新增插件管理模块，设置窗口提供经核实的社区插件目录：插件市场（dsh-market）、增强侧栏（dsh-better-sidebar）、智能体团队（dsh-agent-teams）、OpenCode 会话头（dsh-opencode-go-session）
- 勾选后每次启动自动用引擎 `dsh plugin` 安装并挂载到 Harness Web
- **内置加固插件** `dsh-opencode-go-session`：为 OpenCode/OpenCode Go 请求注入稳定 `x-opencode-session` 头（修复 400 MissingSessionID），默认不透明 UUID、头值校验、debugFile 脱敏
- **启动失败自动恢复**：插件导致 dsh 无法启动时自动剔除并诊断，可一键禁用重启

### 🌐 多语言（新增）
- 设置窗口「语言」：跟随系统（默认）/ 中文 / English
- 引擎侧 `locale.preference` 热发布，无需重启即切换 GUI 与 Harness 页面

### 🎨 外观与桌面
- 主题跟随 Harness（light / dark / system）
- 窗口标题显示 `DSH GUI v<版本>`；托盘提示同时显示 GUI 与引擎版本

### 💾 数据与引擎
- 数据目录可在系统 `~/.dsh` 与应用目录间切换，自动检测并询问迁移
- 每次启动内存会话（cookies/登录态不落盘）
- 引擎版本号显示，更新后立即生效

### 🛠 工程与打包
- README 双语重构（按功能分类）
- win 打包新增便携 zip（NSIS 安装包 + 目录 zip + 便携 zip 三种产物）

---

## 📦 下载

| 平台 | 安装包 | 便携版 |
|---|---|---|
| **Windows** | `DSH GUI Setup 0.2.0.exe`（NSIS 安装包） | `DSH GUI 0.2.0-win.zip` / `DSH-GUI-WIN.zip`（解压即用） |
| **macOS** | `DSH GUI 0.2.0.dmg`（Intel）/ `DSH GUI 0.2.0-arm64.dmg`（Apple Silicon） | |
| **Linux** | `DSH GUI 0.2.0.AppImage` | `DSH-GUI-LINUX.zip` |

> 提示：各平台安装包均已捆绑便携 Node（≥v26），终端用户无需安装任何运行时。Gitee / GitCode 镜像因平台附件限制不挂载安装包，请统一从本 GitHub Release 下载。

---

## 🧭 运行方式

```bash
# 源码运行（需 Node.js ≥ 23）
npm install
npm start
```

首次启动自动安装 DeepSeek Harness 引擎（约 1–2 分钟）。

---

*项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI · 问题反馈：GitHub Issues*