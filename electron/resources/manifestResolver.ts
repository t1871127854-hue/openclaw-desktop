import fs from 'fs-extra';
import path from 'node:path';
import type {LogService} from '../services/logService';
import type {ManifestLoadOptions, ResourceManifest, ResourceSourceKind, ResourceValidationResult} from './types';

const DEFAULT_LOCAL_MANIFEST = path.join(process.cwd(), 'offline_resources', 'manifest.json');

export class ManifestResolver {
  constructor(private readonly logService: LogService) {}

  async loadManifest(options: ManifestLoadOptions = {}): Promise<ResourceManifest> {
    const manifest = options.localPath
      ? await this.loadFromLocalFile(options.localPath)
      : options.remoteUrl
        ? await this.loadFromRemoteUrl(options.remoteUrl)
        : await this.loadBestEffortManifest();

    const validation = this.validateBasicSchema(manifest);
    if (!validation.valid) {
      await this.logService.error(`Manifest validation failed: ${validation.errors.join('; ')}`, 'resources');
      throw new Error(`Invalid resource manifest: ${validation.errors.join('; ')}`);
    }

    const merged = {
      ...manifest,
      defaultSourcePriority: this.mergeSourcePriorities(manifest.defaultSourcePriority, options.sourcePriority),
    } satisfies ResourceManifest;

    await this.logService.info(
      `Manifest loaded: schema=${merged.schemaVersion}, product=${merged.productVersion}, resources=${merged.resources.length}`,
      'resources',
    );

    return merged;
  }

  async loadFromLocalFile(localPath: string): Promise<ResourceManifest> {
    await this.logService.info(`Loading manifest from local file: ${localPath}`, 'resources');
    return fs.readJson(localPath) as Promise<ResourceManifest>;
  }

  async loadFromRemoteUrl(remoteUrl: string): Promise<ResourceManifest> {
    await this.logService.info(`Loading manifest from remote URL: ${remoteUrl}`, 'resources');
    const response = await fetch(remoteUrl, {signal: AbortSignal.timeout(10000)});
    if (!response.ok) {
      throw new Error(`Failed to load remote manifest: HTTP ${response.status}`);
    }
    return response.json() as Promise<ResourceManifest>;
  }

  validateBasicSchema(manifest: ResourceManifest): ResourceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!manifest?.schemaVersion) errors.push('schemaVersion is required');
    if (!manifest?.productVersion) errors.push('productVersion is required');
    if (!manifest?.generatedAt) errors.push('generatedAt is required');
    if (!Array.isArray(manifest?.defaultSourcePriority)) errors.push('defaultSourcePriority must be an array');
    if (!Array.isArray(manifest?.resources)) errors.push('resources must be an array');
    if (!Array.isArray(manifest?.bundles)) errors.push('bundles must be an array');

    for (const resource of manifest?.resources ?? []) {
      if (!resource.id) errors.push('resource.id is required');
      if (!resource.platform) errors.push(`resource ${resource.id || '<unknown>'} missing platform`);
      if (!resource.arch) errors.push(`resource ${resource.id || '<unknown>'} missing arch`);
      if (!resource.resourceType) errors.push(`resource ${resource.id || '<unknown>'} missing resourceType`);
      if (!Array.isArray(resource.sources) || resource.sources.length === 0) {
        errors.push(`resource ${resource.id || '<unknown>'} must declare at least one source`);
      }
      if (resource.sha256 === 'TODO' || resource.sha256.length < 8) {
        warnings.push(`resource ${resource.id} has placeholder-like sha256`);
      }
    }

    for (const bundle of manifest?.bundles ?? []) {
      if (!bundle.id) errors.push('bundle.id is required');
      if (!Array.isArray(bundle.resourceIds) || bundle.resourceIds.length === 0) {
        errors.push(`bundle ${bundle.id || '<unknown>'} must contain resourceIds`);
      }
    }

    return {valid: errors.length === 0, errors, warnings};
  }

  mergeSourcePriorities(
    manifestPriority: ResourceSourceKind[] = [],
    overrides: ResourceSourceKind[] = [],
  ): ResourceSourceKind[] {
    return [...overrides, ...manifestPriority].filter((item, index, all) => all.indexOf(item) === index);
  }

  private async loadBestEffortManifest(): Promise<ResourceManifest> {
    if (await fs.pathExists(DEFAULT_LOCAL_MANIFEST)) {
      return this.loadFromLocalFile(DEFAULT_LOCAL_MANIFEST);
    }

    await this.logService.warn(`No local manifest found at ${DEFAULT_LOCAL_MANIFEST}; using empty skeleton manifest.`, 'resources');
    return {
      schemaVersion: '1.0.0',
      productVersion: '0.0.0-dev',
      generatedAt: new Date().toISOString(),
      compatibilityRange: {},
      defaultSourcePriority: ['local-import', 'lan', 'mirror-cn', 'official', 'custom'],
      resources: [],
      bundles: [],
    };
  }
}
