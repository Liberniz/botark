import { registerSlackIpc, stopSlack } from './slack/slackIpc'
import { registerWorkspaceIpc, stopWorkspaces } from './mcp/hub'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { attachWebViewManager, registerWebViewIpc } from './webViewIpc'
import { attachMuseSessionManager, disposeAllMuseManagers, registerMuseIpc } from './muse/museIpc'
import { registerUpdaterIpc, startAutoUpdater } from './updater'
import { registerMobileSyncIpc, stopMobileSyncServer } from './mobileSync/mobileSyncIpc'
import { applyAllStoredProxies } from './muse/accountProxy'
import { closeAllLocalProxyBridges } from './localProxyBridge'
import { hardenVaultFilePermissions, registerVaultIpc } from './securityVault'
import { getAppWindowIcon } from './appIcon'

try {
  app.commandLine?.appendSwitch?.('disable-blink-features', 'AutomationControlled')
} catch {
  /* ignore in test environments */
}

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null
let quitting = false

// Seamless upgrade from legacy "bothub" userData directory: if an existing user
// already has accounts/sessions in Application Support/bothub and no new botark
// directory yet, preserve their exact userData directory automatically.
try {
  const appData = app.getPath('appData')
  const newUserData = join(appData, 'botark')
  const legacyUserData = join(appData, 'bothub')
  const legacyHasData =
    existsSync(join(legacyUserData, 'Partitions')) ||
    existsSync(join(legacyUserData, 'grok-sand-tokens.json'))
  const newHasData =
    existsSync(join(newUserData, 'Partitions')) ||
    existsSync(join(newUserData, 'grok-sand-tokens.json')) ||
    existsSync(join(newUserData, 'cue-tokens.json'))
  if (existsSync(legacyUserData) && (legacyHasData || !existsSync(newUserData)) && !newHasData) {
    app.setPath('userData', legacyUserData)
  }
} catch {
  /* ignore */
}

// Two instances share userData and race on every JSON store and on
// Chromium's profile; hand the second launch over to the first.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// A stray rejection or transient socket error in a timer/proxy/IPC handler
// should be logged cleanly instead of crashing the whole desktop workspace.
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : typeof reason
  console.error('[bothub] unhandled rejection:', text.slice(0, 300))
})
process.on('uncaughtException', (error) => {
  console.error('[bothub] uncaught exception:', `${error.name}: ${error.message}`.slice(0, 300))
})

function createMainWindow(): BrowserWindow {
  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 620,
    show: false,
    title: 'BotArk',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 28 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Embedded platform web sessions (hidden until the renderer attaches one).
  const views = attachWebViewManager(win)
  attachMuseSessionManager(win, views)

  const showMainWindow = (): void => {
    if (win.isDestroyed()) return
    if (!win.isVisible()) win.show()
  }
  win.once('ready-to-show', showMainWindow)
  win.webContents.once('did-finish-load', showMainWindow)
  setTimeout(showMainWindow, 1500)

  // macOS: the red button hides the window instead of destroying it. A
  // re-created window used to start a second Muse session manager while the
  // old one kept its timers and gateways running (one leak per reopen).
  win.on('close', (event) => {
    if (isMac && !quitting) {
      event.preventDefault()
      // Hiding a fullscreen window leaves an empty black Space behind.
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => win.hide())
        win.setFullScreen(false)
      } else {
        win.hide()
      }
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Never open new Electron windows from the renderer; hand http(s) links to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The app is a single page: block navigations (e.g. a file dropped onto the
  // window) that would replace the UI. Reloads are not affected.
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // Self-heal if Chromium's renderer process crashes or runs out of memory.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[bothub] renderer gone:', details.reason, 'exitCode=', details.exitCode)
    if (!quitting && !win.isDestroyed() && details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (!quitting && !win.isDestroyed()) win.webContents.reload()
      }, 600)
    }
  })
  win.on('unresponsive', () => {
    console.warn('[bothub] main window became unresponsive')
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.on('before-quit', () => {
  quitting = true
  void stopSlack()
  stopWorkspaces()
  void stopMobileSyncServer()
  disposeAllMuseManagers()
  void closeAllLocalProxyBridges()
})

app.whenReady().then(async () => {
  if (!gotLock) return
  hardenVaultFilePermissions()
  // Before any partition loads: otherwise the first requests go direct.
  await Promise.race([applyAllStoredProxies(), new Promise((r) => setTimeout(r, 5_000))])
  registerWebViewIpc()
  registerMuseIpc()
  registerUpdaterIpc()
  registerMobileSyncIpc()
  registerVaultIpc()
  registerWorkspaceIpc(() => mainWindow)
  registerSlackIpc(() => mainWindow)
  mainWindow = createMainWindow()
  startAutoUpdater()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    else mainWindow = createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
