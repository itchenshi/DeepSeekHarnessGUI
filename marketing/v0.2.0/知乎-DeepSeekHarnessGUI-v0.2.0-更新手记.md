# DSH GUI v0.2.0 更新手记：给 DeepSeek Harness 的桌面壳，补上了「插件、语言、界面」这三块拼图

> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库，MIT License，非官方项目）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI / https://gitcode.com/itchenshi/DeepSeekHarnessGUI
> 开源平台：三平台互为镜像，安装包以 GitHub Releases 为准（https://github.com/itchenshi/DeepSeekHarnessGUI/releases）

上篇《给 DeepSeek Harness 套了个壳》写的是「为什么做这个壳」。这篇聊聊 **v0.2.0**：距离 0.1.0 之后，我给这个壳补齐了哪三块拼图，以及每一块背后我在想什么。

## 一、0.1.0 之后的问题

0.1.0 的 DSH GUI 核心是「运行体验」：内嵌窗口、自动更新引擎、数据目录迁移、系统托盘。用下来方向是对的，但有几个明显的「差点意思」：

1. **插件要靠命令行。** Harness 的插件生态正在起来，但终端用户面对 `dsh plugin --profile web add xxx` 这种命令行，基本等于没有入口。
2. **语言是硬编码中文。** 项目 README 有英文版，但应用界面只有中文——中文用户友好，英文用户直接劝退。
3. **界面跟引擎是「两张皮」。** 引擎里选了深色主题，壳窗口却是白的；标题栏、托盘提示也跟版本号对不上。

v0.2.0 就是冲着这三个问题去的。

## 二、拼图一：插件管理，「勾选即装」

这个版本最重要的改动是内置了**第三方插件管理**。设置窗口里有一个「第三方插件」区，列出经我们核实的社区插件：

- 插件市场（dsh-market）
- 增强侧栏（dsh-better-sidebar）
- 智能体团队（dsh-agent-teams）
- OpenCode 会话头（dsh-opencode-go-session）

用户只需要**勾选**，下次启动 GUI 就会自动用引擎的 `dsh plugin` 把插件装进 Harness Web 并挂载。装的逻辑是幂等的：已经装过的不会重复装，用户手动装过的同名插件也不会被误删。

这里有一个安全上的坚持：**第三方插件 = 在你的权限下运行第三方代码**。所以这个列表默认全部不勾选，勾选前你最好自己看过源码。我们还内置了一个**安全加固版**的 OpenCode 会话头插件（`dsh-opencode-go-session`），它给发往 OpenCode/OpenCode Go 的请求加稳定的 `x-opencode-session` 头、修掉 400 MissingSessionID；但和社区原版不同，它**默认用不透明 UUID 而不是把你的内部会话 ID 发给第三方**，并对日志做了脱敏——这是我们在「功能」和「隐私」之间选的保守答案。

配套做了**启动失败自愈**：如果某个刚勾选的插件把引擎搞到起不来，GUI 会自动剔除它并取消勾选，还会弹一个诊断框问你要不要一键禁用重启。没有这个机制，「自动装插件」这个功能我是不敢默认开的——它可能把用户锁在门外。

## 三、拼图二：多语言，「免重启切换」

设置窗口新增「语言」：**跟随系统（默认）/ 中文 / English**。

技术上没有做复杂的 i18n 框架，而是把语言选择**双向同步**到引擎侧：GUI 的窗口、托盘菜单、对话框走自己的字典；Harness 页面走引擎的 `settings.yaml` → `locale.preference`，引擎支持热发布，所以**切换语言不用重启**——设置窗口里选完，页面立刻跟着变。

顺带把「跟随系统」做成了默认：Windows 中文系统进来自动是中文，英文系统自动是英文，不用手动选。

## 四、拼图三：界面跟随引擎，「一张皮」

- **主题跟随**：启动时读 `settings.yaml` 的 `ui-theme.preference`（light / dark / system），壳窗口和各页面自动对齐。不会出现「引擎深色、壳刺眼白」的分裂感。
- **版本可见**：窗口标题显示 `DSH GUI v0.2.0`，托盘提示同时给出 GUI 版本和引擎版本——升级后版本号对不对，一眼就知道。

## 五、其他值得提的

- **win 便携 zip**：除了 NSIS 安装包，现在也出便携 zip，解压即用（绿色软件党狂喜）。
- **README 双语重构**：按功能分类重写了中文版并补全了英文版，环境变量、设置项、打包发布一节不落。
- **CI 构建清理**：GitHub Actions 在 tag 构建前会先清空 dist，避免上一版本的 exe/dmg 残留混进新版本 Release——这是我发行 v0.2.0 时踩过的坑（Release 里混进了 0.1.0 的产物），已修。

## 六、技术栈的一点补充

壳依然是 **Electron + 原生 JS**，dsh 仍是官方 `@deepseek-ai/dsh` 子进程，内核没有动。插件管理模块（`src/plugin-manager.js`）维护一个目录 + 用引擎的 `dsh plugin` 做安装对账；内置插件走「staging 副本 + file 安装」，不依赖 npm 注册表。三平台安装包由 GitHub Actions 矩阵构建（Windows / macOS x64+arm64 / Linux），Intel macOS 的便携 Node 用 `DSH_NODE_ARCH` 在 Apple Silicon runner 上交叉打包。

## 七、适合谁、不适合谁

**适合**：
- 想在 Windows / macOS / Linux 上「开箱即用」跑 Harness 的开发者；
- 不想每次升级都手动 `npm i` 的长期用户；
- 对「Electron 壳 + 子进程托管 + 插件对账」这套工程感兴趣的人。

**不适合**：
- 只想要命令行/API 的 Harness 重度用户（壳是加分项不是必需品）；
- 担心第三方插件安全、且不想审源码的用户（那就在设置里全别勾）。

## 八、下一步

- OpenCode 会话头插件的模型发现接口（`GET /models`）还没加头，OpenCode 中继若也对它鉴权会需要补；
- 插件目录会随社区生态扩充，欢迎在 Issues 里提名你验证过的插件；
- 引擎更新通道的「跳过 alpha / 含全部预发布」已经就位，细节体验继续打磨。

## 结尾

这个项目从 0.1.0 走到 0.2.0，我的取舍始终是一条：**壳只做官方引擎没空做的「体验活」，内核永远 100% 官方**。这样官方每次更新我都跟着躺赢，不用维护 fork 依赖。

如果你在桌面端折腾 Harness，欢迎去 [GitHub 主仓库](https://github.com/itchenshi/DeepSeekHarnessGUI) 看看（[Gitee](https://gitee.com/itchenshi/DeepSeekHarnessGUI) / [GitCode](https://gitcode.com/itchenshi/DeepSeekHarnessGUI) 镜像同步）；用出问题，直接开 issue——开源项目最怕的不是批评，是沉默。

> 补充一句：DSH GUI 是独立开源项目（MIT），与 DeepSeek Harness 官方无隶属关系；任何 Harness 本体的能力问题请查阅官方文档。