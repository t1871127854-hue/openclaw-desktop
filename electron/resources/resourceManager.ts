import path from 'node:path';
import fs from 'fs-extra';
import type {LogService} from '../services/logService';
import {CacheManager} from './cacheManager';
import {ManifestResolver} from './manifestResolver';
import type {
  ManifestLoadOptions,
  ResourceBundle,
  ResourceDefinition,
  ResourceManifest,
  ResourceResolveRequest,
  ResourceVerificationResult,
  ResolvedResourceSet,
} from './types';

export class ResourceManager {
  private manifest: ResourceManifest | null = null;

  constructor(
    private readonly manifestResolver: ManifestResolver,
    private readonly cacheManager: CacheManager,
    private readonly resourceRoot: string,
    private readonly logService: LogService,
  ) {}

  async loadManifest(options: ManifestLoadOptions = {}) {
    this.manifest = await this.manifestResolver.loadManifest(options);
    return this.manifest;
  }

  async resolveResources(request: ResourceResolveRequest): Promise<ResolvedResourceSet> {
    const manifest = await this.ensureManifestLoaded();
    const bundle = this.findBundle(manifest, request);
    const directResources = bundle
      ? bundle.resourceIds.map((resourceId) => manifest.resources.find((resource) => resource.id === resourceId)).filter((resource): resource is ResourceDefinition => Boolean(resource))
      : manifest.resources.filter((resource) => resource.platform === request.platform && resource.arch === request.arch && resource.modeTags.includes(request.mode));

    const resourcesById = new Map(directResources.map((resource) => [resource.id, resource]));
    const missingDependencies: string[] = [];
    for (const resource of directResources) {
      for (const dependency of resource.dependencies) {
        const dependencyResource = manifest.resources.find((candidate) => candidate.id === dependency.resourceId);
        if (dependencyResource) resourcesById.set(dependencyResource.id, dependencyResource);
        else missingDependencies.push(dependency.resourceId);
      }
    }

    await this.logService.info(`Resolved ${resourcesById.size} resource(s) for ${request.platform}/${request.arch}/${request.mode}`, 'resources');
    return {bundle, resources: [...resourcesById.values()], missingDependencies};
  }

  async getBundleResources(bundleId: string) {
    const manifest = await this.ensureManifestLoaded();
    const bundle = manifest.bundles.find((item) => item.id === bundleId) ?? null;
    if (!bundle) return [];
    return bundle.resourceIds.map((resourceId) => manifest.resources.find((resource) => resource.id === resourceId)).filter((resource): resource is ResourceDefinition => Boolean(resource));
  }

  async getMissingResources(resources: ResourceDefinition[]) {
    const missing: ResourceDefinition[] = [];
    for (const resource of resources) {
      const verification = await this.cacheManager.verifyCachedFile(resource);
      if (!verification.exists || !verification.valid) missing.push(resource);
    }
    await this.logService.info(`Detected ${missing.length} missing/invalid resource(s)`, 'resources');
    return missing;
  }

  async assessResourceReuse(resource: ResourceDefinition) {
    const verification = await this.cacheManager.verifyCachedFile(resource);
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
    const results = await Promise.all(resources.map((resource) => this.cacheManager.verifyCachedFile(resource)));
    const validCount = results.filter((item) => item.valid).length;
    await this.logService.info(`Verified local resources: ${validCount}/${results.length} valid`, 'resources');
    return results;
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

  private findBundle(manifest: ResourceManifest, request: ResourceResolveRequest): ResourceBundle | null {
    if (request.bundleId) return manifest.bundles.find((bundle) => bundle.id === request.bundleId) ?? null;
    return manifest.bundles.find((bundle) => bundle.platform === request.platform && bundle.arch === request.arch && bundle.mode === request.mode) ?? null;
  }
}
