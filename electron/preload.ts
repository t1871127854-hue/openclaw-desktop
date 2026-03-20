import {contextBridge, ipcRenderer} from 'electron';
import type {InstallState, LogEntry, OpenClawApi} from '../src/types/api';

const api: OpenClawApi = {
  getStatus: () => ipcRenderer.invoke('openclaw:get-status'),
  readConfig: () => ipcRenderer.invoke('openclaw:read-config'),
  testModel: (payload) => ipcRenderer.invoke('openclaw:test-model', payload),
  testChannel: (payload) => ipcRenderer.invoke('openclaw:test-channel', payload),
  getLogs: () => ipcRenderer.invoke('openclaw:get-logs'),
  subscribeLogs: (listener: (entry: LogEntry) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, entry: LogEntry) => listener(entry);
    ipcRenderer.on('openclaw:log-entry', subscription);
    return () => ipcRenderer.removeListener('openclaw:log-entry', subscription);
  },
  exportLogs: () => ipcRenderer.invoke('openclaw:export-logs'),
  executeAction: (payload) => ipcRenderer.invoke('openclaw:execute-action', payload),
  getState: () => ipcRenderer.invoke('openclaw:get-state'),
  setState: (state: InstallState) => ipcRenderer.invoke('openclaw:set-state', state),
  clearLogs: () => ipcRenderer.invoke('openclaw:clear-logs'),
  runDiagnostics: () => ipcRenderer.invoke('openclaw:run-diagnostics'),
  repairDiagnostic: (id: string) => ipcRenderer.invoke('openclaw:repair-diagnostic', id),
};

contextBridge.exposeInMainWorld('openClaw', api);
