import fs from 'fs-extra';
import path from 'node:path';
import type {LogService} from '../services/logService';
import type {
  ManifestLoadOptions,
  ResourceBundle,
  ResourceDefinition,
  ResourceManifest,
  ResourceSourceKind,
  ResourceValidationResult,
} from './types';

const DEFAULT_LOCAL_MANIFEST = path.join(process.cwd(), 'offline_resources', 'manifest.json');

export class ManifestResolver {
  constructor(private readonly logService: LogService) {}

  async loadManifest(options: ManifestLoadOptions = {}): Promise<ResourceManifest> {
    const manifest = options.localPath
      ? await this.loadFromLocalFile(options.localPath)
      : options.remoteUrl
        ? await this.loadFromRemoteUrl(options.remoteUrl)
        : await this.loadBestEffortManifest();

    const normalized = await this.normalizeManifest(manifest);
    const validation = this.validateBasicSchema(normalized);
    if (!validation.valid) {
      await this.logService.error(`Manifest validation failed: ${validation.errors.join('; ')}`, 'resources');
      throw new Error(`Invalid resource manifest: ${validation.errors.join('; ')}`);
    }
    for (const warning of validation.warnings) {
      await this.logService.warn(`Manifest warning: ${warning}`, 'resources');
    }

    const merged = {
      ...normalized,
      defaultSourcePriority: this.mergeSourcePriorities(normalized.defaultSourcePriority, options.sourcePriority),
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
      if ((resource.sources ?? []).length === 0) {
        warnings.push(`resource ${resource.id || '<unknown>'} has no sources; fallback empty array applied`);
      }
      if (resource.sha256 === 'TODO' || resource.sha256.length < 8) {
        warnings.push(`resource ${resource.id} has placeholder-like sha256`);
      }
    }

    for (const bundle of manifest?.bundles ?? []) {
      if (!bundle.id) errors.push('bundle.id is required');
      if ((bundle.resourceIds ?? []).length === 0) {
        warnings.push(`bundle ${bundle.id || '<unknown>'} has no resourceIds; fallback empty array applied`);
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

  private async normalizeManifest(manifest: Partial<ResourceManifest> | null | undefined): Promise<ResourceManifest> {
    const resources = Array.isArray(manifest?.resources) ? manifest.resources : [];
    const bundles = Array.isArray(manifest?.bundles) ? manifest.bundles : [];

    if (!Array.isArray(manifest?.resources)) {
      await this.logService.warn('Invalid manifest resources field, fallback applied.', 'resources');
    }
    if (!Array.isArray(manifest?.bundles)) {
      await this.logService.warn('Invalid manifest bundles field, fallback applied.', 'resources');
    }
    if (!Array.isArray(manifest?.defaultSourcePriority)) {
      await this.logService.warn('Invalid manifest defaultSourcePriority field, fallback applied.', 'resources');
    }

    return {
      schemaVersion: manifest?.schemaVersion || '1.0.0',
      productVersion: manifest?.productVersion || '0.0.0-dev',
      generatedAt: manifest?.generatedAt || new Date().toISOString(),
      compatibilityRange: manifest?.compatibilityRange ?? {},
      defaultSourcePriority: Array.isArray(manifest?.defaultSourcePriority)
        ? manifest.defaultSourcePriority
        : ['local-import', 'lan', 'mirror-cn', 'official', 'custom'],
      resources: await Promise.all(resources.map((resource) => this.normalizeResource(resource))),
      bundles: await Promise.all(bundles.map((bundle) => this.normalizeBundle(bundle))),
    };
  }

  private async normalizeResource(resource: Partial<ResourceDefinition> | null | undefined): Promise<ResourceDefinition> {
    const resourceId = resource?.id || '<unknown>';
    const normalized = {
      ...resource,
      modeTags: Array.isArray(resource?.modeTags) ? resource.modeTags : [],
      sources: Array.isArray(resource?.sources) ? resource.sources : [],
      dependencies: Array.isArray(resource?.dependencies) ? resource.dependencies : [],
    } as ResourceDefinition;

    if (!Array.isArray(resource?.modeTags)) {
      await this.logService.warn(`Invalid resource field, fallback applied: modeTags (${resourceId})`, 'resources');
    }
    if (!Array.isArray(resource?.sources)) {
      await this.logService.warn(`Invalid resource field, fallback applied: sources (${resourceId})`, 'resources');
    }
    if (!Array.isArray(resource?.dependencies)) {
      await this.logService.warn(`Invalid resource field, fallback applied: dependencies (${resourceId})`, 'resources');
    }

    return normalized;
  }

  private async normalizeBundle(bundle: Partial<ResourceBundle> | null | undefined): Promise<ResourceBundle> {
    const bundleId = bundle?.id || '<unknown>';
    const normalized = {
      ...bundle,
      resourceIds: Array.isArray(bundle?.resourceIds) ? bundle.resourceIds.filter(Boolean) : [],
    } as ResourceBundle;

    if (!Array.isArray(bundle?.resourceIds)) {
      await this.logService.warn(`Invalid bundle field, fallback applied: resourceIds (${bundleId})`, 'resources');
    }

    return normalized;
  }
}
