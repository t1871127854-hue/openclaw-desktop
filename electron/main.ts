import {app, BrowserWindow} from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerIpc} from './ipc/registerIpc';
import {CommandService} from './services/commandService';
import {GatewayService} from './services/gatewayService';
import {LogService} from './services/logService';
import {RuntimeService} from './services/runtimeService';
import {StorageService} from './services/storageService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const basePath = isDev ? process.cwd() : exeDir;
const appDataPath = process.env.APPDATA || app.getPath('appData');
const documentsPath = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : app.getPath('documents');
const workspacePath = path.join(documentsPath, 'OpenClaw_Workspace');
const configFile = path.join(app.getPath('home'), '.openclaw', 'openclaw.json');
const stateFile = path.join(basePath, 'install_state.json');
const logFile = path.join(basePath, 'openclaw_launcher.log');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1120,
    minHeight: 760,
    title: 'OpenClaw Launcher',
    icon: path.join(__dirname, '../public/favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    void mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools({mode: 'detach'});
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.setMenuBarVisibility(false);
}

async function bootstrap() {
  const logService = new LogService(logFile, workspacePath);
  await logService.init();
  await logService.info('Electron main process ready.', 'system');

  const storageService = new StorageService(configFile, stateFile);
  const commandService = new CommandService(logService);
  const gatewayService = new GatewayService({basePath, workspacePath}, commandService, logService);
  const runtimeService = new RuntimeService(
    {
      basePath,
      userDataPath: app.getPath('userData'),
      homePath: app.getPath('home'),
      appDataPath,
      workspacePath,
      configFile,
      stateFile,
      logFile,
    },
    logService,
    storageService,
    commandService,
    gatewayService,
  );

  registerIpc(runtimeService, logService);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.whenReady().then(bootstrap);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
