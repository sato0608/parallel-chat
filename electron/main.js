// Parallel Chat — Mac アプリのエントリ。ローカルサーバーを内蔵し、ウィンドウで表示する。
const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { start } = require('../server');

let server = null;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

async function createWindow() {
  if (!server) {
    server = await start({ dataDir: path.join(app.getPath('userData'), 'data'), port: 0 });
  }
  const origin = new URL(server.url).origin;
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 420,
    title: 'Parallel Chat',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#1b1a18',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  // 外部リンクは既定のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
  await win.loadURL(server.url);
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Claude に読ませるフォルダを選択（読み取り専用）',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  createWindow();
});
app.on('activate', () => {
  if (!win) createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server && server.close());
