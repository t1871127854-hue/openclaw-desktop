import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {ActionResult} from '../../src/types/api';
import type {CommandService} from '../services/commandService';
import type {LogService} from '../services/logService';
import type {CacheManager} from '../resources/cacheManager';
import type {LocalImportManager} from '../resources/localImportManager';
import type {ResourceManager} from '../resources/resourceManager';
import type {InstallModeTag, ResourceDefinition, ResourceManifest, ResolvedResourceSet, SupportedArch, SupportedPlatform} from '../resources/types';

export interface PlatformInfo {
  platform: SupportedPlatform;
  arch: SupportedArch;
  osRelease: string;
  hostname: string;
  cpuCount: number;
}

export interface EnvironmentDetection {
  platformInfo: PlatformInfo;
  supported: boolean;
  summary: string;
  facts: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
}

export interface CompatibilityClassification {
  platform: SupportedPlatform;
  arch: SupportedArch;
  level: 'native' | 'compatible' | 'degraded' | 'unsupported';
  recommendedModes: InstallModeTag[];
  blockers: string[];
  reasons: string[];
}

export interface InstallPlanStep {
  id: string;
  title: string;
  status: 'pending' | 'ready' | 'blocked' | 'stub' | 'completed';
  notes?: string[];
}

export interface InstallPlan {
  platform: SupportedPlatform;
  arch: SupportedArch;
  mode: InstallModeTag;
  summary: string;
  selectedBundleId?: string;
  resourceIds: string[];
  requiresAdmin: boolean;
  requiresNetwork: boolean;
  steps: InstallPlanStep[];
  existingAndValid: string[];
  existingButInvalid: string[];
  missing: string[];
  blockers: string[];
  warnings: string[];
  reusableComponents: string[];
  repairableComponents: string[];
  missingButOptionalResources: string[];
}

export interface ValidationCheck {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  blocking?: boolean;
}

export interface ResetStepResult {
  id: string;
  success: boolean;
  detail: string;
}

export interface InstallExecutionDetails {
  plan: InstallPlan;
  missingResources: string[];
  unresolvedDependencies: string[];
  suggestedModeChange?: InstallModeTag;
  executedSteps: ResetStepResult[];
  validation?: PostInstallValidationDetails;
}

export interface PostInstallValidationDetails {
  passed: boolean;
  checks: ValidationCheck[];
  warnings: string[];
  blockingIssues: string[];
}

export interface ResetExecutionDetails {
  removedPaths: string[];
  skippedPaths: string[];
  warnings: string[];
  steps: ResetStepResult[];
}

export interface PlatformOperationResult extends ActionResult {
  status: 'implemented' | 'stub';
}

export interface GatewayExecutionDetails {
  pid: number | null;
  entryPoint: string | null;
  workingDirectory: string | null;
  running: boolean;
}

export interface PlatformPaths {
  basePath: string;
  workspacePath: string;
  runtimeRoot: string;
  cacheRoot: string;
  logsRoot: string;
  offlineResourcesRoot: string;
  importRoot: string;
}

export interface PlatformAdapterOptions {
  paths: PlatformPaths;
  distroName?: string;
  gatewayWorkingDirectory?: string;
  gatewayEntryPoint?: string;
}

export interface PlatformAdapterContext {
  resourceManager: ResourceManager;
  cacheManager: CacheManager;
  localImportManager: LocalImportManager;
  manifest?: ResourceManifest;
  preferredMode?: InstallModeTag;
}

export interface PlatformAdapter {
  getPlatformInfo(): Promise<PlatformInfo>;
  detectEnvironment(): Promise<EnvironmentDetection>;
  classifyCompatibility(environment?: EnvironmentDetection): Promise<CompatibilityClassification>;
  planInstall(context: PlatformAdapterContext): Promise<InstallPlan>;
  installRuntime(plan: InstallPlan): Promise<PlatformOperationResult>;
  validatePostInstall(plan: InstallPlan): Promise<PlatformOperationResult>;
  startGateway(): Promise<PlatformOperationResult>;
  stopGateway(): Promise<PlatformOperationResult>;
  resetRuntime(): Promise<PlatformOperationResult>;
}

interface PreparedInstallState {
  context: PlatformAdapterContext;
  manifest: ResourceManifest;
  resolved: ResolvedResourceSet;
  plan: InstallPlan;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  protected readonly options: PlatformAdapterOptions;
  private preparedInstallState: PreparedInstallState | null = null;
  private gatewayProcess: ChildProcessWithoutNullStreams | null = null;
  private gatewayEntryPoint: string | null = null;
  private gatewayWorkingDirectory: string | null = null;

  constructor(
    protected readonly commandService: CommandService,
    protected readonly logService: LogService,
    options: PlatformAdapterOptions,
  ) {
    this.options = options;
  }

  protected abstract readonly platform: SupportedPlatform;

  async getPlatformInfo(): Promise<PlatformInfo> {
    return {
      platform: this.platform,
      arch: this.normalizeArch(process.arch),
      osRelease: os.release(),
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
    };
  }

  abstract detectEnvironment(): Promise<EnvironmentDetection>;
  abstract classifyCompatibility(environment?: EnvironmentDetection): Promise<CompatibilityClassification>;
  abstract planInstall(context: PlatformAdapterContext): Promise<InstallPlan>;

  async installRuntime(plan: InstallPlan): Promise<PlatformOperationResult> {
    await this.logService.warn(`[stub] installRuntime for ${plan.platform}/${plan.arch}/${plan.mode}`, 'platform');
    return {
      success: false,
      status: 'stub',
      error: `${this.platform} installRuntime is not implemented yet.`,
      details: {plan},
    };
  }

  async validatePostInstall(plan: InstallPlan): Promise<PlatformOperationResult> {
    return {
      success: false,
      status: 'stub',
      error: `${this.platform} validatePostInstall is not implemented yet.`,
      details: {plan},
    };
  }

  async startGateway(): Promise<PlatformOperationResult> {
    return {
      success: false,
      status: 'stub',
      error: `${this.platform} startGateway is not implemented yet.`,
    };
  }

  async stopGateway(): Promise<PlatformOperationResult> {
    return {
      success: true,
      status: 'stub',
      result: `${this.platform} stopGateway placeholder acknowledged.`,
    };
  }

  async resetRuntime(): Promise<PlatformOperationResult> {
    return {
      success: false,
      status: 'stub',
      error: `${this.platform} resetRuntime is not implemented yet.`,
    };
  }

  protected setPreparedInstallState(state: PreparedInstallState) {
    this.preparedInstallState = state;
  }

  protected getPreparedInstallState(plan?: InstallPlan) {
    if (!this.preparedInstallState) return null;
    if (!plan) return this.preparedInstallState;
    return this.preparedInstallState.plan.summary === plan.summary ? this.preparedInstallState : null;
  }

  protected normalizeArch(arch: string): SupportedArch {
    if (arch === 'arm64') return 'arm64';
    return 'x64';
  }

  protected async ensureDirectories(paths: string[]) {
    for (const target of paths) {
      await fs.ensureDir(target);
    }
  }

  protected async isAdmin(): Promise<boolean> {
    if (process.platform === 'win32') {
      const result = await this.commandService.runPowerShell(
        "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')",
        {timeoutMs: 10000},
      );
      return result.success && result.stdout.trim() === 'True';
    }

    const result = await this.commandService.runCommand('id', ['-u'], {source: 'platform', timeoutMs: 5000});
    return result.success && result.stdout.trim() === '0';
  }

  protected isSafeManagedPath(target: string) {
    const normalized = path.resolve(target).toLowerCase();
    const allowedRoots = [
      this.options.paths.runtimeRoot,
      this.options.paths.cacheRoot,
      this.options.paths.logsRoot,
      this.options.paths.offlineResourcesRoot,
      this.options.paths.importRoot,
    ].map((item) => path.resolve(item).toLowerCase());

    return allowedRoots.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`));
  }

  protected createStep(id: string, success: boolean, detail: string): ResetStepResult {
    return {id, success, detail};
  }

  protected trackGatewayProcess(child: ChildProcessWithoutNullStreams, entryPoint: string, workingDirectory: string) {
    this.gatewayProcess = child;
    this.gatewayEntryPoint = entryPoint;
    this.gatewayWorkingDirectory = workingDirectory;
    child.once('exit', () => {
      if (this.gatewayProcess?.pid === child.pid) {
        this.gatewayProcess = null;
      }
    });
  }

  protected getGatewayDetails(): GatewayExecutionDetails {
    return {
      pid: this.gatewayProcess?.pid ?? null,
      entryPoint: this.gatewayEntryPoint,
      workingDirectory: this.gatewayWorkingDirectory,
      running: Boolean(this.gatewayProcess && !this.gatewayProcess.killed),
    };
  }

  protected async stopTrackedGateway(forceCommand?: {command: string; args: string[]}) {
    const child = this.gatewayProcess;
    if (!child?.pid) {
      return {stopped: true, detail: 'No tracked gateway process.'};
    }

    const pid = child.pid;
    child.kill('SIGTERM');

    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (exited) {
      this.gatewayProcess = null;
      return {stopped: true, detail: `Gateway ${pid} stopped gracefully.`};
    }

    if (forceCommand) {
      const forced = await this.commandService.runCommand(forceCommand.command, forceCommand.args, {source: 'platform', timeoutMs: 10000});
      if (forced.success) {
        this.gatewayProcess = null;
        return {stopped: true, detail: `Gateway ${pid} was force-stopped.`};
      }
      return {stopped: false, detail: forced.stderr || forced.stdout || `Failed to force-stop gateway ${pid}.`};
    }

    return {stopped: false, detail: `Gateway ${pid} did not exit after SIGTERM.`};
  }

  protected summarizeMissingResources(resources: ResourceDefinition[]) {
    return resources.map((resource) => `${resource.id}(${resource.resourceType})`);
  }

  protected buildInstallFailure(
    plan: InstallPlan,
    message: string,
    details: Partial<InstallExecutionDetails>,
  ): PlatformOperationResult {
    return {
      success: false,
      status: 'implemented',
      error: message,
      details: {
        plan,
        missingResources: [],
        unresolvedDependencies: [],
        executedSteps: [],
        ...details,
      } as Record<string, unknown>,
    };
  }
}
