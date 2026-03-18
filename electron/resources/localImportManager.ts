import fs from 'fs-extra';
import path from 'node:path';
import type {LogService} from '../services/logService';
import {CacheManager} from './cacheManager';
import {ManifestResolver} from './manifestResolver';
import type {LocalImportCandidate, ResourceDefinition, ResourceManifest, SupportedArch, SupportedPlatform} from './types';

export class LocalImportManager {
  constructor(
    private readonly importRoot: string,
    private readonly manifestResolver: ManifestResolver,
    private readonly cacheManager: CacheManager,
    private readonly logService: LogService,
  ) {}

  async scanImportDirectory() {
    await fs.ensureDir(this.importRoot);
    const files = await fs.readdir(this.importRoot);
    const manifestFiles = files.filter((file) => /manifest.*\.json$/i.test(file)).sort();
    await this.logService.info(`Scanned import directory ${this.importRoot}: ${manifestFiles.length} manifest(s)`, 'resources');
    return manifestFiles.map((file) => path.join(this.importRoot, file));
  }

  async loadLocalManifest(manifestPath?: string): Promise<LocalImportCandidate | null> {
    const manifests = manifestPath ? [manifestPath] : await this.scanImportDirectory();
    const selected = manifests[0];
    if (!selected) {
      await this.logService.warn(`No local import manifest found in ${this.importRoot}`, 'resources');
      return null;
    }

    const manifest = await this.manifestResolver.loadManifest({localPath: selected});
    await this.logService.info(`Loaded local import manifest: ${selected}`, 'resources');
    return {manifestPath: selected, manifest, resources: manifest.resources};
  }

  validatePlatformArch(manifest: ResourceManifest, platform: SupportedPlatform, arch: SupportedArch) {
    const compatible = manifest.resources.every((resource) => resource.platform === platform && resource.arch === arch);
    return {
      compatible,
      reason: compatible ? 'ok' : `Manifest contains resources outside ${platform}/${arch}`,
    };
  }

  async importIntoCacheIndex(resources: ResourceDefinition[], baseDir = this.importRoot) {
    const imported: string[] = [];

    for (const resource of resources) {
      const sourcePath = path.join(baseDir, resource.filename);
      if (!(await fs.pathExists(sourcePath))) {
        await this.logService.warn(`Local import file missing for ${resource.id}: ${sourcePath}`, 'resources');
        continue;
      }
      await this.cacheManager.putCachedFile(resource, sourcePath);
      imported.push(resource.id);
    }

    await this.logService.success(`Imported ${imported.length} local resource(s) into cache`, 'resources');
    return imported;
  }
}
