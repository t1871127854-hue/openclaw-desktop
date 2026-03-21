import { contextBridge, ipcRenderer } from 'electron';
import type { FeishuConfigForm, LauncherLogEntry, ModelConfigForm, OpenClawApi, PersistedWorkflowState } from '../src/types/api';

const api: OpenClawApi = {
  getOverview: () => ipcRenderer.invoke('openclaw:get-overview'),
  getLogs: () => ipcRenderer.invoke('openclaw:get-logs'),
  subscribeLogs: (listener: (entry: LauncherLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: LauncherLogEntry) => listener(entry);
    ipcRenderer.on('openclaw:log', handler);
    return () => ipcRenderer.removeListener('openclaw:log', handler);
  },
  subscribeWorkflow: (listener: (state: PersistedWorkflowState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: PersistedWorkflowState) => listener(state);
    ipcRenderer.on('openclaw:workflow', handler);
    return () => ipcRenderer.removeListener('openclaw:workflow', handler);
  },
  installAll: () => ipcRenderer.invoke('openclaw:install-all'),
  resumeInstall: () => ipcRenderer.invoke('openclaw:resume-install'),
  repairAll: () => ipcRenderer.invoke('openclaw:repair-all'),
  writeModelConfig: (payload: ModelConfigForm) => ipcRenderer.invoke('openclaw:write-model-config', payload),
  testModelConfig: (payload: ModelConfigForm) => ipcRenderer.invoke('openclaw:test-model-config', payload),
  writeFeishuConfig: (payload: FeishuConfigForm) => ipcRenderer.invoke('openclaw:write-feishu-config', payload),
  importSkillsPack: () => ipcRenderer.invoke('openclaw:import-skills-pack'),
  restartGateway: () => ipcRenderer.invoke('openclaw:restart-gateway'),
  openDashboard: () => ipcRenderer.invoke('openclaw:open-dashboard'),
  uninstallOpenClaw: () => ipcRenderer.invoke('openclaw:uninstall-openclaw'),
  uninstallEverything: () => ipcRenderer.invoke('openclaw:uninstall-everything'),
  clearLogs: () => ipcRenderer.invoke('openclaw:clear-logs'),
};

contextBridge.exposeInMainWorld('openclawApi', api);
