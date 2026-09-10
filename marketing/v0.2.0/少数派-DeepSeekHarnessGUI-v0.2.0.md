# 让 DeepSeek Harness 变得优雅：一个开箱即用的开源桌面壳 DSH GUI

> 少数派 / 小众软件 · 完整文章（复制即发）
> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI / https://gitcode.com/itchenshi/DeepSeekHarnessGUI
> 开源许可：MIT · 免费 · 跨平台（Windows / macOS / Linux）· 非官方独立项目

![DSH GUI 主窗口](主窗口.png)

## 痛点故事

如果你用过 DeepSeek 开源的 Agent 框架 Harness，多半有过这些体验：Web UI 开在浏览器标签页里，关掉就找不到了；升级要手动敲 `npm` 命令；界面只有英文或中文，主题还不跟系统走。

DSH GUI 想解决的就是这件事——**给 Harness 一个像样的桌面壳**：下载、解压、双击，完事。

## 它解决了什么

- **不占浏览器**：内嵌窗口加载 Harness Web UI，不跟你日常网页混在一起；
- **自动保持最新引擎**：启动 + 每 30 分钟检查 npm registry，发现新版按你的策略处理（询问 / 静默 / 仅提示），右下角有持久角标提醒；
- **插件勾选即装**（v0.2.0）：设置窗口里勾一下，重启就装好挂载；官方插件目录 + 内置加固的 OpenCode 会话头插件；
- **多语言**（v0.2.0）：跟随系统 / 中文 / English，免重启切换；
- **主题跟随**（v0.2.0）：跟 Harness 的 light / dark / system 一张皮；
- **数据目录可控**：默认 `~/.dsh`，可切到应用目录并自动迁移；
- **每次启动全新会话**：内存会话、cookies 不落盘，退出清理整个进程树；
- **零安装**：安装包捆绑便携 Node，普通用户不需要装 Node、不需要碰命令行。

![设置窗口](设置.png)

## 30 秒上手

到 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 下载你平台的安装包（Windows 版还有绿色 zip，解压即用），打开后首次启动会自动装 Harness 引擎，约 1–2 分钟，之后用完即走。

## 适合谁 / 不适合谁

**适合**：想在桌面端无痛使用 Harness 的开发者；不想每次升级手动 `npm i` 的长期用户。

**不适合**：只习惯命令行的 Harness 重度用户；对第三方插件安全敏感、且不想审源码的用户（设置里全别勾即可）。

## 结尾

DSH GUI 是 MIT 开源的独立项目，与 DeepSeek 官方无隶属关系，内核运行的仍是官方 Harness 引擎。如果你感兴趣，欢迎去仓库点个 Star、反馈问题，或提名你希望收录的插件。

> 截图用深色主题主界面 + 设置窗插件区 + 语言切换三张。
