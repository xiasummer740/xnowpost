import pkg from 'electron-updater';
import { BrowserWindow } from 'electron';
const { autoUpdater } = pkg;

autoUpdater.autoDownload = false;  // 不自动下载，等用户确认
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow = null;

export function initUpdater(window) {
  mainWindow = window;

  // 检查更新（静默，不弹窗）
  autoUpdater.checkForUpdates().catch(() => {});

  // 有可用更新
  autoUpdater.on('update-available', (info) => {
    const version = info.version;
    mainWindow?.webContents.send('update:available', {
      version,
      releaseDate: info.releaseDate,
    });
  });

  // 已是最新
  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update:not-available');
  });

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred,
    });
  });

  // 下载完成
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update:downloaded');
  });

  // 错误
  autoUpdater.on('error', (err) => {
    console.error('自动更新错误:', err.message);
  });
}

// 用户点击"下载更新"
export function downloadUpdate() {
  autoUpdater.downloadUpdate();
}

// 用户点击"立即安装"
export function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

// 检查更新（手动触发）
export function checkForUpdates() {
  autoUpdater.checkForUpdates().catch(() => {});
}
