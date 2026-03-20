import path from 'node:path';
import fs from 'fs-extra';
import type {LogService} from '../services/logService';
import {CacheManager} from './cacheManager';
import {ManifestResolver} from './manifestResolver';
import type {
  ManifestLoadOptions,
  ResourceAvailability,
  ResourceBundle,
  ResourceDefinition,
  ResourceManifest,
  ResourceResolveRequest,
  ResourceVerificationResult,
  ResolvedResourceSet,
} from './types';

export class ResourceManager {
  private manifest: ResourceManifest | null = null;
  private resourceIndex = new Map<string, ResourceDefinition>();

  constructor(
    private readonly manifestResolver: ManifestResolver,
    private readonly cacheManager: CacheManager,
    private readonly resourceRoot: string,
    private readonly logService: LogService,
  ) {}

  async loadManifest(options: ManifestLoadOptions = {}) {
    this.manifest = await this.manifestResolver.loadManifest(options);
    this.resourceIndex = new Map((this.manifest.resources ?? []).map((resource) => [resource.id, resource]));
    return this.manifest;
  }

  async resolveResources(request: ResourceResolveRequest): Promise<ResolvedResourceSet> {
    const manifest = await this.ensureManifestLoaded();
    const bundle = this.findBundle(manifest, request);
    const filteredResources = (manifest.resources ?? []).filter(
      (resource) =>
        resource.platform === request.platform
        && resource.arch === request.arch
        && Array.isArray(resource.modeTags)
        && resource.modeTags.includes(request.mode),
    );
    const bundleResources = bundle
      ? (bundle.resourceIds ?? [])
          .map((resourceId) => {
            const resource = this.resourceIndex.get(resourceId) ?? null;
            if (!resource) {
              void this.logService.warn(`Bundle ${bundle.id} references missing resource ${resourceId}; skipping.`, 'resources');
            }
            return resource;
          })
          .filter((resource): resource is ResourceDefinition => Boolean(resource))
      : [];

    const resourcesById = new Map<string, ResourceDefinition>();
    for (const resource of [...bundleResources, ...filteredResources]) {
      resourcesById.set(resource.id, resource);
    }
    const directResources = [...resourcesById.values()];
    const missingDependencies: string[] = [];
    for (const resource of directResources) {
      for (const dependency of resource.dependencies ?? []) {
        const dependencyResource = this.resourceIndex.get(dependency.resourceId);
        if (dependencyResource) resourcesById.set(dependencyResource.id, dependencyResource);
        else {
          missingDependencies.push(dependency.resourceId);
          await this.logService.warn(`Missing dependency ${dependency.resourceId} referenced by ${resource.id}.`, 'resources');
        }
      }
    }

    if (directResources.length === 0) {
      await this.logService.error(
        `Resource resolution produced 0 resources for ${request.platform}/${request.arch}/${request.mode}; bundle=${bundle?.id ?? 'none'}, manifestResources=${manifest.resources.length}.`,
        'resources',
      );
    }
    await this.logService.info(`Resolved ${resourcesById.size} resource(s) for ${request.platform}/${request.arch}/${request.mode}`, 'resources');
    return {bundle, resources: [...resourcesById.values()], missingDependencies};
  }

  async getBundleResources(bundleId: string) {
    const manifest = await this.ensureManifestLoaded();
    const bundle = (manifest.bundles ?? []).find((item) => item.id === bundleId) ?? null;
    if (!bundle) return [];
    return (bundle.resourceIds ?? [])
      .map((resourceId) => (manifest.resources ?? []).find((resource) => resource.id === resourceId))
      .filter((resource): resource is ResourceDefinition => Boolean(resource));
  }

  async getMissingResources(resources: ResourceDefinition[]) {
    const missing: ResourceDefinition[] = [];
    for (const resource of resources) {
      const availability = await this.getResourceAvailability(resource);
      if (!availability.available || !availability.valid) missing.push(resource);
    }
    await this.logService.info(`Detected ${missing.length} missing/invalid resource(s)`, 'resources');
    return missing;
  }

  async assessResourceReuse(resource: ResourceDefinition) {
    const verification = (await this.getResourceAvailability(resource)).verification;
    if (verification.exists && verification.valid) {
      return {resourceId: resource.id, reusable: true, mustRedownload: false, reason: 'valid-cache'};
    }
    if (verification.exists && !verification.valid) {
      await this.cacheManager.invalidateBadCache(resource.id);
      return {resourceId: resource.id, reusable: false, mustRedownload: true, reason: 'invalid-cache'};
    }
    return {resourceId: resource.id, reusable: false, mustRedownload: true, reason: 'cache-miss'};
  }

  async verifyLocalResources(resources: ResourceDefinition[]): Promise<ResourceVerificationResult[]> {
    const results = await Promise.all(resources.map(async (resource) => (await this.getResourceAvailability(resource)).verification));
    const validCount = results.filter((item) => item.valid).length;
    await this.logService.info(`Verified local resources: ${validCount}/${results.length} valid`, 'resources');
    return results;
  }

  async getAvailabilityForResources(resources: ResourceDefinition[]): Promise<ResourceAvailability[]> {
    return Promise.all(resources.map((resource) => this.getResourceAvailability(resource)));
  }

  async getManifestAvailabilitySummary(options: ManifestLoadOptions = {}) {
    const manifest = await this.loadManifest(options);
    const availability = await this.getAvailabilityForResources(manifest.resources ?? []);
    const importableResources = availability.filter((item) => item.importable).map((item) => item.resourceId);
    const rootfsAvailability = availability.filter((item) => {
      const resource = this.resourceIndex.get(item.resourceId);
      return resource?.resourceType === 'rootfs';
    });
    const checksumAvailability = availability.filter((item) => {
      const resource = this.resourceIndex.get(item.resourceId);
      return resource?.resourceType === 'checksum';
    });

    await this.logService.info(`top-level offline manifest detected: ${manifest.productVersion}`, 'resources');
    await this.logService.info(`normalized resources count: ${manifest.resources.length}`, 'resources');
    await this.logService.info(`resource ids: ${manifest.resources.map((resource) => resource.id).join(', ') || '(none)'}`, 'resources');
    await this.logService.info(`runtime importable resources count: ${importableResources.length}`, 'resources');

    for (const item of [...rootfsAvailability, ...checksumAvailability]) {
      const resource = this.resourceIndex.get(item.resourceId);
      await this.logService.info(`${resource?.resourceType ?? 'resource'} candidates checked: ${item.checkedCandidates.join(' | ') || '(none)'}`, 'resources');
      await this.logService.info(`${resource?.resourceType ?? 'resource'} resolved path: ${item.resolvedPath ?? '(none)'}`, 'resources');
      await this.logService.info(`${resource?.resourceType ?? 'resource'} available/importable: ${item.available}/${item.importable}`, 'resources');
    }

    return {
      manifest,
      availability,
      importableResources,
      rootfsAvailability,
      checksumAvailability,
    };
  }

  getResourcePath(resource: ResourceDefinition) {
    return path.join(this.resourceRoot, resource.relativePath);
  }

  async materializePlaceholderFile(resource: ResourceDefinition) {
    const target = this.getResourcePath(resource);
    await fs.ensureDir(path.dirname(target));
    if (!(await fs.pathExists(target))) await fs.writeFile(target, 'placeholder');
    return target;
  }

  private async ensureManifestLoaded() {
    if (!this.manifest) this.manifest = await this.loadManifest();
    return this.manifest;
  }

  private async ensureResourceAvailable(resource: ResourceDefinition): Promise<ResourceVerificationResult> {
    const cachedVerification = await this.cacheManager.verifyCachedFile(resource);
    if (cachedVerification.exists && cachedVerification.valid) {
      return cachedVerification;
    }

    const localResolution = await this.resolveLocalResourcePath(resource);
    if (!localResolution) {
      return cachedVerification;
    }

    await this.logService.info(`Using filesystem-backed local resource for ${resource.id}: ${localResolution.path}`, 'resources');
    await this.cacheManager.putCachedFile(resource, localResolution.path);
    return this.cacheManager.verifyCachedFile(resource);
  }

  private async getResourceAvailability(resource: ResourceDefinition): Promise<ResourceAvailability> {
    const cachedVerification = await this.cacheManager.verifyCachedFile(resource);
    if (cachedVerification.exists && cachedVerification.valid) {
      return {
        resourceId: resource.id,
        available: true,
        importable: true,
        valid: true,
        resolvedPath: cachedVerification.path ?? null,
        sourceKind: 'cache',
        checkedCandidates: cachedVerification.path ? [cachedVerification.path] : [],
        fallbackUsed: false,
        verification: cachedVerification,
      };
    }

    const localResolution = await this.resolveLocalResourcePath(resource);
    if (!localResolution) {
      return {
        resourceId: resource.id,
        available: false,
        importable: false,
        valid: false,
        resolvedPath: null,
        sourceKind: 'unresolved',
        checkedCandidates: this.buildLocalResourceCandidates(resource).map((candidate) => candidate.path),
        fallbackUsed: false,
        verification: cachedVerification,
      };
    }

    await this.logService.info(`Using filesystem-backed local resource for ${resource.id}: ${localResolution.path} (${localResolution.sourceKind})`, 'resources');
    await this.cacheManager.putCachedFile(resource, localResolution.path);
    const verification = await this.cacheManager.verifyCachedFile(resource);
    return {
      resourceId: resource.id,
      available: verification.exists,
      importable: true,
      valid: verification.valid,
      resolvedPath: localResolution.path,
      sourceKind: localResolution.sourceKind,
      checkedCandidates: localResolution.checkedCandidates,
      fallbackUsed: localResolution.fallbackUsed,
      verification,
    };
  }

  private findBundle(manifest: ResourceManifest, request: ResourceResolveRequest): ResourceBundle | null {
    if (request.bundleId) return (manifest.bundles ?? []).find((bundle) => bundle.id === request.bundleId) ?? null;
    return (manifest.bundles ?? []).find((bundle) => bundle.platform === request.platform && bundle.arch === request.arch && bundle.mode === request.mode) ?? null;
  }

  private async resolveLocalResourcePath(resource: ResourceDefinition) {
    const candidates = this.buildLocalResourceCandidates(resource);
    const checkedCandidates: string[] = [];

    for (const candidate of candidates) {
      checkedCandidates.push(candidate.path);
      if (await fs.pathExists(candidate.path)) {
        return {
          path: candidate.path,
          sourceKind: candidate.sourceKind,
          fallbackUsed: candidate.sourceKind === 'filename-fallback' || candidate.sourceKind === 'legacy-root-fallback',
          checkedCandidates,
        };
      }
    }

    return null;
  }

  private buildLocalResourceCandidates(resource: ResourceDefinition) {
    const sourceCandidates = (resource.sources ?? [])
      .filter((source) => source.type === 'local-import')
      .flatMap((source) => {
        const sourcePath = source.path?.trim();
        if (!sourcePath) return [];
        return [
          {path: path.isAbsolute(sourcePath) ? sourcePath : path.resolve(process.cwd(), sourcePath), sourceKind: 'source-path' as const},
          {path: path.resolve(this.resourceRoot, sourcePath), sourceKind: 'source-path' as const},
          {path: path.resolve(path.dirname(this.resourceRoot), sourcePath), sourceKind: 'source-path' as const},
        ];
      });

    return [
      {path: this.getResourcePath(resource), sourceKind: 'relativePath' as const},
      {path: path.join(this.resourceRoot, resource.filename), sourceKind: 'filename-fallback' as const},
      ...sourceCandidates,
      {path: path.join(this.resourceRoot, path.basename(resource.relativePath || resource.filename)), sourceKind: 'legacy-root-fallback' as const},
    ].filter((candidate, index, all) => all.findIndex((item) => item.path === candidate.path) === index);
  }
}
