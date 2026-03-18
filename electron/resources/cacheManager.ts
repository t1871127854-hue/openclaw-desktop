import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type {LogService} from '../services/logService';
import type {CachedResourceRecord, ResourceDefinition, ResourceVerificationResult} from './types';

interface CacheIndex {
  resources: CachedResourceRecord[];
}

export class CacheManager {
  private readonly indexFile: string;

  constructor(
    private readonly cacheRoot: string,
    private readonly logService: LogService,
  ) {
    this.indexFile = path.join(this.cacheRoot, 'index.json');
  }

  async getCacheRoot() {
    await fs.ensureDir(this.cacheRoot);
    return this.cacheRoot;
  }

  async getCachedFile(resource: ResourceDefinition) {
    const record = await this.findRecord(resource.id);
    if (!record) {
      await this.logService.info(`Cache miss for resource ${resource.id}`, 'resources');
      return null;
    }

    const exists = await fs.pathExists(record.filePath);
    if (!exists) {
      await this.logService.warn(`Cache index entry missing on disk for ${resource.id}`, 'resources');
      await this.removeRecord(resource.id);
      return null;
    }

    await this.logService.info(`Cache hit for resource ${resource.id}: ${record.filePath}`, 'resources');
    return record.filePath;
  }

  async putCachedFile(resource: ResourceDefinition, sourcePath: string) {
    await fs.ensureDir(await this.getCacheRoot());
    const destinationPath = path.join(this.cacheRoot, resource.relativePath);
    await fs.ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);

    const sha256 = await this.computeSha256(destinationPath);
    const stat = await fs.stat(destinationPath);
    const record: CachedResourceRecord = {
      resourceId: resource.id,
      version: resource.version,
      platform: resource.platform,
      arch: resource.arch,
      filePath: destinationPath,
      sha256,
      size: stat.size,
      cachedAt: new Date().toISOString(),
    };

    await this.upsertRecord(record);
    await this.logService.success(`Cached resource ${resource.id} at ${destinationPath}`, 'resources');
    return destinationPath;
  }

  async verifyCachedFile(resource: ResourceDefinition): Promise<ResourceVerificationResult> {
    const filePath = await this.getCachedFile(resource);
    if (!filePath) {
      return {resourceId: resource.id, exists: false, valid: false, reason: 'not-cached'};
    }

    const sha256 = await this.computeSha256(filePath);
    const valid = resource.sha256 === sha256;
    if (!valid) {
      await this.logService.warn(`Cached file hash mismatch for ${resource.id}`, 'resources');
    }

    return {
      resourceId: resource.id,
      exists: true,
      valid,
      path: filePath,
      sha256,
      reason: valid ? 'verified' : 'sha256-mismatch',
    };
  }

  async invalidateBadCache(resourceId: string) {
    const record = await this.findRecord(resourceId);
    if (!record) return false;
    await fs.remove(record.filePath).catch(() => undefined);
    await this.removeRecord(resourceId);
    await this.logService.warn(`Invalidated bad cache for ${resourceId}`, 'resources');
    return true;
  }

  async listCachedResources() {
    const index = await this.readIndex();
    return index.resources;
  }

  private async computeSha256(filePath: string) {
    const hash = crypto.createHash('sha256');
    const buffer = await fs.readFile(filePath);
    hash.update(buffer);
    return hash.digest('hex');
  }

  private async readIndex(): Promise<CacheIndex> {
    await fs.ensureDir(this.cacheRoot);
    if (!(await fs.pathExists(this.indexFile))) {
      return {resources: []};
    }
    return fs.readJson(this.indexFile) as Promise<CacheIndex>;
  }

  private async writeIndex(index: CacheIndex) {
    await fs.writeJson(this.indexFile, index, {spaces: 2});
  }

  private async findRecord(resourceId: string) {
    const index = await this.readIndex();
    return index.resources.find((item) => item.resourceId === resourceId) ?? null;
  }

  private async upsertRecord(record: CachedResourceRecord) {
    const index = await this.readIndex();
    index.resources = index.resources.filter((item) => item.resourceId !== record.resourceId);
    index.resources.push(record);
    await this.writeIndex(index);
  }

  private async removeRecord(resourceId: string) {
    const index = await this.readIndex();
    index.resources = index.resources.filter((item) => item.resourceId !== resourceId);
    await this.writeIndex(index);
  }
}
