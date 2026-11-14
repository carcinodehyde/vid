// Desktop shell: runs the editor's server inside the app on a free loopback
// port and shows the same web UI in a window. The project and caches live in
// the per-user app data folder; exports go to the user's Videos folder.

import path from 'node:path';

import { BrowserWindow, Menu, app, dialog, shell } from 'electron';

import { stopAll } from '../server/media.js';
import { startServer } from '../server/server.js';

const isMac = process.platform === 'darwin';
let running = null;
let window = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16181c',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links leave the editor: an exported file opens in the system's player,
  // anything else in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const exported = url.startsWith(`${running.url}exports/`);
    if (exported) {
      const name = path.basename(decodeURIComponent(new URL(url).pathname));
      shell.openPath(path.join(running.exportDir, name));
    } else if (/^https?:/.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(running.url)) event.preventDefault();
  });
  window.on('closed', () => {
    window = null;
  });
  window.loadURL(running.url);
}

// No Edit > Undo/Redo roles here: their accelerators would swallow the
// Ctrl+Z / Ctrl+Shift+Z the editor handles itself.
function buildMenu() {
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open exports folder', click: () => shell.openPath(running.exportDir) },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  // The project file has one owner: hand over to the copy already running.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    stopAll();
    running?.server.close();
  });

  // Not a top-level await: Electron holds back "ready" until this module has
  // finished loading, so awaiting it here would never return.
  app.whenReady().then(async () => {
    try {
      running = await startServer({
        port: Number(process.env.PORT || 0),
        dataDir: process.env.VID_DATA_DIR || path.join(app.getPath('userData'), 'data'),
        exportDir: process.env.VID_DATA_DIR ? null : path.join(app.getPath('videos'), 'vid'),
      });
      Menu.setApplicationMenu(buildMenu());
      createWindow();
      app.on('activate', () => {
        if (!window) createWindow();
      });
    } catch (error) {
      dialog.showErrorBox('vid could not start', error.stack || error.message);
      app.quit();
    }
  });
}
