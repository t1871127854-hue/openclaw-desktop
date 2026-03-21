export type ItemStatus =
  | 'installed'
  | 'not_installed'
  | 'reboot_required'
  | 'configured'
  | 'not_configured'
  | 'running'
  | 'stopped'
  | 'error'
  | 'fixable'
  | 'warning'
  | 'unknown';

export interface CommandResult {
  success: boolean;
  step: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  suggestion?: string;
}

export interface ResourceFileStatus {
  exists: boolean;
  path: string;
  required: boolean;
  size: number | null;
  message: string;
}

export interface StatusItem {
  key: string;
  title: string;
  status: ItemStatus;
  description: string;
  detail: string;
  actionLabel?: string;
}

export interface RuntimeConfig {
  installPath: string;
  runtimeDistro: string;
  dashboardUrl: string;
  configPathLinux: string;
  configPathWindows: string;
}

export interface LauncherPaths {
  appBaseDir: string;
  logsFile: string;
  stateFile: string;
  resourcesDir: string;
  rootfsPath: string;
  skillsPackPath: string;
  bailianKeyPath: string;
}

export interface LauncherLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  scope: string;
  message: string;
  command?: string;
  args?: string[];
}

export interface WorkflowStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  message: string;
  updatedAt: string;
  result?: CommandResult;
}

export interface PersistedWorkflowState {
  active: boolean;
  requiresReboot: boolean;
  lastCompletedStepIndex: number;
  steps: WorkflowStep[];
  resumedFromReboot: boolean;
  updatedAt: string;
}

export interface ModelConfigForm {
  apiKey: string;
  defaultModel: string;
}

export interface FeishuConfigForm {
  appId: string;
  appSecret: string;
}

export interface RepairReport {
  title: string;
  results: CommandResult[];
}

export interface LauncherOverview {
  generatedAt: string;
  platform: string;
  runtime: RuntimeConfig;
  paths: LauncherPaths;
  resources: {
    rootfs: ResourceFileStatus;
    skillsPack: ResourceFileStatus;
    bailianApiKey: ResourceFileStatus;
  };
  checks: StatusItem[];
  workflow: PersistedWorkflowState;
  modelConfig: {
    configured: boolean;
    apiKeyPresent: boolean;
    defaultModel: string | null;
  };
  feishuConfig: {
    configured: boolean;
    appIdPresent: boolean;
    appSecretPresent: boolean;
  };
  skills: {
    imported: boolean;
    count: number | null;
    detail: string;
  };
  lastError: CommandResult | null;
  lastRepair: RepairReport | null;
  logsTail: LauncherLogEntry[];
}

export interface OpenClawApi {
  getOverview: () => Promise<LauncherOverview>;
  getLogs: () => Promise<string>;
  subscribeLogs: (listener: (entry: LauncherLogEntry) => void) => () => void;
  subscribeWorkflow: (listener: (state: PersistedWorkflowState) => void) => () => void;
  installAll: () => Promise<CommandResult[]>;
  resumeInstall: () => Promise<CommandResult[]>;
  repairAll: () => Promise<RepairReport>;
  writeModelConfig: (payload: ModelConfigForm) => Promise<CommandResult[]>;
  testModelConfig: (payload: ModelConfigForm) => Promise<CommandResult>;
  writeFeishuConfig: (payload: FeishuConfigForm) => Promise<CommandResult[]>;
  importSkillsPack: () => Promise<CommandResult[]>;
  restartGateway: () => Promise<CommandResult[]>;
  openDashboard: () => Promise<CommandResult>;
  uninstallOpenClaw: () => Promise<CommandResult[]>;
  uninstallEverything: () => Promise<CommandResult[]>;
  clearLogs: () => Promise<void>;
}
