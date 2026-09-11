# 🚀 DSH GUI v0.3.0

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

**发布说明：** 自 v0.2.0 以来的功能版本。图标在 Windows 上终于到处都能显示；打包不再每轮重新下载 Node / Electron；第三方插件的「安装」与「启用」拆成两个独立状态并全部与插件市场双向同步；用量插件加入 DeepSeek 账户余额，更名为「模型用量与余量」。

---

## ✨ 主要更新

### 📊 模型用量与余量（原「OpenCode Go 用量」）

- **新增 DeepSeek 账户余额**：使用 DeepSeek 模型时，会话标题右侧显示账户余额（总 / 赠送 / 充值，按币种带 `¥` / `$`），余额不足时标红提示。宿主侧取 `DEEPSEEK_API_KEY` 调 DeepSeek 官方 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/)，**密钥不下发浏览器**。
- **插件更名**：`dsh-opencode-go-usage` → **`dsh-model-usage`**（「模型用量与余量」）。按会话当前选中的模型路由分流：OpenCode Go 模型显示套餐用量（滚动 / 周 / 月 百分比 + 重置时间），DeepSeek 模型显示账户余额。
- **两段各自独立**：一次请求返回两段，各自报告成功/失败原因 —— 只有其中一个密钥也能正常用那一半，另一半显示诊断文案而不是整块消失。
- **升级平滑**：旧包会被自动摘除并换成新版，连「原本被禁用」的选择一起搬过去，不会新旧两版同时加载。

### ✅ 插件的「安装」与「启用」拆成两个状态

- **安装勾选框**：装了即勾、没装即不勾；勾选立即安装、取消立即卸载（不再保存勾选状态）。
- **启用开关**（新）：关掉**不卸载**，只是让引擎不加载它；开启即恢复加载。**走插件市场自己的接口**，与市场页面上的开关完全同一条路径 —— 在线立即生效、保护规则一致；带页内半体的插件切换后设置窗口会出现「**刷新页面**」按钮（与市场「刷新后生效」的提示等价）。禁用/启用的来源会标注（插件市场 / profile 补丁层）。
- **与插件市场双向实时同步**：设置窗口同时 watch `package.json`、`cordis.patch.yml`、市场的 `state.json` 三处，任一侧改动另一侧立即反映。
- **修复「市场里禁用了、引擎其实还在加载」**：根因是 profile 补丁层文件带 UTF-8 BOM，Node 读取时不会剥掉，导致市场写入禁用行时被自己的保护逻辑拒绝。现已修复并顺带修好了文件。
- **安装/卸载过程可见**：进行中显示进度条与阶段文案，并锁定全部操作按钮，不再出现「点了没反应」。

### 🎨 Windows 图标修复

- 主图标改为**白色圆角方块 + 品牌蓝字形**，深浅壁纸/任务栏都醒目。
- **Maye 等老式快速启动工具能显示了**：16~128 用未压缩 BMP 帧（旧解析器只认这种），256 用 PNG 帧（与官方 `electron.exe` 一致）。
- **Windows「更改图标」不再报「文件不包含图标」**：修正了 256 帧格式与 BMP 帧掩码长度，保证图标头、载荷、组条目三者一致。
- 附 `scripts/ico-info.cjs` / `scripts/exe-icon-info.cjs`，可随时自查 `.ico` 与 exe 内嵌图标。

### ⚡ 打包提速（贡献者可感）

- **便携 Node 归档缓存**：`resources/.node-cache/`（带 SHA-256 自校验），已就位时直接跳过 —— 重复打包 **0 下载 0 解压**。
- **Electron 不再每轮 Downloading**：新增 `scripts/ensure-electron.mjs`，首次从镜像下载并用官方 `SHASUMS256.txt` 校验后缓存，之后 `dist:win` 直接喂给 electron-builder，**断网也能构建**。

### 🛠 稳定性

- 坏掉的插件安装/卸载不再挡启动：profile bundle 自愈 + 引擎「干净重装」，已被污染的老安装下次启动自动修复。
- 设置窗口精简：语言/主题统一在 Harness 页面里改，外壳实时跟随；移除冗余勾选项。

---

## 📦 下载

| 平台 | 安装包 | 便携版 |
|---|---|---|
| **Windows** | `DSH GUI Setup 0.3.0.exe`（NSIS 安装包） | `DSH GUI-0.3.0-win.zip`（便携） / `DSH-GUI-WIN.zip`（解压即用目录） |
| **macOS** | `DSH GUI-0.3.0-arm64.dmg`（Apple Silicon） / `DSH GUI-0.3.0.dmg`（Intel） | |
| **Linux** | `DSH GUI-0.3.0.AppImage` | `DSH-GUI-LINUX.zip` |

> 提示：各平台安装包均已捆绑便携 Node（v26），终端用户无需安装任何运行时。
> 三平台仓库（GitHub / Gitee / GitCode）互为镜像；安装包以 GitHub Releases 为准，Gitee 同步挂载 Windows 产物。

### 升级说明

- 直接覆盖安装即可，数据目录与会话记录不受影响。
- 若你在 v0.2.0 装过「OpenCode Go 用量」插件：首次启动会自动换成「模型用量与余量」，无需手动操作。
- 升级后若桌面/开始菜单图标仍是旧的，重启一次资源管理器（或删除 `%LocalAppData%\IconCache.db`）即可刷新图标缓存。

---

## 🧭 运行方式

```bash
# 源码运行（需 Node.js ≥ 23）
npm install
npm start
```

首次启动自动安装 DeepSeek Harness 引擎（约 1–2 分钟）。

---

## 🙏 反馈

- 问题与建议：GitHub Issues
- 项目地址：https://github.com/itchenshi/DeepSeekHarnessGUI

*完整改动见 [CHANGELOG.md](CHANGELOG.md)。*
