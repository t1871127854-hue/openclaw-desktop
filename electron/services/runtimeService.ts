import path from 'node:path';
import fs from 'fs-extra';
import type {
  ActionResult,
  ChannelTestPayload,
  DiagnosticIssue,
  EnvironmentStatus,
  ExecuteActionPayload,
  InstallMode,
  OperationFailureInfo,
  InstallProgressEvent,
  InstallWorkflowStatus,
  UpgradeFinalizeResult,
  UpgradeFinalizeTarget,
  UpgradeExecutionResult,
  UpgradeExecutionStep,
  UpgradePlan,
  UpgradeRollbackPlan,
  UpgradeRollbackResult,
  UpgradeRollbackTarget,
  ModelTestPayload,
  NodeDetectionResult,
  OfflineResourcesResult,
  PortUsageResult,
  RuntimeResetResult,
  TestResult,
  WSLStatusResult,
} from '../../src/types/api';
import {buildDiagnostics} from '../diagnostics/rules';
import {MacOSAdapter} from '../platform/macosAdapter';
import type {PlatformAdapter} from '../platform/base';
import {WindowsAdapter} from '../platform/windowsAdapter';
import {CacheManager} from '../resources/cacheManager';
import {DownloadManager} from '../resources/downloadManager';
import {LocalImportManager} from '../resources/localImportManager';
import {ManifestResolver} from '../resources/manifestResolver';
import {ResourceManager} from '../resources/resourceManager';
import {CommandService} from './commandService';
import {GatewayService} from './gatewayService';
import {LogService} from './logService';
import {StorageService} from './storageService';

interface RuntimePaths {
  basePath: string;
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  workspacePath: string;
  configFile: string;
  stateFile: string;
  logFile: string;
}

const OPENCLAW_DISTRO_NAME = 'OpenClaw-Runtime';
const DEFAULT_GATEWAY_PORT = 18789;

export class RuntimeService {
  private readonly runtimeAppDataDir: string;
  private readonly offlineResourcesDir: string;
  private readonly wslRuntimeDir: string;
  private readonly cacheManager: CacheManager;
  private readonly manifestResolver: ManifestResolver;
  private readonly localImportManager: LocalImportManager;
  private readonly resourceManager: ResourceManager;
  private readonly downloadManager: DownloadManager;
  private readonly platformAdapter: PlatformAdapter;
  private installWorkflow: InstallWorkflowStatus = {
    active: false,
    mode: null,
    stage: 'idle',
    history: [],
    lastUpdatedAt: new Date().toISOString(),
  };

  constructor(
    private readonly paths: RuntimePaths,
    private readonly logService: LogService,
    private readonly storageService: StorageService,
    private readonly commandService: CommandService,
    private readonly gatewayService: GatewayService,
  ) {
    this.runtimeAppDataDir = path.join(this.paths.appDataPath, 'OpenClaw_Runtime');
    this.offlineResourcesDir = path.join(this.paths.basePath, 'offline_resources');
    this.wslRuntimeDir = path.join(this.runtimeAppDataDir, 'WSL_Runtime');
    this.cacheManager = new CacheManager(path.join(this.runtimeAppDataDir, 'resource-cache'), this.logService);
    this.manifestResolver = new ManifestResolver(this.logService);
    this.localImportManager = new LocalImportManager(
      path.join(this.paths.basePath, 'local_imports'),
      this.manifestResolver,
      this.cacheManager,
      this.logService,
    );
    this.resourceManager = new ResourceManager(this.manifestResolver, this.cacheManager, this.offlineResourcesDir, this.logService);
    this.downloadManager = new DownloadManager(this.cacheManager, this.logService);
    this.platformAdapter = process.platform === 'darwin'
      ? new MacOSAdapter(this.commandService, this.logService, {
          paths: {
            basePath: this.paths.basePath,
            workspacePath: this.paths.workspacePath,
            runtimeRoot: this.runtimeAppDataDir,
            cacheRoot: path.join(this.runtimeAppDataDir, 'resource-cache'),
            logsRoot: path.join(this.runtimeAppDataDir, 'logs'),
            offlineResourcesRoot: this.offlineResourcesDir,
            importRoot: path.join(this.paths.basePath, 'local_imports'),
          },
        })
      : new WindowsAdapter(this.commandService, this.logService, {
          paths: {
            basePath: this.paths.basePath,
            workspacePath: this.paths.workspacePath,
            runtimeRoot: this.runtimeAppDataDir,
            cacheRoot: path.join(this.runtimeAppDataDir, 'resource-cache'),
            logsRoot: path.join(this.runtimeAppDataDir, 'logs'),
            offlineResourcesRoot: this.offlineResourcesDir,
            importRoot: path.join(this.paths.basePath, 'local_imports'),
          },
          distroName: OPENCLAW_DISTRO_NAME,
        });
  }

  async getStatus(): Promise<EnvironmentStatus> {
    try {
      await this.logService.info('Refreshing runtime status snapshot.', 'system');
      const persistedState = await this.storageService.readState();
      const [nodeDetails, wslDetails, offlineResources, port18789] = await Promise.all([
        this.detectNodeVersion(),
        this.detectWSLStatus(),
        this.detectOfflineResources(),
        this.checkPortUsage(DEFAULT_GATEWAY_PORT),
      ]);
      const gatewayDetails = await this.gatewayService.getStatus(port18789);
      const installContext = await this.inspectInstallContext();
      const upgradePlan = await this.buildUpgradePlan(nodeDetails.version);

      const diagnostics = buildDiagnostics({
        node: nodeDetails,
        wsl: wslDetails,
        offlineResources,
        port18789,
      });

      const vmPlatform = await this.detectWindowsFeature('VirtualMachinePlatform');
      const sandboxFeature = await this.detectWindowsFeature(process.arch === 'x64' ? 'Containers-DisposableClientVM' : 'Windows-Sandbox');
      const isAdmin = await this.detectAdminStatus();
      const git = await this.detectGitVersion();
      const configExists = await fs.pathExists(this.storageService.configFile);
      const skillPackExists = await fs.pathExists(path.join(this.paths.basePath, 'skills-pack.tar.gz'));
      const rootfsPath = path.join(this.offlineResourcesDir, 'openclaw-rootfs.tar');
      const rootfsExists = await fs.pathExists(rootfsPath);

      return {
        isAdmin,
        is64Bit: process.arch === 'x64',
        node: {isOk: nodeDetails.supported, version: nodeDetails.version ?? 'not_installed'},
        git,
        wsl: wslDetails.installed ? 'installed' : 'not_installed',
        vmPlatform,
        sandboxFeature,
        runtime: wslDetails.openClawDistroInstalled ? 'installed' : 'not_installed',
        gateway: gatewayDetails.running ? 'running' : 'stopped',
        configExists,
        skillPackExists,
        localResources: {
          folderExists: offlineResources.exists,
          rootfsExists,
          path: offlineResources.exists ? this.offlineResourcesDir : `未检测到本地资源包 (检测路径: ${this.offlineResourcesDir})`,
        },
        nodeDetails,
        wslDetails,
        offlineResources,
        port18789,
        gatewayDetails,
        diagnostics,
        installContext,
        installWorkflow: this.installWorkflow,
        upgradePlan,
        installFailure: persistedState.installFailure,
        upgradeFailure: persistedState.upgradeFailure,
        upgradeExecution: persistedState.upgradeExecution,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logService.error(`Status check failed: ${message}`, 'system');
      return {
        isAdmin: false,
        node: {isOk: false, version: 'not_installed'},
        git: {isOk: false, version: 'not_installed'},
        wsl: 'error',
        vmPlatform: 'error',
        sandboxFeature: 'error',
        runtime: 'error',
        gateway: 'error',
        configExists: false,
        skillPackExists: false,
        error: message,
      };
    }
  }

  async detectNodeVersion(): Promise<NodeDetectionResult> {
    await this.logService.info('Detecting Windows Node.js version via node -v.', 'diagnostics');
    const result = await this.commandService.runCommand('node', ['-v'], {source: 'diagnostics', timeoutMs: 10000});
    const rawOutput = `${result.stdout}${result.stderr}`.trim();
    const versionMatch = rawOutput.match(/v?(\d+\.\d+\.\d+)/);
    const version = versionMatch?.[1] ?? null;
    const major = version ? Number.parseInt(version.split('.')[0] ?? '0', 10) : 0;
    const installed = result.success && Boolean(version);
    const supported = installed && major >= 22;
    const advice: string[] = [];

    if (!installed) {
      advice.push('未检测到系统 Node.js，请先安装 Node.js 22+。');
      advice.push(`如需离线安装，请将安装包放入 ${this.offlineResourcesDir}。`);
    } else if (!supported) {
      advice.push(`当前版本 ${version} 不满足 >= 22。`);
      advice.push('建议升级系统 Node.js，或在后续版本接入离线安装入口。');
    } else {
      advice.push(`当前 Node.js ${version} 可用于桌面控制中心骨架。`);
    }

    return {installed, version, supported, rawOutput, advice};
  }

  async detectWSLStatus(): Promise<WSLStatusResult> {
    await this.logService.info('Detecting WSL availability and distro status.', 'diagnostics');
    const whereResult = await this.commandService.runCommand('where', ['wsl.exe'], {source: 'diagnostics', timeoutMs: 10000});
    const available = whereResult.success && Boolean(whereResult.stdout.trim());

    if (!available) {
      return {
        available: false,
        installed: false,
        distroList: [],
        defaultDistro: null,
        versionInfo: '',
        rawStatus: whereResult.stderr || whereResult.stdout,
        rawList: '',
        openClawDistroInstalled: false,
        advice: [
          '系统中未找到 wsl.exe。',
          '请确认 Windows 版本支持 WSL，或以管理员身份启用 Windows Subsystem for Linux。',
        ],
      };
    }

    const [statusResult, listResult] = await Promise.all([
      this.commandService.runCommand('wsl.exe', ['--status'], {source: 'diagnostics', timeoutMs: 15000}),
      this.commandService.runCommand('wsl.exe', ['-l', '-v'], {source: 'diagnostics', timeoutMs: 15000}),
    ]);

    const rawStatus = `${statusResult.stdout}${statusResult.stderr}`.trim();
    const rawList = `${listResult.stdout}${listResult.stderr}`.trim();
    const distroList = rawList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^NAME/i.test(line))
      .map((line) => {
        const isDefault = line.startsWith('*');
        const cleaned = line.replace(/^\*/, '').trim();
        const parts = cleaned.split(/\s{2,}/).filter(Boolean);
        return {
          name: parts[0] ?? cleaned,
          state: parts[1],
          version: parts[2],
          isDefault,
        };
      });

    const defaultDistro = distroList.find((item) => item.isDefault)?.name ?? null;
    const openClawDistroInstalled = distroList.some((item) => item.name === OPENCLAW_DISTRO_NAME);
    const installed = statusResult.success || distroList.length > 0;
    const advice: string[] = [];

    if (!installed) {
      advice.push('WSL 尚未启用。');
      advice.push('建议以管理员身份执行 wsl --install，或在控制面板中启用 WSL 和虚拟机平台。');
    } else {
      advice.push(defaultDistro ? `当前默认发行版为 ${defaultDistro}。` : 'WSL 已启用，但尚未发现默认发行版。');
      if (!openClawDistroInstalled) {
        advice.push(`尚未发现 ${OPENCLAW_DISTRO_NAME} 发行版，后续可导入 OpenClaw rootfs。`);
      }
    }

    return {
      available,
      installed,
      distroList,
      defaultDistro,
      versionInfo: rawStatus,
      rawStatus,
      rawList,
      openClawDistroInstalled,
      advice,
    };
  }

  async detectOfflineResources(): Promise<OfflineResourcesResult> {
    await this.logService.info(`Scanning offline resources at ${this.offlineResourcesDir}`, 'diagnostics');
    const exists = await fs.pathExists(this.offlineResourcesDir);
    const manifestPath = path.join(this.offlineResourcesDir, 'manifest.json');
    const expected = [
      {label: 'WSL 包', patterns: [/wsl/i, /msixbundle$/i, /msi$/i]},
      {label: 'Node 离线包', patterns: [/node/i, /zip$/i, /msi$/i, /exe$/i]},
      {label: 'rootfs / 镜像包', patterns: [/rootfs/i, /image/i, /tar$/i, /tar\.gz$/i]},
      {label: '校验文件', patterns: [/sha256/i, /checksum/i, /manifest/i]},
    ];

    if (!exists) {
      return {
        exists: false,
        basePath: this.offlineResourcesDir,
        missingFiles: expected.map((item) => item.label),
        invalidFiles: [],
        detectedFiles: [],
        modeSuggestion: 'online',
        advice: [
          `未发现离线资源目录：${this.offlineResourcesDir}`,
          '当前建议走 online 模式，或补齐 offline_resources 目录。',
        ],
      };
    }

    const fileNames = (await fs.readdir(this.offlineResourcesDir)).sort();
    const manifestExists = await fs.pathExists(manifestPath);
    const importedManifests = await this.localImportManager.scanImportDirectory().catch(() => []);
    const cachedResources = await this.cacheManager.listCachedResources().catch(() => []);
    const missingFiles = expected
      .filter((item) => !fileNames.some((file) => item.patterns.some((pattern) => pattern.test(file))))
      .map((item) => item.label);

    const invalidFiles = fileNames.filter((file) => /\.(tmp|partial)$/i.test(file));
    const advice = missingFiles.length === 0 && invalidFiles.length === 0
      ? ['离线资源完整，可优先使用 offline 模式。']
      : [
          missingFiles.length > 0 ? `缺失资源：${missingFiles.join('、')}` : '关键离线资源已存在。',
          invalidFiles.length > 0 ? `发现可疑文件：${invalidFiles.join('、')}` : '未发现临时损坏文件。',
          '若暂时无法补齐，建议切换 online 模式。',
        ];

    if (manifestExists) {
      const manifest = await this.resourceManager.loadManifest({localPath: manifestPath}).catch(() => null);
      if (manifest) {
        advice.push(`已检测到资源 manifest，共 ${manifest.resources.length} 个资源定义。`);
      }
    } else {
      advice.push('尚未检测到跨平台资源 manifest.json。');
    }

    advice.push(`本地导入目录 manifest 数量: ${importedManifests.length}`);
    advice.push(`资源缓存条目数量: ${cachedResources.length}`);

    return {
      exists: true,
      basePath: this.offlineResourcesDir,
      missingFiles,
      invalidFiles,
      detectedFiles: fileNames,
      modeSuggestion: missingFiles.length === 0 && invalidFiles.length === 0 ? 'offline' : 'online',
      advice,
    };
  }

  private async inspectInstallContext(): Promise<EnvironmentStatus['installContext']> {
    try {
      const manifestPath = path.join(this.offlineResourcesDir, 'manifest.json');
      const manifest = await this.resourceManager.loadManifest(
        await fs.pathExists(manifestPath) ? {localPath: manifestPath} : {},
      );
      const environment = await this.platformAdapter.detectEnvironment();
      const compatibility = await this.platformAdapter.classifyCompatibility(environment);
      const plan = await this.platformAdapter.planInstall({
        resourceManager: this.resourceManager,
        cacheManager: this.cacheManager,
        localImportManager: this.localImportManager,
        manifest,
        preferredMode: compatibility.recommendedModes[0],
      });

      return {
        adapter: environment.platformInfo.platform,
        compatibility: compatibility.level,
        recommendedModes: compatibility.recommendedModes,
        selectedMode: plan.mode,
        selectedBundleId: plan.selectedBundleId,
        resourceCount: plan.resourceIds.length,
        blockers: plan.blockers,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logService.warn(`Install context inspection degraded: ${message}`, 'platform');
      return {
        adapter: process.platform === 'darwin' ? 'macos' : 'windows',
        compatibility: 'unsupported',
        recommendedModes: [],
        resourceCount: 0,
        blockers: [message],
      };
    }
  }

  private async persistInstallWorkflow() {
    const currentState = await this.storageService.readState();
    await this.storageService.writeState({...currentState, isInstalling: this.installWorkflow.active, workflow: this.installWorkflow});
  }

  private async persistRuntimeState(fragment: Record<string, unknown>) {
    const currentState = await this.storageService.readState();
    await this.storageService.writeState({...currentState, ...fragment});
  }

  private buildFailureInfo(
    kind: 'install' | 'upgrade',
    stage: string,
    reason: string,
    details?: Record<string, unknown>,
  ): OperationFailureInfo {
    const normalizedReason = reason || `${kind} failure`;
    const lowerReason = normalizedReason.toLowerCase();
    const technicalDetails = [
      normalizedReason,
      ...(details ? Object.entries(details).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`) : []),
    ].slice(0, 8);

    if (/remote manifest url is not configured|未配置远端 manifest/i.test(normalizedReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: '未配置远端 manifest，升级检查无法继续。',
        technicalDetails,
        suggestedActions: ['配置 OPENCLAW_REMOTE_MANIFEST_URL。', '暂时继续使用当前版本，或改用本地/离线资源校验流程。'],
        retryable: false,
        recommendedModeSwitch: 'full-offline',
        reportExportable: true,
      };
    }

    if (/failed to load remote manifest|manifest.*http|manifest.*enotfound|manifest.*econn|manifest.*fetch/i.test(lowerReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: '无法访问 manifest，请检查网络或远端地址。',
        technicalDetails,
        suggestedActions: ['确认远端 manifest URL 可访问。', '检查代理/网络连通性。', '如有本地资源，请切换到离线或混合模式后重试。'],
        retryable: true,
        recommendedModeSwitch: 'hybrid',
        reportExportable: true,
      };
    }

    if (/sha256 mismatch|hash|checksum/i.test(lowerReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: '资源校验失败，下载内容与 manifest 中的哈希不一致。',
        technicalDetails,
        suggestedActions: ['重新下载对应资源。', '检查镜像源是否过期或内容被替换。', '如有本地导入包，请优先切换到 import-local 或 full-offline。'],
        retryable: true,
        recommendedModeSwitch: 'import-local',
        reportExportable: true,
      };
    }

    if (/missing after import\/download|missing resource|resource.*missing|resources are still missing/i.test(lowerReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: '所需资源仍然缺失，当前无法继续安装或升级。',
        technicalDetails,
        suggestedActions: ['补齐缺失资源后重试。', '检查 manifest 与 bundle 是否包含目标平台/架构。', '必要时切换为 online 或 hybrid 模式。'],
        retryable: true,
        recommendedModeSwitch: 'online',
        reportExportable: true,
      };
    }

    if (/wsl|rootfs|distro|import/i.test(lowerReason) && /failed|error|stub/.test(lowerReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: 'WSL 导入或运行时替换失败。',
        technicalDetails,
        suggestedActions: ['确认 WSL 与虚拟机平台已启用。', '检查 rootfs/runtime 资源是否完整。', '查看 installer/platform 日志定位具体导入失败点。'],
        retryable: true,
        recommendedModeSwitch: 'full-offline',
        reportExportable: true,
      };
    }

    if (/gateway/i.test(lowerReason) && /failed|error|stub|start/.test(lowerReason)) {
      return {
        stage,
        reason: normalizedReason,
        userFacingMessage: 'Gateway 启动失败，环境尚未处于可用状态。',
        technicalDetails,
        suggestedActions: ['检查端口 18789 是否被占用。', '确认 Gateway bundle 已准备完成。', '查看日志确认入口文件和工作目录。'],
        retryable: true,
        reportExportable: true,
      };
    }

    return {
      stage,
      reason: normalizedReason,
      userFacingMessage: kind === 'upgrade' ? '升级流程未完成，请根据建议操作后重试。' : '安装流程未完成，请根据建议操作后重试。',
      technicalDetails,
      suggestedActions: ['查看日志获取更多技术细节。', '修复阻塞项后重新执行。'],
      retryable: true,
      reportExportable: true,
    };
  }

  private async setInstallFailure(stage: string, reason: string, details?: Record<string, unknown>) {
    const failure = this.buildFailureInfo('install', stage, reason, details);
    await this.logService.warn(`Install failure summary updated: stage=${failure.stage} reason=${failure.reason}`, 'installer');
    await this.persistRuntimeState({installFailure: failure});
    return failure;
  }

  private async clearInstallFailure() {
    await this.persistRuntimeState({installFailure: undefined});
  }

  private async setUpgradeState(execution: UpgradeExecutionResult, failure?: OperationFailureInfo) {
    await this.persistRuntimeState({upgradeExecution: execution, upgradeFailure: failure});
  }

  private async markUpgradeBlocked(plan: UpgradePlan, stage: string, reason: string, details?: Record<string, unknown>) {
    const failure = this.buildFailureInfo('upgrade', stage, reason, details);
    const execution: UpgradeExecutionResult = {
      status: 'blocked',
      executedSteps: [],
      skippedSteps: plan.targets.map((target) => ({
        id: `blocked-${target.component}`,
        status: 'skipped',
        detail: `${target.component} skipped: ${reason}`,
      })),
      blockers: [...plan.blockers, reason],
      rollbackAvailable: false,
      validationSummary: ['Upgrade execution did not start because blocking conditions were detected.'],
      futureIntegrationPoint: plan.futureIntegrationPoint,
    };
    await this.logService.warn(`Upgrade blocked at ${stage}: ${reason}`, 'installer');
    await this.setUpgradeState(execution, failure);
    return {execution, failure};
  }

  private resolveFinalizeMode(
    component: UpgradeFinalizeTarget['component'],
    hasValidatedStage: boolean,
    status: Awaited<ReturnType<RuntimeService['getStatus']>>,
  ): UpgradeFinalizeTarget['replacementMode'] {
    if (!hasValidatedStage) return 'blocked';
    if (component === 'launcher') return 'blocked';
    if (component === 'runtime' || component === 'node') return 'restart-required';
    if (component === 'gateway-bundle') {
      return status.gatewayDetails?.running ? 'restart-required' : 'direct';
    }
    return 'blocked';
  }

  private resolveLiveTargetPath(
    component: UpgradeFinalizeTarget['component'],
    status: Awaited<ReturnType<RuntimeService['getStatus']>>,
  ) {
    switch (component) {
      case 'launcher':
        return process.execPath;
      case 'runtime':
        return this.wslRuntimeDir;
      case 'node':
        return path.join(this.wslRuntimeDir, 'node');
      case 'gateway-bundle':
        return status.gatewayDetails?.workingDirectory ?? path.join(this.paths.workspacePath, 'gateway');
      default:
        return null;
    }
  }

  private createFinalizePlan(
    stagedArtifacts: Array<{component: UpgradeFinalizeTarget['component']; stagedPath: string; validated: boolean}>,
    status: Awaited<ReturnType<RuntimeService['getStatus']>>,
    rollbackPrepared: boolean,
  ): UpgradeFinalizeResult {
    const replacementTargets = stagedArtifacts
      .map<UpgradeFinalizeTarget>((artifact, index) => {
        const replacementMode = this.resolveFinalizeMode(artifact.component, artifact.validated, status);
        const prerequisites = artifact.component === 'gateway-bundle'
          ? ['Gateway bundle staged and validated.', 'Gateway process should be stopped before promotion.']
          : artifact.component === 'runtime'
            ? ['Runtime staged and validated.', 'WSL distro import/export window must be controlled.', 'Exclusive access to runtime directories is required.']
            : artifact.component === 'node'
              ? ['Node package staged and validated.', 'Runtime environment must be quiesced before replacement.']
              : ['Launcher staged and validated.', 'Self-update channel and process handoff are required.'];
        const riskPoints = artifact.component === 'gateway-bundle'
          ? ['Replacing while Gateway is running may leave mixed assets.', 'A restart may be required to refresh entrypoints.']
          : artifact.component === 'runtime'
            ? ['WSL import/copy interruption can leave runtime unavailable.', 'Large file replacement may require long-running exclusive locks.']
            : artifact.component === 'node'
              ? ['Binary replacement may break runtime validation if version metadata diverges.', 'Restart is required to ensure fresh PATH/runtime state.']
              : ['Self-replacement of the desktop launcher is not implemented.', 'Platform packaging/updater integration is still required.'];
        const blockedReasons = replacementMode === 'blocked'
          ? artifact.component === 'launcher'
            ? ['Launcher live replacement remains blocked until self-update handoff is implemented.']
            : ['Validated staged artifact is not available for finalize.']
          : [];
        return {
          component: artifact.component,
          replacementMode,
          order: index + 1,
          stagedPath: artifact.stagedPath,
          liveTargetPath: this.resolveLiveTargetPath(artifact.component, status),
          prerequisites,
          riskPoints,
          blockedReasons,
        };
      })
      .sort((left, right) => left.order - right.order);

    const finalizeBlockedReasons = replacementTargets.flatMap((target) => target.blockedReasons);
    const replacementOrder = replacementTargets.map((target) => `${target.order}. ${target.component} (${target.replacementMode})`);
    const riskSummary = [...new Set(replacementTargets.flatMap((target) => target.riskPoints))];
    const prerequisites = [...new Set(replacementTargets.flatMap((target) => target.prerequisites))];

    return {
      readyToFinalize: replacementTargets.length > 0 && finalizeBlockedReasons.length === 0,
      finalizeBlockedReasons,
      replacementTargets,
      restartRequired: replacementTargets.some((target) => target.replacementMode === 'restart-required'),
      rollbackPrepared,
      replacementOrder,
      riskSummary,
      prerequisites,
    };
  }

  private createRollbackPlan(
    finalizePlan: UpgradeFinalizeResult,
    stagedArtifacts: Array<{component: UpgradeRollbackTarget['component']; stagedPath: string}>,
    backupRoot: string | null,
  ): UpgradeRollbackPlan {
    const rollbackTargets = finalizePlan.replacementTargets.map<UpgradeRollbackTarget>((target) => {
      const stagedArtifact = stagedArtifacts.find((artifact) => artifact.component === target.component);
      const stagingPrerequisites = stagedArtifact
        ? ['Staged artifact path still exists and is removable.']
        : ['No staged artifact was produced for this component.'];
      const stagingBlockers = stagedArtifact ? [] : ['Missing staged artifact prevents staging rollback.'];
      const backupPath = backupRoot ? path.join(backupRoot, target.component) : null;
      return {
        component: target.component,
        rollbackType: target.replacementMode === 'direct' || target.replacementMode === 'restart-required' ? 'live' : 'staging',
        previousVersionPath: target.liveTargetPath,
        stagedPath: stagedArtifact?.stagedPath ?? null,
        backupPath,
        rollbackCapable: Boolean(stagedArtifact),
        prerequisites: target.replacementMode === 'blocked'
          ? stagingPrerequisites
          : [...stagingPrerequisites, 'A live backup snapshot must exist before finalize promotion.'],
        blockers: target.replacementMode === 'blocked'
          ? [...target.blockedReasons, ...stagingBlockers]
          : [...stagingBlockers, 'Live rollback remains blocked until backup snapshots are created during finalize.'],
      };
    });

    return {
      rollbackPrepared: rollbackTargets.some((target) => target.rollbackCapable),
      prerequisites: [...new Set(rollbackTargets.flatMap((target) => target.prerequisites))],
      blockers: [...new Set(rollbackTargets.flatMap((target) => target.blockers))],
      rollbackTargets,
      futureIntegrationPoint: 'Staging rollback is executable now; live rollback requires backup snapshots captured during finalize.',
    };
  }

  private async executeStagingRollback(
    rollbackPlan: UpgradeRollbackPlan,
    executedSteps: UpgradeExecutionStep[],
  ): Promise<UpgradeRollbackResult> {
    const rollbackSteps: UpgradeExecutionStep[] = [];
    const recordRollbackStep = async (step: UpgradeExecutionStep) => {
      rollbackSteps.push(step);
      executedSteps.push(step);
      await this.logService.info(`[rollback:${step.status}] ${step.id} - ${step.detail}`, 'installer');
    };

    const stagingTargets = rollbackPlan.rollbackTargets.filter((target) => target.stagedPath);
    if (stagingTargets.length === 0) {
      const result: UpgradeRollbackResult = {
        status: 'blocked',
        rollbackType: 'staging',
        rollbackPrepared: false,
        blockers: ['No staging targets available for rollback.'],
        executedSteps: rollbackSteps,
        rollbackTargets: rollbackPlan.rollbackTargets,
        futureIntegrationPoint: rollbackPlan.futureIntegrationPoint,
      };
      await this.logService.warn('Staging rollback skipped: no rollback targets were prepared.', 'installer');
      return result;
    }

    for (const target of stagingTargets) {
      if (!target.stagedPath) continue;
      await fs.remove(target.stagedPath).catch(() => undefined);
      await recordRollbackStep({
        id: `rollback-staging-${target.component}`,
        status: 'completed',
        detail: `Removed staged artifact for ${target.component} at ${target.stagedPath}.`,
      });
    }

    const liveBlockers = rollbackPlan.rollbackTargets
      .filter((target) => target.rollbackType === 'live')
      .flatMap((target) => target.blockers);

    return {
      status: liveBlockers.length > 0 ? 'stub' : 'completed',
      rollbackType: 'staging',
      rollbackPrepared: true,
      blockers: liveBlockers,
      executedSteps: rollbackSteps,
      rollbackTargets: rollbackPlan.rollbackTargets,
      futureIntegrationPoint: rollbackPlan.futureIntegrationPoint,
    };
  }

  private async updateInstallWorkflow(
    stage: InstallWorkflowStatus['stage'],
    status: InstallProgressEvent['status'],
    message: string,
    details?: Record<string, unknown>,
  ) {
    const event: InstallProgressEvent = {stage, status, message, timestamp: new Date().toISOString(), details};
    this.installWorkflow = {
      ...this.installWorkflow,
      active: !['completed', 'failed', 'reset-requested'].includes(stage),
      stage,
      history: [...this.installWorkflow.history, event].slice(-50),
      lastUpdatedAt: event.timestamp,
      failureReason: status === 'failed' ? message : this.installWorkflow.failureReason,
    };

    if (status === 'failed') {
      this.installWorkflow.active = false;
      this.installWorkflow.failureReason = message;
    }
    if (stage === 'completed') {
      this.installWorkflow.active = false;
      this.installWorkflow.failureReason = undefined;
    }

    await this.logService.append(`[install:${stage}:${status}] ${message}`, 'installer', status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info');
    await this.persistInstallWorkflow();
  }

  private resolveInstallMode(requestedMode?: InstallMode, localImportManifestCount = 0) {
    if (requestedMode) return requestedMode;
    if (localImportManifestCount > 0) return 'import-local';
    return 'hybrid';
  }

  private mapInstallModeToPlanMode(mode: InstallMode) {
    switch (mode) {
      case 'full-offline':
        return 'full';
      case 'online':
        return 'online-bootstrap';
      case 'import-local':
        return 'importable';
      case 'hybrid':
      default:
        return 'full';
    }
  }

  private async runInstallWizard(requestedMode?: InstallMode) {
    this.installWorkflow = {active: true, mode: requestedMode ?? null, stage: 'detect-environment', history: [], lastUpdatedAt: new Date().toISOString()};
    await this.clearInstallFailure();
    await this.updateInstallWorkflow('detect-environment', 'running', 'Detecting runtime environment.');

    try {
      const environment = await this.platformAdapter.detectEnvironment();
      const compatibility = await this.platformAdapter.classifyCompatibility(environment);
      if (compatibility.level === 'unsupported') {
        await this.updateInstallWorkflow('failed', 'failed', 'Platform environment is unsupported for installation.', {blockers: compatibility.blockers});
        await this.setInstallFailure('detect-environment', 'Platform environment is unsupported for installation.', {blockers: compatibility.blockers});
        return {success: false, error: 'Platform environment is unsupported for installation.', details: {workflow: this.installWorkflow, blockers: compatibility.blockers}};
      }

      const importManifests = await this.localImportManager.scanImportDirectory().catch(() => []);
      const mode = this.resolveInstallMode(requestedMode, importManifests.length);
      this.installWorkflow.mode = mode;
      await this.updateInstallWorkflow('choose-mode', 'completed', `Selected install mode: ${mode}`, {recommendedModes: compatibility.recommendedModes});

      await this.updateInstallWorkflow('resolve-resources', 'running', 'Resolving manifest and required resources.');
      const plan = await this.createPlatformPlan(this.mapInstallModeToPlanMode(mode));
      const manifestPath = path.join(this.offlineResourcesDir, 'manifest.json');
      const manifest = await this.resourceManager.loadManifest(await fs.pathExists(manifestPath) ? {localPath: manifestPath} : {});
      const resolved = await this.resourceManager.resolveResources({
        mode: plan.mode,
        platform: environment.platformInfo.platform,
        arch: environment.platformInfo.arch,
        bundleId: plan.selectedBundleId,
      });
      await this.updateInstallWorkflow('resolve-resources', 'completed', `Resolved ${resolved.resources.length} resources.`, {bundleId: plan.selectedBundleId, blockers: plan.blockers});

      await this.updateInstallWorkflow('import-download-resources', 'running', 'Preparing resources from import/cache/download sources.');
      const localManifest = await this.localImportManager.loadLocalManifest().catch(() => null);
      if (localManifest) {
        const validation = this.localImportManager.validatePlatformArch(localManifest.manifest, environment.platformInfo.platform, environment.platformInfo.arch);
        if (validation.compatible) {
          await this.localImportManager.importIntoCacheIndex(localManifest.resources, path.dirname(localManifest.manifestPath));
        }
      }

      let missing = await this.resourceManager.getMissingResources(resolved.resources);
      const downloadResults = [];
      if (missing.length > 0 && (mode === 'online' || mode === 'hybrid')) {
        const cacheRoot = await this.cacheManager.getCacheRoot();
        for (const resource of missing) {
          const destinationPath = path.join(cacheRoot, '.staging', resource.filename);
          const result = await this.downloadManager.downloadOneFile(resource, destinationPath, {
            retries: 1,
            onProgress: (progress) => {
              void this.updateInstallWorkflow('import-download-resources', 'running', `Downloading ${progress.resourceId}`, progress as unknown as Record<string, unknown>);
            },
          });
          downloadResults.push(result);
        }
        missing = await this.resourceManager.getMissingResources(resolved.resources);
      }

      if (missing.length > 0) {
        await this.updateInstallWorkflow('failed', 'failed', 'Resources are still missing after import/download stage.', {
          missingResources: missing.map((resource) => resource.id),
          downloadResults,
        });
        await this.setInstallFailure('import-download-resources', 'Resources are still missing after import/download stage.', {
          missingResources: missing.map((resource) => resource.id),
          downloadResults,
        });
        return {success: false, error: 'Resources are still missing after import/download stage.', details: {workflow: this.installWorkflow, missingResources: missing.map((resource) => resource.id), downloadResults}};
      }
      await this.updateInstallWorkflow('import-download-resources', 'completed', 'All required resources are available in cache/import storage.', {downloadResults});

      await this.updateInstallWorkflow('install-runtime', 'running', 'Installing runtime.');
      const installResult = await this.platformAdapter.installRuntime(plan);
      if (!installResult.success) {
        await this.updateInstallWorkflow('failed', 'failed', installResult.error || 'Platform install step failed.', installResult.details);
        await this.setInstallFailure('install-runtime', installResult.error || 'Platform install step failed.', installResult.details);
        return installResult;
      }
      await this.updateInstallWorkflow('install-runtime', 'completed', installResult.result || 'Runtime install step completed.', installResult.details);

      await this.updateInstallWorkflow('validate-post-install', 'running', 'Validating installation.');
      const validation = await this.platformAdapter.validatePostInstall(plan);
      if (!validation.success) {
        await this.updateInstallWorkflow('failed', 'failed', validation.error || 'Post-install validation failed.', validation.details);
        await this.setInstallFailure('validate-post-install', validation.error || 'Post-install validation failed.', validation.details);
        return validation;
      }
      await this.updateInstallWorkflow('validate-post-install', 'completed', validation.result || 'Validation passed.', validation.details);

      await this.updateInstallWorkflow('start-gateway', 'running', 'Starting gateway.');
      const gateway = await this.platformAdapter.startGateway();
      if (!gateway.success) {
        await this.updateInstallWorkflow('failed', 'failed', gateway.error || 'Gateway start failed.', gateway.details);
        await this.setInstallFailure('start-gateway', gateway.error || 'Gateway start failed.', gateway.details);
        return gateway;
      }
      await this.updateInstallWorkflow('start-gateway', 'completed', gateway.result || 'Gateway started.', gateway.details);
      await this.updateInstallWorkflow('completed', 'completed', 'Installation workflow completed successfully.', {mode, manifestVersion: manifest.productVersion});
      await this.clearInstallFailure();
      return {success: true, result: 'Installation workflow completed.', details: {workflow: this.installWorkflow, installResult, validation, gateway}};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateInstallWorkflow('failed', 'failed', message);
      await this.setInstallFailure(this.installWorkflow.stage, message);
      return {success: false, error: message, details: {workflow: this.installWorkflow}};
    }
  }

  private async buildUpgradePlan(currentNodeVersion: string | null): Promise<UpgradePlan> {
    const blockers: string[] = [];
    const steps = ['prepare resources', 'replace managed files', 'validate post-upgrade'];
    const targets: UpgradePlan['targets'] = [
      {component: 'launcher' as const, currentVersion: null, targetVersion: null, urgency: 'blocked' as const, reason: 'Launcher package version is not wired to managed install metadata yet.'},
      {component: 'runtime' as const, currentVersion: null, targetVersion: null, urgency: 'blocked' as const, reason: 'Runtime version will come from installed manifest metadata.'},
      {component: 'node' as const, currentVersion: currentNodeVersion, targetVersion: null, urgency: 'blocked' as const, reason: 'No manifest version resolved yet.'},
      {component: 'gateway-bundle' as const, currentVersion: null, targetVersion: null, urgency: 'blocked' as const, reason: 'Gateway version will come from prepared install state.'},
    ];

    let source: UpgradePlan['source'] = 'none';
    const localManifestPath = path.join(this.offlineResourcesDir, 'manifest.json');
    let localManifest = null as any;
    if (await fs.pathExists(localManifestPath)) {
      localManifest = await this.manifestResolver.loadFromLocalFile(localManifestPath).catch(() => null);
      source = localManifest ? 'local-manifest' : source;
    }

    let remoteManifest = null as any;
    const remoteManifestUrl = process.env.OPENCLAW_REMOTE_MANIFEST_URL;
    if (remoteManifestUrl) {
      remoteManifest = await this.manifestResolver.loadFromRemoteUrl(remoteManifestUrl).catch((error) => {
        blockers.push(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (remoteManifest) source = 'remote-manifest';
    } else {
      blockers.push('Remote manifest URL is not configured.');
    }

    const activeManifest = remoteManifest ?? localManifest;
    if (activeManifest) {
      const resourceByType = (type: string) => activeManifest.resources.find((resource: any) => resource.resourceType === type) ?? null;
      const runtimeTarget = resourceByType('runtime')?.version ?? resourceByType('rootfs')?.version ?? null;
      const nodeTarget = resourceByType('node')?.version ?? null;
      const gatewayTarget = resourceByType('gateway-bundle')?.version ?? null;
      const launcherTarget = resourceByType('launcher')?.version ?? activeManifest.productVersion;
      targets[0] = {component: 'launcher', currentVersion: null, targetVersion: launcherTarget, urgency: launcherTarget ? 'optional-update' : 'blocked', reason: launcherTarget ? 'Manifest advertises a launcher package version.' : 'Launcher target missing from manifest.'};
      targets[1] = {component: 'runtime', currentVersion: null, targetVersion: runtimeTarget, urgency: runtimeTarget ? 'optional-update' : 'blocked', reason: runtimeTarget ? 'Manifest advertises a runtime package version.' : 'Runtime target missing from manifest.'};
      targets[2] = {component: 'node', currentVersion: currentNodeVersion, targetVersion: nodeTarget, urgency: nodeTarget && nodeTarget !== currentNodeVersion ? 'required-update' : 'no-update', reason: nodeTarget && nodeTarget !== currentNodeVersion ? 'Installed Node version differs from manifest.' : 'Node already matches manifest or no target available.'};
      targets[3] = {component: 'gateway-bundle', currentVersion: null, targetVersion: gatewayTarget, urgency: gatewayTarget ? 'optional-update' : 'blocked', reason: gatewayTarget ? 'Manifest advertises a gateway bundle version.' : 'Gateway target missing from manifest.'};
    }

    const status: UpgradePlan['status'] = blockers.length > 0
      ? 'blocked'
      : targets.some((target) => target.urgency === 'required-update')
        ? 'required-update'
        : targets.some((target) => target.urgency === 'optional-update')
          ? 'optional-update'
          : 'no-update';

    await this.logService.info(`Upgrade plan evaluated with status=${status}`, 'installer');
    return {
      status,
      source,
      targets,
      blockers,
      steps,
      futureIntegrationPoint: 'prepare resources -> replace managed dirs/files -> validate -> rollback if needed',
      rollbackHint: 'Preserve existing runtime/cache snapshots before replacement.',
    };
  }

  private async runUpgradePlan() {
    const status = await this.getStatus();
    const plan = status.upgradePlan ?? await this.buildUpgradePlan(status.nodeDetails?.version ?? null);
    const executedSteps: UpgradeExecutionStep[] = [];
    const skippedSteps: UpgradeExecutionStep[] = [];
    const blockers = [...plan.blockers];
    const validationSummary: string[] = [];
    let rollbackAvailable = false;
    let stageRoot: string | null = null;

    const recordStep = async (
      bucket: UpgradeExecutionStep[],
      id: string,
      statusValue: UpgradeExecutionStep['status'],
      detail: string,
    ) => {
      bucket.push({id, status: statusValue, detail});
      await this.logService.info(`[upgrade:${statusValue}] ${id} - ${detail}`, 'installer');
    };

    await this.logService.info(`runUpgradePlan invoked with status=${plan.status}`, 'installer');
    await this.setUpgradeState({
      status: 'blocked',
      executedSteps: [],
      skippedSteps: [],
      blockers: [],
      rollbackAvailable: false,
      validationSummary: ['Upgrade execution has not started yet.'],
      futureIntegrationPoint: plan.futureIntegrationPoint,
    });

    if (plan.status === 'no-update') {
      for (const target of plan.targets) {
        skippedSteps.push({id: `no-update-${target.component}`, status: 'skipped', detail: `${target.component} already matches target or has no pending upgrade.`});
      }
      const execution: UpgradeExecutionResult = {
        status: 'validated',
        executedSteps,
        skippedSteps,
        blockers,
        rollbackAvailable: false,
        validationSummary: ['No component required an upgrade.'],
        futureIntegrationPoint: plan.futureIntegrationPoint,
      };
      await this.setUpgradeState(execution);
      return {success: true, result: 'No update required.', details: {plan, execution}};
    }

    const remoteManifestUrl = process.env.OPENCLAW_REMOTE_MANIFEST_URL;
    if (!remoteManifestUrl) {
      const {execution} = await this.markUpgradeBlocked(plan, 'prepare-resources', 'Remote manifest URL is not configured.');
      return {success: false, error: 'Upgrade is blocked.', details: {plan, execution}};
    }

    try {
      const remoteManifest = await this.manifestResolver.loadManifest({remoteUrl: remoteManifestUrl});
      const environment = await this.platformAdapter.getPlatformInfo();
      const actionableComponents = plan.targets.map((target) => {
        const targetTypes = target.component === 'runtime'
          ? ['runtime', 'rootfs']
          : [target.component];
        const resource = remoteManifest.resources.find((candidate) =>
          targetTypes.includes(candidate.resourceType)
          && candidate.platform === environment.platform
          && candidate.arch === environment.arch,
        ) ?? null;
        return {target, resource};
      });

      await this.logService.info(`Upgrade manifest resolved for ${environment.platform}/${environment.arch}`, 'installer');

      for (const {target, resource} of actionableComponents) {
        if (target.urgency === 'no-update') {
          await recordStep(skippedSteps, `prepare-${target.component}`, 'skipped', `${target.component} has no pending upgrade.`);
          continue;
        }
        if (!resource) {
          blockers.push(`No upgrade resource found for ${target.component} on ${environment.platform}/${environment.arch}.`);
          await recordStep(skippedSteps, `prepare-${target.component}`, 'skipped', `Missing manifest resource for ${target.component}.`);
          continue;
        }

        const reuse = await this.resourceManager.assessResourceReuse(resource);
        if (reuse.mustRedownload) {
          const cacheRoot = await this.cacheManager.getCacheRoot();
          const downloadPath = path.join(cacheRoot, '.upgrade-downloads', resource.filename);
          const downloadResult = await this.downloadManager.downloadOneFile(resource, downloadPath, {
            retries: 1,
            onProgress: (progress) => {
              void this.logService.info(
                `Upgrade download progress ${progress.resourceId}: ${progress.downloadedBytes ?? progress.transferredBytes ?? 0}/${progress.totalBytes ?? 0}`,
                'resources',
              );
            },
          });

          if (!downloadResult.success) {
            blockers.push(`${target.component} resource download failed: ${downloadResult.error ?? 'unknown error'}`);
            await recordStep(skippedSteps, `prepare-${target.component}`, 'skipped', `Failed to prepare ${target.component}: ${downloadResult.error ?? 'unknown error'}`);
            continue;
          }
          await recordStep(executedSteps, `prepare-${target.component}`, 'completed', `${target.component} prepared from ${downloadResult.source ?? 'download'} after ${downloadResult.attempts} attempt(s).`);
        } else {
          await recordStep(executedSteps, `prepare-${target.component}`, 'completed', `${target.component} prepared from reusable cache.`);
        }
      }

      if (blockers.length > 0) {
        const failure = this.buildFailureInfo('upgrade', 'prepare-resources', blockers[0]!, {blockers});
        const execution: UpgradeExecutionResult = {
          status: 'blocked',
          executedSteps,
          skippedSteps,
          blockers,
          rollbackAvailable: false,
          validationSummary: ['Upgrade preparation did not complete because required resources were unavailable.'],
          futureIntegrationPoint: plan.futureIntegrationPoint,
        };
        await this.setUpgradeState(execution, failure);
        return {success: false, error: 'Upgrade is blocked.', details: {plan, execution}};
      }

      const verifiedResources = actionableComponents
        .filter((item) => item.resource && item.target.urgency !== 'no-update')
        .map((item) => ({component: item.target.component, resource: item.resource!}));

      for (const {component, resource} of verifiedResources) {
        const verification = await this.cacheManager.verifyCachedFile(resource);
        if (!verification.valid || !verification.path) {
          blockers.push(`${component} verification failed: ${verification.reason ?? 'unknown verification error'}`);
          await recordStep(skippedSteps, `verify-${component}`, 'skipped', `${component} verification failed.`);
          continue;
        }
        validationSummary.push(`${component}: cache verified (${verification.reason ?? 'verified'})`);
        await recordStep(executedSteps, `verify-${component}`, 'completed', `${component} cache verified at ${verification.path}.`);
      }

      if (blockers.length > 0) {
        const failure = this.buildFailureInfo('upgrade', 'verify-resources', blockers[0]!, {blockers});
        const execution: UpgradeExecutionResult = {
          status: 'blocked',
          executedSteps,
          skippedSteps,
          blockers,
          rollbackAvailable: false,
          validationSummary,
          futureIntegrationPoint: plan.futureIntegrationPoint,
        };
        await this.setUpgradeState(execution, failure);
        return {success: false, error: 'Upgrade is blocked.', details: {plan, execution}};
      }

      const cacheRoot = await this.cacheManager.getCacheRoot();
      const stageToken = new Date().toISOString().replace(/[:.]/g, '-');
      const backupRoot = path.join(cacheRoot, '.upgrade-backups', stageToken);
      const stagedArtifacts: Array<{component: UpgradeFinalizeTarget['component']; stagedPath: string; validated: boolean}> = [];
      stageRoot = path.join(cacheRoot, '.upgrade-staging', stageToken);
      await fs.ensureDir(stageRoot);

      for (const {component, resource} of verifiedResources) {
        const cached = await this.cacheManager.verifyCachedFile(resource);
        if (!cached.path) {
          blockers.push(`${component} staged replacement failed because cache path is unavailable.`);
          await recordStep(skippedSteps, `stage-${component}`, 'skipped', `${component} has no cache file to stage.`);
          continue;
        }
        const stagePath = path.join(stageRoot, component, resource.filename);
        await fs.ensureDir(path.dirname(stagePath));
        await fs.copyFile(cached.path, stagePath);
        rollbackAvailable = true;
        stagedArtifacts.push({component, stagedPath: stagePath, validated: false});
        await recordStep(executedSteps, `stage-${component}`, 'completed', `${component} staged at ${stagePath}.`);

        const stagedVerification = await this.downloadManager.verifyHashHook(resource, stagePath);
        if (!stagedVerification.ok) {
          blockers.push(`${component} staged validation failed: ${stagedVerification.reason}`);
          await recordStep(skippedSteps, `validate-${component}`, 'skipped', `${component} staged file failed hash validation.`);
          continue;
        }
        const artifact = stagedArtifacts.find((item) => item.component === component && item.stagedPath === stagePath);
        if (artifact) artifact.validated = true;
        validationSummary.push(`${component}: staged artifact verified`);
        await recordStep(executedSteps, `validate-${component}`, 'completed', `${component} staged artifact passed validation.`);
      }

      const finalizePlan = this.createFinalizePlan(stagedArtifacts, status, rollbackAvailable);
      const rollbackPlan = this.createRollbackPlan(
        finalizePlan,
        stagedArtifacts.map((artifact) => ({component: artifact.component, stagedPath: artifact.stagedPath})),
        backupRoot,
      );
      await this.logService.info(
        `Finalize plan prepared: ready=${finalizePlan.readyToFinalize}, restartRequired=${finalizePlan.restartRequired}, rollbackPrepared=${finalizePlan.rollbackPrepared}`,
        'installer',
      );
      for (const target of finalizePlan.replacementTargets) {
        await this.logService.info(
          `Finalize target ${target.component}: mode=${target.replacementMode}, order=${target.order}, live=${target.liveTargetPath ?? 'n/a'}`,
          'installer',
        );
      }
      await this.logService.info(
        `Rollback plan prepared: prepared=${rollbackPlan.rollbackPrepared}, blockers=${rollbackPlan.blockers.length}`,
        'installer',
      );

      if (blockers.length > 0) {
        const rollbackResult = await this.executeStagingRollback(rollbackPlan, executedSteps);
        if (stageRoot) await fs.remove(stageRoot).catch(() => undefined);
        const failure = this.buildFailureInfo('upgrade', 'validate-after-upgrade', blockers[0]!, {blockers});
        const execution: UpgradeExecutionResult = {
          status: 'rolled-back',
          executedSteps,
          skippedSteps,
          blockers,
          rollbackAvailable,
          validationSummary,
          finalizePlan,
          rollbackPlan,
          rollbackResult,
          futureIntegrationPoint: 'Live replacement/finalize remains stubbed; staged files are validated only.',
        };
        await this.setUpgradeState(execution, failure);
        return {success: false, error: 'Upgrade validation failed.', details: {plan, execution, stageRoot}};
      }

      const rollbackResult: UpgradeRollbackResult = {
        status: 'prepared',
        rollbackType: 'staging',
        rollbackPrepared: rollbackPlan.rollbackPrepared,
        blockers: rollbackPlan.blockers,
        executedSteps: [],
        rollbackTargets: rollbackPlan.rollbackTargets,
        futureIntegrationPoint: rollbackPlan.futureIntegrationPoint,
      };
      await recordStep(
        skippedSteps,
        'finalize-live-replacement',
        'skipped',
        finalizePlan.readyToFinalize
          ? 'Live replacement plan is ready, but actual finalize execution remains stubbed in this round.'
          : `Finalize is not ready: ${finalizePlan.finalizeBlockedReasons.join('；') || 'unknown blockers'}.`,
      );
      const execution: UpgradeExecutionResult = {
        status: 'validated',
        executedSteps,
        skippedSteps,
        blockers,
        rollbackAvailable,
        validationSummary,
        finalizePlan,
        rollbackPlan,
        rollbackResult,
        futureIntegrationPoint: 'Finalize/rollback of live runtime directories remains a stub.',
      };
      await this.setUpgradeState(execution);
      return {
        success: false,
        error: finalizePlan.readyToFinalize
          ? 'Upgrade artifacts were prepared, finalize targets were planned, but live replacement is still stubbed.'
          : 'Upgrade artifacts were prepared, but finalize is blocked by structured preconditions/risk gates.',
        details: {plan, execution, stageRoot},
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stageRoot) {
        const rollbackPlan = this.createRollbackPlan(
          this.createFinalizePlan([], status, rollbackAvailable),
          [],
          null,
        );
        await this.executeStagingRollback(rollbackPlan, executedSteps);
        await fs.remove(stageRoot).catch(() => undefined);
        await recordStep(executedSteps, 'rollback-upgrade-exception', 'completed', `Cleaned staged files after exception from ${stageRoot}.`);
      }
      const failure = this.buildFailureInfo('upgrade', 'prepare-resources', message);
      const execution: UpgradeExecutionResult = {
        status: stageRoot ? 'rolled-back' : 'failed',
        executedSteps,
        skippedSteps,
        blockers: [...blockers, message],
        rollbackAvailable,
        validationSummary,
        futureIntegrationPoint: plan.futureIntegrationPoint,
      };
      await this.logService.error(`Upgrade execution failed: ${message}`, 'installer');
      await this.setUpgradeState(execution, failure);
      return {success: false, error: message, details: {plan, execution}};
    }
  }

  private async createPlatformPlan(preferredMode?: any) {
    const manifestPath = path.join(this.offlineResourcesDir, 'manifest.json');
    const manifest = await this.resourceManager.loadManifest(
      await fs.pathExists(manifestPath) ? {localPath: manifestPath} : {},
    );

    return this.platformAdapter.planInstall({
      resourceManager: this.resourceManager,
      cacheManager: this.cacheManager,
      localImportManager: this.localImportManager,
      manifest,
      preferredMode,
    });
  }

  private async installViaPlatformAdapter(preferredMode?: any) {
    const plan = await this.createPlatformPlan(preferredMode);
    return this.platformAdapter.installRuntime(plan);
  }

  private async validatePlatformRuntime(preferredMode?: any) {
    const plan = await this.createPlatformPlan(preferredMode);
    return this.platformAdapter.validatePostInstall(plan);
  }

  private async startPlatformGateway(preferredMode?: any) {
    await this.createPlatformPlan(preferredMode);
    return this.platformAdapter.startGateway();
  }

  async checkPortUsage(port: number): Promise<PortUsageResult> {
    await this.logService.info(`Checking port usage for ${port}`, 'diagnostics');
    const result = await this.commandService.runCommand('netstat', ['-ano'], {source: 'diagnostics', timeoutMs: 10000});
    const rawOutput = `${result.stdout}${result.stderr}`;

    if (!result.success) {
      return {
        occupied: false,
        port,
        pid: null,
        protocol: null,
        rawOutput,
        advice: [`无法检测端口 ${port}，请确认 netstat 可用。`],
      };
    }

    const match = rawOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.includes(`:${port}`) && /LISTENING/i.test(line));

    if (!match) {
      return {
        occupied: false,
        port,
        pid: null,
        protocol: null,
        rawOutput,
        advice: [`端口 ${port} 当前空闲。`],
      };
    }

    const parts = match.split(/\s+/).filter(Boolean);
    return {
      occupied: true,
      port,
      protocol: parts[0] ?? null,
      pid: Number(parts.at(-1) ?? '0') || null,
      rawOutput: match,
      advice: [`端口 ${port} 被占用，可先查看 PID 再决定是否强制结束。`],
    };
  }

  async killPortProcess(port: number): Promise<ActionResult> {
    const usage = await this.checkPortUsage(port);
    if (!usage.occupied || !usage.pid) {
      await this.logService.warn(`Port ${port} is not occupied, skipping taskkill.`, 'diagnostics');
      return {success: true, result: `端口 ${port} 当前未被占用`};
    }

    await this.logService.warn(`High-risk action: taskkill /PID ${usage.pid} /F for port ${port}`, 'diagnostics');
    const result = await this.commandService.runCommand('taskkill', ['/PID', String(usage.pid), '/F'], {
      source: 'diagnostics',
      timeoutMs: 15000,
    });

    return result.success
      ? {success: true, result: `已结束占用端口 ${port} 的进程 ${usage.pid}`}
      : {success: false, error: result.stderr || result.stdout || `无法结束进程 ${usage.pid}`};
  }

  async executeAction({step, action, ...extra}: ExecuteActionPayload): Promise<ActionResult> {
    await this.logService.info(`Executing action: ${step}`, 'system');

    try {
      switch (step) {
        case 'get-status':
          return {success: true, details: (await this.getStatus()) as unknown as Record<string, unknown>};
        case 'admin':
          return (await this.detectAdminStatus())
            ? {success: true, result: '当前已具备管理员权限。'}
            : {success: false, error: '当前未以管理员身份运行。'};
        case 'startGateway':
        case 'startGatewayAndOpen':
        case 'gateway':
          return this.startPlatformGateway(extra.mode as any);
        case 'stopGateway':
          return this.platformAdapter.stopGateway();
        case 'restartGateway':
        case 'setupGateway':
          return this.gatewayService.restartGateway();
        case 'writeConfig': {
          const merged = await this.storageService.writeConfig((extra.config as Record<string, any>) ?? {});
          return {success: true, result: '配置文件已更新', details: {config: merged}};
        }
        case 'deleteConfig':
          await this.storageService.deleteConfig();
          return {success: true, result: '本地配置已清理'};
        case 'deleteRuntime':
        case 'resetRuntime':
        case 'uninstall':
          await this.updateInstallWorkflow('reset-requested', 'running', 'Reset requested by user.');
          return this.platformAdapter.resetRuntime();
        case 'killPortProcess':
          return this.killPortProcess(Number(extra.port ?? DEFAULT_GATEWAY_PORT));
        case 'installNodeOffline':
          return this.installNodeOffline();
        case 'repairWSL':
          return this.repairWSL();
        case 'repairOfflineResources':
          return this.repairOfflineResources();
        case 'wsl':
          return this.repairWSL();
        case 'vmPlatform':
          return this.enableVirtualMachinePlatform();
        case 'importRuntime':
        case 'installRuntime':
          return this.installViaPlatformAdapter(extra.mode as any);
        case 'runInstallWizard':
          return this.runInstallWizard((extra.mode as InstallMode | undefined) ?? undefined);
        case 'validateRuntime':
          return this.validatePlatformRuntime(extra.mode as any);
        case 'checkUpgrade':
          return {success: true, details: {plan: await this.buildUpgradePlan((await this.detectNodeVersion()).version)}};
        case 'runUpgrade':
          return this.runUpgradePlan();
        case 'sandboxInstall':
          return this.generateSandboxConfig();
        case 'node':
          return this.installNodeOffline();
        case 'openUrl':
          return {success: true, result: `已请求打开: ${String(extra.url ?? '')}`};
        default:
          return {success: false, error: `未实现的动作: ${step}`};
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logService.error(`Action failed: ${message}`, 'system');
      return {success: false, error: message};
    }
  }

  async runDiagnostics(): Promise<DiagnosticIssue[]> {
    await this.logService.info('Running diagnostics rules.', 'diagnostics');
    const [node, wsl, offlineResources, port18789] = await Promise.all([
      this.detectNodeVersion(),
      this.detectWSLStatus(),
      this.detectOfflineResources(),
      this.checkPortUsage(DEFAULT_GATEWAY_PORT),
    ]);
    return buildDiagnostics({node, wsl, offlineResources, port18789});
  }

  async repairDiagnostic(id: string): Promise<ActionResult> {
    await this.logService.warn(`Attempting repair for diagnostic ${id}`, 'diagnostics');
    switch (id) {
      case 'port-18789-in-use':
        return this.killPortProcess(DEFAULT_GATEWAY_PORT);
      case 'node-missing-or-unsupported':
        return this.installNodeOffline();
      case 'wsl-unavailable-or-not-installed':
        return this.repairWSL();
      case 'offline-resources-incomplete':
        return this.repairOfflineResources();
      default:
        return {success: false, error: `未知诊断规则: ${id}`};
    }
  }

  async readConfig() {
    return this.storageService.readConfig();
  }

  async getState() {
    return this.storageService.readState();
  }

  async setState(state: Record<string, any>) {
    return this.storageService.writeState(state);
  }

  async clearLogs() {
    await this.logService.clear();
    return {success: true};
  }

  async getLogs() {
    return this.logService.getSnapshot();
  }

  async exportLogs() {
    return this.logService.exportLogs();
  }

  async testModel({provider, config}: ModelTestPayload): Promise<TestResult> {
    await this.logService.info(`Testing model provider: ${provider}`, 'system');
    try {
      let testUrl = '';
      const headers: Record<string, string> = {'Content-Type': 'application/json'};
      let body: Record<string, unknown> = {};
      const apiKey = String((config.apiKey ?? config.api_key ?? '') as string);

      switch (provider) {
        case 'bailian':
          testUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
          headers.Authorization = `Bearer ${apiKey}`;
          body = {model: 'qwen-turbo', input: {messages: [{role: 'user', content: 'hi'}]}};
          break;
        case 'deepseek':
          testUrl = 'https://api.deepseek.com/chat/completions';
          headers.Authorization = `Bearer ${apiKey}`;
          body = {model: 'deepseek-chat', messages: [{role: 'user', content: 'hi'}]};
          break;
        case 'gemini':
          testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
          body = {contents: [{parts: [{text: 'hi'}]}]};
          break;
        case 'openai':
          testUrl = `${String(config.baseUrl ?? 'https://api.openai.com/v1')}/chat/completions`;
          headers.Authorization = `Bearer ${apiKey}`;
          body = {model: String(config.model ?? 'gpt-4o-mini'), messages: [{role: 'user', content: 'hi'}]};
          break;
        case 'zhipu':
          testUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
          headers.Authorization = `Bearer ${apiKey}`;
          body = {model: 'glm-4', messages: [{role: 'user', content: 'hi'}]};
          break;
        case 'anthropic':
          testUrl = 'https://api.anthropic.com/v1/messages';
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          body = {model: 'claude-3-haiku-20240307', max_tokens: 10, messages: [{role: 'user', content: 'hi'}]};
          break;
        case 'ollama':
          testUrl = `${String(config.baseUrl ?? 'http://localhost:11434')}/api/generate`;
          body = {model: String(config.model ?? 'llama3'), prompt: 'hi', stream: false};
          break;
        case 'codex':
          return apiKey.length > 50
            ? {success: true, message: 'Token 格式校验通过 (Session 登录无法直接测试连接)'}
            : {success: false, message: 'Token 格式不正确'};
        default:
          throw new Error(`不支持的模型提供商: ${provider}`);
      }

      const response = await fetch(testUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) return {success: true, message: '连接成功！'};
      const errText = await response.text();
      return {success: false, message: `失败 (HTTP ${response.status}): ${errText.slice(0, 120)}...`};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {success: false, message: `错误: ${message}`};
    }
  }

  async testChannel({channel, config}: ChannelTestPayload): Promise<TestResult> {
    await this.logService.info(`Testing channel: ${channel}`, 'system');
    try {
      let testUrl = '';
      let body: Record<string, unknown> = {};
      const headers: Record<string, string> = {'Content-Type': 'application/json'};

      switch (channel) {
        case 'feishu':
          testUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
          body = {app_id: config.app_id, app_secret: config.app_secret};
          break;
        case 'dingtalk':
          testUrl = `https://oapi.dingtalk.com/robot/send?access_token=${String(config.access_token ?? '')}`;
          body = {msgtype: 'text', text: {content: 'OpenClaw 渠道测试成功'}};
          break;
        case 'wechat_work':
          testUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${String(config.key ?? '')}`;
          body = {msgtype: 'text', text: {content: 'OpenClaw 渠道测试成功'}};
          break;
        case 'qq':
          return config.bot_id && config.bot_token
            ? {success: true, message: '配置格式校验通过 (QQ 机器人需在运行时测试)'}
            : {success: false, message: '机器人 ID 或 Token 缺失'};
        default:
          throw new Error(`不支持的渠道: ${channel}`);
      }

      const response = await fetch(testUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if (channel === 'feishu' && !data.tenant_access_token) {
          return {success: false, message: `失败: ${data.msg ?? '未知错误'}`};
        }
        return {success: true, message: '连接测试成功！'};
      }

      const errText = await response.text();
      return {success: false, message: `失败 (HTTP ${response.status}): ${errText.slice(0, 120)}...`};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {success: false, message: `错误: ${message}`};
    }
  }


  private async enableVirtualMachinePlatform(): Promise<ActionResult> {
    const status = await this.detectWindowsFeature('VirtualMachinePlatform');
    if (status === 'installed') {
      return {success: true, result: 'Virtual Machine Platform 已启用'};
    }

    await this.logService.warn('Virtual Machine Platform enable flow is not auto-applied in this round.', 'system');
    return {
      success: false,
      error: '当前仅提供检测与建议，请以管理员身份启用 Virtual Machine Platform。',
      details: {commandSuggestion: 'Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart'},
    };
  }

  private async importRuntime(): Promise<ActionResult> {
    const wsl = await this.detectWSLStatus();
    if (!wsl.available) {
      return {success: false, error: 'WSL 当前不可用，无法导入 OpenClaw Runtime。'};
    }

    if (wsl.openClawDistroInstalled) {
      return {success: false, error: `${OPENCLAW_DISTRO_NAME} 已存在，如需重新导入请先执行深度重置。`};
    }

    const rootfsPath = await this.locateRootfsArchive();
    if (!rootfsPath) {
      return {success: false, error: '未在 offline_resources 中找到 rootfs / 镜像包。'};
    }

    const installDir = path.join(this.runtimeAppDataDir, 'distros', OPENCLAW_DISTRO_NAME);
    if (!this.isSafeOpenClawPath(installDir)) {
      return {success: false, error: `目标目录不在白名单中: ${installDir}`};
    }

    await fs.ensureDir(installDir);
    await fs.emptyDir(installDir);
    await this.logService.info(`Preparing WSL import dir: ${installDir}`, 'system');
    const importResult = await this.commandService.runCommand('wsl.exe', ['--import', OPENCLAW_DISTRO_NAME, installDir, rootfsPath, '--version', '2'], {
      source: 'system',
      timeoutMs: 10 * 60 * 1000,
    });

    if (!importResult.success) {
      return {success: false, error: importResult.stderr || importResult.stdout || 'wsl --import 执行失败'};
    }

    const status = await this.detectWSLStatus();
    if (!status.openClawDistroInstalled) {
      return {success: false, error: 'wsl --import 已执行，但回读状态未发现 OpenClaw-Runtime。'};
    }

    await this.logService.success(`WSL runtime imported from ${rootfsPath}`, 'system');
    return {success: true, result: 'OpenClaw Runtime 导入成功', details: {installDir, rootfsPath}};
  }

  private async generateSandboxConfig(): Promise<ActionResult> {
    const sandboxPath = path.join(this.paths.basePath, 'OpenClaw_Sandbox.wsb');
    const content = `<Configuration>\n  <MappedFolders>\n    <MappedFolder>\n      <HostFolder>${this.paths.basePath}</HostFolder>\n      <SandboxFolder>C:\\OpenClaw</SandboxFolder>\n      <ReadOnly>false</ReadOnly>\n    </MappedFolder>\n  </MappedFolders>\n</Configuration>`;
    await fs.writeFile(sandboxPath, content, 'utf8');
    await this.logService.success(`Sandbox config generated at ${sandboxPath}`, 'system');
    return {success: true, result: `沙盒配置文件已生成: ${sandboxPath}`};
  }

  private async installNodeOffline(): Promise<ActionResult> {
    const installer = await this.locateNodeInstaller();
    if (!installer) {
      return {
        success: false,
        error: '未检测到可用的 Node 离线安装包。',
        details: {advice: ['请将 Node 22+ 的 .msi、.exe 或 .zip 安装包放入 offline_resources。']},
      };
    }

    if (!this.isSafeOfflinePath(installer.path)) {
      return {success: false, error: `安装包路径不在白名单中: ${installer.path}`};
    }

    await this.logService.info(`Detected offline Node installer: ${installer.path}`, 'diagnostics');

    if (installer.type === 'msi') {
      const installLogPath = path.join(this.runtimeAppDataDir, 'node-offline-install.log');
      const result = await this.commandService.runCommand('msiexec', ['/i', installer.path, '/qn', '/norestart', '/L*v', installLogPath], {
        source: 'diagnostics',
        timeoutMs: 15 * 60 * 1000,
      });
      if (!result.success) {
        return {success: false, error: result.stderr || result.stdout || 'Node MSI 安装失败', details: {installer: installer.path, installLogPath}};
      }
      const node = await this.detectNodeVersion();
      return node.supported
        ? {success: true, result: `Node 已离线安装到系统中 (${node.version})`, details: {installer: installer.path, installLogPath}}
        : {success: false, error: 'MSI 已执行，但未检测到满足要求的 Node 版本', details: {installer: installer.path, installLogPath, node}};
    }

    if (installer.type === 'exe') {
      if (!installer.silentArgs) {
        return {success: false, error: '该 EXE 安装包缺少安全的静默参数，已阻断自动执行。', details: {installer: installer.path}};
      }
      const result = await this.commandService.runCommand(installer.path, installer.silentArgs, {
        source: 'diagnostics',
        timeoutMs: 15 * 60 * 1000,
      });
      if (!result.success) {
        return {success: false, error: result.stderr || result.stdout || 'Node EXE 安装失败', details: {installer: installer.path, args: installer.silentArgs}};
      }
      const node = await this.detectNodeVersion();
      return node.supported
        ? {success: true, result: `Node 已离线安装到系统中 (${node.version})`, details: {installer: installer.path, args: installer.silentArgs}}
        : {success: false, error: 'EXE 已执行，但未检测到满足要求的 Node 版本', details: {installer: installer.path, node}};
    }

    return {
      success: false,
      error: 'ZIP 离线包已检测到，但本轮未实现自动写入系统 PATH 的无风险流程。',
      details: {installer: installer.path, futureIntegrationPoint: 'extract zip -> managed runtime tools dir -> PATH/bootstrap integration'},
    };
  }


  private async locateNodeInstaller() {
    if (!(await fs.pathExists(this.offlineResourcesDir))) {
      return null;
    }

    const files = await fs.readdir(this.offlineResourcesDir);
    const preferred = files
      .filter((file) => /node/i.test(file) && /\.(msi|exe|zip)$/i.test(file))
      .sort();

    const selected = preferred[0];
    if (!selected) return null;
    const fullPath = path.join(this.offlineResourcesDir, selected);
    const lower = selected.toLowerCase();
    if (lower.endsWith('.msi')) {
      return {path: fullPath, type: 'msi' as const, silentArgs: ['/qn', '/norestart']};
    }
    if (lower.endsWith('.exe')) {
      return {path: fullPath, type: 'exe' as const, silentArgs: /node/i.test(lower) ? ['/S'] : null};
    }
    return {path: fullPath, type: 'zip' as const, silentArgs: null};
  }

  private async locateRootfsArchive() {
    if (!(await fs.pathExists(this.offlineResourcesDir))) {
      return null;
    }

    const files = await fs.readdir(this.offlineResourcesDir);
    const match = files
      .filter((file) => /(rootfs|image)/i.test(file) && /\.(tar|tar\.gz|tgz)$/i.test(file))
      .sort()[0];

    return match ? path.join(this.offlineResourcesDir, match) : null;
  }

  private isSafeOfflinePath(target: string) {
    const normalized = path.resolve(target).toLowerCase();
    const allowed = path.resolve(this.offlineResourcesDir).toLowerCase();
    return normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`);
  }

  private async repairWSL(): Promise<ActionResult> {
    await this.logService.warn('repairWSL runs safe diagnostics only in this round.', 'diagnostics');
    const status = await this.detectWSLStatus();
    const featureCheck = await this.commandService.runPowerShell('Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux', {
      timeoutMs: 15000,
    });

    return {
      success: false,
      error: 'repairWSL 当前仅提供诊断骨架，尚未自动执行高风险安装。',
      details: {
        wslStatus: status,
        featureCheck: featureCheck.stdout || featureCheck.stderr,
        advice: [
          '请以管理员身份执行 wsl --install。',
          '若需要自动化安装，请在下一轮接入明确的管理员确认流程。',
        ],
      },
    };
  }

  private async repairOfflineResources(): Promise<ActionResult> {
    const resources = await this.detectOfflineResources();
    await this.logService.warn('repairOfflineResources currently provides guidance only.', 'diagnostics');
    return {
      success: false,
      error: 'offline_resources 目录仍不完整，请根据建议补齐资源或切换 online 模式。',
      details: resources as unknown as Record<string, unknown>,
    };
  }

  private async resetRuntime(includeWorkspace: boolean): Promise<RuntimeResetResult> {
    await this.logService.warn(`Starting resetRuntime(includeWorkspace=${includeWorkspace})`, 'system');
    const removedPaths: string[] = [];
    const skippedPaths: string[] = [];
    const warnings: string[] = [];

    if (includeWorkspace) {
      warnings.push('工作区目录默认不允许删除，本轮仍强制保留。');
      await this.logService.warn('Workspace deletion requested but blocked by safety policy.', 'system');
    }

    await this.gatewayService.stopGateway();

    const wslStatus = await this.detectWSLStatus();
    if (wslStatus.openClawDistroInstalled) {
      const unregister = await this.commandService.runCommand('wsl.exe', ['--unregister', OPENCLAW_DISTRO_NAME], {
        source: 'system',
        timeoutMs: 30000,
      });
      if (!unregister.success) {
        warnings.push(`WSL 发行版注销失败: ${unregister.stderr || unregister.stdout}`);
      }
    } else {
      skippedPaths.push(`WSL distro ${OPENCLAW_DISTRO_NAME} 不存在`);
    }

    const safePaths = [this.runtimeAppDataDir, this.wslRuntimeDir, this.paths.logFile, this.paths.stateFile];
    for (const target of safePaths) {
      if (!(await fs.pathExists(target))) {
        skippedPaths.push(`${target} 不存在`);
        continue;
      }

      if (!this.isSafeOpenClawPath(target)) {
        warnings.push(`已阻止危险删除路径: ${target}`);
        continue;
      }

      await fs.remove(target);
      removedPaths.push(target);
      await this.logService.success(`Removed runtime path: ${target}`, 'system');
    }

    return {
      success: warnings.length === 0,
      removedPaths,
      skippedPaths,
      warnings,
      message: warnings.length === 0 ? '深度重置已完成' : '深度重置已部分完成，请查看警告',
    };
  }

  private wrapResetResult(result: RuntimeResetResult): ActionResult {
    return {
      success: result.success,
      result: result.message,
      details: result as unknown as Record<string, unknown>,
      error: result.success ? undefined : result.warnings.join('\n'),
    };
  }

  private isSafeOpenClawPath(target: string) {
    const normalized = path.resolve(target).toLowerCase();
    const whitelist = [
      path.resolve(this.runtimeAppDataDir).toLowerCase(),
      path.resolve(path.join(this.runtimeAppDataDir, 'distros')).toLowerCase(),
      path.resolve(this.wslRuntimeDir).toLowerCase(),
      path.resolve(this.paths.logFile).toLowerCase(),
      path.resolve(this.paths.stateFile).toLowerCase(),
    ];

    return whitelist.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`));
  }

  private async detectAdminStatus() {
    const result = await this.commandService.runPowerShell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')", {
      timeoutMs: 10000,
    });
    return result.success && result.stdout.trim() === 'True';
  }

  private async detectWindowsFeature(featureName: string) {
    const result = await this.commandService.runPowerShell(`Get-WindowsOptionalFeature -Online -FeatureName ${featureName}`, {
      timeoutMs: 15000,
    });
    if (!result.success) return 'not_installed' as const;
    return result.stdout.includes('Enabled') ? ('installed' as const) : ('not_installed' as const);
  }

  private async detectGitVersion() {
    const result = await this.commandService.runCommand('git', ['--version'], {source: 'diagnostics', timeoutMs: 10000});
    const versionMatch = `${result.stdout}${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
    return {
      version: versionMatch?.[1] ?? 'not_installed',
      isOk: result.success,
    };
  }
}
