import type {
  ActionResult,
  ChannelTestPayload,
  DiagnosticIssue,
  EnvironmentStatus,
  InstallState,
  LogEntry,
  OpenClawApi,
  TestResult,
  ModelTestPayload,
  ExecuteActionPayload,
} from '../types/api';

const CONFIG_KEY = 'openclaw.mock.config';
const STATE_KEY = 'openclaw.mock.state';
const LOGS_KEY = 'openclaw.mock.logs';
const STATUS_KEY = 'openclaw.mock.status';

const defaultStatus: EnvironmentStatus = {
  isAdmin: false,
  is64Bit: true,
  node: {isOk: false, version: 'not_installed'},
  git: {isOk: false, version: 'not_installed'},
  wsl: 'not_installed',
  vmPlatform: 'not_installed',
  sandboxFeature: 'not_installed',
  runtime: 'not_installed',
  gateway: 'stopped',
  configExists: false,
  skillPackExists: false,
  port18789: {
    occupied: false,
    port: 18789,
    pid: null,
    protocol: null,
    rawOutput: '',
    advice: ['Mock 模式：端口空闲。'],
  },
  offlineResources: {
    exists: false,
    basePath: 'offline_resources',
    missingFiles: ['WSL 包', 'Node 离线包', 'rootfs / 镜像包', '校验文件'],
    invalidFiles: [],
    detectedFiles: [],
    modeSuggestion: 'online',
    advice: ['Mock 模式：未挂载离线资源目录。'],
  },
  installWorkflow: {
    active: false,
    mode: null,
    stage: 'idle',
    history: [],
    lastUpdatedAt: new Date().toISOString(),
  },
  upgradePlan: {
    status: 'blocked',
    source: 'none',
    targets: [],
    blockers: ['Mock 模式：未配置远端 manifest。'],
    steps: ['prepare resources', 'replace managed files', 'validate post-upgrade'],
    futureIntegrationPoint: 'Mock 升级链仅演示计划结构。',
  },
  gatewayDetails: {
    running: false,
    pid: null,
    port: 18789,
    workingDirectory: null,
    entryPoint: null,
    commandLine: null,
    placeholder: true,
    advice: ['Mock 模式：Gateway 尚未启动。'],
  },
  localResources: {
    folderExists: false,
    rootfsExists: false,
    path: 'Mock 模式：未挂载本地 resources/openclaw-rootfs.tar',
  },
};

const listeners = new Set<(entry: LogEntry) => void>();

function safeParse<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function deepMerge(target: Record<string, any>, source: Record<string, any>) {
  const output = {...target};
  Object.entries(source).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(output[key] ?? {}, value as Record<string, any>);
    } else {
      output[key] = value;
    }
  });
  return output;
}

function createLogEntry(message: string, source: LogEntry['source'] = 'system', level: LogEntry['level'] = 'info'): LogEntry {
  return {
    id: crypto.randomUUID(),
    source,
    level,
    message,
    timestamp: new Date().toISOString(),
  };
}

function appendLog(message: string, source: LogEntry['source'] = 'system', level: LogEntry['level'] = 'info') {
  const entry = createLogEntry(message, source, level);
  const history = safeParse<LogEntry[]>(LOGS_KEY, []);
  history.push(entry);
  writeStorage(LOGS_KEY, history.slice(-300));
  listeners.forEach((listener) => listener(entry));
}

function formatLogs(entries: LogEntry[]) {
  return entries
    .map((entry) => `[${entry.timestamp}] [${entry.source.toUpperCase()}] [${entry.level.toUpperCase()}] ${entry.message}`)
    .join('\n');
}

function setStatusPatch(patch: Partial<EnvironmentStatus>) {
  const current = safeParse<EnvironmentStatus>(STATUS_KEY, defaultStatus);
  writeStorage(STATUS_KEY, {...current, ...patch});
}

function getDiagnostics(): DiagnosticIssue[] {
  const status = safeParse<EnvironmentStatus>(STATUS_KEY, defaultStatus);
  return [
    {
      id: 'port-18789-in-use',
      title: 'Port 18789 检查',
      status: status.port18789?.occupied ? 'error' : 'healthy',
      summary: status.port18789?.occupied ? 'Mock：端口被占用' : 'Mock：端口空闲',
      details: status.port18789?.advice ?? [],
      repairable: Boolean(status.port18789?.occupied),
      repairAction: 'killPortProcess',
    },
    {
      id: 'node-missing-or-unsupported',
      title: 'Node.js 版本检查',
      status: status.node.isOk ? 'healthy' : 'error',
      summary: status.node.isOk ? 'Mock：Node 可用' : 'Mock：Node 不可用',
      details: status.nodeDetails?.advice ?? ['Mock 模式：仅演示规则输出。'],
      repairable: true,
      repairAction: 'installNodeOffline',
    },
  ];
}

const mockApi: OpenClawApi = {
  async getStatus() {
    return safeParse<EnvironmentStatus>(STATUS_KEY, defaultStatus);
  },
  async readConfig() {
    return safeParse<Record<string, any>>(CONFIG_KEY, {});
  },
  async testModel({provider}: ModelTestPayload): Promise<TestResult> {
    appendLog(`Mock test-model executed for provider: ${provider}`);
    return {success: true, message: `Mock 模式：${provider} 配置格式校验通过`};
  },
  async testChannel({channel}: ChannelTestPayload): Promise<TestResult> {
    appendLog(`Mock test-channel executed for channel: ${channel}`);
    return {success: true, message: `Mock 模式：${channel} 渠道测试通过`};
  },
  async getLogs() {
    return formatLogs(safeParse<LogEntry[]>(LOGS_KEY, []));
  },
  subscribeLogs(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async exportLogs() {
    appendLog('Mock export logs', 'system', 'success');
    return {success: true, result: 'Mock：日志已导出（未写入真实文件）'};
  },
  async executeAction(payload: ExecuteActionPayload): Promise<ActionResult> {
    appendLog(`Mock execute-action: ${payload.step}`);
    switch (payload.step) {
      case 'wsl':
      case 'repairWSL':
        setStatusPatch({wsl: 'installed'});
        return {success: true, result: 'Mock：WSL 已标记为安装'};
      case 'importRuntime':
      case 'runtime':
        setStatusPatch({runtime: 'installed'});
        return {success: true, result: 'Mock：运行时已导入'};
      case 'runInstallWizard':
        setStatusPatch({
          installWorkflow: {
            active: false,
            mode: (payload.mode as any) ?? 'hybrid',
            stage: 'completed',
            history: [
              {stage: 'detect-environment', status: 'completed', message: 'Mock detect environment', timestamp: new Date().toISOString()},
              {stage: 'choose-mode', status: 'completed', message: 'Mock choose mode', timestamp: new Date().toISOString()},
              {stage: 'resolve-resources', status: 'completed', message: 'Mock resolve resources', timestamp: new Date().toISOString()},
              {stage: 'import-download-resources', status: 'completed', message: 'Mock prepare resources', timestamp: new Date().toISOString()},
              {stage: 'install-runtime', status: 'completed', message: 'Mock install runtime', timestamp: new Date().toISOString()},
              {stage: 'validate-post-install', status: 'completed', message: 'Mock validate runtime', timestamp: new Date().toISOString()},
              {stage: 'start-gateway', status: 'completed', message: 'Mock start gateway', timestamp: new Date().toISOString()},
              {stage: 'completed', status: 'completed', message: 'Mock install wizard completed', timestamp: new Date().toISOString()},
            ],
            lastUpdatedAt: new Date().toISOString(),
          },
          runtime: 'installed',
          gateway: 'running',
        });
        return {success: true, result: 'Mock：安装向导已完成'};
      case 'checkUpgrade':
        return {success: true, result: 'Mock：已检查升级', details: {plan: safeParse<EnvironmentStatus>(STATUS_KEY, defaultStatus).upgradePlan}};
      case 'runUpgrade':
        return {success: false, error: 'Mock：升级执行仍是骨架', details: {plan: safeParse<EnvironmentStatus>(STATUS_KEY, defaultStatus).upgradePlan}};
      case 'startGateway':
      case 'startGatewayAndOpen':
      case 'restartGateway':
      case 'setupGateway':
        setStatusPatch({
          gateway: 'running',
          port18789: {
            occupied: true,
            port: 18789,
            pid: 9527,
            protocol: 'TCP',
            rawOutput: 'TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    9527',
            advice: ['Mock 模式：Gateway 已占用端口 18789。'],
          },
          installWorkflow: {
    active: false,
    mode: null,
    stage: 'idle',
    history: [],
    lastUpdatedAt: new Date().toISOString(),
  },
  upgradePlan: {
    status: 'blocked',
    source: 'none',
    targets: [],
    blockers: ['Mock 模式：未配置远端 manifest。'],
    steps: ['prepare resources', 'replace managed files', 'validate post-upgrade'],
    futureIntegrationPoint: 'Mock 升级链仅演示计划结构。',
  },
  gatewayDetails: {
            running: true,
            pid: 9527,
            port: 18789,
            workingDirectory: 'mock/gateway',
            entryPoint: 'mock-entry.js',
            commandLine: 'node mock-entry.js',
            placeholder: true,
            advice: ['Mock 模式：Gateway 已启动。'],
          },
        });
        appendLog('Mock gateway started', 'gateway', 'success');
        return {success: true, result: 'Mock：Gateway 已启动'};
      case 'stopGateway':
      case 'killPortProcess':
        setStatusPatch({
          gateway: 'stopped',
          port18789: {
            occupied: false,
            port: 18789,
            pid: null,
            protocol: null,
            rawOutput: '',
            advice: ['Mock 模式：端口已释放。'],
          },
        });
        appendLog('Mock gateway stopped', 'gateway', 'warn');
        return {success: true, result: 'Mock：Gateway 已停止'};
      case 'writeConfig': {
        const current = safeParse<Record<string, any>>(CONFIG_KEY, {});
        const next = deepMerge(current, (payload.config as Record<string, any>) ?? {});
        writeStorage(CONFIG_KEY, next);
        setStatusPatch({configExists: true});
        return {success: true, result: 'Mock：配置已保存'};
      }
      case 'deleteConfig':
        writeStorage(CONFIG_KEY, {});
        setStatusPatch({configExists: false});
        return {success: true, result: 'Mock：配置已删除'};
      case 'deleteRuntime':
      case 'resetRuntime':
      case 'uninstall':
        writeStorage(STATUS_KEY, defaultStatus);
        return {success: true, result: 'Mock：运行时已重置'};
      case 'installNodeOffline':
        return {success: false, error: 'Mock：installNodeOffline 仍为占位'};
      case 'repairOfflineResources':
        return {success: false, error: 'Mock：请补齐 offline_resources'};
      case 'openUrl':
        return {success: true, result: `Mock：已跳过打开链接 ${(payload.url as string) ?? ''}`};
      default:
        return {success: true, result: `Mock：已执行 ${payload.step}`};
    }
  },
  async getState() {
    return safeParse<InstallState>(STATE_KEY, {currentStep: 0, completed: [], isInstalling: false});
  },
  async setState(state: InstallState) {
    writeStorage(STATE_KEY, state);
    return {success: true};
  },
  async clearLogs() {
    writeStorage(LOGS_KEY, []);
    return {success: true};
  },
  async runDiagnostics() {
    return getDiagnostics();
  },
  async repairDiagnostic(id: string) {
    return this.executeAction({step: id === 'port-18789-in-use' ? 'killPortProcess' : 'repairWSL'});
  },
};

appendLog('Mock API initialized.');

export {mockApi};
