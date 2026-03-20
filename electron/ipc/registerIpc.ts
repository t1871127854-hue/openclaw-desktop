import {BrowserWindow, ipcMain, shell} from 'electron';
import {RuntimeService} from '../services/runtimeService';
import {LogService} from '../services/logService';

export function registerIpc(runtimeService: RuntimeService, logService: LogService) {
  ipcMain.handle('openclaw:get-status', () => runtimeService.getStatus());
  ipcMain.handle('openclaw:read-config', () => runtimeService.readConfig());
  ipcMain.handle('openclaw:test-model', (_event, payload) => runtimeService.testModel(payload));
  ipcMain.handle('openclaw:test-channel', (_event, payload) => runtimeService.testChannel(payload));
  ipcMain.handle('openclaw:get-logs', () => runtimeService.getLogs());
  ipcMain.handle('openclaw:export-logs', () => runtimeService.exportLogs());
  ipcMain.handle('openclaw:run-diagnostics', () => runtimeService.runDiagnostics());
  ipcMain.handle('openclaw:repair-diagnostic', (_event, id: string) => runtimeService.repairDiagnostic(id));
  ipcMain.handle('openclaw:execute-action', async (_event, payload) => {
    const result = await runtimeService.executeAction(payload);

    if (payload?.step === 'openUrl' && payload?.url) {
      await shell.openExternal(String(payload.url));
    }

    if ((payload?.step === 'startGatewayAndOpen' || payload?.step === 'startGateway') && result.success) {
      await shell.openExternal('http://127.0.0.1:18789');
    }

    return result;
  });
  ipcMain.handle('openclaw:get-state', () => runtimeService.getState());
  ipcMain.handle('openclaw:set-state', (_event, state) => runtimeService.setState(state));
  ipcMain.handle('openclaw:clear-logs', () => runtimeService.clearLogs());

  logService.subscribe((entry) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('openclaw:log-entry', entry);
    });
  });
}
