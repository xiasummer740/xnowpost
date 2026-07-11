let autoUpdater = null;
let mainWindow = null;
let initialized = false;

export function initUpdater(window) {
  if (initialized) return;
  mainWindow = window;
  initialized = true;

  // 延迟加载 electron-updater，避开 app 未就绪的问题
  import('electron-updater').then(mod => {
    const pkg = mod.default || mod;
    autoUpdater = pkg.autoUpdater;
    if (!autoUpdater) { console.error('electron-updater: autoUpdater not found'); return; }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('update:progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      });
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update:downloaded');
    });

    autoUpdater.on('error', (err) => {
      console.error('自动更新错误:', err.message);
      // 错误也传回前端，替代沉默的"已是最新版本"
      mainWindow?.webContents.send('update:error', err.message || '检查更新失败');
    });

    // 首次检查
    checkForUpdates();
  }).catch(err => {
    console.error('electron-updater 加载失败:', err.message);
  });
}

export function downloadUpdate() {
  if (!autoUpdater) {
    console.warn('downloadUpdate: autoUpdater 未就绪');
    return;
  }
  autoUpdater.downloadUpdate();
}

export function quitAndInstall() {
  if (!autoUpdater) {
    console.warn('quitAndInstall: autoUpdater 未就绪');
    return;
  }
  autoUpdater.quitAndInstall();
}

export function checkForUpdates() {
  if (!autoUpdater) {
    console.warn('checkForUpdates: autoUpdater 未就绪，稍后重试');
    return;
  }
  autoUpdater.checkForUpdates().catch(err => {
    console.error('检查更新失败:', err.message);
    mainWindow?.webContents.send('update:error', err.message || '检查更新失败');
  });
}
