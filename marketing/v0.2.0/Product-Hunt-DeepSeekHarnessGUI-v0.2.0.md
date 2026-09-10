# Product Hunt：DSH GUI v0.2.0（英文完整帖）

> 海外发布用。尽量按此清单准备；英文界面截图用同目录 `*-english.png` 系列。

**Name**: DSH GUI
**Tagline**: DeepSeek Harness, now a real desktop app — plugin catalog, multi-language, theme sync.
**URL**: https://github.com/itchenshi/DeepSeekHarnessGUI
**Topics**: Artificial Intelligence · Developer Tools · Open Source · Desktop Apps

**Gallery（截图，中英文各自可选）**
- 主窗口：`主窗口.png`（中文） / `主窗口-english.png`（English）
- 设置窗口：`设置.png`（中文） / `设置-english.png`（English）
- 设置（插件区）：`DSH设置.png`（中文） / `DSH设置-english.png`（English）
- 侧边栏：`DSH侧边栏.png`（中文） / `DSH侧边栏-english.png`（English）

**Description（正文一段，可整段粘贴）**

> DSH GUI is an open-source (MIT) desktop shell for DeepSeek Harness, DeepSeek's agent framework. v0.2.0 adds a built-in third-party plugin catalog (check a box, restart, done): dsh-market, better sidebar, agent teams, and a hardened OpenCode session-header plugin that uses opaque UUIDs instead of leaking your internal session id. Multi-language (follow system / 中文 / English) hot-switches without a restart via the engine's locale preference, and the shell theme now follows Harness's light/dark/system setting. On top of that: startup failure self-healing (a plugin that breaks the engine is auto-removed with a one-click disable-and-restart dialog), portable zips for Windows, and a CI that cleans dist before every tag build so releases never mix in old-version installers. Installers bundle a portable Node — no Node/npm needed for end users. Windows / macOS (x64 + arm64) / Linux.

**First comment（自评，发完立刻跟帖）**

> Hi PH! v0.2.0 was driven by three complaints about 0.1.0: plugins were CLI-only, UI was Chinese-only, and the shell theme didn't follow the engine's. The plugin catalog is my favorite part — the bundled OpenCode session-header plugin is a hardened fork that sends an opaque UUID, not your internal session id, to third parties. Very open to feedback on which plugins to curate next.

**发布技巧**
- 太平洋时间上午 9 点前后发布；
- 发布前找 5–10 个朋友/账号准备 upvote（发布后 24h 内投）；
- 文案避免 best / #1 等触发 PH 审核的词。
