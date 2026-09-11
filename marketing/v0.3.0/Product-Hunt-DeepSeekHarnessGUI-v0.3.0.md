# Product Hunt: DSH GUI v0.3.0 (full English listing)

> For the international launch. Prepare the listing from this file; use the `*-english.png` screenshots in this same directory.

**Name**: DSH GUI
**Tagline**: DeepSeek Harness as a desktop app — plugins, usage, tray (56 chars)
**URL**: https://github.com/itchenshi/DeepSeekHarnessGUI
**Topics**: Artificial Intelligence · Developer Tools · Open Source · Desktop Apps

**Gallery (screenshots; English UI where available)**

- Main window: `主窗口-english.png` — the native window with the workspaces and session list.
- Settings window: `设置-english.png` — engine update policy, data directory, close behavior.
- Settings (third-party plugins): `DSH设置-english.png` — four catalog plugins, each with its own install checkbox and Enabled toggle.
- Model usage, OpenCode Go plan (Chinese UI — no English capture): `模型OpenCodeGo余量.png` — the session header showing rolling / weekly / monthly usage.
- Model balance, DeepSeek account (Chinese UI — no English capture): `模型DeepSeek余量.png` — the session header showing the account balance.

**Description**

> DSH GUI is an open-source (MIT) desktop shell for DeepSeek Harness (`@deepseek-ai/dsh`), DeepSeek's agent framework — and it runs the official engine untouched, so nothing about Harness's capabilities changes. v0.3.0 puts the active model's usage or balance in the session header (OpenCode Go plan usage, or your DeepSeek account balance); either key stays in the host process, so it never reaches the browser. Plugin install and enable are now two separate states, both in two-way live sync with the in-page plugin market — the Enabled toggle calls the market's own endpoint, so the engine side applies immediately. The catalog ships four plugins: dsh-market, dsh-gui-last-session, dsh-model-usage, and a hardened dsh-opencode-go-session. Also in this release: a refreshed Windows app icon (a white rounded square with the brand-blue glyph, so it stands out on the desktop and in shortcuts), and packaging that caches the Node and Electron archives so repeat builds download nothing. Installers bundle a portable Node v26 — no Node/npm needed for end users. Windows / macOS / Linux.

**First comment**

> Hi PH! v0.3.0 came from three things: the usage plugin only knew about OpenCode Go (it is now `dsh-model-usage`, and it also reports your DeepSeek account balance), "installed" and "enabled" were the same checkbox, and the app icon did not stand out on the desktop. That middle one is my favorite part — the Enabled toggle now goes through the plugin market's own endpoint instead of rewriting files behind its back, so the settings window and the market page can never disagree for long. Feedback very welcome on which plugins to curate next.

**Launch tips**

- Launch around 9:00 AM Pacific time.
- Line up 5–10 friends/accounts to upvote before posting, and collect votes within the first 24 hours.
- Keep the copy free of ranking claims (top, leading, number one) — Product Hunt review flags them.

**Disclaimer**: MIT · unofficial independent project, not affiliated with the DeepSeek Harness team.
