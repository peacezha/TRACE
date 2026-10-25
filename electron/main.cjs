const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('node:crypto');
const { createProfileStore } = require('./profile-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { createLocaleStore } = require('./locale-store.cjs');
const { createEditingController } = require('./editing.cjs');
require('./legacy-brand-env.cjs');
const { migrateDesktopProfile } = require('./app-identity.cjs');
const { migrateLegacyShortcuts } = require('./legacy-shortcuts.cjs');
const { generateTotp } = require('./totp.cjs');
const { createLocalFileService } = require('./local-files.cjs');
const { createRemoteEditSessionManager } = require('./remote-edit-sessions.cjs');
const { createWindowCloseGuard } = require('./window-close-guard.cjs');
const { autoUpdater } = require('electron-updater');
const { createUpdateManager } = require('./update-manager.cjs');
const packageMetadata = require('../package.json');

const APP_EDITION = String(process.env.TRACE_EDITION || packageMetadata.traceEdition || 'full').toLowerCase() === 'competition'
  ? 'competition'
  : 'full';
const IS_COMPETITION_EDITION = APP_EDITION === 'competition';
const APP_DISPLAY_NAME = IS_COMPETITION_EDITION ? 'TRACE 竞赛版' : 'TRACE';
process.env.TRACE_EDITION = APP_EDITION;

// 竞赛版与完整版必须能并排安装和运行。productName/appId 负责区分
// 安装与单实例锁，这里再显式分开 userData，防止任何打包工具回退到 name 时
// 复用完整版的账号、AI 密钥、传输队列或对话上下文。
const desktopIdentity = migrateDesktopProfile({ appData: app.getPath('appData'), competition: IS_COMPETITION_EDITION });
app.setName(desktopIdentity.runtimeName);
app.setPath('userData', desktopIdentity.userData);
app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME, applicationVersion: packageMetadata.version });
const localeStore = createLocaleStore({ userData: app.getPath('userData'), installDir: path.dirname(process.execPath) });
const desktopText = (zh, en) => localeStore.get() === 'en-US' ? en : zh;
const editingController = createEditingController({ Menu, BrowserWindow, ipcMain, text: desktopText });

// The Windows GPU process is the most frequent source of renderer loss in the
// field logs (exit -2147483645). TRACE is a text/terminal application, so the
// small graphics-performance trade-off is preferable to a persistent white
// window. This must be called before app.whenReady().
if (process.platform === 'win32') app.disableHardwareAcceleration();

let backendProcess = null;
let mainWindow = null;
let profileStore = null;
let secretStore = null;
let localFileService = null;
let remoteEditSessionManager = null;
let updateManager = null;
let searchAbortControllers = new Map();
let currentLogFile = null;
let appIsQuitting = false;
let rendererRecoveryTimer = null;
let rendererUnresponsiveTimer = null;
let rendererCrashTimestamps = [];

const RENDERER_CRASH_WINDOW_MS = 60_000;
const MAX_RENDERER_RECOVERIES = 3;

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function choosePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available localhost port from ${startPort} to ${startPort + 49}`);
}

function waitForServer(url, timeoutMs = 45000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, res => {
        res.resume();
        resolve();
      });
      req.on('error', err => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Backend did not respond at ${url}: ${err.message}`));
          return;
        }
        setTimeout(attempt, 300);
      });
      req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
    };
    attempt();
  });
}

function appendLog(logFile, chunk) {
  try {
    fs.appendFileSync(logFile, chunk);
  } catch {
    // Logging must never crash the desktop shell.
  }
}

function prepareLogFile(logFile) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      const previous = `${logFile}.1`;
      fs.rmSync(previous, { force: true });
      fs.renameSync(logFile, previous);
    }
  } catch {
    // Best-effort rotation; append below still has its own guard.
  }
  appendLog(logFile, `\n[electron] ===== launch ${new Date().toISOString()} desktopPid=${process.pid} =====\n`);
  if (process.platform === 'win32') {
    appendLog(logFile, '[electron] hardware acceleration disabled: Windows GPU stability fallback\n');
  }
}

function restartAfterRendererCrash(win, detail) {
  if (appIsQuitting || !win || win.isDestroyed()) return;
  const now = Date.now();
  rendererCrashTimestamps = rendererCrashTimestamps
    .filter(timestamp => now - timestamp < RENDERER_CRASH_WINDOW_MS);
  rendererCrashTimestamps.push(now);

  if (rendererCrashTimestamps.length > MAX_RENDERER_RECOVERIES) {
    if (currentLogFile) appendLog(currentLogFile, '[electron] renderer recovery loop detected; offering clean restart\n');
    void dialog.showMessageBox(win, {
      type: 'error',
      title: `${APP_DISPLAY_NAME} 界面连续异常`,
      message: `界面进程连续崩溃，${APP_DISPLAY_NAME} 需要完整重启。`,
      detail: `集群后台作业不会受影响。诊断日志：${currentLogFile || 'trace-server.log'}`,
      buttons: ['立即重启', '退出'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      appIsQuitting = true;
      if (response === 0) app.relaunch();
      stopBackend('renderer-crash-exit');
      app.exit(0);
    }).catch(() => {});
    return;
  }

  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    if (appIsQuitting || win.isDestroyed()) return;
    if (currentLogFile) {
      appendLog(currentLogFile, `[electron] recovering renderer attempt=${rendererCrashTimestamps.length} detail=${detail}\n`);
    }
    win.setTitle(`${APP_DISPLAY_NAME}（正在恢复界面…）`);
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.setTitle(APP_DISPLAY_NAME);
        win.show();
      }
    });
    win.webContents.reloadIgnoringCache();
  }, 400);
}

// 服务端落盘密钥（ai-profile/notify-config/qqbot 中的 apiKey、smtpPass、appSecret）
// 的 AES-256-GCM 主密钥：随机 32 字节，用 safeStorage 加密后存
// userData/server-key.json，派生后端进程时经 TRACE_ENCRYPTION_KEY 注入。
// safeStorage 不可用时仅使用本次进程内的随机密钥，绝不退化为明文落盘；
// 重启后旧密文不可读，用户需要重新配置，与前端“仅保留内存”的语义一致。
function loadServerEncryptionKey() {
  if (!safeStorage.isEncryptionAvailable()) return crypto.randomBytes(32).toString('hex');
  const keyFile = path.join(app.getPath('userData'), 'server-key.json');
  try {
    const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const hex = saved && saved.key ? safeStorage.decryptString(Buffer.from(saved.key, 'base64')) : '';
    if (/^[0-9a-f]{64}$/i.test(hex)) return hex;
  } catch { /* 文件缺失或损坏则重新生成 */ }
  const hex = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, JSON.stringify({ key: safeStorage.encryptString(hex).toString('base64') }), { mode: 0o600 });
  } catch { /* 写失败则本次用临时密钥，下次启动再生成 */ }
  return hex;
}

function startBackend(port) {
  const appRoot = app.getAppPath();
  const serverCwd = app.isPackaged ? path.dirname(appRoot) : appRoot;
  const dataRoot = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dataRoot, { recursive: true });

  // Generate desktop token for secure IPC with the backend
  const desktopToken = crypto.randomBytes(32).toString('hex');

  const logFile = path.join(dataRoot, 'trace-server.log');
  const env = {
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
    PORT: String(port),
    TRACE_APP_ROOT: appRoot,
    TRACE_STATIC_ROOT: appRoot,
    TRACE_DATA_ROOT: dataRoot,
    TRACE_NODE_EXECUTABLE: process.execPath,
    TRACE_DESKTOP_TOKEN: desktopToken,
    TRACE_PARENT_PID: String(process.pid),
    TRACE_EDITION: APP_EDITION,
    TRACE_AI_ENGINE: IS_COMPETITION_EDITION ? 'legacy' : (process.env.TRACE_AI_ENGINE || ''),
  };

  const serverEncryptionKey = loadServerEncryptionKey();
  if (serverEncryptionKey) {
    env.TRACE_ENCRYPTION_KEY = serverEncryptionKey;
  }

  let command;
  let args;
  const options = { cwd: serverCwd, env, windowsHide: true };

  if (app.isPackaged) {
    command = process.execPath;
    args = [path.join(appRoot, 'dist-electron', 'server.cjs')];
    env.ELECTRON_RUN_AS_NODE = '1';
  } else if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', path.join(appRoot, 'node_modules', '.bin', 'tsx.cmd'), 'server.ts'];
  } else {
    command = path.join(appRoot, 'node_modules', '.bin', 'tsx');
    args = ['server.ts'];
  }

  currentLogFile = logFile;
  prepareLogFile(logFile);
  appendLog(logFile, `[electron] starting backend: ${command} ${args.join(' ')}\n`);
  const spawnedBackend = spawn(command, args, options);
  backendProcess = spawnedBackend;
  spawnedBackend.stdout.on('data', chunk => appendLog(logFile, chunk));
  spawnedBackend.stderr.on('data', chunk => appendLog(logFile, chunk));
  spawnedBackend.on('error', error => {
    appendLog(logFile, `[electron] backend spawn error: ${error?.stack || error}\n`);
  });
  spawnedBackend.on('exit', (code, signal) => {
    appendLog(logFile, `[electron] backend exited code=${code} signal=${signal}\n`);
    if (backendProcess === spawnedBackend) backendProcess = null;
    if (!appIsQuitting && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: `${APP_DISPLAY_NAME} 后台已停止`,
        message: '后台服务异常退出，当前 AI 和集群会话已无法继续。',
        detail: `请重启 TRACE。诊断日志：${logFile}\nexit=${code} signal=${signal}`,
      });
    }
  });

  return { logFile, desktopToken };
}

// ── 启动进度窗（splash）─────────────────────────────────────────────
// 便携版冷启动（解压 + 后台启动 + 界面加载）最长可达一分钟，
// 没有反馈就像"打不开"（用户实测踩中）。splash 在 boot 最早期出现，
// 按真实里程碑推进进度条，主窗口 ready-to-show 时关闭。

let splashWindow = null;

function createSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return;
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: `${APP_DISPLAY_NAME} 启动中`,
    backgroundColor: '#f3f4f7',
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splashWindow.setMenu(null);
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), { query: { locale: localeStore.get() } });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function updateSplash(pct, text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const script = `window.setProgress(${Number(pct) || 0}, ${JSON.stringify(text || '')})`;
  splashWindow.webContents.executeJavaScript(script).catch(() => {});
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function createWindow(url, desktopToken) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: APP_DISPLAY_NAME,
    autoHideMenuBar: true,
    // 与默认浅色登录页底色一致，避免启动白闪；深色主题由 index.html 内联脚本预置 data-theme 防闪
    backgroundColor: '#f3f4f7',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // 侧边网页栏（WebPanelDrawer）使用 <webview> 内嵌外部网页
      webviewTag: true,
    },
  });

  // AI 答复中的链接 target="_blank"：一律交给系统浏览器，不在窗内打开新窗口。
  // 侧边网页栏以外的外链都走这个兜底。
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) {
      shell.openExternal(targetUrl).catch(() => {});
    }
    return { action: 'deny' };
  });

  // 全局右键菜单（v0.4.30）：Electron 默认没有右键菜单，非技术用户找不到
  // 「复制」入口（Ctrl+C 可用但不可发现）。按上下文给 剪切/复制/粘贴/全选。
  const attachCopyMenu = contents => editingController.attach(contents, win);
  attachCopyMenu(win.webContents);
  // 侧边网页栏等 <webview> 有独立 webContents，同样挂右键菜单
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') attachCopyMenu(contents);
  });

  win.once('ready-to-show', () => {
    updateSplash(100, '完成');
    closeSplash();
    win.show();
  });
  // 兜底：ready-to-show 因冷启动渲染慢/GPU 抖动迟迟不触发时，10s 后强制显示，
  // 避免"进程在、后端在、窗口就是不出来"（用户实测踩中）；同时记录渲染端错误便于诊断。
  const showFallback = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      if (currentLogFile) appendLog(currentLogFile, '[electron] ready-to-show timed out after 10s; forcing win.show()\n');
      closeSplash();
      win.show();
    }
  }, 10_000);
  win.once('ready-to-show', () => clearTimeout(showFallback));
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && currentLogFile) {
      appendLog(currentLogFile, `[renderer:${level}] ${String(message).slice(0, 500)}\n`);
    }
  });
  // The token stays in the main process and is only attached to this exact loopback origin.
  const trustedOrigin = new URL(url).origin;
  win.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${trustedOrigin}/*`] }, (details, callback) => {
    let requestOrigin = '';
    try { requestOrigin = new URL(details.url).origin; } catch { /* Never inject into malformed URLs. */ }
    if (requestOrigin === trustedOrigin) {
      details.requestHeaders['X-TRACE-Desktop-Token'] = desktopToken;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  win.loadURL(url);
  win.webContents.on('render-process-gone', (_event, details) => {
    if (currentLogFile) appendLog(currentLogFile, `[electron] renderer gone: ${JSON.stringify(details)}\n`);
    if (rendererUnresponsiveTimer) clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = null;
    restartAfterRendererCrash(win, JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 is an intentional navigation abort.
    if (currentLogFile) {
      appendLog(currentLogFile, `[electron] main frame load failed code=${errorCode} url=${validatedUrl} error=${errorDescription}\n`);
    }
    restartAfterRendererCrash(win, `did-fail-load:${errorCode}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    if (currentLogFile) appendLog(currentLogFile, `[electron] preload error path=${preloadPath}: ${error?.stack || error}\n`);
  });
  win.on('unresponsive', () => {
    if (currentLogFile) appendLog(currentLogFile, '[electron] renderer unresponsive; waiting 8s before recovery\n');
    if (rendererUnresponsiveTimer) clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = setTimeout(() => {
      rendererUnresponsiveTimer = null;
      restartAfterRendererCrash(win, 'unresponsive-timeout');
    }, 8_000);
  });
  win.on('responsive', () => {
    if (rendererUnresponsiveTimer) clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = null;
    if (currentLogFile) appendLog(currentLogFile, '[electron] renderer responsive again\n');
  });
  win.on('closed', () => {
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    if (rendererUnresponsiveTimer) clearTimeout(rendererUnresponsiveTimer);
    rendererRecoveryTimer = null;
    rendererUnresponsiveTimer = null;
    mainWindow = null;
  });
  return win;
}

function stopBackend(reason = 'application-exit') {
  const processToStop = backendProcess;
  backendProcess = null;
  if (!processToStop) {
    if (currentLogFile) appendLog(currentLogFile, `[electron] backend cleanup skipped reason=${reason}: no tracked process\n`);
    return;
  }

  if (currentLogFile) {
    appendLog(currentLogFile, `[electron] stopping backend tree pid=${processToStop.pid ?? 'unknown'} reason=${reason}\n`);
  }

  // Windows 的普通 kill 只结束直接子进程。后台再启动的 dsh/node 会变成
  // 孤儿进程并持续占用安装目录，导致下一次更新误报“TRACE 无法关闭”。
  // taskkill /T 只沿本应用后台进程的子树清理，不影响其他 Node 程序。
  if (process.platform === 'win32' && Number.isInteger(processToStop.pid)) {
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    const taskkillPath = path.join(windowsRoot, 'System32', 'taskkill.exe');
    const result = spawnSync(taskkillPath, ['/PID', String(processToStop.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8_000,
    });
    if (currentLogFile) {
      appendLog(currentLogFile, `[electron] backend taskkill status=${result.status ?? 'null'} error=${result.error?.message || 'none'}\n`);
    }
    if (!result.error && result.status === 0) return;
  }

  try { processToStop.kill(); } catch { /* process already exited */ }
}

function hashLocalFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function launchDefaultAppAndWait(filePath, onOpened) {
  // Electron delegates this directly to the operating system's file
  // association handler. The previous hidden `cmd /c start /wait` wrapper can
  // remain alive without ever showing the associated application on some
  // Windows installations, leaving the renderer stuck in an "editing" state.
  // File changes are tracked independently by the remote-edit watcher, so the
  // launcher only needs to confirm that Windows accepted the open request.
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  await onOpened?.();
}

async function checkActiveTransfers(port, token) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/api/transfers`, {
      headers: { 'X-TRACE-Desktop-Token': token },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const transfers = Array.isArray(payload) ? payload : (payload.transfers || []);
          // 只有真正在传输/排队中的任务才阻止关窗；
          // paused 是用户已中断的任务（含重启后恢复的旧任务），没有数据在流动。
          const active = transfers.filter(t => t.state === 'running' || t.state === 'queued');
          resolve(active.length > 0);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function promptBeforeClose(port, token) {
  if (!mainWindow) return true;
  try {
    const hasActive = await checkActiveTransfers(port, token);
    const unsyncedCount = remoteEditSessionManager
      ? remoteEditSessionManager.list().filter(session =>
          session.dirty || session.state === 'uploading' || session.state === 'failed').length
      : 0;
    if (!hasActive && unsyncedCount === 0) return true;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [desktopText('关闭窗口', 'Close window'), desktopText('取消', 'Cancel')],
      defaultId: 1,
      title: unsyncedCount > 0 ? desktopText('远程文件尚未同步', 'Unsynced remote files') : desktopText('文件传输进行中', 'File transfers in progress'),
      message: unsyncedCount > 0
        ? desktopText(`仍有 ${unsyncedCount} 个远程文件修改未同步。强制关闭不会删除本地恢复副本。`, `${unsyncedCount} remote file edits have not been synced. Closing will preserve local recovery copies.`)
        : desktopText('有活动的文件传输任务正在进行。关闭窗口将取消所有未完成的传输。', 'File transfers are in progress. Closing will cancel unfinished transfers.'),
    });
    return response === 0;
  } catch {
    return true;
  }
}

function registerIpcHandlers(port, desktopToken) {
  ipcMain.handle('trace:locale:get', () => localeStore.get());
  ipcMain.handle('trace:locale:set', (_event, locale) => {
    const result = localeStore.set(locale);
    editingController.refreshMenu();
    return result;
  });
  // Profile IPC handlers
  ipcMain.handle('trace:profiles:list', () => {
    return profileStore.list();
  });

  // 前端通用密钥（AI 配置/TOTP 种子/集群记住密码）的加密读写，
  // key 名白名单见 secret-store.cjs；渲染进程启动时水合到内存缓存后同步使用
  ipcMain.handle('trace:secrets:get', (_event, key) => {
    return secretStore.get(key);
  });

  ipcMain.handle('trace:secrets:set', (_event, key, value) => {
    return secretStore.set(key, value);
  });

  ipcMain.handle('trace:secrets:delete', (_event, key) => {
    return secretStore.delete(key);
  });

  ipcMain.handle('trace:profiles:save', (_event, profile) => {
    return profileStore.save(profile);
  });

  ipcMain.handle('trace:profiles:remove', (_event, id) => {
    return profileStore.remove(id);
  });

  // 登录界面下拉选择账号时回填密码/TOTP 秘钥（仅在渲染进程请求时解密）
  ipcMain.handle('trace:profiles:getCredentials', (_event, id) => {
    return profileStore.getCredentials(id);
  });

  ipcMain.handle('trace:profiles:trustFingerprint', (_event, id, fingerprint) => {
    return profileStore.trustFingerprint(id, fingerprint);
  });

  ipcMain.handle('trace:profiles:connect', async (_event, id) => {
    const profile = profileStore.list().find(p => p.id === id);
    if (!profile) throw new Error(`Profile not found: ${id}`);

    const credentials = profileStore.getCredentials(id);
    if (!credentials.password) throw new Error(`No saved password for profile: ${id}`);

    let verificationCode = '';
    if (credentials.totpSecret) {
      verificationCode = generateTotp(credentials.totpSecret);
    }

    // POST to backend /api/desktop/connect
    const body = JSON.stringify({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: credentials.password,
      verificationCode,
      expectedFingerprint: profile.fingerprint,
    });

    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/api/desktop/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-TRACE-Desktop-Token': desktopToken,
        },
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);

            if (res.statusCode === 428) {
              // Fingerprint required
              reject(Object.assign(new Error(result.code || 'Fingerprint required'), {
                code: 'HOST_FINGERPRINT_REQUIRED',
                fingerprint: result.fingerprint,
              }));
              return;
            }

            if (res.statusCode === 409) {
              // Fingerprint mismatch
              reject(Object.assign(new Error(result.code || 'Fingerprint mismatch'), {
                code: 'HOST_FINGERPRINT_MISMATCH',
                expected: result.expected,
                actual: result.actual,
              }));
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(result.error || `Connection failed with status ${res.statusCode}`));
              return;
            }

            // Update lastUsedAt
            profileStore.save({ ...profile, lastUsedAt: Date.now() }).catch(() => {});

            resolve(result);
          } catch (err) {
            reject(new Error(`Invalid response from backend: ${err.message}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Connection request timed out'));
      });
      req.end(body);
    });
  });

  // Local file IPC handlers
  ipcMain.handle('trace:localFiles:listDrives', () => {
    return localFileService.listDrives();
  });

  ipcMain.handle('trace:localFiles:list', (_event, dirPath) => {
    return localFileService.list(dirPath);
  });

  // 主进程剪贴板：绕过 navigator.clipboard 的窗口聚焦限制
  ipcMain.handle('trace:clipboard:readText', () => clipboard.readText());
  ipcMain.handle('trace:clipboard:writeText', (_event, text) => {
    clipboard.writeText(String(text ?? ''));
  });

  // 选择本地目录（Agent 工作区：dsh 引擎本地工具的落点目录）
  ipcMain.handle('trace:dialog:pickDirectory', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] || null);
  });

  ipcMain.handle('trace:localFiles:stat', (_event, targetPath) => {
    return localFileService.stat(targetPath);
  });

  ipcMain.handle('trace:localFiles:mkdir', (_event, dirPath) => {
    return localFileService.mkdir(dirPath);
  });

  ipcMain.handle('trace:localFiles:createFile', (_event, targetPath) => {
    return localFileService.createFile(targetPath);
  });

  ipcMain.handle('trace:localFiles:writeFile', (_event, targetPath, content) => {
    return localFileService.writeFile(targetPath, content);
  });

  ipcMain.handle('trace:localFiles:walk', (_event, dirPath) => {
    return localFileService.walk(dirPath);
  });

  ipcMain.handle('trace:localFiles:rename', (_event, from, to) => {
    return localFileService.rename(from, to);
  });

  ipcMain.handle('trace:localFiles:copy', (_event, sourcePaths, targetDirectory) => {
    return localFileService.copy(sourcePaths, targetDirectory);
  });

  ipcMain.handle('trace:localFiles:trash', (_event, targetPath) => {
    return localFileService.trash(targetPath);
  });

  ipcMain.handle('trace:localFiles:open', async (_event, targetPath) => {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle('trace:localFiles:preview', (_event, targetPath, maxBytes) => {
    return localFileService.readPreview(targetPath, maxBytes);
  });

  ipcMain.handle('trace:localFiles:search', async (_event, root, query) => {
    const requestId = crypto.randomUUID();
    const abortController = new AbortController();
    searchAbortControllers.set(requestId, abortController);

    try {
      const results = await localFileService.search(root, query, abortController.signal);
      return { requestId, results };
    } finally {
      searchAbortControllers.delete(requestId);
    }
  });

  ipcMain.on('trace:localFiles:cancelSearch', (_event, requestId) => {
    const controller = searchAbortControllers.get(requestId);
    if (controller) {
      controller.abort();
      searchAbortControllers.delete(requestId);
    }
  });

  ipcMain.handle('trace:remoteEdits:prepare', (_event, metadata) => {
    return remoteEditSessionManager.prepare(metadata);
  });
  ipcMain.handle('trace:remoteEdits:markDownloaded', (_event, id) => {
    return remoteEditSessionManager.markDownloaded(id);
  });
  ipcMain.handle('trace:remoteEdits:open', (_event, id) => {
    return remoteEditSessionManager.open(id);
  });
  ipcMain.handle('trace:remoteEdits:markUploading', (_event, id, fingerprint) => {
    return remoteEditSessionManager.markUploading(id, fingerprint);
  });
  ipcMain.handle('trace:remoteEdits:markSynced', (_event, id, fingerprint) => {
    return remoteEditSessionManager.markSynced(id, fingerprint);
  });
  ipcMain.handle('trace:remoteEdits:markFailed', (_event, id, error) => {
    return remoteEditSessionManager.markFailed(id, error);
  });
  ipcMain.handle('trace:remoteEdits:retry', (_event, id) => {
    return remoteEditSessionManager.retry(id);
  });
  ipcMain.handle('trace:remoteEdits:discard', (_event, id) => {
    return remoteEditSessionManager.discard(id);
  });
  ipcMain.handle('trace:remoteEdits:list', () => remoteEditSessionManager.list());

  // 安装版更新中心：在线检查/下载/安装，以及本地安装包兜底更新。
  ipcMain.handle('trace:update:getState', () => updateManager.getState());
  ipcMain.handle('trace:update:getSettings', () => updateManager.getSettings());
  ipcMain.handle('trace:update:saveSettings', (_event, settings) => updateManager.saveSettings(settings));
  ipcMain.handle('trace:update:check', () => updateManager.check());
  ipcMain.handle('trace:update:download', () => updateManager.download());
  ipcMain.handle('trace:update:install', () => updateManager.installDownloaded());
  ipcMain.handle('trace:update:pickAndInstall', () => updateManager.pickAndInstall());
}

async function boot() {
  // Restore native editing; custom terminal/file keys ignore menu accelerators
  // only while their pane owns focus, preventing a second terminal paste.
  editingController.refreshMenu();

  createSplash();
  updateSplash(8, `正在启动 ${APP_DISPLAY_NAME}…`);

  const port = await choosePort(Number(process.env.PORT || 3003));
  const url = `http://127.0.0.1:${port}`;
  const { logFile, desktopToken } = startBackend(port);
  updateSplash(30, '正在启动后台服务…');

  // Initialize profile store with safeStorage
  const userDataPath = app.getPath('userData');
  const profilesDir = path.join(userDataPath, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });

  profileStore = createProfileStore({
    safeStorage,
    files: {
      read: async (filePath) => {
        try {
          return fs.readFileSync(path.join(profilesDir, filePath), 'utf8');
        } catch {
          return '';
        }
      },
      writeAtomic: async (filePath, content) => {
        const fullPath = path.join(profilesDir, filePath);
        const tmpPath = fullPath + '.tmp';
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, fullPath);
      },
    },
    filePath: 'profiles.json',
  });

  // Initialize secret store with safeStorage（前端 AI 配置/TOTP/记住密码的加密落盘）
  secretStore = createSecretStore({
    safeStorage,
    files: {
      read: async (filePath) => {
        try {
          return fs.readFileSync(path.join(userDataPath, filePath), 'utf8');
        } catch {
          return '';
        }
      },
      writeAtomic: async (filePath, content) => {
        const fullPath = path.join(userDataPath, filePath);
        const tmpPath = fullPath + '.tmp';
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, fullPath);
      },
    },
    filePath: 'secrets.json',
  });

  // Initialize local file service
  localFileService = createLocalFileService({
    fs: fs.promises,
  });

  remoteEditSessionManager = createRemoteEditSessionManager({
    root: userDataPath,
    files: fs.promises,
    watchFile: (filePath, callback) => {
      const fileName = path.basename(filePath).toLocaleLowerCase();
      return fs.watch(path.dirname(filePath), { persistent: false }, (_event, changedName) => {
        if (!changedName || changedName.toString().toLocaleLowerCase() === fileName) callback();
      });
    },
    hashFile: hashLocalFile,
    launch: launchDefaultAppAndWait,
    onEvent: (type, session) => {
      mainWindow?.webContents.send('trace:remoteEdits:event', { type, session });
    },
  });
  await remoteEditSessionManager.restore();

  updateManager = createUpdateManager({
    app,
    autoUpdater,
    dialog,
    shell,
    getWindow: () => mainWindow,
    settingsFile: path.join(userDataPath, 'update-settings.json'),
    edition: APP_EDITION,
  });

  // Register IPC handlers
  registerIpcHandlers(port, desktopToken);
  updateSplash(60, '正在初始化组件…');

  try {
    await waitForServer(url);
    updateSplash(85, '后台已就绪，正在加载界面…');

    // Activity-aware window close
    mainWindow = createWindow(url, desktopToken);
    mainWindow.on('close', createWindowCloseGuard({
      confirmClose: () => promptBeforeClose(port, desktopToken),
      getWindow: () => mainWindow,
    }));
    updateManager.startAutoCheck();
  } catch (err) {
    closeSplash();
    stopBackend('boot-failed');
    dialog.showErrorBox(`${APP_DISPLAY_NAME} failed to start`, `${err.message}\n\nLog file:\n${logFile}`);
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // 侧边网页栏的 <webview> 是独立 guest webContents：其中的 target=_blank /
  // window.open 同样交给系统浏览器，guest 内不弹新窗。
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (/^https?:\/\//i.test(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => {});
      }
      return { action: 'deny' };
    });
  });

  app.on('child-process-gone', (_event, details) => {
    if (currentLogFile) appendLog(currentLogFile, `[electron] child process gone: ${JSON.stringify(details)}\n`);
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') try {
      migrateLegacyShortcuts({ desktop: app.getPath('desktop'),
        programs: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        userData: app.getPath('userData'), readShortcutLink: filename => shell.readShortcutLink(filename), competition: IS_COMPETITION_EDITION });
    } catch (error) { console.warn('[TRACE] Legacy shortcut cleanup skipped:', error.message); }
    return boot();
  });

  app.on('window-all-closed', () => {
    appIsQuitting = true;
    remoteEditSessionManager?.dispose();
    updateManager?.dispose();
    stopBackend('window-all-closed');
    app.quit();
  });

  app.on('before-quit', () => {
    appIsQuitting = true;
    remoteEditSessionManager?.dispose();
    updateManager?.dispose();
    stopBackend('before-quit');
  });

  // app.exit()/系统会话结束等路径可能绕过正常的窗口关闭顺序；will-quit
  // 再做一次幂等兜底，确保以后日志能明确区分“已清理”和“没有跟踪进程”。
  app.on('will-quit', () => {
    appIsQuitting = true;
    remoteEditSessionManager?.dispose();
    updateManager?.dispose();
    stopBackend('will-quit');
  });
}
