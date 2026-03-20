import fs from 'fs-extra';
import path from 'node:path';
import type {InstallModeTag, ResourceDefinition, ResourceManifest} from '../resources/types';
import {
  BasePlatformAdapter,
  type CompatibilityClassification,
  type EnvironmentDetection,
  type InstallExecutionDetails,
  type InstallPlan,
  type PlatformAdapterContext,
  type PlatformOperationResult,
  type PostInstallValidationDetails,
  type ResetExecutionDetails,
  type ValidationCheck,
} from './base';

export class MacOSAdapter extends BasePlatformAdapter {
  protected readonly platform = 'macos' as const;

  private readonly componentNode = 'node';
  private readonly componentRuntime = 'runtime';
  private readonly componentGateway = 'gateway-bundle';

  async detectEnvironment(): Promise<EnvironmentDetection> {
    const platformInfo = await this.getPlatformInfo();
    const blockers: string[] = [];
    const warnings: string[] = [];
    const isMacHost = process.platform === 'darwin';

    let rosettaDetected = false;
    let codeSigningReady = false;

    if (isMacHost) {
      const [rosettaResult, codesignResult] = await Promise.all([
        this.commandService.runCommand('sysctl', ['-n', 'sysctl.proc_translated'], {source: 'platform', timeoutMs: 5000}),
        this.commandService.runCommand('xcode-select', ['-p'], {source: 'platform', timeoutMs: 5000}),
      ]);
      rosettaDetected = rosettaResult.success && rosettaResult.stdout.trim() === '1';
      codeSigningReady = codesignResult.success;
    } else {
      blockers.push('Current host is not macOS, so macOS adapter cannot perform native runtime actions.');
    }

    if (isMacHost && !codeSigningReady) warnings.push('Xcode command line tools not detected; signing/notarization steps stay unavailable.');

    const summary = isMacHost
      ? `macOS adapter detected ${platformInfo.arch} host; Rosetta=${rosettaDetected ? 'yes' : 'no'}.`
      : 'macOS adapter loaded on a non-macOS host.';

    await this.logService.info(summary, 'platform');

    return {
      platformInfo,
      supported: isMacHost,
      summary,
      facts: {
        isMacHost,
        rosettaDetected,
        codeSigningReady,
        darwinRelease: platformInfo.osRelease,
      },
      blockers,
      warnings,
    };
  }

  async classifyCompatibility(environment?: EnvironmentDetection): Promise<CompatibilityClassification> {
    const env = environment ?? (await this.detectEnvironment());
    const blockers = [...env.blockers];
    const reasons = [...env.warnings];
    let level: CompatibilityClassification['level'] = 'unsupported';

    if (env.supported) {
      level = env.platformInfo.arch === 'arm64' ? 'native' : 'compatible';
      if (env.platformInfo.arch === 'x64') {
        reasons.push('Intel macOS is treated as compatible until runtime packaging is fully validated.');
      }
    }

    return {
      platform: env.platformInfo.platform,
      arch: env.platformInfo.arch,
      level,
      blockers,
      reasons,
      recommendedModes: level === 'unsupported' ? ['core'] : ['full', 'core', 'online-bootstrap', 'importable'],
    };
  }

  async planInstall(context: PlatformAdapterContext): Promise<InstallPlan> {
    const environment = await this.detectEnvironment();
    const compatibility = await this.classifyCompatibility(environment);
    const manifest = context.manifest ?? (await context.resourceManager.loadManifest());
    const mode = context.preferredMode && compatibility.recommendedModes.includes(context.preferredMode)
      ? context.preferredMode
      : compatibility.recommendedModes[0] ?? 'core';
    const resolved = await context.resourceManager.resolveResources({mode, platform: 'macos', arch: environment.platformInfo.arch});
    await this.logService.info(`InstallPlan resources: ${resolved.resources.length}`, 'platform');
    await this.logService.info(`Resource IDs: ${resolved.resources.map((resource) => resource.id).join(', ') || '(none)'}`, 'platform');
    if (resolved.resources.length === 0) {
      await this.logService.error(
        `InstallPlan resource resolution returned 0 resources for macos/${environment.platformInfo.arch}/${mode}. bundle=${resolved.bundle?.id ?? 'none'}, manifest=${manifest.productVersion}`,
        'platform',
      );
    }
    const nodeResource = this.findResource(resolved.resources, 'node');
    const runtimeResource = this.findResource(resolved.resources, 'runtime');
    const gatewayResource = this.findResource(resolved.resources, 'gateway-bundle');
    const warnings = [...compatibility.reasons];
    const blockers = [...compatibility.blockers, ...resolved.missingDependencies.map((dependency) => `Missing dependency: ${dependency}`)];
    const reusableComponents: string[] = [];
    const repairableComponents: string[] = [];
    const missingButOptionalResources: string[] = [];
    const existingAndValid: string[] = [];
    const existingButInvalid: string[] = [];
    const missing: string[] = [];
    const runtimeState = await this.inspectRuntimeState(nodeResource, runtimeResource, gatewayResource);

    if (runtimeState.node.exists) {
      if (runtimeState.node.valid) {
        existingAndValid.push(this.componentNode);
        reusableComponents.push(this.componentNode);
        await this.logService.info(`macOS install plan: reusing system node (${runtimeState.node.detail}).`, 'platform');
      } else {
        existingButInvalid.push(this.componentNode);
        repairableComponents.push(this.componentNode);
        warnings.push(`System Node exists but does not meet requirements (${runtimeState.node.detail}); repair/reinstall may be needed.`);
      }
      if (!nodeResource) warnings.push('Node offline package is absent, but system Node already exists so the Node resource requirement is skipped.');
      else missingButOptionalResources.push(nodeResource.id);
    } else {
      missing.push(this.componentNode);
      if (!nodeResource) {
        blockers.push('System Node is unavailable and no macOS Node resource was resolved.');
      } else {
        await this.logService.info('macOS install plan: system node missing; offline Node resource will be used for install/repair.', 'platform');
      }
    }

    if (runtimeState.runtime.exists) {
      if (runtimeState.runtime.valid) existingAndValid.push(this.componentRuntime);
      else existingButInvalid.push(this.componentRuntime);
      reusableComponents.push(this.componentRuntime);
      repairableComponents.push(this.componentRuntime);
      await this.logService.info(`macOS install plan: existing runtime will be reused (${runtimeState.runtime.detail}).`, 'platform');
      if (!runtimeResource) warnings.push('Runtime package is absent, but an existing runtime can be validated/repaired and reused.');
      else missingButOptionalResources.push(runtimeResource.id);
    } else {
      missing.push(this.componentRuntime);
      if (!runtimeResource) blockers.push('No runtime resource is available and no existing runtime directory can be reused.');
    }

    if (runtimeState.gateway.exists) {
      if (runtimeState.gateway.valid) existingAndValid.push(this.componentGateway);
      else existingButInvalid.push(this.componentGateway);
      reusableComponents.push(this.componentGateway);
      repairableComponents.push(this.componentGateway);
      await this.logService.info(`macOS install plan: existing gateway assets will be reused (${runtimeState.gateway.detail}).`, 'platform');
      if (!gatewayResource) warnings.push('Gateway bundle is absent, but an existing gateway directory can be validated/repaired and reused.');
      else missingButOptionalResources.push(gatewayResource.id);
    } else {
      missing.push(this.componentGateway);
      if (!gatewayResource) blockers.push('No gateway bundle is available and no existing gateway directory can be reused.');
    }

    const plan: InstallPlan = {
      platform: 'macos',
      arch: environment.platformInfo.arch,
      mode,
      summary: this.buildSummary(manifest, mode, compatibility.level),
      selectedBundleId: resolved.bundle?.id,
      resourceIds: resolved.resources.map((resource) => resource.id),
      requiresAdmin: false,
      requiresNetwork: resolved.resources.some((resource) => (resource.sources ?? []).some((source) => source.type !== 'local-import')),
      existingAndValid,
      existingButInvalid,
      missing,
      blockers,
      warnings,
      reusableComponents,
      repairableComponents,
      missingButOptionalResources,
      steps: [
        {id: 'resolve-manifest', title: 'Resolve macOS resource bundle', status: 'completed'},
        {id: 'prepare-runtime', title: 'Prepare native macOS runtime assets', status: compatibility.level === 'unsupported' ? 'blocked' : 'ready'},
        {
          id: 'install-runtime',
          title: 'Install native runtime',
          status: compatibility.level === 'unsupported'
            ? 'blocked'
            : existingAndValid.includes(this.componentRuntime)
              ? 'completed'
              : repairableComponents.includes(this.componentRuntime)
                ? 'ready'
                : 'ready',
          notes: existingAndValid.includes(this.componentRuntime)
            ? ['Existing runtime detected; install will be skipped in favor of validate/run.']
            : repairableComponents.includes(this.componentRuntime)
              ? ['Existing runtime detected but requires validate/repair before reuse.']
              : ['No reusable runtime detected; fresh install/deploy path will be used.'],
        },
      ],
    };

    this.setPreparedInstallState({context, manifest, resolved, plan});
    return plan;
  }

  async installRuntime(plan: InstallPlan): Promise<PlatformOperationResult> {
    const prepared = this.getPreparedInstallState(plan);
    if (!prepared) {
      return this.buildInstallFailure(plan, 'installRuntime requires a prepared plan from planInstall().', {executedSteps: []});
    }

    const executedSteps = [];
    const environment = await this.detectEnvironment();
    const compatibility = await this.classifyCompatibility(environment);
    if (compatibility.level === 'unsupported') {
      return this.buildInstallFailure(plan, 'macOS adapter is not running on a supported macOS host.', {
        executedSteps,
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }

    const localManifest = await prepared.context.localImportManager.loadLocalManifest().catch(() => null);
    if (localManifest) {
      const localCompatibility = prepared.context.localImportManager.validatePlatformArch(localManifest.manifest, 'macos', plan.arch);
      executedSteps.push(this.createStep('scan-local-import', localCompatibility.compatible, localCompatibility.reason));
      if (localCompatibility.compatible) {
        await prepared.context.localImportManager.importIntoCacheIndex(localManifest.resources, path.dirname(localManifest.manifestPath));
      }
    } else {
      executedSteps.push(this.createStep('scan-local-import', true, 'No local import manifest found; continuing with cache only.'));
    }

    const missingResources = await prepared.context.resourceManager.getMissingResources(prepared.resolved.resources);
    const blockingMissingResources = missingResources.filter((resource) => !(plan.missingButOptionalResources ?? []).includes(resource.id));
    if (blockingMissingResources.length > 0) {
      return this.buildInstallFailure(plan, 'Required macOS resources are missing from cache/import bundle.', {
        executedSteps,
        missingResources: this.summarizeMissingResources(blockingMissingResources),
        unresolvedDependencies: prepared.resolved.missingDependencies,
        suggestedModeChange: this.suggestFallbackMode(plan.mode),
      });
    }

    const nodeResource = this.findResource(prepared.resolved.resources, 'node');
    const runtimeResource = this.findResource(prepared.resolved.resources, 'runtime');
    const gatewayResource = this.findResource(prepared.resolved.resources, 'gateway-bundle');
    const systemNodeReusable = (plan.reusableComponents ?? []).includes(this.componentNode);
    const runtimeReusable = (plan.reusableComponents ?? []).includes(this.componentRuntime);
    const gatewayReusable = (plan.reusableComponents ?? []).includes(this.componentGateway);
    if (!nodeResource && !systemNodeReusable) {
      return this.buildInstallFailure(plan, 'macOS install plan is missing required node/runtime/gateway resources.', {
        executedSteps,
        missingResources: ['node'],
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }
    if (!runtimeResource && !runtimeReusable) {
      return this.buildInstallFailure(plan, 'macOS install plan is missing required node/runtime/gateway resources.', {
        executedSteps,
        missingResources: ['runtime'],
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }
    if (!gatewayResource && !gatewayReusable) {
      return this.buildInstallFailure(plan, 'macOS install plan is missing required node/runtime/gateway resources.', {
        executedSteps,
        missingResources: ['gateway-bundle'],
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }

    await this.ensureDirectories([
      this.options.paths.runtimeRoot,
      this.options.paths.cacheRoot,
      this.options.paths.logsRoot,
      this.options.paths.workspacePath,
    ]);
    executedSteps.push(this.createStep('prepare-directories', true, `Prepared ${this.options.paths.runtimeRoot}`));
    if (nodeResource) executedSteps.push(await this.installNodeArchive(nodeResource));
    else executedSteps.push(this.createStep('install-node', systemNodeReusable, systemNodeReusable ? 'System Node already available; skipped offline Node install because system Node is being reused.' : 'Node resource unavailable.'));
    if (runtimeResource) executedSteps.push(await this.extractArchiveResource(runtimeResource, path.join(this.options.paths.runtimeRoot, 'runtime'), 'deploy-runtime'));
    else executedSteps.push(this.createStep('deploy-runtime', runtimeReusable, runtimeReusable ? 'Existing runtime directory detected; switching to validate/repair path.' : 'Runtime resource unavailable.'));
    if (gatewayResource) executedSteps.push(await this.extractArchiveResource(gatewayResource, path.join(this.options.paths.runtimeRoot, 'gateway'), 'deploy-gateway'));
    else executedSteps.push(this.createStep('deploy-gateway', gatewayReusable, gatewayReusable ? 'Existing gateway directory detected; switching to validate/repair path.' : 'Gateway bundle unavailable.'));

    const validation = await this.validateMacInstall(prepared.resolved.resources, plan);
    const details: InstallExecutionDetails = {
      plan,
      missingResources: [],
      unresolvedDependencies: prepared.resolved.missingDependencies,
      executedSteps,
      validation,
      suggestedModeChange: validation.passed ? undefined : this.suggestFallbackMode(plan.mode),
    };

    if (!validation.passed) {
      return {
        success: false,
        status: 'implemented',
        error: 'macOS install chain executed deployment steps but post-install validation did not pass.',
        details: details as unknown as Record<string, unknown>,
      };
    }

    return {
      success: true,
      status: 'implemented',
      result: 'macOS runtime install/validation chain completed.',
      details: details as unknown as Record<string, unknown>,
    };
  }

  async validatePostInstall(plan: InstallPlan): Promise<PlatformOperationResult> {
    const prepared = this.getPreparedInstallState(plan);
    const validation = await this.validateMacInstall(prepared?.resolved.resources ?? [], plan);
    return {
      success: validation.passed,
      status: 'implemented',
      result: validation.passed ? 'macOS post-install validation passed.' : undefined,
      error: validation.passed ? undefined : 'macOS post-install validation failed.',
      details: validation as unknown as Record<string, unknown>,
    };
  }

  async startGateway(): Promise<PlatformOperationResult> {
    const prepared = this.getPreparedInstallState();
    if (!prepared) {
      return {success: false, status: 'implemented', error: 'startGateway requires a prepared install plan.'};
    }

    const existing = this.getGatewayDetails();
    if (existing.running) {
      return {success: true, status: 'implemented', result: 'Gateway already running.', details: existing as unknown as Record<string, unknown>};
    }

    const gatewayResource = this.findResource(prepared.resolved.resources, 'gateway-bundle');
    if (!gatewayResource) {
      return {
        success: false,
        status: 'implemented',
        error: 'OpenClaw 运行时已就绪，Gateway 启动资源尚未配置。',
        details: {
          ...this.getGatewayDetails(),
          runtimeReady: true,
          gatewayBundleReady: false,
          gatewayEntrypointReady: false,
          gatewaySpawnable: false,
          degradedButUsable: true,
        },
      };
    }

    const gatewayEntry = await this.prepareGatewayEntry(gatewayResource);
    if (!gatewayEntry) {
      return {
        success: false,
        status: 'implemented',
        error: '已检测到 Gateway 目录，但未找到可启动入口文件。',
        details: {
          ...this.getGatewayDetails(),
          runtimeReady: true,
          gatewayBundleReady: true,
          gatewayEntrypointReady: false,
          gatewaySpawnable: false,
          degradedButUsable: true,
        },
      };
    }

    const child = await this.commandService.startManagedProcess(gatewayEntry.command, gatewayEntry.args, {
      cwd: gatewayEntry.workingDirectory,
      source: 'gateway',
      env: process.env,
    });
    this.trackGatewayProcess(child, gatewayEntry.entryPoint, gatewayEntry.workingDirectory);
    await this.logService.success(`macOS gateway started with pid ${child.pid ?? 'unknown'}`, 'gateway');

    return {
      success: Boolean(child.pid),
      status: 'implemented',
      result: child.pid ? 'macOS gateway started.' : undefined,
      error: child.pid ? undefined : 'Gateway process spawned without a pid.',
      details: this.getGatewayDetails() as unknown as Record<string, unknown>,
    };
  }

  async stopGateway(): Promise<PlatformOperationResult> {
    const details = await this.stopTrackedGateway(this.getGatewayDetails().pid ? {command: 'kill', args: ['-9', String(this.getGatewayDetails().pid)]} : undefined);
    return {
      success: details.stopped,
      status: 'implemented',
      result: details.stopped ? 'macOS gateway stopped.' : undefined,
      error: details.stopped ? undefined : details.detail,
      details: {...this.getGatewayDetails(), detail: details.detail} as unknown as Record<string, unknown>,
    };
  }

  async resetRuntime(): Promise<PlatformOperationResult> {
    const steps = [];
    const removedPaths: string[] = [];
    const skippedPaths: string[] = [];
    const warnings: string[] = [];

    const stopGatewayResult = await this.stopGateway();
    steps.push(this.createStep('stop-gateway', stopGatewayResult.success, stopGatewayResult.error || stopGatewayResult.result || 'Gateway stop requested.'));

    const pkill = await this.commandService.runCommand('pkill', ['-f', this.options.paths.runtimeRoot], {source: 'platform', timeoutMs: 10000});
    steps.push(this.createStep('stop-processes', pkill.success, pkill.success ? `Stopped processes under ${this.options.paths.runtimeRoot}` : (pkill.stderr || pkill.stdout || 'No matching process stopped.')));

    for (const target of [this.options.paths.runtimeRoot, this.options.paths.cacheRoot, this.options.paths.logsRoot]) {
      if (!this.isSafeManagedPath(target)) {
        warnings.push(`Blocked unsafe removal path: ${target}`);
        steps.push(this.createStep('remove-path', false, `Blocked unsafe path ${target}`));
        continue;
      }
      if (!(await fs.pathExists(target))) {
        skippedPaths.push(target);
        steps.push(this.createStep('remove-path', true, `${target} does not exist.`));
        continue;
      }
      await fs.remove(target);
      removedPaths.push(target);
      steps.push(this.createStep('remove-path', true, `Removed ${target}`));
      await this.logService.success(`Removed macOS runtime path: ${target}`, 'platform');
    }

    const details: ResetExecutionDetails = {removedPaths, skippedPaths, warnings, steps};
    return {
      success: warnings.length === 0,
      status: 'implemented',
      result: warnings.length === 0 ? 'macOS runtime reset completed.' : 'macOS runtime reset completed with warnings.',
      error: warnings.length > 0 ? warnings.join('; ') : undefined,
      details: details as unknown as Record<string, unknown>,
    };
  }

  private async installNodeArchive(nodeResource: ResourceDefinition) {
    const cachedNode = await this.getPreparedInstallState()?.context.cacheManager.getCachedFile(nodeResource);
    if (!cachedNode) return this.createStep('install-node', false, 'Node resource is not cached.');

    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    if (systemNode.success) return this.createStep('install-node', true, `System Node already available: ${systemNode.stdout.trim()}`);

    const managedNodeDir = path.join(this.options.paths.runtimeRoot, 'node');
    await fs.ensureDir(managedNodeDir);
    const lower = cachedNode.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const extract = await this.commandService.runCommand('tar', ['-xzf', cachedNode, '-C', managedNodeDir], {source: 'platform', timeoutMs: 10 * 60 * 1000});
      const nodeBinary = await this.findManagedNodeBinary(managedNodeDir);
      return this.createStep('install-node', extract.success && Boolean(nodeBinary), nodeBinary ? `Managed Node extracted to ${nodeBinary}` : (extract.stderr || extract.stdout || 'Node extraction failed.'));
    }
    if (lower.endsWith('.pkg') || lower.endsWith('.dmg')) {
      return this.createStep('install-node', false, `Prepared macOS Node installer at ${cachedNode}, but pkg/dmg installation is intentionally not auto-applied in this round.`);
    }
    return this.createStep('install-node', false, `Unsupported Node package for macOS skeleton install: ${cachedNode}`);
  }

  private async extractArchiveResource(resource: ResourceDefinition, targetDir: string, stepId: string) {
    const cachedPath = await this.getPreparedInstallState()?.context.cacheManager.getCachedFile(resource);
    if (!cachedPath) return this.createStep(stepId, false, `${resource.id} is not cached.`);

    await fs.ensureDir(targetDir);
    const lower = cachedPath.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const extract = await this.commandService.runCommand('tar', ['-xzf', cachedPath, '-C', targetDir], {source: 'platform', timeoutMs: 10 * 60 * 1000});
      return this.createStep(stepId, extract.success, extract.success ? `Extracted ${resource.id} to ${targetDir}` : (extract.stderr || extract.stdout || `Extraction failed for ${resource.id}`));
    }
    if (lower.endsWith('.zip')) {
      const extract = await this.commandService.runCommand('unzip', ['-o', cachedPath, '-d', targetDir], {source: 'platform', timeoutMs: 10 * 60 * 1000});
      return this.createStep(stepId, extract.success, extract.success ? `Extracted ${resource.id} to ${targetDir}` : (extract.stderr || extract.stdout || `Extraction failed for ${resource.id}`));
    }
    return this.createStep(stepId, false, `Unsupported archive format for ${resource.id}: ${cachedPath}`);
  }

  private async prepareGatewayEntry(gatewayResource: ResourceDefinition) {
    const prepared = this.getPreparedInstallState();
    const gatewayRoot = this.options.gatewayWorkingDirectory ?? path.join(this.options.paths.runtimeRoot, 'gateway');
    await fs.ensureDir(gatewayRoot);
    const cachedBundle = prepared ? await prepared.context.cacheManager.getCachedFile(gatewayResource) : null;
    if (cachedBundle && !(await fs.pathExists(path.join(gatewayRoot, 'gateway')))) {
      await this.extractArchiveResource(gatewayResource, gatewayRoot, 'gateway-startup-extract');
    }

    const entryPoint = this.options.gatewayEntryPoint
      ?? (gatewayResource.installHints.executablePath ? path.join(gatewayRoot, gatewayResource.installHints.executablePath) : null)
      ?? path.join(gatewayRoot, 'gateway', 'server.js');

    if (!(await fs.pathExists(entryPoint))) {
      const fallback = path.join(gatewayRoot, 'server.js');
      if (await fs.pathExists(fallback)) return this.buildGatewayCommand(fallback, path.dirname(fallback));
      return null;
    }

    return this.buildGatewayCommand(entryPoint, path.dirname(entryPoint));
  }

  private async buildGatewayCommand(entryPoint: string, workingDirectory: string) {
    if (entryPoint.endsWith('.js')) {
      const nodeExecutable = await this.findManagedNodeBinary(path.join(this.options.paths.runtimeRoot, 'node')) ?? 'node';
      return {command: nodeExecutable, args: [entryPoint], entryPoint, workingDirectory};
    }
    return {command: entryPoint, args: [], entryPoint, workingDirectory};
  }

  private async validateMacInstall(resources: ResourceDefinition[], plan?: InstallPlan): Promise<PostInstallValidationDetails> {
    const checks: ValidationCheck[] = [];
    const warnings: string[] = [];
    const blockingIssues: string[] = [];

    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    const managedNode = await this.findManagedNodeBinary(path.join(this.options.paths.runtimeRoot, 'node'));
    checks.push({id: 'node-available', title: 'Node available', passed: systemNode.success || Boolean(managedNode), detail: systemNode.success ? systemNode.stdout.trim() : managedNode ? `managed:${managedNode}` : 'Node not detected.', blocking: true});
    checks.push({id: 'runtime-dir', title: 'Runtime directory exists', passed: await fs.pathExists(path.join(this.options.paths.runtimeRoot, 'runtime')), detail: path.join(this.options.paths.runtimeRoot, 'runtime'), blocking: true});
    checks.push({id: 'gateway-dir', title: 'Gateway directory exists', passed: await fs.pathExists(path.join(this.options.paths.runtimeRoot, 'gateway')), detail: path.join(this.options.paths.runtimeRoot, 'gateway'), blocking: true});

    const logProbeFile = path.join(this.options.paths.logsRoot, '.write-test');
    try {
      await fs.ensureDir(this.options.paths.logsRoot);
      await fs.writeFile(logProbeFile, 'ok');
      await fs.remove(logProbeFile);
      checks.push({id: 'logs-writable', title: 'Logs directory writable', passed: true, detail: this.options.paths.logsRoot, blocking: true});
    } catch (error) {
      checks.push({id: 'logs-writable', title: 'Logs directory writable', passed: false, detail: error instanceof Error ? error.message : String(error), blocking: true});
    }

    for (const resource of resources) {
      const resourcePath = path.join(this.options.paths.cacheRoot, resource.relativePath);
      const exists = await fs.pathExists(resourcePath);
      const optionalByPlan = Boolean(plan?.missingButOptionalResources?.includes(resource.id));
      checks.push({id: `resource-${resource.id}`, title: `Resource ${resource.id}`, passed: exists, detail: resourcePath, blocking: !resource.optional && !optionalByPlan});
    }

    const gateway = this.getGatewayDetails();
    checks.push({id: 'gateway-process', title: 'Gateway process running', passed: gateway.running, detail: gateway.running ? `pid=${gateway.pid}` : 'Gateway not running.', blocking: false});

    for (const check of checks) {
      if (!check.passed && check.blocking) blockingIssues.push(`${check.title}: ${check.detail}`);
      if (!check.passed && !check.blocking) warnings.push(`${check.title}: ${check.detail}`);
    }

    return {passed: blockingIssues.length === 0, checks, warnings, blockingIssues};
  }

  private async findManagedNodeBinary(root: string) {
    if (!(await fs.pathExists(root))) return null;
    const direct = path.join(root, 'bin', 'node');
    if (await fs.pathExists(direct)) return direct;
    const children = await fs.readdir(root).catch(() => []);
    for (const child of children) {
      const candidate = path.join(root, child, 'bin', 'node');
      if (await fs.pathExists(candidate)) return candidate;
    }
    return null;
  }

  private findResource(resources: ResourceDefinition[], type: ResourceDefinition['resourceType']) {
    return resources.find((resource) => resource.resourceType === type);
  }

  private suggestFallbackMode(mode: InstallModeTag) {
    return mode === 'full' || mode === 'importable' ? 'core' : 'online-bootstrap';
  }

  private buildSummary(manifest: ResourceManifest, mode: string, level: string) {
    return `macOS install plan (${mode}) built from manifest ${manifest.productVersion} with compatibility=${level}.`;
  }

  private async inspectRuntimeState(
    nodeResource: ResourceDefinition | undefined,
    runtimeResource: ResourceDefinition | undefined,
    gatewayResource: ResourceDefinition | undefined,
  ) {
    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    const nodeVersion = this.extractNodeVersion(systemNode.stdout || systemNode.stderr);
    const nodeMajor = nodeVersion ? Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10) : 0;
    const runtimeDir = path.join(this.options.paths.runtimeRoot, 'runtime');
    const gatewayDir = path.join(this.options.paths.runtimeRoot, 'gateway');
    const runtimeDirExists = await fs.pathExists(runtimeDir);
    const gatewayDirExists = await fs.pathExists(gatewayDir);
    const runtimePayloadAvailable = await this.hasLocalResourcePayload(runtimeResource);
    const gatewayPayloadAvailable = await this.hasLocalResourcePayload(gatewayResource);

    return {
      node: {
        exists: systemNode.success,
        valid: systemNode.success && nodeMajor >= 22,
        detail: systemNode.success ? (nodeVersion ? `version=${nodeVersion}` : systemNode.stdout.trim()) : 'not detected',
        payloadAvailable: Boolean(nodeResource),
      },
      runtime: {
        exists: runtimeDirExists || runtimePayloadAvailable,
        valid: runtimeDirExists,
        detail: runtimeDirExists ? `Runtime directory detected at ${runtimeDir}.` : runtimePayloadAvailable ? 'Runtime payload detected for deployment.' : 'Runtime not detected.',
      },
      gateway: {
        exists: gatewayDirExists || gatewayPayloadAvailable,
        valid: gatewayDirExists,
        detail: gatewayDirExists ? `Gateway directory detected at ${gatewayDir}.` : gatewayPayloadAvailable ? 'Gateway payload detected for deployment.' : 'Gateway assets not detected.',
      },
    };
  }

  private extractNodeVersion(output: string) {
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  }

  private async hasLocalResourcePayload(resource: ResourceDefinition | undefined) {
    if (!resource) return false;
    const prepared = this.getPreparedInstallState();
    const cached = prepared ? await prepared.context.cacheManager.getCachedFile(resource) : null;
    if (cached && await fs.pathExists(cached)) return true;
    return fs.pathExists(path.join(this.options.paths.offlineResourcesRoot, resource.relativePath));
  }
}
