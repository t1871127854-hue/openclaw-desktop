export type StatusType =
  | 'installed'
  | 'not_installed'
  | 'reboot_required'
  | 'configured'
  | 'not_configured'
  | 'running'
  | 'stopped'
  | 'error'
  | 'loading';

export type LogSource = 'system' | 'powershell' | 'gateway' | 'diagnostics' | 'platform' | 'resources' | 'installer';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export type InstallMode = 'full-offline' | 'hybrid' | 'online' | 'import-local';
export type InstallStage =
  | 'idle'
  | 'detect-environment'
  | 'choose-mode'
  | 'resolve-resources'
  | 'import-download-resources'
  | 'install-runtime'
  | 'validate-post-install'
  | 'start-gateway'
  | 'completed'
  | 'failed'
  | 'reset-requested';

export interface InstallProgressEvent {
  stage: InstallStage;
  status: 'running' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface InstallWorkflowStatus {
  active: boolean;
  mode: InstallMode | null;
  stage: InstallStage;
  history: InstallProgressEvent[];
  failureReason?: string;
  lastUpdatedAt: string;
}

export type UpgradeUrgency = 'no-update' | 'optional-update' | 'required-update' | 'blocked';

export interface UpgradeTarget {
  component: 'launcher' | 'runtime' | 'node' | 'gateway-bundle';
  currentVersion: string | null;
  targetVersion: string | null;
  urgency: UpgradeUrgency;
  reason: string;
}

export interface OperationFailureInfo {
  stage: string;
  reason: string;
  userFacingMessage: string;
  technicalDetails: string[];
  suggestedActions: string[];
  retryable: boolean;
  recommendedModeSwitch?: InstallMode;
  reportExportable: boolean;
}

export interface UpgradeExecutionStep {
  id: string;
  status: 'completed' | 'failed' | 'skipped';
  detail: string;
}

export interface UpgradeFinalizeTarget {
  component: UpgradeTarget['component'];
  replacementMode: 'direct' | 'restart-required' | 'blocked';
  order: number;
  stagedPath: string | null;
  liveTargetPath: string | null;
  prerequisites: string[];
  riskPoints: string[];
  blockedReasons: string[];
}

export interface UpgradeFinalizeResult {
  readyToFinalize: boolean;
  finalizeBlockedReasons: string[];
  replacementTargets: UpgradeFinalizeTarget[];
  restartRequired: boolean;
  rollbackPrepared: boolean;
  replacementOrder: string[];
  riskSummary: string[];
  prerequisites: string[];
}

export interface UpgradeRollbackTarget {
  component: UpgradeTarget['component'];
  rollbackType: 'staging' | 'live';
  previousVersionPath: string | null;
  stagedPath: string | null;
  backupPath: string | null;
  rollbackCapable: boolean;
  prerequisites: string[];
  blockers: string[];
}

export interface UpgradeRollbackPlan {
  rollbackPrepared: boolean;
  prerequisites: string[];
  blockers: string[];
  rollbackTargets: UpgradeRollbackTarget[];
  futureIntegrationPoint?: string;
}

export interface UpgradeRollbackResult {
  status: 'prepared' | 'completed' | 'blocked' | 'stub';
  rollbackType: 'staging' | 'live';
  rollbackPrepared: boolean;
  blockers: string[];
  executedSteps: UpgradeExecutionStep[];
  rollbackTargets: UpgradeRollbackTarget[];
  futureIntegrationPoint?: string;
}

export interface UpgradeExecutionResult {
  status: 'prepared' | 'validated' | 'finalized' | 'rolled-back' | 'blocked' | 'failed';
  executedSteps: UpgradeExecutionStep[];
  skippedSteps: UpgradeExecutionStep[];
  blockers: string[];
  rollbackAvailable: boolean;
  validationSummary: string[];
  finalizePlan?: UpgradeFinalizeResult;
  rollbackPlan?: UpgradeRollbackPlan;
  rollbackResult?: UpgradeRollbackResult;
  futureIntegrationPoint?: string;
}

export interface UpgradePlan {
  status: UpgradeUrgency;
  source: 'local-manifest' | 'remote-manifest' | 'none';
  targets: UpgradeTarget[];
  blockers: string[];
  steps: string[];
  futureIntegrationPoint?: string;
  rollbackHint?: string;
}

export interface VersionCheck {
  isOk: boolean;
  version: string;
}

export interface LocalResourcesStatus {
  folderExists: boolean;
  rootfsExists: boolean;
  path: string;
}

export interface NodeDetectionResult {
  installed: boolean;
  version: string | null;
  supported: boolean;
  rawOutput: string;
  advice: string[];
}

export interface WslDistroInfo {
  name: string;
  state?: string;
  version?: string;
  isDefault?: boolean;
}

export interface WSLStatusResult {
  available: boolean;
  installed: boolean;
  distroList: WslDistroInfo[];
  defaultDistro: string | null;
  versionInfo: string;
  rawStatus: string;
  rawList: string;
  openClawDistroInstalled: boolean;
  advice: string[];
}

export interface OfflineResourcesResult {
  exists: boolean;
  basePath: string;
  missingFiles: string[];
  invalidFiles: string[];
  detectedFiles: string[];
  modeSuggestion: 'offline' | 'online';
  advice: string[];
}

export interface PortUsageResult {
  occupied: boolean;
  port: number;
  pid: number | null;
  protocol: string | null;
  rawOutput: string;
  advice: string[];
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  port: number;
  workingDirectory: string | null;
  entryPoint: string | null;
  commandLine: string | null;
  placeholder: boolean;
  advice: string[];
}

export interface RuntimeResetResult {
  success: boolean;
  removedPaths: string[];
  skippedPaths: string[];
  warnings: string[];
  message: string;
}

export interface DiagnosticIssue {
  id: string;
  title: string;
  status: 'healthy' | 'warning' | 'error';
  summary: string;
  details: string[];
  repairable: boolean;
  repairAction?: string;
}


export interface InstallContextSummary {
  adapter: 'windows' | 'macos';
  compatibility: 'native' | 'compatible' | 'degraded' | 'unsupported';
  recommendedModes: string[];
  selectedMode?: string;
  selectedBundleId?: string;
  resourceCount: number;
  blockers: string[];
}

export interface EnvironmentStatus {
  isAdmin: boolean;
  is64Bit?: boolean;
  node: VersionCheck;
  git: VersionCheck;
  wsl: StatusType;
  vmPlatform: StatusType;
  sandboxFeature: StatusType;
  runtime: StatusType;
  gateway: StatusType;
  configExists: boolean;
  skillPackExists: boolean;
  localResources?: LocalResourcesStatus;
  nodeDetails?: NodeDetectionResult;
  wslDetails?: WSLStatusResult;
  offlineResources?: OfflineResourcesResult;
  port18789?: PortUsageResult;
  gatewayDetails?: GatewayStatus;
  diagnostics?: DiagnosticIssue[];
  error?: string;
  installContext?: InstallContextSummary;
  installWorkflow?: InstallWorkflowStatus;
  upgradePlan?: UpgradePlan;
  installFailure?: OperationFailureInfo;
  upgradeFailure?: OperationFailureInfo;
  upgradeExecution?: UpgradeExecutionResult;
}

export interface InstallState {
  currentStep: number;
  completed: string[];
  isInstalling: boolean;
}

export interface ActionResult {
  success: boolean;
  result?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface TestResult {
  success: boolean;
  message: string;
}

export interface LogEntry {
  id: string;
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;
}

export interface ModelTestPayload {
  provider: string;
  config: Record<string, unknown>;
}

export interface ChannelTestPayload {
  channel: string;
  config: Record<string, unknown>;
}

export interface ExecuteActionPayload {
  step: string;
  action?: string;
  [key: string]: unknown;
}

export interface OpenClawApi {
  getStatus(): Promise<EnvironmentStatus>;
  readConfig(): Promise<Record<string, any>>;
  testModel(payload: ModelTestPayload): Promise<TestResult>;
  testChannel(payload: ChannelTestPayload): Promise<TestResult>;
  getLogs(): Promise<string>;
  subscribeLogs(listener: (entry: LogEntry) => void): () => void;
  exportLogs(): Promise<ActionResult>;
  executeAction(payload: ExecuteActionPayload): Promise<ActionResult>;
  getState(): Promise<InstallState>;
  setState(state: InstallState): Promise<{ success: boolean }>;
  clearLogs(): Promise<{ success: boolean }>;
  runDiagnostics(): Promise<DiagnosticIssue[]>;
  repairDiagnostic(id: string): Promise<ActionResult>;
}
