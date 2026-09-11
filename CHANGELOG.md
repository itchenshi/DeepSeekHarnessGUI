# DSH GUI v0.3.0 更新说明

**发布日：2026-09-11** · 从 v0.2.0 累积的所有改动。

> 一句话：**打包显著提速，第三方插件的「安装」和「启用」拆成了两个状态并全部与插件市场双向同步；用量插件加入 DeepSeek 余额并更名为「模型用量与余量」；应用图标改为白色底。**

---

## 📊 用量插件：加入 DeepSeek 余额并更名为「模型用量与余量」

- **插件更名**：`dsh-opencode-go-usage` → **`dsh-model-usage`**（显示名「模型用量与余量 / Model usage & balance」）。
  原因是它不再只管 OpenCode Go，而是按会话当前选中的模型路由分流显示。
- **新增 DeepSeek 账户余额**：使用 DeepSeek 模型（路由 `deepseek-official`）时，在会话标题右侧显示账户余额
  （总 / 赠送 / 充值，按币种带符号：`¥` / `$`），`is_available:false` 或余额列表为空时显示「余额不足」并标红。
  宿主侧经 `ctx.credentials` 取 `DEEPSEEK_API_KEY` 调 DeepSeek 官方
  [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/)（密钥绝不下发浏览器）。
- **两个数据源各自独立**：宿主路由由 `/opencode-go-usage` 变为 **`/model-usage`**，一次返回两段
  （`opencode-go` 用量 + `deepseek` 余额），**每段各自报告 ok/reason** —— 只配了其中一个密钥的用户仍能用那一半，
  另一半退化为诊断文案（`no-key` / `unauthorized` / …）而不是整块消失。每段独立 60s 缓存、失败后 30s 内不重试。
- **门控映射由宿主下发**：provider→段 的对应关系是配置（`opencodeGo.providers` / `deepseek.providers`），
  宿主每次响应带 `sections`，页内据此决定显示哪一段（此前是页内硬编码 `TRACKED_PROVIDERS`）。
  默认 DeepSeek 路由取引擎 `dsh-llm-deepseek` **实际注册**的 `deepseek-official`（核对过引擎源码，不是猜的 `deepseek`）。
- **配置分层**：`config.opencodeGo` / `config.deepseek` 各含 `baseUrl` / `apiKeyRef` / `providers`；
  旧的扁平 `baseUrl` / `apiKeyRef` / `providers` 仍按 `opencodeGo` 段读取（向后兼容）。
- **改名迁移（避免新旧两版同时加载）**：目录条目改名后 profile 里会残留旧包名的 bundle 登记与拷贝，
  而启动维护只按当前 CATALOG 对账、看不见它们 —— 两个版本的页内控件会同时注册。
  现在 `plugin-manager.js` 用 `LEGACY_PLUGIN_PKGS` 做一次性清理：摘旧登记、清补丁层的遗留禁用行
  （含 `[]` 占位还原）、清市场 `state.json` 里的旧包名，并把
  **「原本装着 → 装上替代条目」「原本禁用 → 替代条目同样禁用」** 一起搬过去，改名不改变用户的选择。
- **修复「改名后同一个用量控件显示两遍」**：第一版迁移只摘了 `dsh.profile.bundles`，**没摘 `dependencies`** ——
  而引擎自己的 reconcile 会把「依赖里能解析、且声明了 `dsh.bundle`」的包**重新登记回 bundles**，
  于是 `dsh-opencode-go-usage` 又被引擎装回来，与 `dsh-model-usage` 同时加载（两个页内控件、用量显示两遍）。
  现在迁移改用 `pruneProfilePackages`（bundles **和** dependencies 一起摘），并以「摘完再查一遍」为准
  （不信 `dsh plugin remove` 的返回值）。回归保护：单测断言 dependencies 被摘干净，E2E 在**引擎组合之后**
  再验一次（引擎 reconcile 发生在其自身启动时，早于这一点的断言看不到它复活），并同时检查 bundles 与 dependencies 两处。

## ✅ 第三方插件：安装与启用拆成两个状态，全部与插件市场双向同步

- **①「安装」勾选框 = 安装/卸载状态实时镜像**：装了即勾、没装即不勾。勾选**立即安装**、取消**立即卸载**
  （与 dsh-market 一致：从 profile 摘掉、保留本地文件），不再持久化任何「期望」集合。
- **②「启用」开关 = 加载/禁用状态实时镜像**（新增）。关掉**不卸载**，只是让引擎不加载它；
  开启即恢复加载。**开关直接调用插件市场自己的接口**：`POST <引擎>/dsh-market/toggle`
  （`{name, enabled}`，显式带 `Origin` 头过市场的同源校验）—— 与市场页面上那个开关**完全同一条路径**，
  因此在线生效时机、保护规则、`restart`/`refresh` 信号都一致：
  - 引擎侧**立即生效**（市场用 loader 句柄在线切换，无需重启）；
  - **客户端半体需要刷新页面**：带页内半体的插件禁用后，页面里**已经加载**的那半不会自己消失 ——
    市场正是为此返回 `refresh: true`。设置窗口做了等价处理：切换成功后出现「**刷新页面**」按钮，
    点一下页面就与引擎实际组合对齐；
  - 市场拒绝时（宿主基础设施受保护、市场自身不可关、插件未安装）**原样上报原因，不回退写文件**
    （那等于绕过市场的保护）；
  - **回退路径**：市场不可用（未安装 / 引擎没跑 / 老版本没有该路由）时，退回直接写 profile 用户补丁层
    `cordis.patch.yml` 的 `- id: <rowId>` + `disabled: true|false` 行并同步市场 `state.json`。
    在 `patchReload: live` 的 web profile 上这条路同样由引擎在线重组合（**实测 ~0.7s 生效**）。
- **安装/卸载过程可见（不“卡窗口”）**：插件操作是真实耗时的（pnpm / 引擎子进程）。进行中显示
  **进度条 + 阶段文案**（正在安装/卸载…，随主进程逐阶段推送刷新），并**整体锁定**全部勾选框与操作按钮，
  结束恢复 —— 既消灭“点了没反应”的观感，也避免两个操作并发改同一个 profile 造成锁冲突。
- **插件市场禁用/卸载 → 设置窗口实时同步**：主进程 watch `package.json`、`cordis.patch.yml`、
  `.dsh-market/state.json` 三处（市场开关改的就是这三处），任一变化即重算状态指纹并重绘两个控件；
  指纹已扩展 `enabled` / `disabledBy` 两个字段。动作列表明来源（`已禁用（插件市场）` / `已禁用（profile 补丁层）`）。
- **修复「市场禁用了、但引擎其实还在加载」的根因（BOM）**：profile 的 `cordis.patch.yml` 带 **UTF-8 BOM**，
  而 Node 的 `readFileSync(..., 'utf8')` **不会**像 .NET/PowerShell 那样剥掉它 —— 首行成了 `\uFEFF# 注释`，
  注释正则匹配不到，于是市场 `patch.js` 的 append 保护既认不出空的 `[]` 占位、又把末行判成流式结构而
  **拒绝写入禁用行**。现象就是：市场 `state.json` 记了 disabled、补丁层永远为空、引擎照常加载、设置窗口也无从显示。
  现在读写补丁层一律先剥 BOM 且写回不带 BOM（顺带把文件修好，市场自己的开关之后也能正常写入）。
- **状态不一致自动对账**：若市场已禁用但补丁层还没落下，启动维护与「修复 / 重试」会补写真正的禁用行；
  设置窗口同时显示提示说明原因。对账尊重补丁层已有的 `disabled: false`（显式要它开着时以补丁层为准）。
- **「立即同步」改为「修复 / 重试」**：以「当前已安装集合」为目标再对账（补拉捆绑插件更新），只增不删，
  绝不卸载用户手动装的东西；同时对齐启用/禁用状态。
- 插件目录为四项，展示顺序：**插件市场 dsh-market、最近会话恢复 dsh-gui-last-session、
  模型用量与余量 dsh-model-usage、OpenCode 会话头 dsh-opencode-go-session**。

## 🎨 应用图标改为白色底

- **主图标改为「白色圆角方块 + 品牌蓝字形」**（官方 `#4D6BFE`，带极浅渐变与细描边）——
  桌面/快捷方式上更醒目，深色/浅色壁纸都能看清。
- `build/icon.ico` 由 `scripts/make-icons.mjs` 直接生成（不再依赖 electron-builder 从 PNG 转换），
  帧构成与官方 `electron.exe` 的嵌入方式一致。
- 新增两个可随时自查的工具：`scripts/ico-info.cjs`（检查任意 .ico 的帧构成与长度自洽性）、
  `scripts/exe-icon-info.cjs`（检查 exe 内嵌的 RT_ICON / RT_GROUP_ICON 是否一致、有无悬空条目）。

## ⚡ 打包提速（不再每轮下载 Node / Electron）

- **`bundle-node.mjs` 幂等化 + 归档缓存**：① `resources/node` 已就位且 `version.txt` 的版本/平台与目标一致时
  直接什么都不做（重复打包 0 下载 0 解压）；② 压缩包落盘 `resources/.node-cache/` 并配 SHA-256 sidecar
  自校验（损坏自动作废重下），即使删掉 `resources/node` 也能缓存复用、不再联网；
  ③ `--force` / `DSH_NODE_REFRESH=1` 强制忽略全部缓存重新下载。
- **新增 `scripts/ensure-electron.mjs`**：electron 发行 zip 首次从镜像（默认 npmmirror，`DSH_ELECTRON_MIRROR` 可换）
  下载并**用官方 `SHASUMS256.txt` 校验**后落盘 `resources/.electron-cache/dist.zip`（`.info` 记录版本/平台/SHA-256，
  命中即跳过）。`npm run dist:win` 把该 zip 经 `--config.electronDist` 直接喂给 electron-builder，
  彻底绕开 `@electron/get` —— 不再有每轮的 “Downloading electron-vXX.zip”、不再拉 `SHASUMS256.txt`，断网也能重复打包。
- 两个缓存目录都已加入 `.gitignore`。

## 🛠 坏安装 / 卸载不再挡启动（profile bundle 自愈 + 引擎干净重装）

- **profile bundle 自愈**（`healProfileBundles`）：引擎 spawn 前逐条对账 `dsh.profile.bundles` ——
  可解析且声明了 `dsh.bundle` 的保留（含引擎自带的 `dsh-base` / `dsh-web-app`，从安装锚点解析、永不被误动）；
  不可解析但依赖声明在的条目先按引擎报错里自带的处方跑 `dsh plugin install` 补装，仍失败才修剪；
  完全无依赖声明的 stale 登记（如 `dshmarket`）直接修剪；可解析但没声明 `dsh.bundle` 的同样修剪；
  非法 `patchReload` 重置回 `live`。写回用「临时文件 + rename」原子写，任何失败只记日志、绝不 throw。
- **为什么要 GUI 直接改 manifest**：这类 stale 登记引擎自己的 reconcile 清不掉
  （reconcile 只映射「依赖里成功解析且声明 `dsh.bundle`」的包），`dsh plugin remove` 又因依赖已不在而报
  `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS` —— 只能由 GUI 在 spawn 前修剪，坏掉的安装/卸载永远卡不死启动。
- **实测修复**：引擎 0.1.5-rc.1 上 `cannot resolve profile bundle "dshmarket"` 启动失败 ——
  修剪 `dshmarket` 后引擎正常启动。自愈幂等，配单测 `src/test/plugin-manager.test.cjs`。
- **引擎安装改为「临时前缀 + 原子替换」**：老实现增量装，更新时旧树根部的过期 hoist 残留、
  新依赖却沉进 nested `node_modules` → 引擎在根解析不到 client-ui 包，`ERR_MODULE_NOT_FOUND` 挡死启动。
  现在装进 `<ENGINE_DIR>.stage`、成功后整体换入（旧树先挪走、失败自动还原），产物必然干净布局。
- **引擎树结构自检**：启动时探测「根缺 `dsh-client-ui-commands` + nested 有 + 根留着 `cordis-plugin-loader`」
  的混合残留 → 强制按当前版本走一次干净重装（24h 冷却防误判）。已被污染的老安装下次启动即自动修复。

## 🎛 设置窗口精简

- 移除「会话 - 启动后自动回到最近一次对话」勾选项：功能仍默认生效（由 `dsh-gui-last-session` 插件实现）。
- 移除「语言」「外观」两栏：语言/主题统一在 **Harness 页面（引擎设置）** 里修改；DSH GUI 外壳保持
  「跟随引擎」默认行为（`appearance: engine` + `locale: system`，watch `settings.yaml` 热跟随）——
  页面里改，外壳自动同步，无需重启。
- 布局改为：左列 **关闭窗口 / 数据目录 / 引擎更新**，右列 **第三方插件**（纵贯三行）。
- 不再保存插件勾选状态：`autoPlugins` 字段废弃（旧 `settings.json` 里残留的值不再参与任何逻辑）。

## 🧪 测试与质量

- `npm test` 覆盖：插件状态指纹、启用/禁用补丁层读写与市场同步（含 BOM、`[]` 占位、`dependencies` 迁移）、
  profile 自愈、设置项/主题映射、引擎补丁工具、`dsh-model-usage` 的余额归一化与分段路由，
  以及设置窗口内联 JS 的语法与结构约束。
- `npm run test:e2e` 跑两个 Windows 端到端：设置窗口与插件市场的实时联动（CDP 驱动真实勾选框），
  以及**启用/禁用 + 改名迁移 + `/model-usage` 两段路由**（断言引擎真实激活态、而非只断言文件）。

## 🔧 其他

- 三平台发布脚本加固：Gitee / GitCode 的中文发布说明乱码修复（显式 UTF-8 暂存 + `--data-urlencode`）、
  发布失败不再中断其它平台。

---

> 安装包以 GitHub / Gitee / GitCode Releases 为准；各平台产物一致。
