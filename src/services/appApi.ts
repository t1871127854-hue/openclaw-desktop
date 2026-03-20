import {mockApi} from './mockApi';
import type {
  ChannelTestPayload,
  DiagnosticIssue,
  ExecuteActionPayload,
  InstallState,
  LogEntry,
  ModelTestPayload,
  OpenClawApi,
} from '../types/api';

const endpointMap = {
  getStatus: '/api/status',
  readConfig: '/api/read-config',
  testModel: '/api/test-model',
  testChannel: '/api/test-channel',
  getLogs: '/api/logs',
  exportLogs: '/api/export-logs',
  executeAction: '/api/execute',
  getState: '/api/get-state',
  setState: '/api/set-state',
  clearLogs: '/api/clear-logs',
  runDiagnostics: '/api/diagnostics',
  repairDiagnostic: '/api/repair-diagnostic',
} as const;

async function request<T>(url: string, init?: RequestInit, expectText = false): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return (expectText ? response.text() : response.json()) as Promise<T>;
}

const browserApi: OpenClawApi = {
  getStatus: () => request(endpointMap.getStatus),
  readConfig: () => request(endpointMap.readConfig),
  testModel: (payload: ModelTestPayload) =>
    request(endpointMap.testModel, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    }),
  testChannel: (payload: ChannelTestPayload) =>
    request(endpointMap.testChannel, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    }),
  getLogs: () => request<string>(endpointMap.getLogs, undefined, true),
  subscribeLogs: () => () => {},
  exportLogs: () => request(endpointMap.exportLogs, {method: 'POST'}),
  executeAction: (payload: ExecuteActionPayload) =>
    request(endpointMap.executeAction, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    }),
  getState: () => request(endpointMap.getState),
  setState: (state: InstallState) =>
    request(endpointMap.setState, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(state),
    }),
  clearLogs: () => request(endpointMap.clearLogs, {method: 'POST'}),
  runDiagnostics: () => request<DiagnosticIssue[]>(endpointMap.runDiagnostics),
  repairDiagnostic: (id: string) =>
    request(endpointMap.repairDiagnostic, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
};

function createApi(): OpenClawApi {
  if (typeof window !== 'undefined' && window.openClaw) {
    return window.openClaw;
  }

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    return browserApi;
  }

  return mockApi;
}

const appApi = createApi();

export type {LogEntry};
export {appApi};
