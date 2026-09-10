# Show HN：DSH GUI v0.2.0（英文完整帖）

> 海外发布用。与 Product Hunt 错开一天发布。

**Title**
Show HN: DSH GUI v0.2.0 – desktop shell for DeepSeek Harness (plugin catalog, i18n, theme sync)

**Body（自述帖，HN 风格：what / why / how）**

> DeepSeek's agent framework Harness ships a nice Web UI, but the shell around it was missing three things: a plugin entry point for non-CLI users, an English UI, and a theme that matches the engine.
>
> v0.2.0 of DSH GUI (an Electron shell, not a fork) adds:
> - a **curated plugin catalog** in Settings — check a box, the app runs `dsh plugin` on next launch; bundled OpenCode session-header plugin is a hardened build (opaque UUID, redacted debug logs, header-value validation) that fixes the 400 MissingSessionID;
> - **i18n** (follow-system / 中文 / English) that hot-switches without restart through the engine's `locale.preference`;
> - **theme sync** with Harness's light/dark/system setting;
> - **self-healing on startup failure** — a plugin that breaks the engine is auto-removed and you get a one-click disable-and-restart dialog;
> - portable Windows zips, and a CI step that clears dist before every tag build so a new release never picks up stale v0.1.0 binaries (that bit me on the actual v0.2.0 release).
>
> Everything else stays the same: fresh in-memory session per launch, auto-updating engine (ask/silent/notify), switchable data directory with migration, bundled portable Node for end users.
>
> MIT, non-official (separate from the DeepSeek team). Installers: https://github.com/itchenshi/DeepSeekHarnessGUI/releases
>
> Which plugins should the curated catalog include next? And any thoughts on the "auto-disable a startup-breaking plugin" trade-off vs failing loudly?

**发布技巧**
- 北京时间晚上 21:00–23:00 对应美东上午，流量较好；
- 评论区积极回复所有提问，HN 看重「作者在场」；
- 不要在标题里用 emoji 或「Best」。
