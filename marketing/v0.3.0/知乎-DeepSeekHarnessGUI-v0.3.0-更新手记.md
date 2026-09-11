# DSH GUI v0.3.0 更新手记：图标终于对了、打包快了，插件也终于分清了「装着」和「开着」

> 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI（GitHub 主仓库，MIT License，非官方项目）
> 国内镜像：https://gitee.com/itchenshi/DeepSeekHarnessGUI / https://gitcode.com/itchenshi/DeepSeekHarnessGUI
> 开源平台：三平台互为镜像，安装包以 GitHub Releases 为准（https://github.com/itchenshi/DeepSeekHarnessGUI/releases）
> 版本：v0.3.0，发布日 2026-09-11

上篇《v0.2.0 更新手记》写的是「补上插件、语言、界面这三块拼图」。这篇聊 **v0.3.0**：距离 0.2.0 之后，这个壳被我按住修了四件事——其中两件是我自己天天在用、天天被硌到的，另外两件属于「不修就一直是别人的第一印象」。

![DSH GUI 主窗口](主窗口.png)

## 一、0.2.0 之后的问题

v0.2.0 把「插件管理」做出来了，勾选即装，用着挺顺。但用得越久，越发现三个说大不大、说小不小的疙瘩：

1. **「装着」和「开着」被我用一个勾选框糊在了一起。** 0.2.0 里取消勾选 = 卸载。可很多时候我并不是想卸载，只是暂时不想让它加载（比如某个插件在排查问题时碍事）。想「留着但关掉」，只能去 Harness 页面的插件市场里手动操作——而设置窗口这边随后就显示成了「没装」，两边说的不是一件事。
2. **用量插件只管 OpenCode Go。** 我用 DeepSeek 模型的时候它什么都不显示，会话标题右边空着。而我其实最想看的就是**账户余额还剩多少**——这个数字藏在网页控制台里，很不体面。
3. **Windows 图标是坏的。** 桌面快捷方式有时候一片空白，Maye 这类老式快速启动器里也读不出来，想手动「更改图标」还会弹一句「文件不包含图标」。这一条最伤——它是别人认识这个项目的第一眼。
4. 外加一条只有贡献者能感受到的：**每次打包都要重新下一遍 Node 和 Electron**，断网就打不了包，一轮下来净等下载。

v0.3.0 就是冲着这四条去的。

## 二、第一件事：用量插件加入 DeepSeek 余额，然后改了名字

这是这个版本我自己最常用的改动。

原来的插件叫 `dsh-opencode-go-usage`，顾名思义只管 OpenCode Go 的套餐用量：滚动 / 周 / 月三个百分比，各自带重置时间。现在它按**当前会话选中的模型路由**分流：

- 用 OpenCode Go 模型 → 显示套餐用量（滚动 / 周 / 月 + 重置时间）；
- 用 DeepSeek 模型（路由 `deepseek-official`）→ 显示**账户余额**：总额、赠送、充值三项，按币种带 `¥` / `$` 符号；`is_available: false` 或余额列表为空时，直接显示「余额不足」并标红。

因为它不再只管 OpenCode Go 了，名字也一并换成 **`dsh-model-usage`（模型用量与余量）**。

有个设计细节我特意没有省：**两段取数完全独立**。宿主侧一次请求返回两段，每段各自报告 `ok` 或失败原因（`no-key` / `unauthorized` / …），各自 60 秒缓存、失败后 30 秒内不重试。结果是——只配了 `DEEPSEEK_API_KEY` 没配 OpenCode Go 密钥的人，余额那一半照常好用，另一半退化成一行诊断文案，而不是整块控件消失。反过来也一样。

隐私上仍然是老规矩：`DEEPSEEK_API_KEY` 经 `ctx.credentials` 在**宿主侧**取用，请求 `GET /user/balance` 也在宿主侧发出，**密钥绝不下发浏览器**。

![会话标题旁的用量与余额](DSH侧边栏.png)

还有一件必须自己给自己擦屁股的事：改名之后，profile 里会残留旧包名的 bundle 登记与拷贝，而启动维护只按当前目录对账、根本看不见它们——于是旧版和新版会**同时加载，用量在页面上显示两遍**。这是我第一版迁移踩的坑：当时只摘了 `dsh.profile.bundles`，忘了 `dependencies`，而引擎自己的 reconcile 会把「依赖里能解析、且声明了 `dsh.bundle`」的包重新登记回 bundles，旧包就这么复活了。

现在的做法是：bundles **和** dependencies 一起摘，摘完再查一遍为准（不信 `dsh plugin remove` 的返回值），顺带清掉补丁层的遗留禁用行和插件市场 `state.json` 里的旧包名，最后把「原本装着 → 装上替代条目」「原本禁用 → 替代条目同样禁用」一起搬过去。**改名不该改变用户的选择**——升级之后你不需要做任何事，位置、开关状态都跟原来一样。

## 三、第二件事：「安装」和「启用」拆成两个状态

这是 v0.3.0 结构上最值得说的一处。

设置窗口里现在有两个控件，管两件正交的事：

- **①「安装」勾选框 = 安装/卸载状态实时镜像。** 装了即勾、没装即不勾；勾选**立即安装**、取消**立即卸载**（和插件市场同一套 `dsh plugin` 机制，从 profile 摘掉、保留本地文件）。不再持久化任何「期望」状态。
- **②「启用」开关 = 加载/禁用状态实时镜像**（本版新增）。关掉**不卸载**，只是让引擎不加载它，文件与登记都留着；开启即恢复加载。

关键是第②个开关**直接走插件市场自己的接口**：`POST <引擎>/dsh-market/toggle`，和插件市场页面上那个开关是同一条路径。所以在线生效时机、保护规则、`restart` / `refresh` 信号全都一致：

- 引擎侧**立即生效**，市场用 loader 句柄在线切换，不需要重启；
- 带**客户端半体**的插件（比如模型用量与余量）被禁用后，页面里已经加载的那半不会自己消失——市场正是为此返回 `refresh: true`。设置窗口做了等价处理：切换成功后出现一个「**刷新页面**」按钮，点一下就与引擎实际组合对齐；
- 市场拒绝的情况（宿主基础设施禁止开关、市场自身不可关、插件未安装）**原样上报原因，不回退写文件**——那等于绕过市场自己的保护；
- 市场不可用时（没装 / 引擎没跑 / 老版本没这条路由）才回退到直接写 profile 补丁层 `cordis.patch.yml` 的 `- id: <rowId>` + `disabled: true|false`，并同步市场 `state.json`。在 `patchReload: live` 的 web profile 上这条路同样由引擎在线重组合，**实测约 0.7 秒生效**，只是少了 `restart` / `refresh` 信号。

**双向同步**是两边都做的：设置窗口同时 watch `profiles/web/package.json`、`cordis.patch.yml` 和市场的 `.dsh-market/state.json`（市场开关改的就是这三处），任一处变化就重算状态指纹、把两个控件按真实状态重绘。你在设置窗口里点，市场里立刻跟着变；你在市场里点，设置窗口立刻显示成「已禁用（插件市场）」。

顺手修了一个挺深的 bug：以前市场里禁用了某个插件，**引擎其实还在加载它**。根因是 profile 的 `cordis.patch.yml` 带 UTF-8 BOM，而 Node 的 `readFileSync(..., 'utf8')` 不像 .NET / PowerShell 那样会剥掉它——首行成了 `\uFEFF# 注释`，注释正则匹配不到，市场写禁用行的保护逻辑就把整个文件判成「流式结构」而拒绝写入。现象就是市场 `state.json` 记了 disabled、补丁层永远空着、引擎照常加载、设置窗口也无从显示。现在读写补丁层一律先剥 BOM、写回不带 BOM，**顺便把已经被写坏的文件也修好**。

还有几处小的但很影响手感的调整：

- **安装/卸载过程可见**：插件操作是真的耗时（要跑 pnpm / 引擎子进程），现在进行中显示进度条 + 阶段文案，并整体锁定所有勾选框与按钮，结束恢复。既消灭了「点了没反应」的观感，也避免两个操作并发改同一个 profile 造成锁冲突。
- **状态不一致自动对账**：如果市场已禁用但禁用行还没落进补丁层（此时引擎其实还在加载它），启动维护与「修复 / 重试」会补写成真正的禁用，设置窗口同时显示一行提示说明原因。
- **「立即同步」改名为「修复 / 重试」**：以「当前已安装集合」为目标再对账，只增不删，绝不卸载你手动装的东西。
- 插件目录现在稳定为四项，展示顺序即：**插件市场（dsh-market）、最近会话恢复（dsh-gui-last-session）、模型用量与余量（dsh-model-usage）、OpenCode 会话头（dsh-opencode-go-session，加固版）**。

![设置窗口：第三方插件](DSH设置.png)

顺便替 v0.2.0 那句安全提示再念一遍：**第三方插件等于以你的权限运行第三方代码**，这个列表默认全部不勾选，勾之前请自己看过源码。

## 四、第三件事：Windows 图标，终于到处都能显示

这一条技术上最琐碎，收益上最直接——因为它决定别人点开你的项目之前看到什么。

- **主图标重画为「白色圆角方块 + 品牌蓝字形」**（官方 `#4D6BFE`，带极浅渐变与细描边）。桌面、快捷方式不再「找不到图标」，深色浅色壁纸下都清楚。
- **修 Maye 等老式启动器读不到图标**：electron-builder 之前从 PNG 转出的 ICO 全是 PNG 压缩帧（Vista+ 格式），而旧解析器（.NET Framework 的 `ExtractAssociatedIcon`）只认未压缩 BMP 帧，结果一片空白。现在 `make-icons` 直接生成 `build/icon.ico`：**16~128 用未压缩 BMP 帧、256 用 PNG 帧**，与官方 `electron.exe` 的嵌入方式一致。
- **修 Windows「更改图标」报「文件不包含图标」**：两处根因——① 256 帧必须是 PNG（BMP 在 256 上不可靠，对话框会直接拒收整个文件）；② BMP 帧的 AND 掩码如果按 `w*h`（32bpp 行距）生成，electron-builder 嵌入 exe 时会把它截断成紧凑 1bpp，导致 DIB 头里声明的 `biSizeImage` 与实际载荷长度对不上，严格解析器照样拒。现在源码 `.ico` 直接用紧凑 1bpp 掩码，保证「头 / 载荷 / 组条目」三者一致。
- 另附两个可以随时自查的小工具：`scripts/ico-info.cjs`（看任意 .ico 的帧构成与长度自洽性）和 `scripts/exe-icon-info.cjs`（看 exe 内嵌的 `RT_ICON` / `RT_GROUP_ICON` 有没有悬空条目）。已在真实 exe 上验过：`PrivateExtractIcons` 16/24/32/48/64/128/256 全尺寸可用、`ExtractIconEx` 一组、`SHGetFileInfo` 正常、`ExtractAssociatedIcon` 显示出白底 + 品牌蓝。

一个使用提醒：改完图标要**重新安装或复制构建产物**。Windows 资源管理器和 Maye 都会缓存旧图标，如果重装后还显示旧的，重启一次资源管理器（或删掉 `%LocalAppData%\IconCache.db`）就好。

![设置窗口](设置.png)

## 五、第四件事：打包提速，从「一轮一等」到 0 下载

这条只有贡献者能感受到，但值得写——因为它直接决定「我愿不愿意一天打三个包试错」。

- **便携 Node 归档缓存**：`resources/.node-cache/` 存压缩包并配 SHA-256 sidecar 自校验（损坏自动作废重下）。`resources/node` 已就位且版本 / 平台一致时，直接什么都不做；即使把 `resources/node` 整个删掉，也能从缓存复用、不再联网。要强制重下就 `--force` 或 `DSH_NODE_REFRESH=1`。
- **Electron 不再每轮 Downloading**：新增 `scripts/ensure-electron.mjs`，首次从镜像（默认 npmmirror）下载并**用官方 `SHASUMS256.txt` 校验**后落盘 `resources/.electron-cache/dist.zip`；`npm run dist:win` 把这个 zip 经 `--config.electronDist` 直接喂给 electron-builder，彻底绕开 `@electron/get`——不再有每轮的 "Downloading electron-vXX.zip"、不再拉校验文件，**断网也能重复打包**。

两个缓存目录都已加进 `.gitignore`。重复打包现在是 **0 下载 0 解压**。

## 六、顺手修的稳定性问题

- **坏掉的安装/卸载不再挡启动**：新增 profile bundle 自愈（`healProfileBundles`），引擎 spawn 前逐条对账 `dsh.profile.bundles`——能解析且声明了 `dsh.bundle` 的保留（含引擎自带的 `dsh-base` / `dsh-web-app`，永不被误动）；不可解析但依赖还在的先按引擎报错里的处方补装，仍失败才修剪；完全没依赖声明的 stale 登记（比如 `dshmarket`）直接修剪；非法 `patchReload` 重置回 `live`。写回用「临时文件 + rename」原子写，任何失败只记日志、绝不 throw。实测在引擎 `0.1.5-rc.1` 上修好了 `cannot resolve profile bundle "dshmarket"` 导致的启动失败。
- **为什么得由 GUI 直接改 manifest**：这类 stale 登记引擎自己的 reconcile 清不掉，`dsh plugin remove` 又会因为依赖已不在而报 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`——只能由外壳在 spawn 前修剪。
- **引擎安装改为「临时前缀 + 原子替换」**：老实现是增量安装，更新时旧树根部会留下过期 hoist 残留、新依赖却沉进 nested `node_modules`，引擎在根上解析不到 client-ui 包，`ERR_MODULE_NOT_FOUND` 直接把启动挡死。现在装进 `<ENGINE_DIR>.stage`、成功后整体换入（旧树先挪走、失败自动还原），产物必然是干净布局。另加了引擎树结构自检：发现「根缺 `dsh-client-ui-commands` + nested 里有 + 根上还留着 `cordis-plugin-loader`」的混合残留，就强制按当前版本走一次干净重装（24 小时冷却防误判）——**已经被污染的老安装，下次启动会自己修好**。
- **设置窗口精简**：移除了「启动后自动回到最近一次对话」勾选项（功能仍默认生效，由 `dsh-gui-last-session` 插件实现），也移除了外壳里单独的「语言」「外观」两栏——语言和主题统一到 **Harness 页面（引擎设置）**里改，外壳默认「跟随引擎 / 跟随系统」（`appearance: engine` + `locale: system`，watch `settings.yaml` 热跟随），页面里改完外壳自动同步、不用重启。布局改成左列「关闭窗口 / 数据目录 / 引擎更新」、右列「第三方插件」纵贯三行。
- **三平台发布脚本加固**：Gitee / GitCode 的中文发布说明乱码修复（显式 UTF-8 暂存 + `--data-urlencode`），某个平台发布失败也不再中断其它平台。

## 七、安装包与升级

| 平台 | 安装包 | 便携版 |
|---|---|---|
| **Windows** | `DSH GUI Setup 0.3.0.exe`（NSIS） | `DSH GUI-0.3.0-win.zip` / `DSH-GUI-WIN.zip`（解压即用目录） |
| **macOS** | `DSH GUI-0.3.0-arm64.dmg`（Apple Silicon）/ `DSH GUI-0.3.0.dmg`（Intel） | |
| **Linux** | `DSH GUI-0.3.0.AppImage` | `DSH-GUI-LINUX.zip` |

各平台安装包都**捆绑了便携 Node（v26）**，终端用户不需要安装任何运行时；三平台仓库互为镜像，**安装包只挂在 GitHub Releases**（Gitee 单附件上限 100 MB、GitCode 不支持附件，而 Windows 产物有 139–202 MB，所以这两个镜像只放源码与说明）。

升级很省事：**直接覆盖安装即可**，数据目录与会话记录不受影响。如果你在 v0.2.0 装过「OpenCode Go 用量」，首次启动会自动换成「模型用量与余量」，连当初「已禁用」的选择一起搬过去，不会有新旧两版同时加载的情况。图标如果还是旧的，重启一次资源管理器就好。

## 八、技术栈的一点补充

壳依然是 **Electron + 原生 JS**，dsh 仍是官方 `@deepseek-ai/dsh` 子进程，内核没有动过一行。插件管理模块（`src/plugin-manager.js`）维护一份经过核实的目录，用引擎自己的 `dsh plugin` 做安装对账，并额外处理两件引擎不管的事：旧包名迁移和 profile bundle 自愈。「启用」开关不自己实现一套加载器，而是复用插件市场的 `POST /dsh-market/toggle`——这条选择有点啰嗦（要处理 `refresh` 信号、要保留市场的拒绝语义），但换来的是**两个入口永远说同一件事**。

测试也跟着补了：`npm test` 现在覆盖插件状态指纹、启用/禁用的补丁层读写与市场同步（含 BOM、`[]` 占位、`dependencies` 迁移）、profile 自愈、设置项与主题映射、`dsh-model-usage` 的余额归一化与分段路由，以及设置窗口内联 JS 的语法与结构约束。`npm run test:e2e` 跑两个 Windows 端到端：设置窗口与插件市场的实时联动（CDP 驱动真实勾选框），以及启用/禁用 + 改名迁移 + `/model-usage` 两段路由——断言的是**引擎的真实激活态**，不只是断言文件写对了。

## 九、适合谁、不适合谁

**适合**：
- 想在 Windows / macOS / Linux 上「开箱即用」跑 Harness、又不想先装 Node 的开发者；
- 同时用 DeepSeek 和 OpenCode Go 模型、希望用量和余额一眼可见的人；
- 喜欢把插件装着但临时关掉、又不想真去卸载的折腾派；
- 对「Electron 壳 + 子进程托管 + 插件状态对账」这套工程感兴趣的人。

**不适合**：
- 只想要命令行 / API 的 Harness 重度用户（壳是加分项，不是必需品）；
- 担心第三方插件安全、且不想审源码的用户（那就在设置里一个都别勾）。

## 十、下一步

- 「启用」开关的回退路径（市场不可用时直接写补丁层）目前拿不到 `restart` / `refresh` 信号，带页内半体的插件在那种情况下只能靠手动刷新页面，体验还能再拉平一点；
- OpenCode 会话头插件的模型发现接口（`GET /models`）还没加头，OpenCode 中继若也对它鉴权，需要补；
- 插件目录会随社区生态扩充，欢迎在 Issues 里提名你验证过、且能稳定跑起来的插件；
- 引擎更新通道的「跳过 alpha / 含全部预发布」已经就位，细节体验继续打磨。

## 结尾

从 0.1.0 到 0.3.0，我的取舍没变过一条：**壳只做官方引擎没空做的「体验活」，内核永远 100% 官方**。所以这个版本里最花时间的其实不是新功能，而是那些「看起来不算功能」的地方——一个能显示的图标、一次不用等下载的打包、一个不会说谎的开关状态。这些东西没法写进功能列表里炫耀，但它们是每天都在用的部分。

如果你在桌面端折腾 Harness，欢迎去 [GitHub 主仓库](https://github.com/itchenshi/DeepSeekHarnessGUI) 看看（[Gitee](https://gitee.com/itchenshi/DeepSeekHarnessGUI) / [GitCode](https://gitcode.com/itchenshi/DeepSeekHarnessGUI) 镜像同步）；用出问题，直接开 issue——开源项目最怕的不是批评，是沉默。

> MIT · 非官方独立项目 · 与 DeepSeek Harness 官方无隶属关系。任何 Harness 本体的能力问题，请查阅官方文档。
