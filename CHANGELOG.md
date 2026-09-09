# DSH GUI v0.2.0 更新说明

**发布日：2026-09-08** · 从 v0.1.0 累积的所有改动。

## ✨ 新功能（New features）

### 第三方插件管理
- 新增插件管理模块 `plugin-manager.js`，在设置窗口提供经核实的第三方插件目录（插件市场 dsh-market、增强侧栏 dsh-better-sidebar、智能体团队 dsh-agent-teams、OpenCode 会话头 dsh-opencode-go-session）。
- 勾选后每次启动自动用引擎 `dsh plugin` 安装并挂载到 Harness Web，幂等对账，不改动用户手动装的同名插件。
- 内置本地捆绑插件（`plugins/dsh-opencode-go-session`）：为 OpenCode / OpenCode Go 请求注入稳定 `x-opencode-session` 头（修复 400 MissingSessionID，保持会话亲和/提示缓存）；**安全加固版**——默认不透明 UUID、头值校验、debugFile 限位与脱敏。
- **启动失败自动恢复**：刚自动安装的插件若导致 dsh 无法启动，自动剔除并取消勾选；疑似插件导致失败时弹诊断框，可一键禁用重启（含 `DSH_SHELL_TEST_BREAK_PLUGIN` 等测试钩子）。

### 多语言（i18n）
- 设置窗口新增「语言」：跟随系统（默认）/ 中文 / English；引擎侧经由 `settings.yaml` 的 `locale.preference` 热发布，无需重启即切换 GUI 与 Harness 页面。

### 外观与桌面
- 启动时读取 Harness `ui-theme.preference` 跟随 light / dark / system 设置窗口与页面主题。
- 窗口标题显示 `DSH GUI v<版本>`；托盘提示同时显示 GUI 与引擎版本。

### 数据与引擎
- 数据目录可在「跟随系统 ~/.dsh」与「应用目录」间切换，自动检测并询问迁移。
- 引擎版本号显示（引擎包实际版本），引擎更新后立即生效。
- 每次启动内存会话（cookies/登录态不落盘）、退出清理进程树。

## 🛠 工程与脚本（Build & tooling）
- 新增三平台推送脚本 `scripts/push-all.ps1`（GitHub / Gitee / GitCode，分支+tags，支持 token 注入）。
- 新增三平台发布脚本 `scripts/publish-all.ps1`（推送 → 本地构建 → 三平台 Releases 发布 + 产物上传）。
- electron-builder win 目标新增便携 zip（NSIS 安装包 + 目录 zip + 便携 zip 三种产物）。
- README 双语重构：按功能分类组织功能总览、设置项、打包发布说明、目录结构、环境变量。

## 🔧 其他
- Windows E2E 冒烟脚本、状态页/通知角标细节优化。

---

> 安装包以 GitHub / Gitee / GitCode Releases 为准；各平台产物一致。