# Show HN: DSH GUI v0.3.0 (English full post)

> For the overseas launch. Space it out from the Product Hunt post by a day.

**Title**
Show HN: DSH GUI v0.3.0 – desktop shell for DeepSeek Harness (model usage & balance, install/enable plugin states)

**Body (self post, HN style: what / why / how)**

> DSH GUI is an unofficial, MIT-licensed Electron shell for DeepSeek Harness (`@deepseek-ai/dsh`). Instead of wrapping or patching the engine, it spawns `dsh web --no-open --port 0`, parses the authenticated loopback URL out of stdout and loads it in an embedded window — so the official engine stays untouched (no fork, no patched engine), and every Harness capability keeps working inside a tray-resident desktop app.
>
> v0.3.0 (2026-09-11) is out. The three things that changed:
> - **Model usage & balance in the session header** — the usage plugin was renamed `dsh-opencode-go-usage` → `dsh-model-usage`, because it now splits by the session's current model route: OpenCode Go models show plan usage (rolling / weekly / monthly), DeepSeek models show the **account balance** (total / granted / topped-up). The two feeds are independent, so a missing key only disables its own half. Keys are resolved in the host process (`ctx.credentials`) and **never sent to the browser**.
> - **"Install" and "Enable" are two separate states** — the checkbox mirrors install/uninstall, a new "Enabled" toggle mirrors loaded/disabled, and both stay in **two-way live sync** with the in-page plugin market. The toggle calls the market's own `POST /dsh-market/toggle`, so it applies live without a restart, with the market's protection rules intact; plugins that also have a client half get a "Reload page" action because the already-loaded page half cannot remove itself.
> - **A refreshed Windows icon** (a white rounded square with the brand-blue glyph, so it stands out on the desktop and in shortcuts), and **packaging is much faster** — the Node and Electron archives are cached locally, so repeat builds download nothing and even work offline.
>
> What carried over unchanged: a fresh in-memory session per launch (no login state on disk), the engine kept up to date at startup plus every fixed 30 minutes with an ask / silent / notify-only policy, a switchable data directory with migration, a four-plugin curated catalog (dsh-market, dsh-gui-last-session, dsh-model-usage, dsh-opencode-go-session), and a bundled portable Node v26 so end users install no runtime at all. Windows / macOS / Linux; more detail in the README.
>
> Screenshots (English UI): `主窗口-english.png` (main window), `设置-english.png` (settings), `DSH设置-english.png` (Harness settings), `DSH侧边栏-english.png` (sidebar).
>
> MIT · unofficial independent project, not affiliated with the DeepSeek Harness team. Installers: https://github.com/itchenshi/DeepSeekHarnessGUI/releases — mirrors: GitHub https://github.com/itchenshi/DeepSeekHarnessGUI (primary), Gitee https://gitee.com/itchenshi/DeepSeekHarnessGUI, GitCode https://gitcode.com/itchenshi/DeepSeekHarnessGUI
>
> Feedback I'd like: which plugins should the curated catalog include next? Is separating install from enable the right call, or does it make the settings window harder to read than a single control? And does showing your DeepSeek balance inside the session header feel useful, or is it the kind of thing you'd rather keep out of a chat window?

**Posting tips**
- 21:00–23:00 Beijing time lines up with US Eastern morning, which gets better traffic;
- reply to every question in the comments — HN values the author being present;
- no emoji and no "Best" in the title.
