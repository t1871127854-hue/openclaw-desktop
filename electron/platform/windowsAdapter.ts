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

export class WindowsAdapter extends BasePlatformAdapter {
  protected readonly platform = 'windows' as const;

  async detectEnvironment(): Promise<EnvironmentDetection> {
    const platformInfo = await this.getPlatformInfo();
    const blockers: string[] = [];
    const warnings: string[] = [];
    const isWindowsHost = process.platform === 'win32';

    let wslAvailable = false;
    let powershellAvailable = false;

    if (isWindowsHost) {
      const [wslResult, powershellResult] = await Promise.all([
        this.commandService.runCommand('where', ['wsl.exe'], {source: 'platform', timeoutMs: 5000}),
        this.commandService.runCommand('where', ['powershell.exe'], {source: 'platform', timeoutMs: 5000}),
      ]);
      wslAvailable = wslResult.success && Boolean(wslResult.stdout.trim());
      powershellAvailable = powershellResult.success && Boolean(powershellResult.stdout.trim());
    } else {
      blockers.push('Current host is not Windows, so Windows adapter cannot perform native runtime actions.');
    }

    if (!powershellAvailable && isWindowsHost) warnings.push('powershell.exe not found in PATH.');
    if (!wslAvailable && isWindowsHost) warnings.push('wsl.exe not found; Windows runtime import remains unavailable.');

    const summary = isWindowsHost
      ? `Windows adapter detected ${platformInfo.arch} host; WSL=${wslAvailable ? 'yes' : 'no'}.`
      : 'Windows adapter loaded on a non-Windows host.';

    await this.logService.info(summary, 'platform');

    return {
      platformInfo,
      supported: isWindowsHost,
      summary,
      facts: {
        isWindowsHost,
        powershellAvailable,
        wslAvailable,
        windowsRelease: platformInfo.osRelease,
      },
      blockers,
      warnings,
    };
  }

  async classifyCompatibility(environment?: EnvironmentDetection): Promise<CompatibilityClassification> {
    const env = environment ?? (await this.detectEnvironment());
    const blockers = [...env.blockers];
    const reasons = [...env.warnings];
    const wslAvailable = Boolean(env.facts.wslAvailable);
    const level = !env.supported ? 'unsupported' : wslAvailable ? 'native' : 'compatible';

    if (env.supported && !wslAvailable) {
      reasons.push('Windows host is usable for core/bootstrap flows, but full runtime import is gated on WSL.');
    }

    return {
      platform: env.platformInfo.platform,
      arch: env.platformInfo.arch,
      level,
      blockers,
      reasons,
      recommendedModes: level === 'native' ? ['full', 'core', 'online-bootstrap', 'importable'] : ['core', 'online-bootstrap'],
    };
  }

  async planInstall(context: PlatformAdapterContext): Promise<InstallPlan> {
    const environment = await this.detectEnvironment();
    const compatibility = await this.classifyCompatibility(environment);
    const manifest = context.manifest ?? (await context.resourceManager.loadManifest());
    const mode = context.preferredMode && compatibility.recommendedModes.includes(context.preferredMode)
      ? context.preferredMode
      : compatibility.recommendedModes[0] ?? 'core';
    const resolved = await context.resourceManager.resolveResources({mode, platform: 'windows', arch: environment.platformInfo.arch});
    const nodeResource = this.findResource(resolved.resources, 'node');
    const runtimeResource = this.findResource(resolved.resources, 'runtime');
    const rootfsResource = this.findResource(resolved.resources, 'rootfs');
    const gatewayResource = this.findResource(resolved.resources, 'gateway-bundle');
    const warnings = [...compatibility.reasons];
    const blockers = [...compatibility.blockers, ...resolved.missingDependencies.map((dependency) => `Missing dependency: ${dependency}`)];
    const reusableComponents: string[] = [];
    const repairableComponents: string[] = [];
    const missingButOptionalResources: string[] = [];
    const distroName = this.options.distroName ?? 'OpenClaw-Runtime';
    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    const runtimeDirExists = await fs.pathExists(path.join(this.options.paths.runtimeRoot, 'runtime'));
    const gatewayDirExists = await fs.pathExists(path.join(this.options.paths.runtimeRoot, 'gateway'));
    const distroList = await this.commandService.runCommand('wsl.exe', ['-l', '-v'], {source: 'platform', timeoutMs: 15000});
    const distroLines = distroList.success ? distroList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    const distroExists = distroLines.some((line) => line.includes(distroName));
    const defaultDistroExists = distroLines.some((line) => line.startsWith('*'));

    if (systemNode.success) {
      reusableComponents.push('node');
      if (!nodeResource) warnings.push('System Node is already available; offline Node package is not required for this install plan.');
      if (nodeResource) missingButOptionalResources.push(nodeResource.id);
    } else if (!nodeResource) {
      blockers.push('System Node is unavailable and no offline Node resource was resolved.');
    }

    if (distroExists || runtimeDirExists) {
      reusableComponents.push('runtime');
      repairableComponents.push('runtime');
      if (!(runtimeResource || rootfsResource)) {
        warnings.push('Existing runtime/distro detected; runtime package is missing but validation/repair can continue.');
      }
      if (runtimeResource) missingButOptionalResources.push(runtimeResource.id);
      if (rootfsResource) missingButOptionalResources.push(rootfsResource.id);
    } else if (!(runtimeResource || rootfsResource)) {
      blockers.push('No runtime/rootfs resource is available and no existing runtime can be reused.');
    }

    if (gatewayDirExists) {
      reusableComponents.push('gateway-bundle');
      repairableComponents.push('gateway-bundle');
      if (gatewayResource) missingButOptionalResources.push(gatewayResource.id);
      else warnings.push('Existing gateway directory detected; gateway bundle resource can be treated as optional for validate/repair.');
    }

    if (!defaultDistroExists && distroExists) {
      warnings.push('WSL is enabled and OpenClaw-Runtime exists, but no default distro is configured; this is treated as a warning only.');
    }

    const plan: InstallPlan = {
      platform: 'windows',
      arch: environment.platformInfo.arch,
      mode,
      summary: this.buildSummary(manifest, mode, compatibility.level),
      selectedBundleId: resolved.bundle?.id,
      resourceIds: resolved.resources.map((resource) => resource.id),
      requiresAdmin: mode === 'full' || mode === 'importable',
      requiresNetwork: resolved.resources.some((resource) => resource.sources.some((source) => source.type !== 'local-import')),
      blockers,
      warnings,
      reusableComponents,
      repairableComponents,
      missingButOptionalResources,
      steps: [
        {id: 'resolve-manifest', title: 'Resolve Windows resource bundle', status: 'completed'},
        {id: 'prepare-runtime', title: 'Prepare Windows runtime assets', status: compatibility.level === 'unsupported' ? 'blocked' : 'ready'},
        {id: 'install-runtime', title: 'Install/import runtime', status: compatibility.level === 'unsupported' ? 'blocked' : repairableComponents.includes('runtime') ? 'completed' : 'ready'},
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
      return this.buildInstallFailure(plan, 'Windows adapter is not running on a supported Windows host.', {
        executedSteps,
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }

    const isAdmin = await this.isAdmin();
    executedSteps.push(this.createStep('check-admin', !plan.requiresAdmin || isAdmin, `requiresAdmin=${plan.requiresAdmin}, isAdmin=${isAdmin}`));
    if (plan.requiresAdmin && !isAdmin) {
      return this.buildInstallFailure(plan, 'Administrator privileges are required for the selected Windows install mode.', {
        executedSteps,
        unresolvedDependencies: prepared.resolved.missingDependencies,
        suggestedModeChange: 'core',
      });
    }

    const localManifest = await prepared.context.localImportManager.loadLocalManifest().catch(() => null);
    if (localManifest) {
      const localCompatibility = prepared.context.localImportManager.validatePlatformArch(localManifest.manifest, 'windows', plan.arch);
      executedSteps.push(this.createStep('scan-local-import', localCompatibility.compatible, localCompatibility.reason));
      if (localCompatibility.compatible) {
        await prepared.context.localImportManager.importIntoCacheIndex(localManifest.resources, path.dirname(localManifest.manifestPath));
      }
    } else {
      executedSteps.push(this.createStep('scan-local-import', true, 'No local import manifest found; continuing with cache only.'));
    }

    const missingResources = await prepared.context.resourceManager.getMissingResources(prepared.resolved.resources);
    const blockingMissingResources = missingResources.filter((resource) => !plan.missingButOptionalResources.includes(resource.id));
    if (blockingMissingResources.length > 0) {
      await this.logService.warn(`Windows install blocked by missing resources: ${this.summarizeMissingResources(missingResources).join(', ')}`, 'platform');
      return this.buildInstallFailure(plan, 'Required Windows resources are missing from cache/import bundle.', {
        executedSteps,
        missingResources: this.summarizeMissingResources(blockingMissingResources),
        unresolvedDependencies: prepared.resolved.missingDependencies,
        suggestedModeChange: this.suggestFallbackMode(plan.mode),
      });
    }

    const nodeResource = this.findResource(prepared.resolved.resources, 'node');
    const runtimeResource = this.findResource(prepared.resolved.resources, 'runtime');
    const rootfsResource = this.findResource(prepared.resolved.resources, 'rootfs');
    const gatewayResource = this.findResource(prepared.resolved.resources, 'gateway-bundle');

    const systemNodeReusable = plan.reusableComponents.includes('node');
    const runtimeReusable = plan.reusableComponents.includes('runtime');

    if (!nodeResource && !systemNodeReusable) {
      return this.buildInstallFailure(plan, 'Windows install plan is missing required node/runtime resources.', {
        executedSteps,
        missingResources: ['node'],
        unresolvedDependencies: prepared.resolved.missingDependencies,
      });
    }

    if (!(runtimeResource || rootfsResource) && !runtimeReusable) {
      return this.buildInstallFailure(plan, 'Windows install plan is missing required node/runtime resources.', {
        executedSteps,
        missingResources: ['runtime/rootfs'],
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
    if (nodeResource) {
      executedSteps.push(await this.installNodeResource(nodeResource));
    } else {
      executedSteps.push(this.createStep('install-node', systemNodeReusable, systemNodeReusable ? 'System Node already available; skipped offline Node install.' : 'Node resource unavailable.'));
    }

    const rootfsPath = rootfsResource ? await prepared.context.cacheManager.getCachedFile(rootfsResource) : null;
    const runtimePath = runtimeResource ? await prepared.context.cacheManager.getCachedFile(runtimeResource) : null;
    const runtimeSourcePath = rootfsPath ?? runtimePath;
    const runtimeTarget = path.join(this.options.paths.runtimeRoot, 'runtime');
    await fs.ensureDir(runtimeTarget);
    executedSteps.push(this.createStep('prepare-runtime-target', true, runtimeTarget));

    const wslStatus = await this.commandService.runCommand('wsl.exe', ['--status'], {source: 'platform', timeoutMs: 15000});
    const wslReady = wslStatus.success;
    executedSteps.push(this.createStep('wsl-preflight', wslReady, wslReady ? 'WSL status command succeeded.' : (wslStatus.stderr || wslStatus.stdout || 'WSL unavailable')));

    const importInstallDir = path.join(this.options.paths.runtimeRoot, 'distros', this.options.distroName ?? 'OpenClaw-Runtime');
    await fs.ensureDir(importInstallDir);
    const importCommand = ['--import', this.options.distroName ?? 'OpenClaw-Runtime', importInstallDir, runtimeSourcePath ?? '', '--version', '2'];
    executedSteps.push(this.createStep('assemble-import-command', Boolean(runtimeSourcePath), `wsl.exe ${importCommand.filter(Boolean).join(' ')}`));

    const preImport = await this.commandService.runCommand('wsl.exe', ['-l', '-q'], {source: 'platform', timeoutMs: 15000});
    const distroName = this.options.distroName ?? 'OpenClaw-Runtime';
    const distroAlreadyExists = preImport.success && preImport.stdout.split(/\r?\n/).map((line) => line.trim()).includes(distroName);
    const runtimeDirExists = await fs.pathExists(runtimeTarget);
    executedSteps.push(this.createStep('pre-import-distro-check', !distroAlreadyExists, distroAlreadyExists ? `${distroName} already registered.` : `${distroName} not registered yet.`));

    if (distroAlreadyExists || runtimeDirExists) {
      executedSteps.push(this.createStep('reuse-runtime', true, `Detected existing ${distroAlreadyExists ? 'WSL distro' : 'runtime directory'}; switching to validate/repair path.`));
      executedSteps.push(this.createStep('execute-import', true, 'Skipped import because an existing runtime can be reused and validated.'));
    } else if (runtimeSourcePath && wslReady && this.isSafeManagedPath(importInstallDir) && !distroAlreadyExists) {
      const importResult = await this.commandService.runCommand('wsl.exe', importCommand, {source: 'platform', timeoutMs: 15 * 60 * 1000});
      executedSteps.push(this.createStep('execute-import', importResult.success, importResult.success ? `Imported ${distroName}` : (importResult.stderr || importResult.stdout || 'wsl --import failed.')));
    } else {
      const reasons = [
        runtimeSourcePath ? null : 'runtime source missing',
        wslReady ? null : 'WSL unavailable',
        this.isSafeManagedPath(importInstallDir) ? null : 'unsafe install dir',
        !distroAlreadyExists ? null : 'distro already exists',
      ].filter(Boolean).join(', ');
      executedSteps.push(this.createStep('execute-import', false, `Import blocked: ${reasons}`));
    }

    const postImportList = await this.commandService.runCommand('wsl.exe', ['-l', '-v'], {source: 'platform', timeoutMs: 15000});
    const distroExistsAfter = postImportList.success && postImportList.stdout.split(/\r?\n/).some((line) => line.includes(distroName));
    executedSteps.push(this.createStep('post-import-readback', distroExistsAfter, distroExistsAfter ? `${distroName} visible in wsl -l -v` : (postImportList.stderr || postImportList.stdout || 'Distro not visible after import.')));
    executedSteps.push(this.createStep('post-import-dir-check', await fs.pathExists(importInstallDir), importInstallDir));

    if (gatewayResource) {
      const gatewayPath = await prepared.context.cacheManager.getCachedFile(gatewayResource);
      executedSteps.push(this.createStep('gateway-resource', Boolean(gatewayPath), gatewayPath ? gatewayPath : 'Gateway bundle not cached.'));
    }

    const validation = await this.validateWindowsInstall(prepared.resolved.resources, plan);
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
        error: 'Windows install chain executed preflight/import steps but post-install validation did not pass.',
        details: details as unknown as Record<string, unknown>,
      };
    }

    return {
      success: true,
      status: 'implemented',
      result: 'Windows runtime install/validation chain completed.',
      details: details as unknown as Record<string, unknown>,
    };
  }

  async validatePostInstall(plan: InstallPlan): Promise<PlatformOperationResult> {
    const prepared = this.getPreparedInstallState(plan);
    const validation = await this.validateWindowsInstall(prepared?.resolved.resources ?? [], plan);
    return {
      success: validation.passed,
      status: 'implemented',
      result: validation.passed ? 'Windows post-install validation passed.' : undefined,
      error: validation.passed ? undefined : 'Windows post-install validation failed.',
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
      return {success: false, status: 'implemented', error: 'Gateway bundle is not present in the prepared install state.'};
    }

    const gatewayEntry = await this.prepareGatewayEntry(gatewayResource);
    if (!gatewayEntry) {
      return {success: false, status: 'implemented', error: 'Unable to resolve Windows gateway startup entry.'};
    }

    const child = await this.commandService.startManagedProcess(gatewayEntry.command, gatewayEntry.args, {
      cwd: gatewayEntry.workingDirectory,
      source: 'gateway',
      env: process.env,
    });
    this.trackGatewayProcess(child, gatewayEntry.entryPoint, gatewayEntry.workingDirectory);
    await this.logService.success(`Windows gateway started with pid ${child.pid ?? 'unknown'}`, 'gateway');

    return {
      success: Boolean(child.pid),
      status: 'implemented',
      result: child.pid ? 'Windows gateway started.' : undefined,
      error: child.pid ? undefined : 'Gateway process spawned without a pid.',
      details: this.getGatewayDetails() as unknown as Record<string, unknown>,
    };
  }

  async stopGateway(): Promise<PlatformOperationResult> {
    const details = await this.stopTrackedGateway(this.getGatewayDetails().pid ? {command: 'taskkill', args: ['/PID', String(this.getGatewayDetails().pid), '/T', '/F']} : undefined);
    return {
      success: details.stopped,
      status: 'implemented',
      result: details.stopped ? 'Windows gateway stopped.' : undefined,
      error: details.stopped ? undefined : details.detail,
      details: {...this.getGatewayDetails(), detail: details.detail} as unknown as Record<string, unknown>,
    };
  }

  async resetRuntime(): Promise<PlatformOperationResult> {
    const steps = [];
    const removedPaths: string[] = [];
    const skippedPaths: string[] = [];
    const warnings: string[] = [];
    const distroName = this.options.distroName ?? 'OpenClaw-Runtime';

    const stopGatewayResult = await this.stopGateway();
    steps.push(this.createStep('stop-gateway', stopGatewayResult.success, stopGatewayResult.error || stopGatewayResult.result || 'Gateway stop requested.'));

    const terminate = await this.commandService.runCommand('wsl.exe', ['--terminate', distroName], {source: 'platform', timeoutMs: 15000});
    steps.push(this.createStep('terminate-distro', terminate.success, terminate.success ? `Terminated ${distroName}` : (terminate.stderr || terminate.stdout || 'No running distro terminated.')));

    const list = await this.commandService.runCommand('wsl.exe', ['-l', '-q'], {source: 'platform', timeoutMs: 15000});
    const distroExists = list.success && list.stdout.split(/\r?\n/).map((line) => line.trim()).includes(distroName);
    if (distroExists) {
      const unregister = await this.commandService.runCommand('wsl.exe', ['--unregister', distroName], {source: 'platform', timeoutMs: 30000});
      steps.push(this.createStep('unregister-distro', unregister.success, unregister.success ? `Unregistered ${distroName}` : (unregister.stderr || unregister.stdout || 'Unregister failed.')));
      if (!unregister.success) warnings.push(`Failed to unregister ${distroName}`);
    } else {
      steps.push(this.createStep('unregister-distro', true, `${distroName} not registered.`));
    }

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
      await this.logService.success(`Removed Windows runtime path: ${target}`, 'platform');
    }

    const details: ResetExecutionDetails = {removedPaths, skippedPaths, warnings, steps};
    return {
      success: warnings.length === 0,
      status: 'implemented',
      result: warnings.length === 0 ? 'Windows runtime reset completed.' : 'Windows runtime reset completed with warnings.',
      error: warnings.length > 0 ? warnings.join('; ') : undefined,
      details: details as unknown as Record<string, unknown>,
    };
  }

  private async installNodeResource(nodeResource: ResourceDefinition) {
    const cachedNode = await this.getPreparedInstallState()?.context.cacheManager.getCachedFile(nodeResource);
    if (!cachedNode) return this.createStep('install-node', false, 'Node resource is not cached.');

    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    if (systemNode.success) return this.createStep('install-node', true, `System Node already available: ${systemNode.stdout.trim()}`);

    const managedNodeDir = path.join(this.options.paths.runtimeRoot, 'node');
    await fs.ensureDir(managedNodeDir);
    const lower = cachedNode.toLowerCase();
    if (lower.endsWith('.zip')) {
      const extract = await this.commandService.runPowerShell(`Expand-Archive -Force -Path \"${cachedNode}\" -DestinationPath \"${managedNodeDir}\"`, {timeoutMs: 10 * 60 * 1000});
      const nodeExe = await this.findManagedNodeExecutable(managedNodeDir);
      return this.createStep('install-node', extract.success && Boolean(nodeExe), nodeExe ? `Managed Node extracted to ${nodeExe}` : (extract.stderr || extract.stdout || 'Node extraction failed.'));
    }
    if (lower.endsWith('.msi') || lower.endsWith('.exe')) {
      return this.createStep('install-node', false, `Prepared Windows Node installer at ${cachedNode}, but silent system install is intentionally not auto-applied in this round.`);
    }
    return this.createStep('install-node', false, `Unsupported Node package for Windows skeleton install: ${cachedNode}`);
  }

  private async prepareGatewayEntry(gatewayResource: ResourceDefinition) {
    const prepared = this.getPreparedInstallState();
    const cachedBundle = prepared ? await prepared.context.cacheManager.getCachedFile(gatewayResource) : null;
    if (!cachedBundle) return null;

    const gatewayRoot = this.options.gatewayWorkingDirectory ?? path.join(this.options.paths.runtimeRoot, 'gateway');
    await fs.ensureDir(gatewayRoot);
    if (cachedBundle.toLowerCase().endsWith('.zip')) {
      await this.commandService.runPowerShell(`Expand-Archive -Force -Path \"${cachedBundle}\" -DestinationPath \"${gatewayRoot}\"`, {timeoutMs: 10 * 60 * 1000});
    }

    const entryPoint = this.options.gatewayEntryPoint
      ?? (gatewayResource.installHints.executablePath ? path.join(gatewayRoot, gatewayResource.installHints.executablePath) : null)
      ?? path.join(gatewayRoot, 'gateway', 'server.js');

    if (!(await fs.pathExists(entryPoint))) {
      const fallback = path.join(gatewayRoot, 'server.js');
      if (await fs.pathExists(fallback)) {
        return this.buildGatewayCommand(fallback, path.dirname(fallback));
      }
      return null;
    }

    return this.buildGatewayCommand(entryPoint, path.dirname(entryPoint));
  }

  private async buildGatewayCommand(entryPoint: string, workingDirectory: string) {
    if (entryPoint.toLowerCase().endsWith('.js')) {
      const nodeExecutable = await this.findManagedNodeExecutable(path.join(this.options.paths.runtimeRoot, 'node')) ?? 'node';
      return {command: nodeExecutable, args: [entryPoint], entryPoint, workingDirectory};
    }
    return {command: entryPoint, args: [], entryPoint, workingDirectory};
  }

  private async validateWindowsInstall(resources: ResourceDefinition[], plan?: InstallPlan): Promise<PostInstallValidationDetails> {
    const checks: ValidationCheck[] = [];
    const warnings: string[] = [];
    const blockingIssues: string[] = [];

    const systemNode = await this.commandService.runCommand('node', ['-v'], {source: 'platform', timeoutMs: 5000});
    const managedNode = await this.findManagedNodeExecutable(path.join(this.options.paths.runtimeRoot, 'node'));
    checks.push({id: 'node-available', title: 'Node available', passed: systemNode.success || Boolean(managedNode), detail: systemNode.success ? systemNode.stdout.trim() : managedNode ? `managed:${managedNode}` : 'Node not detected.', blocking: true});

    const runtimeDir = path.join(this.options.paths.runtimeRoot, 'runtime');
    const runtimeDirExists = await fs.pathExists(runtimeDir);

    const distroName = this.options.distroName ?? 'OpenClaw-Runtime';
    const distroList = await this.commandService.runCommand('wsl.exe', ['-l', '-v'], {source: 'platform', timeoutMs: 10000});
    const distroExists = distroList.success && distroList.stdout.split(/\r?\n/).some((line) => line.includes(distroName));
    checks.push({id: 'runtime-available', title: 'Runtime available', passed: runtimeDirExists || distroExists, detail: runtimeDirExists ? runtimeDir : distroExists ? distroName : 'Runtime dir and distro both unavailable.', blocking: true});

    for (const resource of resources) {
      const resourcePath = path.join(this.options.paths.cacheRoot, resource.relativePath);
      const exists = await fs.pathExists(resourcePath);
      const optionalByPlan = Boolean(plan?.missingButOptionalResources.includes(resource.id));
      checks.push({id: `resource-${resource.id}`, title: `Resource ${resource.id}`, passed: exists, detail: resourcePath, blocking: !resource.optional && !optionalByPlan});
    }
    checks.push({id: 'wsl-distro', title: 'WSL distro registered', passed: distroExists, detail: distroExists ? distroName : 'Distro not registered yet.', blocking: false});

    const gateway = this.getGatewayDetails();
    checks.push({id: 'gateway-process', title: 'Gateway process running', passed: gateway.running, detail: gateway.running ? `pid=${gateway.pid}` : 'Gateway not running.', blocking: false});

    for (const check of checks) {
      if (!check.passed && check.blocking) blockingIssues.push(`${check.title}: ${check.detail}`);
      if (!check.passed && !check.blocking) warnings.push(`${check.title}: ${check.detail}`);
    }

    return {passed: blockingIssues.length === 0, checks, warnings, blockingIssues};
  }

  private async findManagedNodeExecutable(root: string) {
    if (!(await fs.pathExists(root))) return null;
    const direct = path.join(root, 'node.exe');
    if (await fs.pathExists(direct)) return direct;
    const children = await fs.readdir(root).catch(() => []);
    for (const child of children) {
      const candidate = path.join(root, child, 'node.exe');
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
    return `Windows install plan (${mode}) built from manifest ${manifest.productVersion} with compatibility=${level}.`;
  }
}
