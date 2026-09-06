"use strict";

/**
 * DSH GUI Shell — main process.
 *
 * Responsibilities:
 *  1. Ensure the DeepSeek Harness engine (@deepseek-ai/dsh) is the LATEST
 *     version: launch-time and periodic update checks (configurable), install
 *     into an app-owned directory per update policy, notify the user.
 *  2. Settings window: update policy / check toggle / check interval /
 *     data directory / close-window behavior, persisted in
 *     <userData>/settings.json. Quick settings also live in the app menu.
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

const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, dialog, screen, ipcMain } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const semver = require("semver");
const YAML = require("yaml");
const { defaultDshHome, hasHomeData, moveHomeData } = require("./home-migrate");

const DSH_PACKAGE = "@deepseek-ai/dsh";
// Overridable for regions where registry.npmjs.org is slow/unreachable.
const REGISTRY_LATEST_URL =
  process.env.DSH_SHELL_REGISTRY_URL || `https://registry.npmjs.org/${DSH_PACKAGE}/latest`;

const UPDATE_POLICIES = {
  auto: "静默更新（每次使用最新版）",
  ask: "询问后再更新（默认）",
  notify: "仅提示，不自动更新",
};

const DSH_HOME_MODES = {
  app: "应用目录（随应用携带）",
  system: "跟随系统 ~/.dsh（默认）",
};

const CLOSE_ACTIONS = {
  tray: "隐藏到托盘",
  quit: "直接退出",
};

// Test hook: redirect userData (engine dir / settings) for isolated smoke runs
// of packaged builds. Must run before anything reads app paths.
if (process.env.DSH_SHELL_USERDATA) {
  app.setPath("userData", process.env.DSH_SHELL_USERDATA);
}

const DEFAULT_SETTINGS = {
  updatePolicy: "ask", // 询问后再更新（默认）
  dshHomeMode: "system", // 数据目录默认跟随系统 ~/.dsh
  updateCheckEnabled: true,
  updateCheckIntervalHours: 1, // 检查间隔默认 1 小时
  closeAction: "tray", // 关闭窗口默认隐藏到托盘
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
    if (DSH_HOME_MODES[parsed.dshHomeMode]) settings.dshHomeMode = parsed.dshHomeMode;
    if (typeof parsed.updateCheckEnabled === "boolean") settings.updateCheckEnabled = parsed.updateCheckEnabled;
    if (typeof parsed.updateCheckIntervalHours === "number" && Number.isFinite(parsed.updateCheckIntervalHours)) {
      settings.updateCheckIntervalHours = Math.min(8760, Math.max(1, parsed.updateCheckIntervalHours));
    }
    if (parsed.closeAction === "tray" || parsed.closeAction === "quit") settings.closeAction = parsed.closeAction;
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
  if (typeof patch.updateCheckEnabled === "boolean") next.updateCheckEnabled = patch.updateCheckEnabled;
  if (typeof patch.updateCheckIntervalHours === "number" && Number.isFinite(patch.updateCheckIntervalHours)) {
    next.updateCheckIntervalHours = Math.min(8760, Math.max(1, Math.round(patch.updateCheckIntervalHours * 10) / 10));
  }
  if (patch.closeAction === "tray" || patch.closeAction === "quit") next.closeAction = patch.closeAction;
  if (Object.keys(next).length > 0) {
    await saveSettings(next);
    buildMenu();
    scheduleUpdateChecks();
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
  await new Promise((resolve) => killProcessTree(dshChild, resolve));
  dshChild = null;
  engineStarted = false;
  lastEngineUrl = null;
  log("engine stopped for home switch");
  return true;
}

async function restartEngineAfterSwitch(nodeExec) {
  setStatus("数据目录已切换", "正在重新启动 DeepSeek Harness…");
  await startEngine(nodeExec);
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
        title: "切换数据目录",
        message: `源数据目录（${srcPath}）包含数据`,
        detail: `是否将数据移动到目标目录（${dstPath}）？选择“仅切换”则数据保留在原位置。`,
        buttons: ["移动并切换", "仅切换，不移动"],
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
    setStatus("正在移动数据目录…", "");
    const result = await moveHomeData(srcPath, dstPath);
    log("move result:", JSON.stringify(result));
    if (result.skipped.length > 0) {
      dialog
        .showMessageBox(parent, {
          type: "warning",
          title: "部分数据未移动",
          message: `已移动 ${result.moved} 项，${result.skipped.length} 项未移动`,
          detail: result.skipped.join("\n"),
          buttons: ["确定"],
        })
        .catch(() => {});
    } else {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: "数据已移动",
          message: `已将 ${result.moved} 项数据移动到 ${dstPath}`,
          buttons: ["确定"],
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
      target.webContents.send("settings:changed", settings);
    }
  }
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
// version engine
// ---------------------------------------------------------------------------

async function fetchLatestVersion(timeoutMs = 8000) {
  // Test-only override so CI can exercise the update path deterministically.
  if (process.env.DSH_SHELL_TEST_LATEST) return process.env.DSH_SHELL_TEST_LATEST;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const data = await res.json();
    return typeof data.version === "string" && data.version !== "" ? data.version : null;
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
    const args = [
      npmCli,
      "install",
      spec,
      "--prefix", ENGINE_DIR,
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
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with ${code}\n${tail}`));
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
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
    const match = buffer.match(/^dsh web: (\S+)\s*$/m);
    if (match) onUrl(match[1]);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", onError);
  child.on("exit", (code, signal) => onExit(code, signal));
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

function fatalUi(error, title = "启动失败") {
  err(title, error);
  setStatus(title, String((error && error.message) || error));
  dialog
    .showMessageBox(win, {
      type: "error",
      title,
      message: `${title}：无法启动 DeepSeek Harness`,
      detail: String((error && error.message) || error),
      buttons: ["确定"],
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// harness appearance (theme) adoption
// ---------------------------------------------------------------------------

let windowThemeDark = true;

function themeQuery() {
  return windowThemeDark ? "dark" : "light";
}

/** Read the harness appearance preference from <DSH_HOME>/settings.yaml. */
async function readHarnessTheme() {
  const home = dshHome ?? defaultDshHome();
  const file = path.join(home, "settings.yaml");
  try {
    const text = await fsp.readFile(file, "utf8");
    const doc = YAML.parse(text);
    const pref = doc && doc["ui-theme"] && doc["ui-theme"].preference;
    if (pref === "light" || pref === "dark" || pref === "system") return pref;
  } catch (error) {
    log("harness settings.yaml unreadable, using system theme:", error.message);
  }
  return "system";
}

function applyHarnessTheme(preference) {
  nativeTheme.themeSource = preference === "light" || preference === "dark" ? preference : "system";
  windowThemeDark =
    preference === "dark" ||
    (preference !== "light" && nativeTheme.shouldUseDarkColors);
  log("harness theme:", preference, "| window dark:", windowThemeDark);
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
  noticeWin.loadFile(path.join(__dirname, "notice.html"), { query: { theme: themeQuery() } });
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
    },
  });
  // 主窗口启动最大化显示.
  win.maximize();
  win.show();
  win.loadFile(path.join(__dirname, "status.html"), { query: { theme: themeQuery() } });
  win.webContents.once("did-finish-load", () => {
    if (engineStarted && lastEngineUrl) {
      // Engine already running (window reopened from tray): reuse its URL.
      win.loadURL(lastEngineUrl).catch((error) => err("loadURL failed:", error));
      return;
    }
    boot().catch((error) => fatalUi(error));
  });
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed() && win.webContents.getURL().startsWith("http")) {
      log("embedded web contents loaded:", win.webContents.getURL());
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
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
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
    title: "设置 — DSH GUI",
    icon: iconPath("icon.png"),
    backgroundColor: windowThemeDark ? "#0f151d" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"), { query: { theme: themeQuery() } });
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

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath("tray-icon.png"));
    if (img.isEmpty()) throw new Error("tray icon is empty");
    tray = new Tray(img);
    hasTray = true;
    tray.setToolTip("DeepSeek Harness");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开窗口", click: () => showMainWindow() },
        { label: "设置", click: () => openSettingsWindow() },
        { type: "separator" },
        { label: "退出", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => showMainWindow());
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
  const current = settings.updatePolicy;
  const currentHome = settings.dshHomeMode;
  const setPolicy = (policy) => {
    if (policy === current) return;
    applySettingsPatch({ updatePolicy: policy }).then(() => {
      log("update policy ->", policy);
      buildMenu();
    });
  };
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
      label: "设置",
      submenu: [
        { label: "打开设置窗口…", click: () => openSettingsWindow() },
        { type: "separator" },
        { label: "更新策略", enabled: false },
        {
          type: "radio",
          label: UPDATE_POLICIES.auto,
          checked: current === "auto",
          click: () => setPolicy("auto"),
        },
        {
          type: "radio",
          label: UPDATE_POLICIES.ask,
          checked: current === "ask",
          click: () => setPolicy("ask"),
        },
        {
          type: "radio",
          label: UPDATE_POLICIES.notify,
          checked: current === "notify",
          click: () => setPolicy("notify"),
        },
        { type: "separator" },
        { label: "数据目录", enabled: false },
        {
          type: "radio",
          label: DSH_HOME_MODES.app,
          checked: currentHome === "app",
          click: () => setHomeMode("app"),
        },
        {
          type: "radio",
          label: DSH_HOME_MODES.system,
          checked: currentHome === "system",
          click: () => setHomeMode("system"),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
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
  const ms = Math.max(Math.round(settings.updateCheckIntervalHours * 3600 * 1000), 60_000);
  updateCheckTimer = setTimeout(() => {
    runPeriodicUpdateCheck().catch((error) => err("periodic check failed:", error));
  }, ms);
  log(`next periodic update check in ${Math.round(ms / 3600 / 1000)}h`);
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
    showUpdateNotice(`发现新版本 v${latest}`, "将于下次启动时更新");
  } finally {
    checkingInProgress = false;
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
  log("userData:", userDataDir());
  log("node:", nodeExec, "(", nodeVersion, ")");

  const installed = await readInstalledVersion();
  log("installed:", installed ?? "none");

  // Decide whether to query the registry.
  let latest = null;
  let checkedThisLaunch = false;
  if (settings.updateCheckEnabled) {
    const last = typeof settings.lastCheckedAt === "number" ? settings.lastCheckedAt : 0;
    const intervalMs = Math.max(settings.updateCheckIntervalHours * 3600 * 1000, 60_000);
    const due = Date.now() - last >= intervalMs;
    if (due || installed === null) {
      checkedThisLaunch = true;
      setStatus("正在检查 DeepSeek Harness 版本…");
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

  // A Node runtime change (e.g. first run with a bundled portable node) makes
  // the previously installed engine's native modules ABI-incompatible -> reinstall.
  const nodeChanged = Boolean(
    settings.engineNode && nodeVersion && settings.engineNode !== nodeVersion,
  );
  const updateNeeded =
    installed === null ||
    (latest !== null && semver.lt(installed, latest)) ||
    nodeChanged;
  log("updateNeeded:", updateNeeded, "| nodeChanged:", Boolean(nodeChanged));

  if (updateNeeded) {
    if (installed === null && latest === null && !settings.updateCheckEnabled) {
      // Update checks are off and we have no engine: one-time setup install.
      log("no engine and update checks disabled -> one-time install of latest");
      setStatus("首次运行：正在安装 DeepSeek Harness…", "（更新检查已关闭）");
      try {
        await npmInstall(null, (line) => setStatus("首次安装", String(line).slice(0, 120) || "正在下载…"));
        const installedNow = await readInstalledVersion();
        await saveSettings({ engineNode: nodeVersion ?? settings.engineNode, lastNotifiedVersion: undefined });
        log("engine installed:", installedNow);
      } catch (error) {
        fatalUi(error, "引擎安装失败");
        return;
      }
    } else if (installed !== null && latest === null) {
      // Registry unreachable but engine present -> run what we have (offline).
      log("offline fallback");
      setStatus(`离线模式：使用 v${installed}`, "正在启动 DeepSeek Harness…");
    } else {
      const verb =
        installed === null
          ? "首次安装"
          : nodeChanged
            ? "运行时已变更，重新安装"
            : `发现新版本 v${latest}（当前 v${installed}）`;
      const policy = settings.updatePolicy;

      // "ask": let the user choose, unless we have no choice at all.
      if (policy === "ask" && installed !== null && !nodeChanged && latest !== null) {
        const { response } = await dialog
          .showMessageBox(win, {
            type: "question",
            title: "发现新版本",
            message: `发现 DeepSeek Harness 新版本 v${latest}`,
            detail: `当前版本 v${installed}。是否现在更新？`,
            buttons: ["立即更新", "用当前版本启动"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .catch(() => ({ response: 0 }));
        if (response === 1) {
          log("user skipped update");
          setStatus(`跳过更新，使用 v${installed}`, "正在启动 DeepSeek Harness…");
          await startEngine(nodeExec);
          scheduleUpdateChecks();
          return;
        }
      }

      // "notify": only inform, never install (unless we must install to run at all).
      if (policy === "notify" && installed !== null && !nodeChanged && latest !== null) {
        log("notify-only policy: skipping install");
        showUpdateNotice(`发现新版本 v${latest}`, "可在设置中改为自动更新");
        setStatus(`发现新版本 v${latest}（未自动更新）`, "正在启动 DeepSeek Harness…");
        await startEngine(nodeExec);
        scheduleUpdateChecks();
        return;
      }

      // auto (or forced) -> install.
      log("installing", DSH_PACKAGE, latest ? `@${latest}` : "(latest)");
      setStatus(verb, "正在下载并安装…");
      try {
        await npmInstall(latest, (line) =>
          setStatus(verb, String(line).slice(0, 120) || "正在下载并安装…"),
        );
        const installedNow = await readInstalledVersion();
        log("engine updated to", installedNow ?? latest);
        await saveSettings({ engineNode: nodeVersion ?? settings.engineNode, lastNotifiedVersion: undefined });
        if (installedNow && installedNow !== installed) {
          showUpdateNotice(`已更新到 v${installedNow}`, "本次启动已使用最新版本");
        }
        setStatus(`已就绪 v${installedNow ?? latest}`, "正在启动 DeepSeek Harness…");
      } catch (error) {
        err("engine update failed:", error);
        if (installed !== null) {
          dialog
            .showMessageBox(win, {
              type: "warning",
              title: "更新失败",
              message: `自动更新到 v${latest} 失败`,
              detail: `${String((error && error.message) || error)}\n\n将使用当前版本 v${installed} 启动。`,
              buttons: ["继续"],
            })
            .catch(() => {});
          setStatus(`更新失败，使用 v${installed} 启动`, "正在启动 DeepSeek Harness…");
        } else {
          fatalUi(error, "引擎安装失败");
          return;
        }
      }
    }
  } else if (installed !== null) {
    if (checkedThisLaunch) {
      log("engine already up to date");
      setStatus(`版本已是最新 v${installed}`, "正在启动 DeepSeek Harness…");
    } else {
      log("engine present; skipped registry check (within interval / disabled)");
      setStatus(`已就绪 v${installed}`, "正在启动 DeepSeek Harness…");
    }
  }

  await startEngine(nodeExec);
  scheduleUpdateChecks();

  // Test-only hook: force an update notice for CI verification.
  if (process.env.DSH_SHELL_TEST_NOTICE) {
    showUpdateNotice("已更新到 v9.9.9-test", "测试通知：本次启动已使用最新版本");
  }
}

async function startEngine(nodeExec) {
  setStatus("正在启动 DeepSeek Harness…", "首次启动需要初始化本地配置");
  let settled = false;

  dshChild = spawnDsh(nodeExec, {
    onUrl: (url) => {
      if (settled) return;
      settled = true;
      uiSettled = true;
      engineStarted = true;
      lastEngineUrl = url;
      log("web UI URL:", url);
      setStatus("正在加载界面…", "");
      win.loadURL(url).catch((error) => err("loadURL failed:", error));
      scheduleAutoQuit();
    },
    onExit: (code, signal) => {
      log("dsh exited code=", code, "signal=", signal ?? "");
      engineStarted = false;
      lastEngineUrl = null;
      if (!settled) {
        setStatus("DeepSeek Harness 启动失败", `进程退出码 ${code ?? ""} ${signal ?? ""}`);
      }
    },
    onError: (error) => {
      if (settled) return;
      settled = true;
      engineStarted = false;
      fatalUi(error, "dsh 启动失败");
    },
  });
  return dshChild;
}

// ---------------------------------------------------------------------------
// IPC (settings window)
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:set", async (_event, patch) => {
    try {
      return await applySettingsPatch(patch ?? {});
    } catch (error) {
      err("settings:set failed:", error);
      throw error;
    }
  });
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
    // Read DeepSeek Harness' own appearance setting first, then show windows
    // according to it (requirement: 窗口启动时先读取外观设置再显示).
    const harnessTheme = await readHarnessTheme();
    applyHarnessTheme(harnessTheme);
    registerIpc();
    buildMenu();
    createTray();
    createWindow();
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