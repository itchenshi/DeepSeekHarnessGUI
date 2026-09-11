"use strict";

/**
 * DSH GUI Shell — main process.
 *
 * Responsibilities:
 *  1. Ensure the DeepSeek Harness engine (@deepseek-ai/dsh) is the LATEST
 *     version: launch-time and periodic update checks (fixed 30-minute
 *     interval, not user-configurable), install into an app-owned directory
 *     per update policy, notify the user. The engine update settings (policy /
 *     channel / check enable) live in the Harness settings page, exposed to
 *     the embedded web UI through the dsh-gui IPC bridge.
 *  2. Settings window: data directory / close-window / auto-restore
 *     preferences, persisted in <userData>/settings.json. Quick settings also
 *     live in the app menu.
 *  3. Spawn `dsh web --no-open --port 0`, parse the authenticated loopback
 *     URL from stdout, and load it in an embedded BrowserWindow (no system
 *     browser is ever opened).
 *  4. Fresh per-launch session: in-memory (non-persist) session partition;
 *     every launch starts a brand-new dsh child process, killed (tree
 *     included) on quit. Settings / sessions / workspace records of the
 *     harness live under DSH_HOME, which defaults to the app's data dir.
 *  5. System tray: open window / settings / quit. Window close either hides
 *     to tray or quits, per the closeAction setting.
 *  6. Persistent update notice: frameless corner badge dismissed by the user.
 *
 * Node resolution order: bundled portable node (resources/node) ->
 * $DSH_SHELL_NODE -> Node on PATH. npm installs use a node that ships npm
 * (bundled node usually has one; otherwise the host Node, since npm is
 * ABI-safe pure JS).
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, dialog, screen, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const semver = require("semver");
const YAML = require("yaml");
const {
  APPEARANCE_MODES,
  parseEngineSettings,
  applyEngineSettings,
  engineThemeForAppearance,
} = require("./settings-ui");
const { statusFingerprint } = require("./plugin-state");
const { defaultDshHome, hasHomeData, moveHomeData } = require("./home-migrate");
const { ensureEnginePatches } = require("./engine-patch");
const {
  CATALOG: PLUGIN_CATALOG,
  CATALOG_IDS: pluginCatalogIds,
  catalogStatus: pluginCatalogStatus,
  catalogEngineCompat: pluginEngineCompat,
  installedBundles: readInstalledProfileBundles,
  readProfilePnpmManager: readProfilePnpmManagerFn,
  syncEnabledPlugins,
  setPluginEnabled,
  reconcilePluginEnabled,
  removeLegacyPlugins,
  packageRowIds,
  ensurePnpm: ensurePluginPnpm,
  removePlugin: removeEnginePlugin,
  healProfileBundles: healProfileBundlesFn,
  pruneProfileBundles: pruneProfileBundlesFn,
} = require("./plugin-manager");

const DSH_PACKAGE = "@deepseek-ai/dsh";
// 完整 packument（而非 dist-tag latest）：GitHub 的 v0.1.3-alpha.2 只挂在 npm 的
// `alpha` 标签上；读全量版本后由 fetchLatestVersion 取最高 semver（含预发布）。
// Overridable for regions where registry.npmjs.org is slow/unreachable.
const REGISTRY_LATEST_URL =
  process.env.DSH_SHELL_REGISTRY_URL || `https://registry.npmjs.org/${DSH_PACKAGE}`;

const UPDATE_POLICIES = {
  auto: "静默更新（每次使用最新版）",
  ask: "询问后再更新（默认）",
  notify: "仅提示，不自动更新",
};

/** 版本通道：决定“最新版本”怎么选（见 fetchLatestVersion）。 */
const UPDATE_CHANNELS = {
  all: "最新版（含 alpha/beta/rc 预发布）",
  rc: "跳过 alpha（取 rc/正式版最高）",
  npm: "跟随 npm latest 标签",
};

/** DSH GUI 应用自身的更新来源（GitHub Releases，仅检测+打开下载页）。 */
const GUI_REPO_API = "https://api.github.com/repos/itchenshi/DeepSeekHarnessGUI/releases/latest";
const GUI_RELEASES_URL = "https://github.com/itchenshi/DeepSeekHarnessGUI/releases/latest";

/** 引擎检查更新的固定频率：30 分钟（不再可设置）。 */
const ENGINE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const DSH_HOME_MODES = {
  app: "应用目录（随应用携带）",
  system: "跟随系统 ~/.dsh（默认）",
};

const CLOSE_ACTIONS = {
  tray: "隐藏到托盘",
  quit: "直接退出",
};

/**
 * UI 语言设置：跟随系统 / 中文 / English。
 * 缺省 "system"：优先跟随引擎设置文件里的语言（引擎页面即用它），否则按
 * Electron 的系统语言解析为 zh|en；同时把结果同步到引擎的
 * <DSH_HOME>/settings.yaml 的 locale.preference（引擎热发布该文件，内置页面跟随）。
 * 外观（appearance）同理：engine=跟随引擎主题（默认），system/light/dark 显式
 * 选择并写回 ui-theme.preference；主进程 watch settings.yaml 热跟随两侧改动。
 */
const UI_LOCALES = { system: "跟随系统", zh: "中文", en: "English" };

/** 各界面文案（zh / en）。key 全部集中在此，调用处经 L() 取当前语言。 */
const UI_STRINGS = {
  zh: {
    // tray / menu
    "tray.open": "打开窗口",
    "tray.guiUpdate": "检查 DSH GUI 更新…",
    "tray.settings": "设置",
    "tray.quit": "退出",
    "menu.settings": "设置",
    "menu.openSettings": "打开设置窗口…",
    "menu.dataDir": "数据目录",
    "menu.quit": "退出",
    "menu.home.app": "应用目录（随应用携带）",
    "menu.home.system": "跟随系统 ~/.dsh（默认）",
    // settings window
    "settings.title": "设置",
    "settings.autoSave": "修改后自动保存",
    "settings.language": "语言",
    "settings.language.hint": "界面语言：设置窗口 / 托盘菜单 / 内嵌 Harness 界面都会切换",
    "settings.dataDir": "数据目录",
    "settings.home.system": "跟随系统 ~/.dsh（默认）",
    "settings.home.app": "应用目录（设置 / 会话 / 工作区记录随应用携带）",
    "settings.home.moveHint": "切换时若源目录有数据会询问是否移动",
    "settings.close": "关闭窗口",
    "settings.close.tray": "隐藏到托盘（默认，从托盘恢复）",
    "settings.close.quit": "直接退出（关闭窗口即退出，托盘一并移除）",
    "settings.session": "会话",
    "settings.autoRestore": "启动后自动回到最近一次对话（关闭后每次启动从空白/新会话开始）",
    "settings.autoRestore.hint": "记录你最后打开/使用的会话，重启 DeepSeek Harness 后自动切回",
    "settings.saved": "已保存",
    "settings.titleBar": "设置 — DSH GUI",
    // status page
    "status.checking": "正在检查版本…",
    // update flows
    "update.check": "正在检查 DeepSeek Harness 版本…",
    "update.cantCheck": "无法检查更新",
    "update.cantReach": "无法连接更新服务器",
    "update.currentV": "当前版本 v{0}。请检查网络后重试。",
    "update.notInstalled": "尚未安装引擎。",
    "update.upToDate.title": "已是最新版本",
    "update.upToDate.msg": "DeepSeek Harness 已是最新版本 v{0}",
    "update.found.title": "发现新版本",
    "update.found.msg": "可更新到 DeepSeek Harness v{0}",
    "update.found.detail": "当前版本：v{0}。\n是否立即下载更新，并在完成后重启 DSH GUI 以使用新版本？",
    "update.notInstalled.detail": "引擎尚未安装。是否立即下载最新版本并安装？",
    "update.nowRestart": "立即更新并重启",
    "update.later": "暂不更新",
    "update.installing": "正在更新到 v{0}…",
    "update.installProgress": "下载并安装 DeepSeek Harness",
    "update.done.title": "更新完成",
    "update.done.msg": "已更新到 DeepSeek Harness v{0}",
    "update.done.detail": "重启 DSH GUI 后即使用新版本。现在重启吗？",
    "update.restartNow": "立即重启",
    "update.restartLater": "稍后重启",
    "update.failed.title": "更新失败",
    "update.failed.msg": "更新 DeepSeek Harness 失败",
    "update.failed.willUseCurrent": "将使用当前版本 v{0} 启动。",
    "update.gui.title": "发现新版本",
    "update.gui.msg": "DSH GUI 可更新到 v{0}",
    "update.gui.detail": "当前版本：v{0}。\n是否打开下载页面（GitHub Releases）？",
    "update.gui.open": "打开下载页",
    "update.gui.cancel": "取消",
    "update.gui.cant.title": "无法检查更新",
    "update.gui.cant.msg": "无法连接 GitHub 获取 DSH GUI 版本信息",
    "update.gui.upToDate": "DSH GUI 已是最新版本 v{0}",
    "update.notice.found": "发现新版本 v{0}",
    "update.notice.nextLaunch": "将于下次启动时更新",
    "update.notice.updated": "已更新到 v{0}",
    "update.notice.thisLaunch": "本次启动已使用最新版本",
    "update.notice.detailAuto": "可在设置中改为自动更新",
    "update.status.upToDate": "版本已是最新 v{0}",
    "update.status.ready": "已就绪 v{0}",
    "update.status.skipped": "跳过更新，使用 v{0}",
    "update.status.found": "发现新版本 v{0}（未自动更新）",
    "update.status.updated": "已更新到 v{0}",
    "update.status.failed": "更新失败，使用 v{0} 启动",
    "update.status.offline": "离线模式：使用 v{0}",
    "update.status.first": "首次运行：正在安装 DeepSeek Harness…",
    "update.firstInstall": "首次安装",
    "update.reinstallRuntime": "运行时已变更，重新安装",
    "update.reinstall": "重新安装",
    "update.runtimeChanged": "运行时已变更",
    "update.newVersion": "发现新版本 v{0}（当前 v{1}）",
    "update.bootQuestion.title": "发现新版本",
    "update.bootQuestion.msg": "发现 DeepSeek Harness 新版本 v{0}",
    "update.bootQuestion.detail": "当前版本 v{0}。是否现在更新？",
    "update.bootNow": "立即更新",
    "update.bootUseCurrent": "用当前版本启动",
    "update.autoUpdateFailed": "自动更新到 v{0} 失败",
    "update.checksOff": "（更新检查已关闭）",
    "update.starting": "正在启动 DeepSeek Harness…",
    "update.firstInit": "首次启动需要初始化本地配置",
    "update.loadingUi": "正在加载界面…",
    "update.startFailedExit": "进程退出码 {0} {1}",
    // 第三方插件：启动失败自动剔除
    "plugin.excluded.title": "插件导致启动失败，已自动剔除",
    "plugin.excluded.msg": "刚自动安装的插件导致 dsh 无法启动，已移除并在设置中取消勾选：{0}。下次启动将不再自动安装。",
    // 引擎意外退出 / GUI 托管重启
    "engine.autoRestartGaveUp": "引擎多次意外退出（已尝试 {0} 次自动重启），请检查日志或重启 DSH GUI",
    "engine.crash.title": "引擎意外退出",
    "engine.crash.msg": "dsh 多次意外退出（退出码 {0}），已停止自动重启。可在设置窗口点「重启引擎」手动重试。",
    // 启动失败诊断
    "diag.title": "DeepSeek Harness 启动失败",
    "diag.savedLog": "启动错误日志已保存：\n{0}",
    "diag.plugin.title": "疑似第三方插件导致启动失败",
    "diag.plugin.msg": "检测到以下插件可能是启动失败的原因：\n{0}\n\n是否禁用这些插件并重新启动？",
    "diag.plugin.disable": "禁用并重启",
    "diag.plugin.keep": "暂不禁用，查看日志",
    "diag.notPlugin.title": "DeepSeek Harness 启动失败",
    "diag.notPlugin.msg": "启动失败看起来不是第三方插件导致的。\n\n最后输出：\n{0}",
    "diag.openLogs": "打开日志目录",
    // home switch
    "home.switchTitle": "切换数据目录",
    "home.hasDataMsg": "源数据目录（{0}）包含数据",
    "home.hasDataDetail": "是否将数据移动到目标目录（{0}）？选择“仅切换”则数据保留在原位置。",
    "home.moveAndSwitch": "移动并切换",
    "home.switchOnly": "仅切换，不移动",
    "home.switching": "正在移动数据目录…",
    "home.switched": "数据目录已切换",
    "home.restarting": "正在重新启动 DeepSeek Harness…",
    "home.partial.title": "部分数据未移动",
    "home.partial.msg": "已移动 {0} 项，{1} 项未移动",
    "home.moved.title": "数据已移动",
    "home.moved.msg": "已将 {0} 项数据移动到 {1}",
    "home.modeLabel": "数据目录",
    // dialogs & misc
    "common.ok": "知道了",
    "common.okShort": "确定",
    "common.continue": "继续",
    "common.engine": "引擎",
    "common.engineShort": "Engine",
    "engine.installFailed": "引擎安装失败",
    "engine.startFailed": "dsh 启动失败",
    "common.startFailed": "启动失败",
    "startFailed": "无法启动 DeepSeek Harness",
    "engine.notFound": "引擎安装目录缺失或不可用：{0}",
  },
  en: {
    // tray / menu
    "tray.open": "Open Window",
    "tray.guiUpdate": "Check for DSH GUI Updates…",
    "tray.settings": "Settings",
    "tray.quit": "Quit",
    "menu.settings": "Settings",
    "menu.openSettings": "Open Settings Window…",
    "menu.dataDir": "Data Folder",
    "menu.quit": "Quit",
    "menu.home.app": "App folder (travels with the app)",
    "menu.home.system": "Follow system ~/.dsh (default)",
    // settings window
    "settings.title": "Settings",
    "settings.autoSave": "Changes are saved automatically",
    "settings.language": "Language",
    "settings.language.hint": "Applies to the settings window, tray & menus, in-page DSH GUI features, and the embedded Harness UI",
    "settings.dataDir": "Data Folder",
    "settings.home.system": "Follow system ~/.dsh (default)",
    "settings.home.app": "App folder (settings / sessions / workspace records travel with the app)",
    "settings.home.moveHint": "If the source folder holds data you will be asked whether to move it",
    "settings.close": "Close Window",
    "settings.close.tray": "Hide to tray (default; restore from tray)",
    "settings.close.quit": "Quit (closing the window quits and removes the tray)",
    "settings.session": "Session",
    "settings.autoRestore": "Automatically reopen the last conversation on launch (off = always start blank/new)",
    "settings.autoRestore.hint": "Remembers the conversation you last opened so it is reopened after restarting DeepSeek Harness",
    "settings.saved": "Saved",
    "settings.titleBar": "Settings — DSH GUI",
    // status page
    "status.checking": "Checking for updates…",
    // update flows
    "update.check": "Checking DeepSeek Harness version…",
    "update.cantCheck": "Cannot Check for Updates",
    "update.cantReach": "Cannot reach the update server",
    "update.currentV": "Installed: v{0}. Check your network and try again.",
    "update.notInstalled": "The engine is not installed yet.",
    "update.upToDate.title": "Already Up to Date",
    "update.upToDate.msg": "DeepSeek Harness is already up to date (v{0})",
    "update.found.title": "Update Available",
    "update.found.msg": "DeepSeek Harness v{0} is available",
    "update.found.detail": "Installed: v{0}.\nDownload and update now, then restart DSH GUI to use it?",
    "update.notInstalled.detail": "The engine is not installed yet. Download and install the latest version now?",
    "update.nowRestart": "Update & Restart",
    "update.later": "Not Now",
    "update.installing": "Updating to v{0}…",
    "update.installProgress": "Downloading and installing DeepSeek Harness",
    "update.done.title": "Update Complete",
    "update.done.msg": "Updated to DeepSeek Harness v{0}",
    "update.done.detail": "DSH GUI will use the new version after restart. Restart now?",
    "update.restartNow": "Restart Now",
    "update.restartLater": "Later",
    "update.failed.title": "Update Failed",
    "update.failed.msg": "Failed to update DeepSeek Harness",
    "update.failed.willUseCurrent": "DSH GUI will start with the current version v{0}.",
    "update.gui.title": "Update Available",
    "update.gui.msg": "DSH GUI v{0} is available",
    "update.gui.detail": "Installed: v{0}.\nOpen the download page (GitHub Releases)?",
    "update.gui.open": "Open Download Page",
    "update.gui.cancel": "Cancel",
    "update.gui.cant.title": "Cannot Check for Updates",
    "update.gui.cant.msg": "Cannot reach GitHub to check the DSH GUI version",
    "update.gui.upToDate": "DSH GUI is already up to date (v{0})",
    "update.notice.found": "New version v{0} available",
    "update.notice.nextLaunch": "Will update on next launch",
    "update.notice.updated": "Updated to v{0}",
    "update.notice.thisLaunch": "This launch already uses the latest version",
    "update.notice.detailAuto": "You can switch to automatic updates in Settings",
    "update.status.upToDate": "Up to date (v{0})",
    "update.status.ready": "Ready (v{0})",
    "update.status.skipped": "Update skipped, using v{0}",
    "update.status.found": "New version v{0} available (not installed automatically)",
    "update.status.updated": "Updated to v{0}",
    "update.status.failed": "Update failed, starting with v{0}",
    "update.status.offline": "Offline mode: using v{0}",
    "update.status.first": "First run: installing DeepSeek Harness…",
    "update.firstInstall": "First-time install",
    "update.reinstallRuntime": "Runtime changed; reinstalling",
    "update.reinstall": "Reinstall",
    "update.runtimeChanged": "Runtime changed",
    "update.newVersion": "New version v{0} available (installed: v{1})",
    "update.bootQuestion.title": "Update Available",
    "update.bootQuestion.msg": "A new DeepSeek Harness version v{0} is available",
    "update.bootQuestion.detail": "Installed: v{0}. Update now?",
    "update.bootNow": "Update Now",
    "update.bootUseCurrent": "Start with Current Version",
    "update.autoUpdateFailed": "Automatic update to v{0} failed",
    "update.checksOff": "(update checks are off)",
    "update.starting": "Starting DeepSeek Harness…",
    "update.firstInit": "First launch needs a one-time configuration",
    "update.loadingUi": "Loading interface…",
    "update.startFailedExit": "Process exit code {0} {1}",
    // third-party plugin start-failure exclusion
    "plugin.excluded.title": "Plugin broke startup — auto-excluded",
    "plugin.excluded.msg": "A plugin auto-installed this launch prevented dsh from starting. It was removed and unchecked in settings: {0}. It will not be auto-installed again.",
    // engine unexpected exit / GUI-managed restart
    "engine.autoRestartGaveUp": "Engine exited unexpectedly several times (auto-restarted {0}×) — check the logs or restart DSH GUI",
    "engine.crash.title": "Engine exited unexpectedly",
    "engine.crash.msg": "dsh exited unexpectedly (code {0}); auto-restart was stopped. Use “Restart Engine” in the settings window to retry.",
    // startup-failure diagnosis
    "diag.title": "DeepSeek Harness failed to start",
    "diag.savedLog": "Startup error log saved:\n{0}",
    "diag.plugin.title": "A third-party plugin may have broken startup",
    "diag.plugin.msg": "These plugins look like the likely cause of the startup failure:\n{0}\n\nDisable them and restart?",
    "diag.plugin.disable": "Disable & Restart",
    "diag.plugin.keep": "Keep for now, view log",
    "diag.notPlugin.title": "DeepSeek Harness failed to start",
    "diag.notPlugin.msg": "The failure does not look plugin-related.\n\nLast output:\n{0}",
    "diag.openLogs": "Open Logs Folder",
    // home switch
    "home.switchTitle": "Switch Data Folder",
    "home.hasDataMsg": "The source data folder ({0}) contains data",
    "home.hasDataDetail": "Move the data to the destination folder ({0})? Choose “Switch only” to keep the data where it is.",
    "home.moveAndSwitch": "Move & Switch",
    "home.switchOnly": "Switch Only",
    "home.switching": "Moving data folder…",
    "home.switched": "Data folder switched",
    "home.restarting": "Restarting DeepSeek Harness…",
    "home.partial.title": "Some Data Was Not Moved",
    "home.partial.msg": "{0} items moved, {1} items were not moved",
    "home.moved.title": "Data Moved",
    "home.moved.msg": "Moved {0} items to {1}",
    "home.modeLabel": "Data Folder",
    // dialogs & misc
    "common.ok": "OK",
    "common.okShort": "OK",
    "common.continue": "Continue",
    "common.engine": "Engine",
    "common.engineShort": "Engine",
    "engine.installFailed": "Engine Install Failed",
    "engine.startFailed": "Failed to Start dsh",
    "common.startFailed": "Startup Failed",
    "startFailed": "DeepSeek Harness could not be started",
    "engine.notFound": "Engine directory is missing or unusable: {0}",
  },
};

/** 格式化 {0} {1} … 占位符。 */
function fmt(template, ...args) {
  if (!template) return template;
  let out = template;
  args.forEach((value, i) => {
    out = out.split(`{${i}}`).join(String(value ?? ""));
  });
  return out;
}

// Test hook: redirect userData (engine dir / settings) for isolated smoke runs
// of packaged builds. Must run before anything reads app paths.
if (process.env.DSH_SHELL_USERDATA) {
  app.setPath("userData", process.env.DSH_SHELL_USERDATA);
}

const DEFAULT_SETTINGS = {
  updatePolicy: "ask", // 引擎更新策略（auto/ask/notify）
  updateChannel: "npm", // 引擎版本通道（默认=跟随 npm latest 标签）
  dshHomeMode: "system", // 数据目录默认跟随系统 ~/.dsh
  updateCheckEnabled: true, // 引擎更新检查开关
  closeAction: "tray", // 关闭窗口默认隐藏到托盘
  autoRestoreLastSession: true, // 启动后自动回到最近一次对话
  locale: "system", // UI 语言：system=跟随系统 / zh=中文 / en=English
  // UI 外观：engine=跟随引擎（Harness 页面主题，默认）/ system=跟随系统 / light / dark。
  // 选 system/light/dark 会同时写回引擎设置文件，两侧一起切换。
  appearance: "engine",
};

let ENGINE_DIR = null;
let NPM_CACHE_DIR = null;
let win = null;
let settingsWin = null;
let tray = null;
let hasTray = false;
let dshChild = null;
let uiSettled = false;
let quitting = false;
let dshHome = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsPath = null;
let updateCheckTimer = null;
let checkingInProgress = false;
let engineStarted = false;
let lastEngineUrl = null;
// 本次启动刚自动安装的插件 id（用于“引擎启动失败 → 剔除”兜底）。
let pluginsInstalledThisLaunch = [];
let pluginFailureRecoveryDone = false;
let pluginReadyWatchdog = null;
// 启动失败诊断：本次启动只弹一次（无论是否自动剔除过）。
let startupDiagnosisDone = false;
// “重启引擎”请求/进行中的标记（页面或设置窗口触发 → 主进程杀掉并重拉 dsh）。
let engineRestartInFlight = false;
// 非退出场景下引擎意外退出 → 自动重拉一次（dsh 页面自己没法重启 GUI 的 dsh）。
let engineReady = false;
// 有意停止引擎（切换数据目录 / 更新流程等）时置位，避免被当成“意外退出”自动重拉。
let intentionalEngineStop = false;
// 就绪后连续意外退出的计数（>3 停止自动重拉并提示）。
let unexpectedEngineExits = 0;
// “启动后自动回到最近一次对话”：轮询 __dshOpenLast 就绪的计时器（窗口级一个即可，
// 页面每导航/重载一次即重置，避免多个页面周期叠加轮询）。
let openLastPollTimer = null;
let openLastPollTries = 0;
let openLastPollClosed = null; // 绑定到 win 'closed' 的清理函数

/** Test/CI hook: quit N ms after the web UI finished loading. */
const autoquitMs = Number(process.env.DSH_SHELL_AUTOQUIT_MS) || 0;

function scheduleAutoQuit() {
  if (autoquitMs > 0) {
    log(`auto-quit scheduled in ${autoquitMs}ms`);
    setTimeout(() => app.quit(), autoquitMs);
  }
}

// ---------------------------------------------------------------------------
// logging helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[shell]", ...args);
}

function err(...args) {
  console.error("[shell]", ...args);
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function userDataDir() {
  return app.getPath("userData");
}

function engineDshVersionPath() {
  return path.join(ENGINE_DIR, "node_modules", DSH_PACKAGE, "package.json");
}

/** 当前“正在运行/将运行”的引擎版本（首次安装前可能为 null）。 */
let engineVersion = null;

function installedVersionNow() {
  try {
    return JSON.parse(fs.readFileSync(engineDshVersionPath(), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** 主窗口标题显示 DSH GUI 应用版本；托盘提示同时给出 GUI 与引擎版本。 */
function applyEngineVersionChrome() {
  const appV = app.getVersion() || "0.0.0";
  const engV = engineVersion ?? installedVersionNow();
  const label = `DSH GUI v${appV}`;
  if (win && !win.isDestroyed()) win.setTitle(label);
  if (tray && !tray.isDestroyed()) {
    const engineLabel = resolveUiLang() === "zh" ? "引擎" : "engine";
    tray.setToolTip(engV ? `DSH GUI v${appV} · ${engineLabel} v${engV}` : `DSH GUI v${appV}`);
  }
  return engV;
}

function engineDshBinPath() {
  return path.join(ENGINE_DIR, "node_modules", DSH_PACKAGE, "lib", "bin.js");
}

function iconPath(name) {
  // Icons live next to this file (src), packaged inside app.asar as well.
  return path.join(__dirname, name);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  settingsPath = path.join(userDataDir(), "settings.json");
  try {
    const raw = (await fsp.readFile(settingsPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (UPDATE_POLICIES[parsed.updatePolicy]) settings.updatePolicy = parsed.updatePolicy;
    if (UPDATE_CHANNELS[parsed.updateChannel]) settings.updateChannel = parsed.updateChannel;
    if (DSH_HOME_MODES[parsed.dshHomeMode]) settings.dshHomeMode = parsed.dshHomeMode;
    if (typeof parsed.updateCheckEnabled === "boolean") settings.updateCheckEnabled = parsed.updateCheckEnabled;
    if (parsed.closeAction === "tray" || parsed.closeAction === "quit") settings.closeAction = parsed.closeAction;
    if (typeof parsed.autoRestoreLastSession === "boolean") settings.autoRestoreLastSession = parsed.autoRestoreLastSession;
    // 旧版本持久化的 autoPlugins（勾选意图）已废弃：勾选框=安装状态实时镜像，
    // 不再保存期望集合。旧字段保留在 settings.json 里但不再参与任何逻辑。
    if (UI_LOCALES[parsed.locale]) settings.locale = parsed.locale;
    if (APPEARANCE_MODES[parsed.appearance]) settings.appearance = parsed.appearance;
    if (typeof parsed.engineNode === "string") settings.engineNode = parsed.engineNode;
    if (typeof parsed.lastNotifiedVersion === "string") settings.lastNotifiedVersion = parsed.lastNotifiedVersion;
    if (typeof parsed.lastCheckedAt === "number") settings.lastCheckedAt = parsed.lastCheckedAt;
  } catch {
    /* first run: keep defaults */
  }
  // Resolve the harness home per mode. DSH_SHELL_HOME (test) always wins.
  const explicitTestHome = process.env.DSH_SHELL_HOME;
  dshHome =
    (explicitTestHome && explicitTestHome.trim() !== "" && explicitTestHome) ||
    (settings.dshHomeMode === "system"
      ? null // null -> let dsh fall back to ~/.dsh
      : path.join(userDataDir(), "dsh-home"));
  log("settings:", JSON.stringify(settings), "| dshHome:", dshHome ?? "~/.dsh");
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  if (!settingsPath) settingsPath = path.join(userDataDir(), "settings.json");
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  broadcastSettings();
}

async function applySettingsPatch(patch) {
  const next = {};
  if (typeof patch.updatePolicy === "string" && UPDATE_POLICIES[patch.updatePolicy]) next.updatePolicy = patch.updatePolicy;
  if (typeof patch.updateChannel === "string" && UPDATE_CHANNELS[patch.updateChannel]) next.updateChannel = patch.updateChannel;
  if (typeof patch.updateCheckEnabled === "boolean") next.updateCheckEnabled = patch.updateCheckEnabled;
  if (patch.closeAction === "tray" || patch.closeAction === "quit") next.closeAction = patch.closeAction;
  if (typeof patch.autoRestoreLastSession === "boolean") next.autoRestoreLastSession = patch.autoRestoreLastSession;
  // autoPlugins 已废弃（不再持久化勾选意图）。
  if (UI_LOCALES[patch.locale]) next.locale = patch.locale;
  if (APPEARANCE_MODES[patch.appearance]) next.appearance = patch.appearance;
  if (Object.keys(next).length > 0) {
    await saveSettings(next);
    buildMenu();
    scheduleUpdateChecks();
    if (Object.prototype.hasOwnProperty.call(next, "locale")) {
      refreshTrayMenu();
      applyEngineVersionChrome();
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.setTitle(L("settings.titleBar"));
      }
      await syncEngineUI({ locale: resolveUiLang() }).catch((error) => err("syncEngineUI locale failed:", error.message));
      if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
        // 页面内文案跟随引擎 locale 服务；引擎设置文件热发布后由引擎自行切换。
        log("ui locale ->", resolveUiLang());
      }
    }
    if (Object.prototype.hasOwnProperty.call(next, "appearance")) {
      // 立即按新外观模式应用；显式选择（非“跟随引擎”）同时写回引擎设置文件。
      await refreshAppearance();
      const pushTheme = engineThemeForAppearance(next.appearance);
      if (pushTheme) {
        await syncEngineUI({ theme: pushTheme }).catch((error) => err("syncEngineUI theme failed:", error.message));
      }
    }
  }
  // Data-directory switches go through the guarded flow (data check + move).
  if (typeof patch.dshHomeMode === "string" && DSH_HOME_MODES[patch.dshHomeMode]) {
    await switchHomeMode(patch.dshHomeMode).catch((error) => err("switchHomeMode failed:", error));
  }
  return settings;
}

// ---------------------------------------------------------------------------
// harness home switching (with data check + optional move)
// ---------------------------------------------------------------------------

function effectiveHomePath() {
  // The active harness home the engine currently uses.
  return dshHome ?? defaultDshHome();
}

async function killEngineForSwitch() {
  if (!dshChild) return false;
  intentionalEngineStop = true;
  await new Promise((resolve) => killProcessTree(dshChild, resolve));
  dshChild = null;
  engineStarted = false;
  lastEngineUrl = null;
  log("engine stopped for home switch");
  return true;
}

async function restartEngineAfterSwitch(nodeExec) {
  setStatus(L("home.switched"), L("home.restarting"));
  await startEngine(nodeExec);
  // 新引擎就绪后清除“有意停止”标记（startEngine 内 onUrl 复位 isIntentional 也可以）。
  setTimeout(() => {
    intentionalEngineStop = false;
  }, 5000);
}

/**
 * Switch the harness data directory. If the current home holds data, ask the
 * user whether to move it; on consent (and safe, engine stopped) the data is
 * moved, then the engine is restarted against the new home.
 */
async function switchHomeMode(mode) {
  if (mode === settings.dshHomeMode) return;
  const srcPath = effectiveHomePath();
  const dstPath = mode === "system" ? defaultDshHome() : path.join(userDataDir(), "dsh-home");
  const parent = win ?? settingsWin;
  let doMove = false;

  const hasData = await hasHomeData(srcPath);
  if (hasData && path.resolve(srcPath) !== path.resolve(dstPath)) {
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("home.switchTitle"),
        message: L("home.hasDataMsg", srcPath),
        detail: L("home.hasDataDetail", dstPath),
        buttons: [L("home.moveAndSwitch"), L("home.switchOnly")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    doMove = response === 0;
  } else {
    log("home switch: source has no data (or same path), no move needed");
  }

  if (doMove) {
    await killEngineForSwitch(); // stop writers before moving files
    log("moving harness data:", srcPath, "->", dstPath);
    setStatus(L("home.switching"), "");
    const result = await moveHomeData(srcPath, dstPath);
    log("move result:", JSON.stringify(result));
    if (result.skipped.length > 0) {
      dialog
        .showMessageBox(parent, {
          type: "warning",
          title: L("home.partial.title"),
          message: L("home.partial.msg", result.moved, result.skipped.length),
          detail: result.skipped.join("\n"),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    } else {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("home.moved.title"),
          message: L("home.moved.msg", result.moved, dstPath),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    }
  } else if (hasData && path.resolve(srcPath) !== path.resolve(dstPath)) {
    log("home switch: user chose not to move data");
  }

  await saveSettings({ dshHomeMode: mode });
  // Re-resolve the effective home for the engine side.
  const testHome = process.env.DSH_SHELL_HOME;
  dshHome =
    mode === "system"
      ? null
      : testHome && testHome.trim() !== ""
        ? testHome
        : path.join(userDataDir(), "dsh-home");
  log("dshHome now:", dshHome ?? "~/.dsh");
  buildMenu();
  // 新数据目录的引擎外观/语言设置重新读入，并让热跟随 watch 指向新目录。
  await readEngineUiPrefs().catch(() => {});
  await refreshAppearance().catch((error) => err("refreshAppearance failed:", error.message));
  startEngineSettingsWatcher();
  // 热跟随 <DSH_HOME>/profiles/web/package.json：插件市场那边禁用/卸载插件后，
  // 设置窗口的第三方插件勾选状态要跟着刷新。
  stopProfileWatcher();
  startProfileWatcher();

  // If the engine was running against the old home (moved or not), restart it
  // so this session keeps working on the new home.
  if (doMove) {
    const nodeExec = resolveNodeExecutable();
    await restartEngineAfterSwitch(nodeExec);
  }
}

function broadcastSettings() {
  for (const target of [settingsWin]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send("settings:changed", settingsPayload());
    }
  }
}

/** 设置窗口看到的数据：持久设置 + 界面语言 + 引擎版本信息 + 插件目录。 */
function settingsPayload() {
  const currentEngine = engineVersion ?? installedVersionNow();
  const compat = pluginEngineCompat(currentEngine);
  return {
    ...settings,
    uiLang: resolveUiLang(),
    installedEngine: currentEngine,
    checkIntervalMinutes: Math.round(ENGINE_CHECK_INTERVAL_MS / 60000),
    engineRunning: Boolean(engineStarted && dshChild),
    pluginCatalog: PLUGIN_CATALOG.map((entry) => ({
      id: entry.id,
      pkg: entry.pkg,
      zh: entry.zh,
      en: entry.en,
      zhDesc: entry.zhDesc,
      enDesc: entry.enDesc,
      url: entry.url,
      zhEngine: entry.zhEngine ?? null,
      enEngine: entry.enEngine ?? null,
      engineRange: entry.engineRange ?? null,
      engineOk: (compat[entry.id] && compat[entry.id].ok) ?? true,
    })),
    // 勾选框 = 安装状态实时镜像：插件状态在这里，设置窗口据此勾/不勾。
    pluginStatus: pluginCatalogStatus(effectiveHomePath()),
  };
}

// ---------------------------------------------------------------------------
// node / npm resolution
// ---------------------------------------------------------------------------

/** Bundled portable Node shipped inside the app (resources/node). */
function bundledNodeExecutable() {
  const candidates =
    process.platform === "win32"
      ? [path.join(process.resourcesPath, "node", "node.exe")]
      : [path.join(process.resourcesPath, "node", "bin", "node")];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Resolve the Node executable used to run the engine. Order:
 * bundled portable node -> $DSH_SHELL_NODE -> Node on PATH.
 */
function resolveNodeExecutable() {
  const bundled = bundledNodeExecutable();
  if (bundled) {
    log("using bundled node:", bundled);
    return bundled;
  }
  const explicit = process.env.DSH_SHELL_NODE;
  if (explicit && explicit.trim() !== "") {
    log("using DSH_SHELL_NODE:", explicit);
    return explicit.trim();
  }
  const probe = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  return process.platform === "win32" ? "node.exe" : "node";
}

function resolveNpmCli(nodeExec) {
  const installerDir = path.dirname(nodeExec);
  const prefixDir = path.dirname(installerDir);
  const candidates = [
    path.join(installerDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(prefixDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(prefixDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const probe = spawnSync(nodeExec, ["-e", "console.log(require.resolve('npm/bin/npm-cli.js'))"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  return null;
}

/**
 * A Node that carries npm, for installing the engine.
 */
function resolveNpmProvider() {
  const candidates = [];
  const explicit = process.env.DSH_SHELL_NODE;
  if (explicit && explicit.trim() !== "") candidates.push(explicit.trim());
  const bundled = bundledNodeExecutable();
  if (bundled) candidates.push(bundled);
  if (candidates.every((c) => resolveNpmCli(c) === null)) {
    // No explicit/bundled node carries npm -> use the host Node on PATH.
    const probe = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") candidates.push(probe.stdout.trim());
  }
  for (const node of candidates) {
    const cli = resolveNpmCli(node);
    if (cli) return { node, cli };
  }
  throw new Error("cannot locate any Node that ships npm (npm-cli.js)");
}

function nodeVersionOf(nodeExec) {
  const probe = spawnSync(nodeExec, ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// bundled plugin staging root (space-free path required by pnpm install)
// ---------------------------------------------------------------------------

/**
 * 8.3 短路径：仅当路径含空格且系统能给出短路径时缩短，否则原样返回。
 * 引擎用 shell 转发参数给 pnpm（Node 26 起 shell:true 不再转义参数），
 * file: spec 里出现空格会被 cmd 拆词，所以含空格的路径必须先做短化。
 */
function shortPathIfSpaced(p) {
  if (!/\s/u.test(p)) return p;
  try {
    const probe = spawnSync(
      "cmd",
      ["/d", "/s", "/c", `for %I in ("${p}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true },
    );
    const short = probe.status === 0 ? String(probe.stdout ?? "").trim() : "";
    if (short && !/\s/u.test(short) && fs.existsSync(short)) return short;
  } catch {
    /* keep long path */
  }
  return p;
}

/**
 * 捆绑插件（随应用发布、源码在 app.asar/plugins 里的本地插件）安装前的
 * staging 根目录。必须是「稳定 + 无空格」的绝对路径：
 *  - 稳定：pnpm 把 `file:` spec 原样写进 profile 的 dependencies，之后该
 *    profile 里再跑 pnpm 仍要能解析到同一份拷贝；
 *  - 无空格：userData 通常是 "...\DSH GUI\..."（含空格），经引擎 shell 转发给
 *    pnpm 会被拆词。取 <home>\.dsh-gui\bundled-plugins，必要时 8.3 短化。
 */
function pluginBundledPluginsDir() {
  const dir = path.join(os.homedir(), ".dsh-gui", "bundled-plugins");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    err("plugin staging dir create failed:", error.message);
  }
  return shortPathIfSpaced(dir);
}

/**
 * 操作当前 profile 应使用的 pnpm spec：跟随「构建该 profile node_modules 的
 * pnpm 主版本」（marketplace 可能用 pnpm 12 建过；混用 pnpm 10 会
 * ERR_PNPM_UNEXPECTED_STORE），新 profile 回落 pnpm@10。
 */
function profilePnpmSpec() {
  return readProfilePnpmManagerFn(effectiveHomePath()) ?? "pnpm@10";
}

// ---------------------------------------------------------------------------
// version engine
// ---------------------------------------------------------------------------

async function fetchLatestVersion(timeoutMs = 8000) {
  // Test-only override so CI can exercise the update path deterministically.
  if (process.env.DSH_SHELL_TEST_LATEST) return process.env.DSH_SHELL_TEST_LATEST;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 读全量 packument 并取“最高 semver（含预发布）”：GitHub 的 v0.1.3-alpha.2
    // 在 npm 上挂在 dist-tag `alpha`，而 `latest` 标签仍停留在旧版 —— 只读 /latest
    // 会漏掉新预发布版本。测试时可用 DSH_SHELL_REGISTRY_URL 指向完整 packument。
    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const data = await res.json();
    const all = Object.keys(data.versions ?? {}).filter((v) => semver.valid(v));
    const channel = UPDATE_CHANNELS[settings?.updateChannel] ? settings.updateChannel : "all";

    // npm：跟随 dist-tag `latest`（发布方认可线）。
    if (channel === "npm") {
      const tag = data["dist-tags"] && data["dist-tags"].latest;
      if (tag && all.includes(tag)) return tag;
    }
    // rc：跳过 alpha，取 rc / 正式版最高。
    const list =
      channel === "rc"
        ? all.filter((v) => {
            const pre = semver.prerelease(v);
            return !pre || pre[0] !== "alpha";
          })
        : all; // all：最高合法版本（含 alpha/beta/rc 预发布）
    return list.sort((a, b) => (semver.lt(a, b) ? 1 : -1))[0] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function readInstalledVersion() {
  try {
    const pkg = JSON.parse(await fsp.readFile(engineDshVersionPath(), "utf8"));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Install `@deepseek-ai/dsh` into ENGINE_DIR with a dedicated npm cache.
 * `version` may be null to install the latest (unversioned spec).
 */
function npmInstall(version, onProgress) {
  return new Promise((resolve, reject) => {
    let npm;
    try {
      npm = resolveNpmProvider();
    } catch (error) {
      reject(error);
      return;
    }
    const { node: nodeExec, cli: npmCli } = npm;
    const spec = version ? `${DSH_PACKAGE}@${version}` : DSH_PACKAGE;
    // 装进同卷的临时前缀（<ENGINE_DIR>.stage），成功后原子替换 ENGINE_DIR。
    // 老实现直接 `--prefix ENGINE_DIR` 增量装：更新时 npm 的新依赖会沉进
    // @deepseek-ai/dsh 的 nested node_modules，旧树根部残留的 hoist
    // （cordis-plugin-loader 等）原样留下 → 引擎在根 import 不到 nested 的
    // client-ui 包，ERR_MODULE_NOT_FOUND 挡死整个启动。级联安装必须从空目录
    // 开始（产物全部 hoist 到根），再整体换入；失败时旧引擎原样保留可回滚。
    const stage = `${ENGINE_DIR}.stage`;
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* stale stage dir unwritable -> npm fails loudly below */
    }
    const args = [
      npmCli,
      "install",
      spec,
      "--prefix", stage,
      "--no-audit", "--no-fund", "--no-save",
      "--loglevel", "error",
    ];
    log("npm", args.join(" "));
    const child = spawn(nodeExec, args, {
      env: {
        ...process.env,
        npm_config_cache: NPM_CACHE_DIR,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      tail = (tail + chunk).split(/\r?\n/u).slice(-6).join("\n");
      const line = chunk
        .split(/\r?\n/u)
        .filter((l) => l.trim() !== "")
        .pop();
      if (line) onProgress?.(line.trim());
    });
    const cleanupStage = () => {
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    child.on("error", (error) => {
      cleanupStage();
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        cleanupStage();
        reject(new Error(`npm install exited with ${code}\n${tail}`));
        return;
      }
      try {
        // 原子换入：旧树挪走 -> stage 换入 -> 删旧树。任一步失败都尽量还原。
        const old = `${ENGINE_DIR}.old`;
        try {
          fs.rmSync(old, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        if (fs.existsSync(ENGINE_DIR)) fs.renameSync(ENGINE_DIR, old);
        try {
          fs.renameSync(stage, ENGINE_DIR);
        } catch (error) {
          if (fs.existsSync(old) && !fs.existsSync(ENGINE_DIR)) {
            try {
              fs.renameSync(old, ENGINE_DIR);
            } catch {
              /* keep old; install reported as failed below */
            }
          }
          cleanupStage();
          reject(error);
          return;
        }
        try {
          fs.rmSync(old, { recursive: true, force: true });
        } catch {
          /* stale .old dir is harmless */
        }
        resolve();
      } catch (error) {
        cleanupStage();
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// dsh child process
// ---------------------------------------------------------------------------

function spawnDsh(nodeExec, { onUrl, onExit, onError }) {
  const bin = engineDshBinPath();
  if (!fs.existsSync(bin)) {
    onError(new Error(`engine not found: ${bin}`));
    return null;
  }
  const env = {
    ...process.env,
    ...(dshHome ? { DSH_HOME: dshHome } : {}),
  };
  const child = spawn(
    nodeExec,
    [bin, "web", "--no-open", "--port", "0"],
    {
      cwd: os.homedir(), // default workspace root for dsh
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffer = "";
  const tail = [];
  const pushTail = (text) => {
    for (const line of String(text).split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > 400) tail.shift();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pushTail(chunk);
    buffer += chunk;
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
    const match = buffer.match(/^dsh web: (\S+)\s*$/m);
    if (match) onUrl(match[1]);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    pushTail(chunk);
  });
  child.on("error", onError);
  child.on("exit", (code, signal) => onExit(code, signal));
  // 供启动失败诊断读取最近的引擎输出。
  child.__dshTail = () => tail.join("\n");
  return child;
}

function killProcessTree(child, done) {
  if (!child || child.pid === undefined) {
    done?.();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", () => done?.());
    killer.on("error", () => done?.());
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      done?.();
    }, 2000);
  }
}

/**
 * GUI 托管的“重启引擎”：杀掉当前 dsh 子进程，再按既有流程重新拉起（重新加载
 * web profile → 新装/变更的插件在此生效）。与 app.relaunch 不同，不退出 DSH GUI，
 * 会话数据都在 $DSH_HOME 下，不受影响。
 */
function restartEngineNow(reason) {
  if (engineRestartInFlight) return { ok: false, reason: "already restarting" };
  if (!dshChild) return { ok: false, reason: "engine not running" };
  engineRestartInFlight = true;
  engineReady = false;
  intentionalEngineStop = true;
  log("restarting engine...", reason ?? "");
  const child = dshChild;
  dshChild = null;
  killProcessTree(child, () => {
    engineStarted = false;
    lastEngineUrl = null;
    const nodeExec = resolveNodeExecutable();
    startEngine(nodeExec)
      .catch((error) => {
        err("engine restart failed:", error);
        engineRestartInFlight = false;
        engineReady = false;
        intentionalEngineStop = false;
        fatalUi(error, L("engine.startFailed"));
      });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// window / status page
// ---------------------------------------------------------------------------

function setStatus(text, sub) {
  if (!win || win.isDestroyed()) return;
  const code = `(() => {
    const s = document.getElementById("status");
    if (s) s.textContent = ${JSON.stringify(text ?? "")};
    if (${JSON.stringify(sub ?? "")}) {
      const b = document.getElementById("sub");
      if (b) { b.textContent = ${JSON.stringify(sub ?? "")}; b.hidden = false; }
    }
  })()`;
  win.webContents.executeJavaScript(code).catch(() => {});
}

function fatalUi(error, title = L("common.startFailed")) {
  err(title, error);
  setStatus(title, String((error && error.message) || error));
  dialog
    .showMessageBox(win, {
      type: "error",
      title,
      message: `${title}：${L("startFailed")}`,
      detail: String((error && error.message) || error),
      buttons: [L("common.ok")],
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 启动失败诊断：保存启动错误日志，判断是否由第三方插件引起，按结果提示并可选禁用。
// ---------------------------------------------------------------------------

/** <userData>/logs/ 下的启动失败日志文件。 */
function startupErrorLogPath(tag) {
  const dir = path.join(userDataDir(), "logs");
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\.\d+Z$/, "");
  return path.join(dir, `dsh-start-${tag}-${stamp}.log`);
}

async function writeStartupErrorLog(file, { code, signal, tail }) {
  try {
    const lines = [
      `DSH GUI startup error log`,
      `time: ${new Date().toISOString()}`,
      `version: ${app.getVersion()}`,
      `engine: ${engineVersion ?? "unknown"}`,
      `exit: ${code ?? "?"} signal: ${signal ?? "none"}`,
      "",
      "---- engine output (tail) ----",
      String(tail ?? "").slice(-20000),
    ];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, lines.join("\n"), "utf8");
    return file;
  } catch (error) {
    err("write startup log failed:", error.message);
    return null;
  }
}

/**
 * 从引擎输出里找“可能出问题的插件”：逐个对照 profile 里已装的非基础 bundle，
 * 只要包名出现在输出（报错/路径）里就列为可疑。返回 [{id?, pkg}]（目录外插件无 id）。
 */
function suspectPluginsFromTail(tail, extraBundlePkgs) {
  const hay = String(tail ?? "").toLowerCase();
  const found = [];
  for (const pkg of extraBundlePkgs) {
    if (hay.includes(String(pkg).toLowerCase())) {
      const entry = PLUGIN_CATALOG.find((c) => c.pkg === pkg);
      found.push(entry ? { id: entry.id, pkg: entry.pkg } : { id: undefined, pkg });
    }
  }
  if (found.length === 0) {
    // 兜底：输出提到 bundle 层加载失败（overlay / cordis.patch / profile bundle），
    // 且确实装过第三方插件 → 把所有非基础 bundle 都列为可疑。
    const bundleSignals = ["cordis.patch", "overlay", "profile bundle", "failed to read", "plugin"];
    if (bundleSignals.some((s) => hay.includes(s)) && extraBundlePkgs.length > 0) {
      for (const pkg of extraBundlePkgs) {
        if (!found.some((f) => f.pkg === pkg)) {
          const entry = PLUGIN_CATALOG.find((c) => c.pkg === pkg);
          found.push(entry ? { id: entry.id, pkg: entry.pkg } : { id: undefined, pkg });
        }
      }
    }
  }
  return found;
}

function suspectsLabel(list) {
  return list
    .map((s) => {
      const entry = PLUGIN_CATALOG.find((c) => c.pkg === s.pkg);
      if (!entry) return s.pkg;
      const zh = entry.zh;
      const label = resolveUiLang() === "en" ? entry.en ?? s.pkg : zh;
      return `${label}（${s.pkg}）`;
    })
    .join("\n");
}

/**
 * 引擎启动失败后的统一入口：保存错误日志 → 判定是否插件问题 →
 * 插件问题则询问“禁用并重启”，非插件问题则展示查到的原因。
 * @param {object} o { code, signal, error, tail }
 * @returns {Promise<void>}
 */
async function diagnoseStartFailure({ code, signal, error, tail }) {
  const logFile = await writeStartupErrorLog(startupErrorLogPath("fail"), { code, signal, tail });
  const parent = win && !win.isDestroyed() ? win : undefined;
  // 已装 bundle（含基础层），取“可疑”插件：基础层之外的都算第三方。
  const profileBundles = readInstalledProfileBundles(effectiveHomePath());
  const extraBundles = profileBundles.filter(
    (pkg) => pkg !== "@deepseek-ai/dsh-base" && pkg !== "@deepseek-ai/dsh-web-app",
  );
  const suspects = suspectPluginsFromTail(`${tail ?? ""}\n${error?.message ?? ""}`, extraBundles);

  const logHint = logFile ? `\n\n${L("diag.savedLog", logFile)}` : "";
  if (suspects.length > 0) {
    // 测试钩子：自动选择“禁用并重启”（用于无人工冒烟）。
    const autoDisable = process.env.DSH_SHELL_TEST_AUTODISABLE === "1";
    const { response } = autoDisable
      ? { response: 0 }
      : await dialog
          .showMessageBox(parent, {
            type: "warning",
            title: L("diag.plugin.title"),
            message: L("diag.plugin.msg", suspectsLabel(suspects)),
            detail: `${L("diag.savedLog", logFile ?? "?")}`,
            buttons: [L("diag.plugin.disable"), L("diag.plugin.keep")],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .catch(() => ({ response: 1 }));
    if (response === 0) {
      // 禁用并重启：移除可疑插件（profiles bundle；勾选框随之经 watch 取消）后重拉引擎。
      try {
        const pnpmBinDir = await ensurePluginPnpm({
          installDir: path.join(userDataDir(), "pnpm-tools"),
          pnpmSpec: profilePnpmSpec(),
          nodeExec: resolveNodeExecutable(),
          log,
        });
        for (const suspect of suspects) {
          const res = await removeEnginePlugin({
            engineDir: ENGINE_DIR,
            dshHome: effectiveHomePath(),
            pnpmBinDir,
            pkg: suspect.pkg,
            nodeExec: resolveNodeExecutable(),
            log,
          });
          if (res.ok) continue;
          // 引擎 remove 失败（常见于依赖已不在 package.json：pnpm 报
          // ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS，正是会挡启动的 stale 登记）时
          // 兜底直接摘掉 bundle 登记——禁用语义等价，且不碰用户其余状态。
          try {
            const pruned = pruneProfileBundlesFn(effectiveHomePath(), [suspect.pkg]);
            if (pruned.includes(suspect.pkg)) {
              log("disable fallback: pruned stale bundle registration:", suspect.pkg);
              continue;
            }
          } catch (error) {
            err("disable fallback prune failed:", suspect.pkg, error.message);
          }
          err("disable plugin failed:", suspect.pkg, res.output.slice(-200));
        }
      } catch (error) {
        err("disable plugin failed:", error);
      }
      setStatus(L("diag.title"), L("diag.plugin.disable"));
      await startEngine(resolveNodeExecutable()).catch((error) => fatalUi(error, L("engine.startFailed")));
      return;
    }
    // 用户选择“保留”：给出日志路径，页面停留在失败信息。
    setStatus(L("engine.startFailed"), String(error?.message ?? code ?? ""));
    if (!autoDisable) {
      dialog
        .showMessageBox(parent, {
          type: "error",
          title: L("diag.plugin.title"),
          message: L("diag.plugin.msg", suspectsLabel(suspects)),
          detail: logHint,
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    }
    return;
  }

  // 非插件问题：展示查到的最后输出/错误。
  const reason = String(error?.message ?? tail ?? "").trim().slice(0, 2000);
  setStatus(L("diag.title"), (reason || "?").slice(0, 200));
  dialog
    .showMessageBox(parent, {
      type: "error",
      title: L("diag.notPlugin.title"),
      message: L("diag.notPlugin.msg", reason || "?"),
      detail: logHint,
      buttons: [L("common.ok")],
    })
    .catch(() => {});
}

/**
 * 启动失败统一入口（防御性包装）：本次启动只诊断一次，避免 onExit/watchdog 重复弹窗。
 * 自动剔除（pluginFailureRecoveryDone）与诊断各自独立：即便本次已自动剔除并重试过，
 * 若仍失败，仍应弹窗让用户决定（手动禁用 or 查看原因）。
 */
async function handleStartupFailure({ code, signal, error, tail }) {
  if (startupDiagnosisDone) return;
  startupDiagnosisDone = true;
  clearTimeout(pluginReadyWatchdog);
  pluginReadyWatchdog = null;
  await diagnoseStartFailure({ code, signal, error, tail: tail ?? "" }).catch((e2) =>
    err("startup diagnosis failed:", e2.message),
  );
}

/** 已退出/挂起的引擎输出尾部（若子进程还在则取它缓存的输出）。 */
function engineOutputTail() {
  try {
    return dshChild && typeof dshChild.__dshTail === "function" ? dshChild.__dshTail() : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// harness appearance (theme) adoption
// ---------------------------------------------------------------------------

let windowThemeDark = true;

function themeQuery() {
  return windowThemeDark ? "dark" : "light";
}

// 最近一次从 <DSH_HOME>/settings.yaml 读到的引擎 UI 配置（主题/语言），供
// “跟随引擎”模式与设置文件变更时热跟随。
let engineThemePref = "system";
let engineLocalePref = null;

/**
 * 启动/切目录时读取引擎设置文件里的主题与语言，作为“跟随引擎”的初始值。
 * 文件不存在或不可读时保留默认值（主题 system、语言跟随系统/引擎）。
 */
async function readEngineUiPrefs() {
  const file = path.join(effectiveHomePath(), "settings.yaml");
  try {
    const { theme, locale } = parseEngineSettings(await fsp.readFile(file, "utf8"));
    engineThemePref = theme ?? "system";
    engineLocalePref = locale ?? null;
    log("engine UI prefs:", { theme: engineThemePref, locale: engineLocalePref });
  } catch (error) {
    log("harness settings.yaml unreadable, keeping defaults:", error.message);
  }
}

function applyHarnessTheme(preference) {
  nativeTheme.themeSource = preference === "light" || preference === "dark" ? preference : "system";
  windowThemeDark =
    preference === "dark" ||
    (preference !== "light" && nativeTheme.shouldUseDarkColors);
  log("harness theme:", preference, "| window dark:", windowThemeDark);
}

/**
 * 按当前 GUI 外观模式算出生效主题并应用（原生窗口 + 已打开的子窗口）。
 * engine 模式先取一次最新引擎值；显式模式直接用所选值。
 */
async function refreshAppearance() {
  if ((settings.appearance ?? "engine") === "engine") {
    await readEngineUiPrefs().catch(() => {});
  }
  const mode = settings.appearance ?? "engine";
  applyHarnessTheme(mode === "engine" ? engineThemePref : mode);
  notifyChildWindowsTheme();
}

/** 把主题消息投递给一个子窗口：设置窗走 preload IPC，其余本地窗口用 executeJavaScript。 */
function sendThemeToWindow(target, theme) {
  if (!target || target.isDestroyed()) return;
  const apply = () => {
    if (target.isDestroyed()) return;
    try {
      target.setBackgroundColor(theme === "dark" ? "#0f151d" : "#ffffff");
    } catch {
      /* ignore */
    }
    if (target === settingsWin) {
      try {
        target.webContents.send("app:theme", theme);
      } catch {
        /* ignore */
      }
    } else {
      target.webContents
        .executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(theme)};` +
            `document.documentElement.style.colorScheme=${JSON.stringify(theme)};`,
        )
        .catch(() => {});
    }
  };
  if (target.webContents.isLoading()) target.webContents.once("did-finish-load", apply);
  else apply();
}

/**
 * 把新主题同步给已打开的本机子窗口（设置窗 / 更新角标）。主窗口内嵌的是引擎
 * 页面，主题由引擎自己热发布管理，这里不碰它。
 */
function notifyChildWindowsTheme() {
  const theme = themeQuery(); // "light" | "dark"
  sendThemeToWindow(settingsWin, theme);
  sendThemeToWindow(noticeWin, theme);
}

// ---------------------------------------------------------------------------
// 引擎 UI 设置热跟随（watch <DSH_HOME>/settings.yaml）
// ---------------------------------------------------------------------------

let engineSettingsWatcher = null;
let engineSettingsWatchTimer = null;
let engineSettingsWatchRetries = 0;

function startEngineSettingsWatcher() {
  stopEngineSettingsWatcher();
  const home = effectiveHomePath();
  const file = path.join(home, "settings.yaml");
  try {
    engineSettingsWatcher = fs.watch(home, { persistent: false }, (eventType, filename) => {
      const name = String(filename || "");
      if (name && name !== "settings.yaml") return;
      if (eventType === "rename" && !fs.existsSync(file)) return; // 删除/替换噪音
      if (engineSettingsWatchTimer) clearTimeout(engineSettingsWatchTimer);
      engineSettingsWatchTimer = setTimeout(() => {
        engineSettingsWatchTimer = null;
        onEngineSettingsChanged().catch((error) => err("engine settings watcher failed:", error.message));
      }, 300);
    });
    engineSettingsWatchRetries = 0;
    log("watching engine UI settings:", file);
  } catch (error) {
    // 目录可能还没被引擎建出来：稍后重试（引擎启动后会创建）。
    err("cannot watch engine settings.yaml:", error.message);
    if (engineSettingsWatchRetries < 10) {
      engineSettingsWatchRetries += 1;
      setTimeout(() => startEngineSettingsWatcher(), 5000);
    }
  }
}

function stopEngineSettingsWatcher() {
  if (engineSettingsWatchTimer) {
    clearTimeout(engineSettingsWatchTimer);
    engineSettingsWatchTimer = null;
  }
  if (engineSettingsWatcher) {
    try {
      engineSettingsWatcher.close();
    } catch {
      /* ignore */
    }
    engineSettingsWatcher = null;
  }
}

// ---------------------------------------------------------------------------
// profile 热跟随（watch package.json + cordis.patch.yml + 市场 state.json）
// ---------------------------------------------------------------------------
//
// 插件的两个正交状态各有各的文件：
//   - 安装/卸载 → profiles/web/package.json 的 dsh.profile.bundles；
//   - 启用/禁用 → profiles/web/cordis.patch.yml 的 `- id: X` + `disabled:` 行，
//     市场另外把包名记进 profiles/web/.dsh-market/state.json 的 disabled 列表。
// 用户在 Harness 页面的插件市场（dshmarket）里禁用/启用/卸载插件时改的就是这些
// 文件。GUI 不主动同步这一侧，只在这里 watch 变化后重算并向设置窗口广播——
// 状态由文件本身驱动，两侧显示自然一致。

let profileWatcher = null;
let profileWatchTimer = null;
let profileWatchRetries = 0;
let lastPluginStatusFingerprint = null;

/** profile 清单路径（可能尚不存在：引擎首次运行前由 dsh 创建）。 */
function profileManifestPath() {
  return path.join(effectiveHomePath(), "profiles", "web", "package.json");
}

/** watch 时要关注的 profile 目录内文件名（其余名字一律忽略）。 */
const PROFILE_WATCH_FILES = new Set(["package.json", "cordis.patch.yml"]);

/** 市场状态目录里的 state.json（启用/禁用的市场侧记录）。 */
function marketStateDir() {
  return path.join(effectiveHomePath(), "profiles", "web", ".dsh-market");
}

function startProfileWatcher() {
  stopProfileWatcher();
  const dir = path.dirname(profileManifestPath());
  const schedule = (label) => {
    if (profileWatchTimer) clearTimeout(profileWatchTimer);
    profileWatchTimer = setTimeout(() => {
      profileWatchTimer = null;
      onProfileChanged(label).catch((error) => err("profile watcher failed:", error.message));
    }, 400);
  };
  try {
    profileWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      const name = String(filename || "");
      // 空 filename 是平台的兜底（无法给出名字时），此时仍需重算。
      if (name && !PROFILE_WATCH_FILES.has(name)) return;
      schedule(name || "profile");
    });
    profileWatchRetries = 0;
    log("watching profile manifest:", profileManifestPath());
  } catch (error) {
    // 引擎还没建出 profiles/web：稍后重试。
    err("cannot watch profile manifest:", error.message);
    if (profileWatchRetries < 10) {
      profileWatchRetries += 1;
      setTimeout(() => startProfileWatcher(), 5000);
    }
  }
  // 市场状态目录单独 watch：它建得比 profile 晚（引擎首次跑市场才出现），
  // 所以用「不存在就重试」的独立循环，不能和上面的 profile watch 共用一个 try。
  startMarketWatcher();
}

let marketWatcher = null;
let marketWatchRetries = 0;

function startMarketWatcher() {
  if (marketWatcher) {
    try {
      marketWatcher.close();
    } catch {
      /* ignore */
    }
    marketWatcher = null;
  }
  const dir = marketStateDir();
  if (!fs.existsSync(dir)) {
    // 市场还没跑过：10 次（约 30s）内每 3s 试一次即可，之后由下一次
    // startProfileWatcher（引擎重启/profile 变化）再挂。
    if (marketWatchRetries < 10) {
      marketWatchRetries += 1;
      setTimeout(() => startMarketWatcher(), 3000);
    }
    return;
  }
  try {
    marketWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      const name = String(filename || "");
      if (name && name !== "state.json") return;
      if (profileWatchTimer) clearTimeout(profileWatchTimer);
      profileWatchTimer = setTimeout(() => {
        profileWatchTimer = null;
        onProfileChanged("market state").catch((error) => err("market watcher failed:", error.message));
      }, 400);
    });
    marketWatchRetries = 0;
    log("watching marketplace state:", path.join(dir, "state.json"));
  } catch (error) {
    err("cannot watch marketplace state:", error.message);
  }
}

function stopProfileWatcher() {
  if (profileWatchTimer) {
    clearTimeout(profileWatchTimer);
    profileWatchTimer = null;
  }
  if (profileWatcher) {
    try {
      profileWatcher.close();
    } catch {
      /* ignore */
    }
    profileWatcher = null;
  }
  if (marketWatcher) {
    try {
      marketWatcher.close();
    } catch {
      /* ignore */
    }
    marketWatcher = null;
  }
}

/**
 * profile 状态变化时：重算插件状态指纹，真的变了才广播（避免 GUI 自己安装/
 * 卸载/切换启用时写文件触发的重复刷新）。设置窗口收到后会重绘列表。
 */
async function onProfileChanged(source = "profile") {
  const status = pluginCatalogStatus(effectiveHomePath());
  const fingerprint = statusFingerprint(status);
  if (fingerprint === lastPluginStatusFingerprint) return;
  lastPluginStatusFingerprint = fingerprint;
  log(`plugin state changed outside the GUI (${source}):`, fingerprint);
  broadcastSettings();
}

/**
 * settings.yaml 变化时：主题/语言跟随引擎侧改动。GUI 自己写回的值会因“值相等”
 * 被跳过，不会产生循环；语言只在 GUI 处于“跟随系统”模式时采纳，且只改 GUI
 * 侧解析（不写回 yaml）。
 */
async function onEngineSettingsChanged() {
  let parsed;
  try {
    parsed = parseEngineSettings(await fsp.readFile(path.join(effectiveHomePath(), "settings.yaml"), "utf8"));
  } catch {
    return; // 写入中/被替换，等下一次事件
  }
  const nextTheme = parsed.theme ?? engineThemePref;
  if (nextTheme !== engineThemePref) {
    log("engine theme changed:", engineThemePref, "->", nextTheme);
    engineThemePref = nextTheme;
    if ((settings.appearance ?? "engine") === "engine") {
      applyHarnessTheme(nextTheme);
      notifyChildWindowsTheme();
    }
  }
  const nextLocale = parsed.locale ?? engineLocalePref;
  if (nextLocale !== engineLocalePref) {
    log("engine UI locale changed:", engineLocalePref, "->", nextLocale);
    engineLocalePref = nextLocale;
    if (settings.locale === "system" && nextLocale) {
      // “跟随系统”时跟随引擎页面的语言选择：外壳文案立即重算并刷新。
      buildMenu();
      refreshTrayMenu();
      applyEngineVersionChrome();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(L("settings.titleBar"));
      broadcastSettings();
    }
  }
}

// ---------------------------------------------------------------------------
// UI 语言（GUI 与引擎同步）
// ---------------------------------------------------------------------------

/**
 * 当前生效语言：zh | en。
 *  - locale=zh|en：显式选择；
 *  - locale=system：优先跟随引擎设置文件里的语言（引擎页面即用它），没有则按
 *    Electron 系统语言解析。
 */
function resolveUiLang() {
  if (settings.locale === "zh" || settings.locale === "en") return settings.locale;
  if (engineLocalePref === "zh" || engineLocalePref === "en") return engineLocalePref;
  let sys = "en";
  try {
    const loc = String(app.getLocale() ?? "").toLowerCase();
    if (loc.startsWith("zh")) sys = "zh";
  } catch {
    /* fall back to en */
  }
  return sys;
}

/** 当前语言下的文案。 */
function L(key, ...args) {
  const lang = resolveUiLang();
  const table = UI_STRINGS[lang] ?? UI_STRINGS.en;
  return fmt(table[key] ?? UI_STRINGS.en[key] ?? key, ...args);
}

/**
 * 把 GUI 的语言/外观选择写入引擎设置文件 <DSH_HOME>/settings.yaml 的
 * locale.preference / ui-theme.preference。引擎的 dsh-settings-file 会 watch
 * 该文件并热发布，内置 Harness UI 立即跟随。system 语言模式写入解析后的结果，
 * 保持 GUI 与引擎一致。文件不存在或不可写时静默跳过（非致命）。
 */
async function syncEngineUI(patch) {
  const home = effectiveHomePath();
  const file = path.join(home, "settings.yaml");
  await fsp.mkdir(home, { recursive: true }).catch(() => {});
  let doc;
  let locale = null;
  let theme = null;
  try {
    const text = await fsp.readFile(file, "utf8");
    ({ doc, locale, theme } = parseEngineSettings(text));
  } catch {
    doc = YAML.parseDocument("");
  }
  const changes = {};
  if (patch.locale !== undefined && patch.locale !== null && patch.locale !== locale) changes.locale = patch.locale;
  if (patch.theme !== undefined && patch.theme !== null && patch.theme !== theme) changes.theme = patch.theme;
  if (Object.keys(changes).length === 0) {
    log("engine UI settings already up to date");
    return;
  }
  await fsp.writeFile(file, applyEngineSettings(doc, changes), "utf8");
  log("engine UI settings synced:", file, "->", JSON.stringify(changes));
}

// ---------------------------------------------------------------------------
// persistent update notice (corner badge window)
// ---------------------------------------------------------------------------

let noticeWin = null;

function showUpdateNotice(title, sub) {
  if (!win || win.isDestroyed()) return;
  if (noticeWin && !noticeWin.isDestroyed()) {
    noticeWin.close();
    noticeWin = null;
  }
  const W = 360;
  const H = 92;
  noticeWin = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: windowThemeDark ? "#0f151d" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  noticeWin.setAlwaysOnTop(true, "screen-saver");
  noticeWin.loadFile(path.join(__dirname, "notice.html"), { query: { theme: themeQuery(), lang: resolveUiLang() } });
  noticeWin.webContents.once("did-finish-load", () => {
    noticeWin.webContents
      .executeJavaScript(
        `document.getElementById("t").textContent = ${JSON.stringify(title)};
         document.getElementById("s").textContent = ${JSON.stringify(sub ?? "")};`,
      )
      .then(() => {
        const mainBounds = win.getBounds();
        const area = screen.getDisplayMatching(mainBounds).workArea;
        const x = area.x + area.width - W - 16;
        const y = area.y + area.height - H - 16;
        noticeWin.setBounds({ x, y, width: W, height: H });
        noticeWin.show();
        log("update notice shown:", title);
      })
      .catch((error) => err("notice render failed:", error));
  });
  noticeWin.on("closed", () => {
    noticeWin = null;
  });
}

// ---------------------------------------------------------------------------
// main window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false, // shown maximized below (avoid normal-size flicker)
    autoHideMenuBar: true,
    title: "DeepSeek Harness",
    icon: iconPath("icon.png"),
    backgroundColor: windowThemeDark ? "#0b0f14" : "#f0f2f5",
    webPreferences: {
      // Non-persist partition -> in-memory session, fresh on every launch.
      partition: `dsh-launch-${Date.now()}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 页面内“重启回最近会话”的窄桥（记录/读取 last-session.json）。
      preload: path.join(__dirname, "workspace-preload.js"),
    },
  });
  // 主窗口启动最大化显示.
  win.maximize();
  win.show();
  applyEngineVersionChrome(); // 标题带上当前引擎版本（若有）
  win.loadFile(path.join(__dirname, "status.html"), { query: { theme: themeQuery(), lang: resolveUiLang() } });
  win.webContents.once("did-finish-load", () => {
    if (engineStarted && lastEngineUrl) {
      // Engine already running (window reopened from tray): reuse its URL.
      win.loadURL(lastEngineUrl).catch((error) => err("loadURL failed:", error));
      return;
    }
    boot().catch((error) => fatalUi(error));
  });
  win.webContents.on("page-title-updated", (event) => {
    // 页面想改标题时：阻止它，并把我们的“标题 + 版本号”设回去。
    event.preventDefault();
    applyEngineVersionChrome();
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed() && win.webContents.getURL().startsWith("http")) {
      log("embedded web contents loaded:", win.webContents.getURL());
      // 引擎页加载完成后标题可能被页面短暂覆盖，再次固定。
      setTimeout(() => applyEngineVersionChrome(), 0);
      // 页面就绪后：设置开启时，请网页端插件尽早尝试自动打开“最近一次对话”
      // （减少“先显示空白对话再切回”的时长；false = 每次从空白/新会话开始）。
      // 注意：不能只试一次——会话页客户端模块（dsh-client-ui-conversation 补丁，
      // 暴露 window.__dshOpenLast）在页面加载数秒后才执行 apply()，固定延时 300ms
      // 的一次探测在插件较重/机器较慢时会错过，且再无重试 → “重启后不回上次会话”。
      // 这里按固定间隔轮询，直到 __dshOpenLast 就位并调用成功，或到达上限放弃。
      const stopOpenLastPoll = () => {
        if (openLastPollTimer) {
          clearTimeout(openLastPollTimer);
          openLastPollTimer = null;
        }
      };
      stopOpenLastPoll();
      openLastPollTries = 0;
      if (openLastPollClosed && !win.isDestroyed()) {
        win.removeListener("closed", openLastPollClosed);
      }
      openLastPollClosed = () => {
        stopOpenLastPoll();
        openLastPollClosed = null;
      };
      win.once("closed", openLastPollClosed);
      const tryOpenLast = () => {
        openLastPollTimer = null;
        if (win.isDestroyed() || settings.autoRestoreLastSession === false) return;
        if (openLastPollTries >= 100) {
          // ~30s 上限：足够覆盖冷启动最慢的模块加载。
          log("auto-restore: gave up waiting for __dshOpenLast");
          return;
        }
        openLastPollTries += 1;
        win.webContents
          .executeJavaScript("if (window.__dshOpenLast) { window.__dshOpenLast(); true } else { false }")
          .then((done) => {
            if (done === true) {
              log("auto-restore: __dshOpenLast invoked on try", openLastPollTries);
              return;
            }
            openLastPollTimer = setTimeout(tryOpenLast, 300);
          })
          .catch((error) => {
            // 页面仍在加载/导航：稍后重试（不是致命错误）。
            err("auto-restore probe failed (retrying):", error.message);
            openLastPollTimer = setTimeout(tryOpenLast, 300);
          });
      };
      setTimeout(tryOpenLast, 300);

      // 诊断钩子（DSH_SHELL_PAGE_DEBUG=1）：转发页面 console，检查页面桥与
      // “最近会话”补丁暴露的 __dshOpenLast 是否就位。
      if (process.env.DSH_SHELL_PAGE_DEBUG === "1") {
        win.webContents.on("console-message", (event, level, message) => {
          log(`[page console ${level}]`, String(message).slice(0, 500));
        });
        const probeScript = `(async () => {
          const out = {};
          try {
            out.dshGui = typeof window.__dshGui;
            out.guiKeys = Object.keys(window.__dshGui || {});
            out.openLast = typeof window.__dshOpenLast;
            out.title = document.title;
          } catch (e) { out.error = String((e && e.stack) || e); }
          return JSON.stringify(out);
        })()`;
        setTimeout(() => {
          win.webContents
            .executeJavaScript(probeScript)
            .then((res) => log("PAGE_DEBUG_PROBE:", res))
            .catch((error) => err("PAGE_DEBUG_PROBE failed:", error.message));
        }, 3000);
      }
    }
  });
  win.on("close", (event) => {
    // The main window must not close while the modal settings window is open.
    if (!quitting && settingsWin && !settingsWin.isDestroyed()) {
      event.preventDefault();
      log("main window cannot close while settings window is open");
      return;
    }
    // Close-to-tray: intercept unless the app is actually quitting.
    if (!quitting && settings.closeAction === "tray" && hasTray) {
      event.preventDefault();
      win.hide();
      log("window hidden to tray (closeAction=tray)");
    }
  });
  win.on("closed", () => {
    win = null;
  });
  return win;
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------
// settings window
// ---------------------------------------------------------------------------

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const parent = win && !win.isDestroyed() ? win : undefined;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  settingsWin = new BrowserWindow({
    width: 800,
    height: Math.min(760, workArea.height - 40),
    // 双列布局：内容自适应高度（≤ 屏幕工作区），body 滚动仅作极短屏兜底。
    useContentSize: true,
    show: true,
    // Modal over the main window: while open, the main window cannot be
    // operated (clicked, minimized, or closed via its title bar).
    parent,
    modal: Boolean(parent),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: L("settings.titleBar"),
    icon: iconPath("icon.png"),
    backgroundColor: windowThemeDark ? "#0f151d" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"), {
    query: { theme: themeQuery(), lang: resolveUiLang() },
  });
  settingsWin.on("close", () => {
    // Guide the window back after the modal is gone (test/CI evidence).
    log("settings window closing");
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
    if (win && !win.isDestroyed()) log("main window enabled again:", win.isEnabled());
  });
  log("settings modal open; main enabled:", win && !win.isDestroyed() ? win.isEnabled() : "no-main");
}

// ---------------------------------------------------------------------------
// system tray
// ---------------------------------------------------------------------------

function trayMenuTemplate() {
  return Menu.buildFromTemplate([
    { label: L("tray.open"), click: () => showMainWindow() },
    { label: L("tray.guiUpdate"), click: () => runGuiUpdate() },
    { label: L("tray.settings"), click: () => openSettingsWindow() },
    { type: "separator" },
    { label: L("tray.quit"), click: () => app.quit() },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(trayMenuTemplate());
  } catch (error) {
    err("tray menu refresh failed:", error.message);
  }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath("tray-icon.png"));
    if (img.isEmpty()) throw new Error("tray icon is empty");
    tray = new Tray(img);
    hasTray = true;
    tray.setToolTip("DeepSeek Harness");
    tray.setContextMenu(trayMenuTemplate());
    tray.on("click", () => showMainWindow());
    applyEngineVersionChrome();
    log("tray created");
  } catch (error) {
    hasTray = false;
    err("tray unavailable:", error.message);
  }
}

// ---------------------------------------------------------------------------
// app menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const currentHome = settings.dshHomeMode;
  const setHomeMode = (mode) => {
    if (mode === currentHome) return;
    // switchHomeMode handles: data check -> optional move -> save -> restart.
    applySettingsPatch({ dshHomeMode: mode }).then(() => {
      log("dsh home mode ->", mode);
      buildMenu();
    });
  };
  const template = [
    {
      label: L("menu.settings"),
      submenu: [
        { label: L("menu.openSettings"), click: () => openSettingsWindow() },
        { type: "separator" },
        { label: L("menu.dataDir"), enabled: false },
        {
          type: "radio",
          label: L("menu.home.app"),
          checked: currentHome === "app",
          click: () => setHomeMode("app"),
        },
        {
          type: "radio",
          label: L("menu.home.system"),
          checked: currentHome === "system",
          click: () => setHomeMode("system"),
        },
        { type: "separator" },
        { role: "quit", label: L("menu.quit") },
      ],
    },
  ];
  if (process.platform === "darwin") {
    template.unshift({ role: "appMenu" });
    template.push({ role: "editMenu" });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// update checks (launch + periodic)
// ---------------------------------------------------------------------------

function scheduleUpdateChecks() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (!settings.updateCheckEnabled) return;
  updateCheckTimer = setTimeout(() => {
    runPeriodicUpdateCheck().catch((error) => err("periodic check failed:", error));
  }, ENGINE_CHECK_INTERVAL_MS);
  log(`next periodic update check in ${Math.round(ENGINE_CHECK_INTERVAL_MS / 60000)}min`);
}

async function runPeriodicUpdateCheck() {
  scheduleUpdateChecks(); // re-arm before awaiting
  if (checkingInProgress) return;
  checkingInProgress = true;
  try {
    const latest = await fetchLatestVersion();
    const installed = await readInstalledVersion();
    if (latest === null) return;
    if (installed === null) return; // boot handles first install
    if (semver.gte(installed, latest)) return;
    if (settings.lastNotifiedVersion === latest) return; // already told the user
    log("periodic check found newer:", installed, "->", latest);
    await saveSettings({ lastNotifiedVersion: latest });
    showUpdateNotice(L("update.notice.found", latest), L("update.notice.nextLaunch"));
  } finally {
    checkingInProgress = false;
  }
}

let guiCheckBusy = false;

/** 托盘“检查 DSH GUI 更新…”：查 GitHub Releases，有新版则询问并打开下载页。 */
async function runGuiUpdate() {
  if (guiCheckBusy) return;
  guiCheckBusy = true;
  const parent = win && !win.isDestroyed() ? win : undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let res;
    try {
      res = await fetch(GUI_REPO_API, {
        signal: controller.signal,
        headers: { accept: "application/vnd.github+json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const release = await res.json();
    const tag = String(release.tag_name || "").replace(/^v/i, "");
    const current = app.getVersion();
    if (!semver.valid(tag)) throw new Error("invalid release tag");
    if (!semver.lt(current, tag)) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.upToDate.title"),
          message: L("update.gui.upToDate", current),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return;
    }
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.gui.title"),
        message: L("update.gui.msg", tag),
        detail: L("update.gui.detail", current),
        buttons: [L("update.gui.open"), L("update.gui.cancel")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (response === 0) {
      shell.openExternal(GUI_RELEASES_URL).catch((error) => err("openExternal failed:", error.message));
    }
  } catch (error) {
    err("gui update check failed:", error);
    dialog
      .showMessageBox(parent, {
        type: "info",
        title: L("update.gui.cant.title"),
        message: L("update.gui.cant.msg"),
        detail: String((error && error.message) || error),
        buttons: [L("common.ok")],
      })
      .catch(() => {});
  } finally {
    guiCheckBusy = false;
  }
}

let engineCheckBusy = false;

/** 设置窗口「立即检查引擎更新」：查新版 → 有则询问 → 下载安装 → 询问重启。 */
async function runManualEngineUpdate() {
  if (engineCheckBusy) return { busy: true };
  engineCheckBusy = true;
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win && !win.isDestroyed() ? win : undefined;
  try {
    const latest = await fetchLatestVersion();
    const installed = await readInstalledVersion();
    if (latest === null) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.cantCheck"),
          message: L("update.cantReach"),
          detail: installed ? L("update.currentV", installed) : L("update.notInstalled"),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return { ok: true, status: "unreachable" };
    }
    if (installed !== null && semver.gte(installed, latest)) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.upToDate.title"),
          message: L("update.upToDate.msg", installed),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return { ok: true, status: "up-to-date" };
    }
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.found.title"),
        message: L("update.found.msg", latest),
        detail: L("update.found.detail", installed ?? L("update.notInstalled")),
        buttons: [L("update.nowRestart"), L("update.later")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (response !== 0) return { ok: true, status: "deferred" };

    log("manual engine update: installing", DSH_PACKAGE, "@" + latest);
    await npmInstall(latest, () => {});
    const nowV = await readInstalledVersion();
    log("manual engine update: installed", nowV ?? latest);
    engineVersion = nowV;
    applyEngineVersionChrome();
    broadcastSettings();
    await saveSettings({
      engineNode: (() => {
        try {
          return nodeVersionOf(resolveNodeExecutable());
        } catch {
          return settings.engineNode;
        }
      })(),
      lastNotifiedVersion: undefined,
    });
    const { response: restart } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.done.title"),
        message: L("update.done.msg", nowV ?? latest),
        detail: L("update.done.detail"),
        buttons: [L("update.restartNow"), L("update.restartLater")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (restart === 0) {
      log("manual engine update: restarting to use new engine");
      app.relaunch();
      app.quit();
    }
    return { ok: true, status: "installed", installed: nowV ?? latest };
  } catch (error) {
    err("manual engine update failed:", error);
    dialog
      .showMessageBox(parent, {
        type: "error",
        title: L("update.failed.title"),
        message: L("update.failed.msg"),
        detail: String((error && error.message) || error),
        buttons: [L("common.ok")],
      })
      .catch(() => {});
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    engineCheckBusy = false;
  }
}

// ---------------------------------------------------------------------------
// boot sequence
// ---------------------------------------------------------------------------

async function boot() {
  const nodeExec = resolveNodeExecutable();
  const nodeVersion = nodeVersionOf(nodeExec);

  ENGINE_DIR = path.join(userDataDir(), "dsh-engine");
  NPM_CACHE_DIR = path.join(userDataDir(), "npm-cache");
  await fsp.mkdir(ENGINE_DIR, { recursive: true });
  await fsp.mkdir(NPM_CACHE_DIR, { recursive: true });
  if (dshHome) await fsp.mkdir(dshHome, { recursive: true });

  // UI 语言：GUI 与引擎同步（system 模式在启动时解析一次并写入引擎设置文件）。
  try {
    await syncEngineUI({ locale: resolveUiLang() });
  } catch (error) {
    err("engine UI locale sync skipped:", error.message);
  }

  log("userData:", userDataDir());
  log("node:", nodeExec, "(", nodeVersion, ")");

  const installed = await readInstalledVersion();
  log("installed:", installed ?? "none");
  engineVersion = installed;
  applyEngineVersionChrome();

  // Decide whether to query the registry.
  let latest = null;
  let checkedThisLaunch = false;
  if (settings.updateCheckEnabled) {
    const last = typeof settings.lastCheckedAt === "number" ? settings.lastCheckedAt : 0;
    const due = Date.now() - last >= ENGINE_CHECK_INTERVAL_MS;
    if (due || installed === null) {
      checkedThisLaunch = true;
      setStatus(L("update.check"));
      try {
        latest = await fetchLatestVersion();
      } catch (error) {
        err("registry check failed:", error.message);
      }
      await saveSettings({ lastCheckedAt: Date.now() });
    } else {
      log("update check skipped (within interval)");
    }
  } else {
    log("update checking is disabled");
  }
  log("latest:", latest ?? "unreachable");

  // 引擎树结构自检：老版本 GUI 用 `npm install --prefix ENGINE_DIR` 增量更新，
  // 更新后根目录残留旧引擎的 hoist（cordis-plugin-loader 等），新依赖却沉进
  // @deepseek-ai/dsh 的 nested node_modules —— cordis-plugin-loader 在根 import
  // 不到 nested 的 @deepseek-ai/dsh-client-ui-* → ERR_MODULE_NOT_FOUND 挡死整个
  // 启动。健康安装是全部 hoist 到根。探针命中这种混合残留时，强制按当前版本
  // 走一次干净重装（npmInstall 现在是临时前缀 + 原子替换，产物必然干净布局）；
  // 24h 冷却防误判反复重装；注册表不可达则只记日志，等下次可达再修。
  const hybridEngineTree =
    installed !== null &&
    !fs.existsSync(path.join(ENGINE_DIR, "node_modules", "@deepseek-ai", "dsh-client-ui-commands")) &&
    fs.existsSync(
      path.join(ENGINE_DIR, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-client-ui-commands"),
    ) &&
    fs.existsSync(path.join(ENGINE_DIR, "node_modules", "@deepseek-ai", "cordis-plugin-loader"));
  const repairCooled =
    !(typeof settings.lastEngineRepairAt === "number" && Date.now() - settings.lastEngineRepairAt < 24 * 3600 * 1000);
  const forceEngineReinstall = hybridEngineTree && repairCooled && latest !== null;
  if (hybridEngineTree) {
    log(
      forceEngineReinstall
        ? `engine tree is a stale hoist mix; clean reinstall of ${installed} scheduled`
        : latest === null
          ? "engine tree is a stale hoist mix but registry is unreachable; will repair on a later launch"
          : "engine tree is a stale hoist mix; repair skipped within cooldown",
    );
  }

  // A Node runtime change (e.g. first run with a bundled portable node) makes
  // the previously installed engine's native modules ABI-incompatible -> reinstall.
  const nodeChanged = Boolean(
    settings.engineNode && nodeVersion && settings.engineNode !== nodeVersion,
  );
  const updateNeeded =
    installed === null ||
    (latest !== null && semver.lt(installed, latest)) ||
    nodeChanged ||
    forceEngineReinstall;
  log("updateNeeded:", updateNeeded, "| nodeChanged:", Boolean(nodeChanged));

  if (updateNeeded) {
    if (installed === null && latest === null && !settings.updateCheckEnabled) {
      // Update checks are off and we have no engine: one-time setup install.
      log("no engine and update checks disabled -> one-time install of latest");
      setStatus(L("update.status.first"), L("update.checksOff"));
      try {
        await npmInstall(null, (line) => setStatus(L("update.firstInstall"), String(line).slice(0, 120) || L("update.installProgress")));
        const installedNow = await readInstalledVersion();
        await saveSettings({ engineNode: nodeVersion ?? settings.engineNode, lastNotifiedVersion: undefined });
        log("engine installed:", installedNow);
        engineVersion = installedNow;
        applyEngineVersionChrome();
      } catch (error) {
        fatalUi(error, L("engine.installFailed"));
        return;
      }
    } else if (installed !== null && latest === null) {
      // Registry unreachable but engine present -> run what we have (offline).
      log("offline fallback");
      setStatus(L("update.status.offline", installed), L("update.starting"));
    } else {
      const verb =
        installed === null
          ? L("update.firstInstall")
          : nodeChanged
            ? L("update.reinstallRuntime")
            : L("update.newVersion", latest, installed);
      const policy = settings.updatePolicy;

      // "ask": let the user choose, unless we have no choice at all.
      if (policy === "ask" && installed !== null && !nodeChanged && !forceEngineReinstall && latest !== null) {
        const { response } = await dialog
          .showMessageBox(win, {
            type: "question",
            title: L("update.bootQuestion.title"),
            message: L("update.bootQuestion.msg", latest),
            detail: L("update.bootQuestion.detail", installed),
            buttons: [L("update.bootNow"), L("update.bootUseCurrent")],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .catch(() => ({ response: 0 }));
        if (response === 1) {
          log("user skipped update");
          setStatus(L("update.status.skipped", installed), L("update.starting"));
          await startEngine(nodeExec);
          scheduleUpdateChecks();
          return;
        }
      }

      // "notify": only inform, never install (unless we must install to run at all,
      // or the tree is broken and needs a same-version repair).
      if (policy === "notify" && installed !== null && !nodeChanged && !forceEngineReinstall && latest !== null) {
        log("notify-only policy: skipping install");
        showUpdateNotice(L("update.notice.found", latest), L("update.notice.detailAuto"));
        setStatus(L("update.status.found", latest), L("update.starting"));
        await startEngine(nodeExec);
        scheduleUpdateChecks();
        return;
      }

      // auto (or forced) -> install.
      log("installing", DSH_PACKAGE, latest ? `@${latest}` : "(latest)");
      setStatus(verb, L("update.installProgress"));
      try {
        await npmInstall(latest, (line) =>
          setStatus(verb, String(line).slice(0, 120) || L("update.installProgress")),
        );
        const installedNow = await readInstalledVersion();
        log("engine updated to", installedNow ?? latest);
        engineVersion = installedNow;
        applyEngineVersionChrome();
        await saveSettings({
          engineNode: nodeVersion ?? settings.engineNode,
          lastNotifiedVersion: undefined,
          ...(forceEngineReinstall ? { lastEngineRepairAt: Date.now() } : {}),
        });
        if (installedNow && installedNow !== installed) {
          showUpdateNotice(L("update.notice.updated", installedNow), L("update.notice.thisLaunch"));
        }
        setStatus(L("update.status.ready", installedNow ?? latest), L("update.starting"));
      } catch (error) {
        err("engine update failed:", error);
        if (installed !== null) {
          dialog
            .showMessageBox(win, {
              type: "warning",
              title: L("update.failed.title"),
              message: L("update.autoUpdateFailed", latest),
              detail: `${String((error && error.message) || error)}\n\n${L("update.failed.willUseCurrent", installed)}`,
              buttons: [L("common.continue")],
            })
            .catch(() => {});
          setStatus(L("update.status.failed", installed), L("update.starting"));
        } else {
          fatalUi(error, L("engine.installFailed"));
          return;
        }
      }
    }
  } else if (installed !== null) {
    if (checkedThisLaunch) {
      log("engine already up to date");
      setStatus(L("update.status.upToDate", installed), L("update.starting"));
    } else {
      log("engine present; skipped registry check (within interval / disabled)");
      setStatus(L("update.status.ready", installed), L("update.starting"));
    }
  }

  await startEngine(nodeExec);
  scheduleUpdateChecks();

  // Test-only hook: force an update notice for CI verification.
  if (process.env.DSH_SHELL_TEST_NOTICE) {
    showUpdateNotice(L("update.notice.updated", "9.9.9-test"), L("update.notice.thisLaunch"));
  }
}

async function startEngine(nodeExec) {
  setStatus(L("update.starting"), L("update.firstInit"));
  // 给引擎客户端打幂等小补丁（“重启回最近会话”页内逻辑；锚点不匹配跳过不阻塞）。
  // 注意：这只是**兜底**。主实现是插件 dsh-gui-last-session；补丁在锚点存在时
  // 仍会打上（旧引擎/未装插件的用户照常可用），锚点不存在就跳过、不再因版本号
  // 不同而静默失效。
  try {
    ensureEnginePatches({ engineDir: ENGINE_DIR, log });
  } catch (error) {
    err("engine patch skipped:", error.message);
  }
  // 把 GUI 自己的“最近会话”指针交接给插件（单向补齐，插件已有则不覆盖）。
  await handOffLastSessionToPlugin();
  // 第三方插件对账（幂等；任一步失败只记日志，不影响启动）。
  // 勾选框 = 安装状态的实时镜像（不再持久化期望集合），所以启动时**不存在**
  // “按上次勾选自动安装”这回事——profile 里的已装集合本身就是状态。启动对账
  // 只做两件维护（针对目录内**已安装**的条目）：
  //   1. 捆绑插件的随包源版本落后于应用版本时重装（让 profile 拷贝跟上代码）；
  //   2. 已装但对当前引擎不兼容的目录插件（会让 profile 启动崩溃，如
  //      dsh-agent-teams 0.1.15 ↔ 0.1.2-rc.1）在 spawn 引擎前移除。
  // 非目录/用户手动装的额外 bundle 一律不动（交给“启动失败诊断”弹窗处理）。
  // 没有已装的目录插件时跳过整个对账（省掉一次 pnpm 自举）。
  pluginsInstalledThisLaunch = [];
  startupDiagnosisDone = false;
  // 自愈：修剪 profile 里不可解析 / 失效的 bundle 登记。引擎 reconcile 单靠
  // 自己清不掉这类条目（`dsh plugin remove` 会因依赖缺失报错、reconcile 又只
  // 管“依赖里成功解析且声明 dsh.bundle”的包），坏掉的安装/卸载留下的 stale
  // 登记会把引擎启动挡死（`cannot resolve profile bundle`）。这里在 spawn 前
  // 直接对账 manifest——有则修剪/补装，无则零开销返回。任何失败只记日志。
  try {
    const healed = await healProfileBundlesFn({
      engineDir: ENGINE_DIR,
      dshHome: effectiveHomePath(),
      nodeExec,
      pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
      log,
    });
    if (healed.changed) {
      log(
        "profile bundle self-heal:",
        healed.pruned.length > 0 ? `pruned [${healed.pruned.join(", ")}]` : "no prune",
        healed.repaired.length > 0 ? `repaired [${healed.repaired.join(", ")}]` : "",
      );
    }
    if (healed.errors.length > 0) err("profile bundle self-heal issues:", healed.errors.join(" | "));
  } catch (error) {
    err("profile bundle self-heal skipped:", error.message);
  }
  // 旧插件清理必须**先于**安装对账：目录条目改名后，profile 里还留着旧包名的
  // 登记与拷贝，而启动维护只按当前 CATALOG 对账、看不见它们 —— 结果新旧两版同时
  // 加载（两个页内控件 + 路由冲突）。这里摘除旧包，并把「替代条目」交给下面的
  // 安装对账，让原先装过它的用户平滑换成新插件（含沿用启用/禁用意图）。
  let legacyPlugins = { pruned: [], removedRows: [], replaced: [], changed: false };
  try {
    legacyPlugins = await removeLegacyPlugins({
      engineDir: ENGINE_DIR,
      dshHome: effectiveHomePath(),
      nodeExec,
      pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
      log,
    });
    if (legacyPlugins.changed) {
      log(
        "legacy plugins cleaned:",
        legacyPlugins.pruned.length > 0 ? `pruned [${legacyPlugins.pruned.join(", ")}]` : "",
        legacyPlugins.removedRows.length > 0 ? `rows [${legacyPlugins.removedRows.join(", ")}]` : "",
        legacyPlugins.replaced.length > 0 ? `replaced by [${legacyPlugins.replaced.join(", ")}]` : "",
      );
    }
  } catch (error) {
    err("legacy plugin cleanup skipped:", error.message);
  }
  const bootStatus = pluginCatalogStatus(effectiveHomePath());
  const installedCatalogIds = PLUGIN_CATALOG.filter((entry) => bootStatus[entry.id] && bootStatus[entry.id].installed).map(
    (entry) => entry.id,
  );
  // 被旧插件替代的条目视为「用户本来就要用」——原样装上，别让改名把功能弄丢。
  for (const id of legacyPlugins.replaced) {
    if (!installedCatalogIds.includes(id)) installedCatalogIds.push(id);
  }
  if (installedCatalogIds.length > 0) {
    try {
      const syncResult = await syncEnabledPlugins({
        enabledIds: installedCatalogIds,
        engineDir: ENGINE_DIR,
        dshHome: effectiveHomePath(),
        nodeExec,
        pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
        stagingRoot: pluginBundledPluginsDir(),
        mode: "install",
        log,
      });
      if (syncResult.installed.length > 0) {
        pluginsInstalledThisLaunch = syncResult.installed;
        log("updated bundled plugins:", syncResult.installed.join(", "));
        // 测试钩子：破坏刚装的插件 bundle（模拟“坏插件导致引擎启动失败”）。
        if (process.env.DSH_SHELL_TEST_BREAK_PLUGIN) {
          const fsx = require("node:fs");
          for (const id of syncResult.installed) {
            const entry = PLUGIN_CATALOG.find((c) => c.id === id);
            if (!entry) continue;
            const patch = path.join(effectiveHomePath(), "profiles", "web", "node_modules", entry.pkg, "cordis.patch.yml");
            try {
              fsx.rmSync(patch, { force: true });
              log("test hook: corrupted plugin bundle patch for", entry.pkg);
            } catch (error) {
              err("test hook: corrupt failed", error.message);
            }
          }
        }
      }
      if (syncResult.removed.length > 0) {
        log("auto-removed engine-incompatible plugins:", syncResult.removed.join(", "));
      }
      if (syncResult.skipped.length > 0) {
        log("skipped engine-incompatible plugins:", syncResult.skipped.join(", "));
      }
      if (syncResult.errors.length > 0) err("plugin maintenance issues:", syncResult.errors.join(" | "));
    } catch (error) {
      err("plugin maintenance skipped:", error.message);
    }
  }
  // 启用/禁用对账（与安装集合无关，独立于上面的 if）：市场里禁用过的插件若补丁层
  // 还没落下，这里补上——否则市场显示「已禁用」而引擎照常加载它。
  try {
    const enabledSync = reconcilePluginEnabled({ dshHome: effectiveHomePath(), log });
    if (enabledSync.changed) log("plugin enable-state synced:", enabledSync.healed.join(", "));
  } catch (error) {
    err("plugin enable-state reconcile skipped:", error.message);
  }
  let settled = false;

  // 引擎启动失败兜底：本次刚自动装过插件且 dsh 迟迟不就绪/提前退出/报错时，
  // 把刚装的插件逐个 remove（勾选框随之经 watch 实时取消勾选），提示后重试一次。
  const clearWatchdog = () => {
    if (pluginReadyWatchdog) {
      clearTimeout(pluginReadyWatchdog);
      pluginReadyWatchdog = null;
    }
  };
  const recoverFromPluginFailure = async (reason) => {
    if (pluginFailureRecoveryDone) return;
    pluginFailureRecoveryDone = true;
    clearWatchdog();
    const ids = [...pluginsInstalledThisLaunch];
    pluginsInstalledThisLaunch = [];
    if (ids.length === 0) return;
    log("engine start failed after plugin auto-install (" + reason + ") — excluding plugins:", ids.join(", "));
    // 同样落一份启动错误日志（即使走自动剔除）。
    try {
      await writeStartupErrorLog(startupErrorLogPath("auto-exclude"), {
        code: null,
        signal: reason,
        tail: engineOutputTail(),
      });
    } catch (error) {
      err("write auto-exclude log failed:", error.message);
    }
    // 终止当前引擎进程（若还活着）。
    if (dshChild) {
      intentionalEngineStop = true;
      await new Promise((resolve) => killProcessTree(dshChild, resolve));
      dshChild = null;
    }
    let removed = [];
    try {
      const pnpmBinDir = await ensurePluginPnpm({
        installDir: path.join(userDataDir(), "pnpm-tools"),
        pnpmSpec: profilePnpmSpec(),
        nodeExec,
        log,
      });
      for (const id of ids) {
        const entry = PLUGIN_CATALOG.find((c) => c.id === id);
        if (!entry) continue;
        const res = await removeEnginePlugin({
          engineDir: ENGINE_DIR,
          dshHome: effectiveHomePath(),
          pnpmBinDir,
          pkg: entry.pkg,
          nodeExec,
          log,
        });
        if (res.ok) removed.push(id);
        else err("exclude plugin remove failed:", entry.pkg, res.output.slice(-200));
      }
    } catch (error) {
      err("plugin exclusion failed:", error);
    }
    if (removed.length > 0) {
      showUpdateNotice(
        L("plugin.excluded.title"),
        L("plugin.excluded.msg", removed.map((id) => PLUGIN_CATALOG.find((c) => c.id === id)?.pkg ?? id).join(", ")),
      );
    }
    setStatus(L("engine.startFailed"), L("plugin.excluded.title"));
    // 剔除后重试一次（坏插件已从 profile 移除，这次不会再装回）。
    await startEngine(nodeExec);
  };

  dshChild = spawnDsh(nodeExec, {
    onUrl: (url) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      uiSettled = true;
      engineStarted = true;
      engineReady = true;
      engineRestartInFlight = false;
      intentionalEngineStop = false;
      unexpectedEngineExits = 0;
      lastEngineUrl = url;
      log("web UI URL:", url);
      setStatus(L("update.loadingUi"), "");
      win.loadURL(url).catch((error) => err("loadURL failed:", error));
      // 引擎页就绪后其 document.title 可能覆盖窗口标题，稍后把“标题+版本号”固定回去。
      setTimeout(() => applyEngineVersionChrome(), 1500);
      scheduleAutoQuit();
    },
    onExit: (code, signal) => {
      log("dsh exited code=", code, "signal=", signal ?? "");
      engineStarted = false;
      engineReady = false;
      lastEngineUrl = null;
      if (!settled) {
        // 尚未就绪就退出：本次刚自动装过插件 → 先自动剔除并重试（保留既有兜底）；
        // 已剔除过或本就没有本次新装插件 → 进入诊断（保存日志、判定插件/原因）。
        if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
          recoverFromPluginFailure(`exit ${code}`).catch((error) => err("plugin recovery failed:", error.message));
        } else {
          handleStartupFailure({ code, signal, tail: engineOutputTail() });
        }
        return;
      }
      // 曾成功就绪后退出：主动停止/切换目录/正在重启由调用方负责，这里不插手。
      if (quitting || engineRestartInFlight || intentionalEngineStop) return;
      // 本次刚装过插件且尚未剔除过 → 可能插件在运行后把引擎弄崩，先剔除再重拉。
      if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
        recoverFromPluginFailure(`exit-after-ready ${code}`).catch((error) =>
          err("plugin recovery failed:", error.message),
        );
        return;
      }
      // 其余意外退出（含 dsh 页面自身请求退出/插件市场的“重启”）：GUI 作为
      // supervisor 自动重拉引擎；连续失败 3 次后停止并提示。
      unexpectedEngineExits += 1;
      if (unexpectedEngineExits > 3) {
        setStatus(L("engine.startFailed"), L("engine.autoRestartGaveUp", unexpectedEngineExits));
        showUpdateNotice(L("engine.crash.title"), L("engine.crash.msg", String(code ?? signal ?? "")));
        return;
      }
      log(`engine exited after ready (${code} ${signal ?? ""}) — auto-restart ${unexpectedEngineExits}/3`);
      setTimeout(() => {
        if (!quitting && !engineRestartInFlight) restartEngineNow(`auto-restart after exit ${code}`);
      }, 600);
    },
    onError: (error) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      engineStarted = false;
      engineReady = false;
      if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
        recoverFromPluginFailure(String((error && error.message) || error)).catch((e2) =>
          err("plugin recovery failed:", e2.message),
        );
      } else {
        handleStartupFailure({ error, tail: engineOutputTail() });
      }
    },
  });
  // 看门狗：引擎装好但 90 秒未就绪（坏插件卡死或其它原因）→ 走剔除/诊断重试。
  pluginReadyWatchdog = setTimeout(() => {
    if (!settled && !pluginFailureRecoveryDone) {
      recoverFromPluginFailure("watchdog timeout").catch((error) => err("plugin recovery failed:", error.message));
    } else if (!settled && !startupDiagnosisDone) {
      // 无本次新装插件时引擎仍挂起 → 终止后诊断。
      intentionalEngineStop = true;
      if (dshChild) {
        const child = dshChild;
        dshChild = null;
        killProcessTree(child, () => {
          handleStartupFailure({ tail: engineOutputTail(), code: "timeout" });
        });
      } else {
        handleStartupFailure({ tail: engineOutputTail(), code: "timeout" });
      }
    }
  }, 90000);
  return dshChild;
}

// ---------------------------------------------------------------------------
// IPC (settings window)
// ---------------------------------------------------------------------------

/**
 * 安装/卸载进度推给设置窗口（阶段文字实时刷新，避免长时间无反馈像卡死）。
 */
function sendSettingsProgress(text) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      settingsWin.webContents.send("plugins:progress", { text: String(text ?? ""), at: Date.now() });
    } catch {
      /* 窗口正在销毁，忽略 */
    }
  }
}

/** 包一层 log：既走主进程日志，也实时推送进度给设置窗口。 */
function progressLogFor(header) {
  sendSettingsProgress(header);
  return (...args) => {
    const line = args.map(String).join(" ");
    log(line);
    sendSettingsProgress(line);
  };
}

/**
 * 勾选框的即时安装/卸载。复用 syncEnabledPlugins：
 *  - install：以单个 id 为目标（install 模式，只增不删；捆绑插件自动 staging、
 *    引擎不兼容自动跳过）；
 *  - remove：以“当前已装集合去掉目标”为目标（sync 模式）→ 恰好只卸目标一个
 *    （目录外/用户手动装的 bundle 不在目录里，天然不动）。
 * 成功后广播新状态，让设置窗口按安装状态实时重绘勾选。期间逐阶段发送进度。
 */
async function runPluginInstallUninstall(entry, action) {
  const progressLog = progressLogFor(action === "install" ? "installing " + entry.pkg : "removing " + entry.pkg);
  try {
    const common = {
      engineDir: ENGINE_DIR,
      dshHome: effectiveHomePath(),
      nodeExec: resolveNodeExecutable(),
      pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
      stagingRoot: pluginBundledPluginsDir(),
      log: progressLog,
    };
    let result;
    if (action === "install") {
      result = await syncEnabledPlugins({ enabledIds: [entry.id], mode: "install", ...common });
    } else {
      const status = pluginCatalogStatus(effectiveHomePath());
      const installedIds = PLUGIN_CATALOG.filter((e) => status[e.id] && status[e.id].installed)
        .map((e) => e.id)
        .filter((id) => id !== entry.id);
      result = await syncEnabledPlugins({ enabledIds: installedIds, mode: "sync", ...common });
    }
    broadcastSettings();
    sendSettingsProgress(action === "install" ? "install done" : "remove done");
    const ok =
      action === "install" ? result.installed.includes(entry.id) : result.removed.includes(entry.id);
    return {
      ok,
      skipped: result.skipped.includes(entry.id),
      changed: result.changed,
      error: ok ? null : (result.errors[0] ?? null),
      errors: result.errors,
      status: pluginCatalogStatus(effectiveHomePath()),
    };
  } catch (error) {
    err("plugin " + action + " failed:", error);
    sendSettingsProgress("failed: " + ((error && error.message) || error));
    return {
      ok: false,
      skipped: false,
      changed: false,
      error: String((error && error.message) || error),
      errors: [String((error && error.message) || error)],
      status: pluginCatalogStatus(effectiveHomePath()),
    };
  }
}

/**
 * 调用插件市场自己的开关接口——与市场页面上那个开关**完全同一条路径**。
 *
 *   POST <engineOrigin>/dsh-market/toggle   {"name": "<pkg>", "enabled": <bool>}
 *
 * 为什么必须走市场的接口，而不是自己写补丁层：
 *  - 市场不只写文件，还用 loader 句柄做**在线**切换（hotUnmount / entry.update），
 *    并处理「宿主基础设施禁止开关」「carrier bundle 要连 bundles 一起摘」「主题
 *    互斥」这些情况；纯写文件只能覆盖其中一部分。
 *  - 它还会返回 `restart` / `refresh`：有客户端半体的插件（如 OpenCode Go 用量）
 *    禁用后，页面里**已经加载**的那半不会自己消失，需要刷新页面——市场据此弹
 *    「刷新后生效」提示。自己写文件拿不到这个信号。
 *  - 同一套校验（未安装 / 受保护模块 / 市场自身）保持两侧行为一致。
 *
 * 市场用 sameOrigin() 校验（Origin 的 host 必须等于 Host），所以显式带上
 * Origin 头；curl/浏览器之外没有别的地方会替我们加。
 *
 * @returns {Promise<{available:boolean,status?:number,json?:object,reason?:string}>}
 *   available=false 表示市场这条路走不通（引擎没在跑、连不上、或该版本没有这个
 *   路由），调用方回退到直接写补丁层。
 */
function callMarketToggle(pkg, enabled) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(lastEngineUrl).origin;
    } catch {
      resolve({ available: false, reason: "engine is not running" });
      return;
    }
    const body = JSON.stringify({ name: pkg, enabled: Boolean(enabled) });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      `${origin}/dsh-market/toggle`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          origin,
        },
        timeout: 20000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 响应（如引擎的 404 页面）-> 由调用方按状态码决定回退 */
          }
          done({ available: true, status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("market toggle timed out")));
    req.on("error", (error) => done({ available: false, reason: error.message }));
    req.end(body);
  });
}

/**
 * 第三方插件的启用/禁用（与 dshmarket 的开关保持一致）。
 *
 * 优先走市场的 `/dsh-market/toggle`（在线切换 + 正确的 restart/refresh 信号 +
 * 同一套保护规则）；只有在市场这条路不可用（引擎未运行 / 连不上 / 该版本没有
 * 这个路由）时才回退到直接写 profile 补丁层 + 市场 state.json——那条路在
 * `patchReload: live` 的 web profile 上同样能被引擎在线重组合（实测 ~0.7s），
 * 只是缺少 restart/refresh 信号与市场的保护规则。
 *
 * 注意：市场**明确拒绝**时（403 受保护 / 400 未安装 / 市场自身）绝不回退到写文件
 * ——那等于绕过市场的保护，两侧行为就不一致了。
 */
async function runPluginSetEnabled(entry, enabled) {
  const progressLog = progressLogFor((enabled ? "enabling " : "disabling ") + entry.pkg);
  const dshHome = effectiveHomePath();
  try {
    const market = await callMarketToggle(entry.pkg, enabled);
    if (market.available && market.status === 200 && market.json && market.json.ok) {
      const state = market.json.activation?.[entry.pkg]?.state ?? null;
      sendSettingsProgress(
        (enabled ? "enabled " : "disabled ") + entry.pkg + (state ? " (" + state + ")" : ""),
      );
      broadcastSettings();
      return {
        ok: true,
        changed: true,
        via: "market",
        restart: market.json.restart === true,
        refresh: market.json.refresh === true,
        activation: state,
        status: pluginCatalogStatus(dshHome),
      };
    }
    if (market.available && market.status >= 400) {
      // 市场按自己的规则拒绝了：原样把原因交给界面，不回退写文件。
      const reason =
        (market.json && market.json.error) ||
        market.text?.slice(0, 300) ||
        `market refused (HTTP ${market.status})`;
      err("market toggle refused:", entry.pkg, reason);
      sendSettingsProgress("failed: " + reason);
      return { ok: false, changed: false, via: "market", error: String(reason), status: pluginCatalogStatus(dshHome) };
    }

    // ---- 回退：市场不可用（未安装 / 老版本 / 引擎没跑）----
    progressLog(
      "market toggle unavailable" + (market.reason ? ` (${market.reason})` : "") + "; writing the profile patch layer",
    );
    const rowIds = packageRowIds(dshHome, entry.pkg);
    const res = setPluginEnabled({ dshHome, pkg: entry.pkg, rowIds, enabled });
    broadcastSettings();
    sendSettingsProgress(enabled ? "enable done (patch layer)" : "disable done (patch layer)");
    return {
      ok: res.ok,
      changed: res.changed,
      via: "file",
      // 补丁层这条路没有市场的激活态信息：客户端半体仍需刷新页面才消失。
      refresh: true,
      error: res.ok ? null : (res.reason ?? null),
      rowIds,
      status: pluginCatalogStatus(dshHome),
    };
  } catch (error) {
    err("plugin " + (enabled ? "enable" : "disable") + " failed:", error);
    sendSettingsProgress("failed: " + ((error && error.message) || error));
    return {
      ok: false,
      changed: false,
      error: String((error && error.message) || error),
      status: pluginCatalogStatus(effectiveHomePath()),
    };
  }
}

function registerIpc() {
  ipcMain.handle("settings:get", () => settingsPayload());
  ipcMain.handle("settings:set", async (_event, patch) => {
    try {
      return await applySettingsPatch(patch ?? {});
    } catch (error) {
      err("settings:set failed:", error);
      throw error;
    }
  });

  // GUI 托管的引擎重启（页面/设置窗口用）：杀掉 dsh 子进程并按既有流程重拉。
  ipcMain.handle("dsh-gui:restart-engine", () => restartEngineNow("requested from page"));
  ipcMain.handle("settings:restart-engine", () => restartEngineNow("requested from settings"));

  // 设置窗口「立即检查引擎更新」：查新版 → 按选择下载安装（弹窗在主进程完成）。
  ipcMain.handle("settings:update-check", () => runManualEngineUpdate());

  // 勾选框 = 安装状态实时镜像（不持久化期望集合）。勾选/取消勾选立即对 profile
  // 生效：装一个 / 卸一个，随后广播新状态让设置窗口重新渲染。返回
  // { ok, skipped, error, changed, status } —— ok=false 且 skipped=true 表示
  // 引擎不兼容未装；error 为安装/卸载失败信息。
  ipcMain.handle("plugins:install", async (_event, id) => {
    const entry = PLUGIN_CATALOG.find((c) => c.id === id);
    if (!entry) return { ok: false, error: "unknown plugin: " + String(id) };
    return runPluginInstallUninstall(entry, "install");
  });
  ipcMain.handle("plugins:remove", async (_event, id) => {
    const entry = PLUGIN_CATALOG.find((c) => c.id === id);
    if (!entry) return { ok: false, error: "unknown plugin: " + String(id) };
    return runPluginInstallUninstall(entry, "remove");
  });

  // 启用/禁用（第二个勾选框）：状态镜像 + 走市场的开关接口（见 callMarketToggle）。
  ipcMain.handle("plugins:set-enabled", async (_event, id, enabled) => {
    const entry = PLUGIN_CATALOG.find((c) => c.id === id);
    if (!entry) return { ok: false, error: "unknown plugin: " + String(id) };
    return runPluginSetEnabled(entry, enabled !== false);
  });

  // 「刷新 Harness 页面」：禁用/启用带客户端半体的插件后，页面里已经加载的那半
  // 不会自己消失/出现，需要重新加载页面才与引擎的实际组合一致。市场的开关也是
  // 这个语义（它返回 refresh 并显示「刷新后生效」），这里给设置窗口一个等价的
  // 动作按钮。重新加载只重取引擎 URL，会话数据都在 $DSH_HOME 里，不会丢。
  ipcMain.handle("dsh-gui:reload-engine-window", () => {
    if (!win || win.isDestroyed()) return { ok: false, error: "main window is gone" };
    if (!lastEngineUrl) return { ok: false, error: "engine is not running" };
    win.loadURL(lastEngineUrl).catch((error) => err("engine reload failed:", error.message));
    return { ok: true };
  });

  // 设置窗口「修复 / 重试」：勾选框已实时镜像安装状态，不再有“收敛到勾选”的
  // 语义——这里以“当前已安装集合”为目标再对账一遍：补拉捆绑插件的随包更新、
  // 清理不一致，且**绝不卸载**用户手动装的东西（install 模式只增不删）。返回
  // changed 供页面提示“需重启引擎”。期间逐阶段发送进度。
  ipcMain.handle("settings:plugin-sync", async () => {
    const progressLog = progressLogFor("repairing plugins");
    try {
      // 先自愈：清掉不可解析/失效的 bundle 登记（坏安装留下的 stale 条目会让
      // 引擎启动失败），再对账目录插件。
      let healed;
      try {
        healed = await healProfileBundlesFn({
          engineDir: ENGINE_DIR,
          dshHome: effectiveHomePath(),
          nodeExec: resolveNodeExecutable(),
          pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
          log: progressLog,
        });
        if (healed.changed)
          progressLog(
            `self-heal: pruned [${healed.pruned.join(", ")}]${healed.repaired.length ? ` repaired [${healed.repaired.join(", ")}]` : ""}`,
          );
      } catch (error) {
        err("plugin self-heal failed:", error);
        healed = { pruned: [], repaired: [], changed: false, errors: [String((error && error.message) || error)] };
      }
      // 「修复 / 重试」也清一次旧插件：目录条目改名后 profile 里可能留着旧包名，
      // 不清就会新旧两版同时加载。
      let legacy = { pruned: [], removedRows: [], changed: false };
      try {
        legacy = await removeLegacyPlugins({
          engineDir: ENGINE_DIR,
          dshHome: effectiveHomePath(),
          nodeExec: resolveNodeExecutable(),
          pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
          log: progressLog,
        });
        if (legacy.changed)
          progressLog(
            `legacy plugins: pruned [${legacy.pruned.join(", ")}]${legacy.removedRows.length ? ` rows [${legacy.removedRows.join(", ")}]` : ""}`,
          );
      } catch (error) {
        err("legacy plugin cleanup failed:", error);
      }
      const status = pluginCatalogStatus(effectiveHomePath());
      const installedIds = PLUGIN_CATALOG.filter((entry) => status[entry.id] && status[entry.id].installed).map(
        (entry) => entry.id,
      );
      const result = await syncEnabledPlugins({
        enabledIds: installedIds,
        engineDir: ENGINE_DIR,
        dshHome: effectiveHomePath(),
        nodeExec: resolveNodeExecutable(),
        pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
        stagingRoot: pluginBundledPluginsDir(),
        mode: "install",
        log: progressLog,
      });
      // 「修复 / 重试」同时把启用/禁用对账一遍：市场里禁用过的插件若补丁层还没
      // 落下（market state.json 与 cordis.patch.yml 不一致），补上禁用行——否则
      // 市场显示「已禁用」而引擎照常加载。
      let enabledSync = { healed: [], changed: false };
      try {
        enabledSync = reconcilePluginEnabled({ dshHome: effectiveHomePath(), log: progressLog });
        if (enabledSync.changed) progressLog(`enable-state synced: [${enabledSync.healed.join(", ")}]`);
      } catch (error) {
        err("plugin enable-state reconcile failed:", error);
      }
      broadcastSettings();
      sendSettingsProgress("repair done");
      return { ...result, healed, enabledSync, legacy, status: pluginCatalogStatus(effectiveHomePath()) };
    } catch (error) {
      err("plugin sync failed:", error);
      sendSettingsProgress("failed: " + ((error && error.message) || error));
      return {
        installed: [],
        removed: [],
        skipped: [],
        changed: false,
        errors: [String((error && error.message) || error)],
      };
    }
  });

  // 设置窗口内容自适应高度：由页面在内容尺寸变化时上报（语言切换/主题等）。
  ipcMain.handle("settings:autosize", (_event, height) => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    if (_event.sender !== settingsWin.webContents) return;
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const target = Math.min(Math.max(480, Math.round(Number(height) || 560)), Math.max(480, workArea.height - 40));
    settingsWin.setContentSize(800, target);
  });

  // “最近一次对话”记忆：记录 / 读取用户最后使用的会话（重启后自动打开）。
  //
  // 这是**旧**实现（页内补丁经 window.__dshGui 桥调用）留下的 IPC。现在主实现是
  // 插件 `dsh-gui-last-session`（宿主侧自己写 <DSH_HOME>/last-session.json），
  // 插件装好后不再需要这条桥——保留它只为兼容“插件未安装/未生效”的兜底场景。
  function lastSessionFile() {
    return path.join(userDataDir(), "last-session.json");
  }
  ipcMain.handle("dsh-gui:set-last-session", async (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId.startsWith("session-")) throw new Error("invalid session id");
    await fsp.writeFile(lastSessionFile(), JSON.stringify({ sessionId, updatedAt: Date.now() }), "utf8");
    return { ok: true };
  });
  ipcMain.handle("dsh-gui:get-last-session", async () => {
    try {
      const data = JSON.parse(await fsp.readFile(lastSessionFile(), "utf8"));
      if (typeof data.sessionId === "string" && data.sessionId.startsWith("session-")) return data;
    } catch {
      /* none yet */
    }
    return null;
  });
}

/**
 * 把 GUI 自己的“最近会话”指针交接给插件。
 *
 * 插件把指针存在 <DSH_HOME>/last-session.json（与 GUI 的 <userData> 不同）。
 * 只做单向的“旧 -> 新”补齐：仅在插件侧还没有指针、而 GUI 侧有时才写入，避免
 * 用一份过期数据覆盖插件已经记录好的更新结果。
 */
async function handOffLastSessionToPlugin() {
  try {
    const pluginFile = path.join(effectiveHomePath(), "last-session.json");
    const guiFile = path.join(userDataDir(), "last-session.json");
    let pluginPointer = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(pluginFile, "utf8"));
      if (typeof parsed?.sessionId === "string" && parsed.sessionId.startsWith("session-")) pluginPointer = parsed;
    } catch {
      /* plugin has no pointer yet */
    }
    if (pluginPointer) return;
    let guiPointer = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(guiFile, "utf8"));
      if (typeof parsed?.sessionId === "string" && parsed.sessionId.startsWith("session-")) guiPointer = parsed;
    } catch {
      /* nothing to hand over */
    }
    if (!guiPointer) return;
    await fsp.mkdir(path.dirname(pluginFile), { recursive: true });
    await fsp.writeFile(
      pluginFile,
      JSON.stringify({ sessionId: guiPointer.sessionId, updatedAt: guiPointer.updatedAt ?? Date.now() }),
      "utf8",
    );
    log("handed the last-session pointer over to the plugin:", guiPointer.sessionId);
  } catch (error) {
    err("last-session hand-off failed (non-fatal):", error.message);
  }
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    await loadSettings();
    // Read DeepSeek Harness' own appearance/locale first, then show windows
    // according to them (requirement: 窗口启动时先读取外观设置再显示).
    await readEngineUiPrefs();
    applyHarnessTheme(engineThemePref);
    registerIpc();
    buildMenu();
    createTray();
    createWindow();
    // 热跟随 <DSH_HOME>/settings.yaml：引擎页面里换主题/语言，外壳立即跟上。
    startEngineSettingsWatcher();
    // 热跟随 <DSH_HOME>/profiles/web/package.json：插件市场那边禁用/卸载插件后，
    // 设置窗口的第三方插件勾选状态要跟着刷新。
    startProfileWatcher();
    // Test/CI hook: open the settings window right after startup.
    if (process.env.DSH_SHELL_TEST_OPEN_SETTINGS) {
      setImmediate(() => openSettingsWindow());
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 || !win || win.isDestroyed()) showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    // With "隐藏到托盘" the main window's close event is intercepted, so this
    // fires only while the app is already quitting. With "直接退出" a closed
    // window reaches here -> quit the whole app (tray removed on quit too).
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopProfileWatcher();
    if (tray) {
      tray.destroy();
      tray = null;
      hasTray = false;
      log("tray destroyed");
    }
  });

  // Async tree-kill of the dsh child before the app actually exits.
  app.on("will-quit", (event) => {
    if (!dshChild) return;
    event.preventDefault();
    log("stopping dsh engine…");
    killProcessTree(dshChild, () => {
      dshChild = null;
      app.quit();
    });
  });

  // Test/CI hook: if the UI never becomes ready, quit after a generous
  // watchdog so automated runs cannot hang. Only active when AUTOQUIT is set.
  if (autoquitMs > 0) {
    setTimeout(() => {
      if (!uiSettled) {
        err("autoquit watchdog: web UI never loaded");
        app.quit();
      }
    }, autoquitMs + 120000);
  }

  app.disableHardwareAcceleration();
}