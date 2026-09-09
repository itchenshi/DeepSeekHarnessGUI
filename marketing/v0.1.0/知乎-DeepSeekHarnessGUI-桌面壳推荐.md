# 给 DeepSeek Harness 套了个壳：我为什么做一个开源的桌面端 DSH GUI

> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库，MIT License，非官方项目）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI（Gitee 同步仓库）

最近 DeepSeek 开源的 Agent 框架 **DeepSeek Harness**（技术预览阶段，`@deepseek-ai/dsh`）热度不小。它是一个能真正干活的编码 Agent：读/写工作区文件、跑命令、委派子任务、维护计划，还带 CLI、Python SDK 和一套不错的 Web UI。我用了一段时间，体验很惊艳，但工具链本身却总有一种「差最后一公里」的别扭感。

于是我给 Harness 写了个桌面壳，叫 **DSH GUI**。这篇文章不聊「怎么装」——README 里写得很清楚——我想认真聊聊几个问题：它到底解决什么痛点？为什么选择「套壳」而不是「重写」？以及开源这件事本身。

## 一、先说清楚：DeepSeek Harness 是什么

DeepSeek Harness 是 DeepSeek 官方的开源 Agent 框架（MIT 许可），你通过 npm 安装 `@deepseek-ai/dsh` 来使用。它提供：

- **CLI 模式**：命令行里跑任务、做开发；
- **Python SDK**：在代码里驱动 agent；
- **Web UI（`dsh web`）**：图形化工作区、会话、审批流，体感类似一个本地 AI IDE。

Agent 可以读取和编辑工作区文件、执行命令、把子任务委派出去，并在需要时向你请求审批。它的用户数据默认都在 `~/.dsh` 下：`settings.yaml`（模型/系统/插件配置）、`sessions/`（会话历史）、`storages/`（工作区记录）、`credentials` 等等。

一句话总结：**这是个非常强的引擎，但官方把「运行体验」的功课留给了使用者自己。**

## 二、我遇到的实际痛点

如果你只用过 `dsh web` 几分钟，可能感受不深；但天天用，问题就浮出来了：

**1. 工具链还停在命令行时代。** 要先装 Node ≥ 23（引擎依赖 Node 23+ 的 zstd API），然后 `npm install -g @deepseek-ai/dsh` 或者用 npx 拉最新版。对开发者来说这不是门槛，但对想体验一下的人来说，这已经劝退了一大批人。

**2. Web UI 存活在浏览器标签页里。** `dsh web` 启动后开在浏览器里，你的任务、登录态、会话和日常上网混在一起。关掉标签页＝任务没了，有时候连自己都忘了还开着。更别说多人抢一个浏览器环境。

**3. 升级焦虑是 CLI 工具的隐形税。** Harness 迭代很快（技术预览嘛，几乎每周都有变化）。问题在于：你根本不知道什么时候出了新版、新版修了什么、你的本地版本是不是已经落后。于是变成「能用就不敢升」和「升完发现配置不兼容」两种焦虑交替出现。

**4. 数据目录散落且不可控。** 配置、会话、工作区、凭证全在 `~/.dsh`，听起来很整洁，但当你想要整体备份、迁移到新机器、或者让「完全干净地重来一次」的时候，每一步都得小心翼翼。

**5. 跨平台重复劳动。** 在 Windows 上配好的环境，换到 macOS / Linux 又要重来一遍。

这些痛点单独看都不大，但凑在一起，就是「工具很好，使用体验跟不上」的典型症状。我想，能不能有人把这一公里补上？

## 三、我的选择：做一个壳，而不是重写

很多人拿到这种项目第一反应是「我要不要 fork 一下，自己改 UI」。我认真考虑过，最后否决了。原因很朴素：**Harness 本体的演进速度，远快于任何人重写 UI 的速度。** 如果我 fork 一份自己魔改，就会永远陷入「官方又更新了，我的分支落后了」的泥潭。

所以定位很明确：

- **内核保持 100% 官方**：壳只是一个启动器，运行的永远是官方的 `@deepseek-ai/dsh`（甚至每次都用 registry 上的 `latest`）；
- **外壳负责「运行体验」**：窗口、托盘、更新、数据目录、主题，这些官方没精力做的脏活累活我来。

技术上选了 Electron，理由不多说——跨平台、内嵌 Chromium 能完全控制会话、系统托盘和模态窗口都是原生能力。接着是几个关键设计决定：

**① 内嵌窗口，不占浏览器。** 壳进程启动 `dsh web --no-open --port 0`，从 stdout 解析带认证的 loopback URL，加载进内嵌的 Electron 窗口。不占你的浏览器标签页，端口自动分配，URL 里带的认证信息也不暴露出来。

**② 每次启动都是全新的。** 内嵌窗口用内存会话，cookies / 登录态不落盘；每次启动都全新 spawn 一个 dsh 子进程，退出时把整个进程树一起清理干净。隐私上是「每次都是第一次」，整洁得令人舒适。

**③ 自动保持最新引擎。** 启动时和运行期间（默认每小时）检查 npm registry 的 `latest`，发现新版按策略处理：默认**询问后再更新**，也可以设成静默更新或仅提示。更新安装到应用私有目录，完成后右下角弹出持久角标提醒你。升级焦虑？不存在的，它替你盯着。

**④ 数据目录可控，还带迁移。** 默认跟随系统 `~/.dsh`，可以切换成应用目录；切换时自动检测源目录有没有数据，询问你是否要**移动**（流程是：停引擎 → 迁移 → 按新目录重启）。想干净备份/迁移整包，一条龙。

**⑤ 外观跟随 Harness。** 启动时读 `settings.yaml` 里的 `ui-theme.preference`（light / dark / system），窗口和各页面主题自动对齐，不会出现「设置里选了深色，壳却是刺眼的白色」这种分裂感。

**⑥ 捆绑便携 Node，终端用户零安装。** 打包时把 Node ≥ 23 一起打进应用。意味着终端用户**不需要装 Node、不需要 npm、不需要任何命令行**——下载解压就能用。这是「开源工具走向大众」最关键的一步。

还有一些小决定：主窗口启动即最大化、关闭窗口默认隐藏到托盘（可选直接退出）、设置窗口做成模态（改设置时主窗口不可误操作）。每一个都写进了 README，有取舍，也有理由。

## 四、一点工程上的坦诚

必须承认，这不是什么大项目，它 v0.1.0，刚起步。

- 它只负责「启动器/外壳」这层，任何 Harness 能力本身的问题，请回到官方文档（[DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)）；
- 打包跨平台有几个平台限制（比如 AppImage 只能在 Linux/macOS 上构建，README 里写清楚了）；
- 目前最缺的不是赞美，而是**真实使用者的反馈**——issue、讨论、甚至一句「这里体验很怪」。

## 五、怎么用？（30 秒版）

**方式 A：源码运行**（需要 Node ≥ 23，仅开发/contributor 需要）：

```sh
npm install
npm start
```

首次启动会自动联网安装 DeepSeek Harness 引擎（1–2 分钟，状态页有进度），之后只有官方发新版本才会再次安装。

**方式 B：直接用打包产物。** 在 [Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 或 `dist/` 拿对应平台的包（Windows NSIS 安装包 / macOS dmg / Linux AppImage），解压即用，机器上连 Node 都可以没有。国内读者也可以从 [Gitee 镜像仓库](https://gitee.com/itchenshi/DeepSeekHarnessGUI) 访问项目、下载源码（安装包以 GitHub Release 为准）。

## 六、最后说几句

我一直觉得，现在的 AI 工具不缺「更强的模型」，缺的是「更体面的使用方式」。一个引擎再强，如果用户要在终端里折腾半小时才能跑起来，它就永远只是开发者的玩具。DeepSeek Harness 是个好引擎，DSH GUI 想做的，就是让它被更多人「无痛地」用起来。

- 开源地址（GitHub）：https://github.com/itchenshi/DeepSeekHarnessGUI
- 国内镜像（Gitee）：https://gitee.com/itchenshi/DeepSeekHarnessGUI
- 许可：MIT，与 DeepSeek Harness 官方项目无隶属关系；
- 如果它帮你省下了五分钟，欢迎点个 Star；如果你觉得哪里做得不对，欢迎开 issue。

开源项目最怕的不是批评，是沉默。