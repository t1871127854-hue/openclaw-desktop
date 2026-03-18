import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import type {LogService} from '../services/logService';
import {CacheManager} from './cacheManager';
import type {
  DownloadAttemptResult,
  DownloadProgress,
  DownloadQueueItem,
  ResourceDefinition,
  ResourceSource,
  ResourceSourceKind,
} from './types';

export interface DownloadManagerOptions {
  sourcePriority?: ResourceSourceKind[];
  retries?: number;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

export class DownloadManager {
  constructor(
    private readonly cacheManager: CacheManager,
    private readonly logService: LogService,
  ) {}

  listSources(resource: ResourceDefinition, sourcePriority: ResourceSourceKind[] = []) {
    const priority = sourcePriority.length > 0 ? sourcePriority : ['local-import', 'lan', 'mirror-cn', 'official', 'custom'];
    return [...resource.sources]
      .filter((source) => source.enabled !== false)
      .sort((left, right) => {
        const leftRank = priority.indexOf(left.type);
        const rightRank = priority.indexOf(right.type);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return (left.priority ?? 100) - (right.priority ?? 100);
      });
  }

  chooseSource(resource: ResourceDefinition, sourcePriority: ResourceSourceKind[] = []): ResourceSource | null {
    return this.listSources(resource, sourcePriority)[0] ?? null;
  }

  async shouldReuseCache(resource: ResourceDefinition) {
    const verification = await this.cacheManager.verifyCachedFile(resource);
    if (verification.exists && verification.valid) {
      return {reusable: true, reason: 'cache-valid', path: verification.path};
    }
    if (verification.exists && !verification.valid) {
      await this.cacheManager.invalidateBadCache(resource.id);
      return {reusable: false, reason: 'cache-invalidated', path: verification.path};
    }
    return {reusable: false, reason: 'cache-miss', path: undefined};
  }

  async enqueueDownloads(items: DownloadQueueItem[], options: DownloadManagerOptions = {}) {
    const results: DownloadAttemptResult[] = [];
    for (const item of items) {
      results.push(await this.downloadOneFile(item.resource, item.destinationPath, options));
    }
    return results;
  }

  async downloadOneFile(resource: ResourceDefinition, destinationPath: string, options: DownloadManagerOptions = {}): Promise<DownloadAttemptResult> {
    const cacheDecision = await this.shouldReuseCache(resource);
    if (cacheDecision.reusable && cacheDecision.path) {
      await fs.ensureDir(path.dirname(destinationPath));
      await fs.copyFile(cacheDecision.path, destinationPath);
      await this.logService.info(`Reused valid cache for ${resource.id}: ${cacheDecision.reason}`, 'resources');
      return {
        resourceId: resource.id,
        success: true,
        source: 'cache',
        destinationPath,
        attempts: 0,
        verified: true,
        fromCache: true,
      };
    }

    const sources = this.listSources(resource, options.sourcePriority);
    if (sources.length === 0) {
      return {resourceId: resource.id, success: false, destinationPath, attempts: 0, error: 'No available source for resource'};
    }

    const retries = options.retries ?? 2;
    let lastError = 'unknown download error';
    let totalAttempts = 0;

    for (const source of sources) {
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        totalAttempts += 1;
        try {
          await this.logService.info(`Downloading ${resource.id} via ${source.type} (attempt ${attempt}/${retries + 1})`, 'resources');
          await this.performTransfer(resource, source, destinationPath, options, attempt);
          const verified = await this.verifyHashHook(resource, destinationPath);
          if (!verified.ok) {
            await fs.remove(destinationPath).catch(() => undefined);
            throw new Error(verified.reason);
          }
          await this.cacheManager.putCachedFile(resource, destinationPath);
          return {
            resourceId: resource.id,
            success: true,
            source: source.type,
            destinationPath,
            attempts: totalAttempts,
            verified: true,
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await this.logService.warn(`Download attempt failed for ${resource.id} via ${source.type}: ${lastError}`, 'resources');
        }
      }
      await this.logService.warn(`Falling back to next source for ${resource.id}`, 'resources');
    }

    return {resourceId: resource.id, success: false, source: sources.at(-1)?.type, destinationPath, attempts: totalAttempts, error: lastError, verified: false};
  }

  async verifyHashHook(resource: ResourceDefinition, filePath: string) {
    const hash = crypto.createHash('sha256');
    hash.update(await fs.readFile(filePath));
    const actual = hash.digest('hex');
    return {ok: actual === resource.sha256, actual, reason: actual === resource.sha256 ? 'verified' : `sha256 mismatch: expected ${resource.sha256}, received ${actual}`};
  }

  createResumeToken(resource: ResourceDefinition) {
    return {supported: false, resourceId: resource.id, phase: 'not-started', reason: 'Range/resume is reserved for a later iteration.'};
  }

  private async performTransfer(resource: ResourceDefinition, source: ResourceSource, destinationPath: string, options: DownloadManagerOptions, retryCount: number) {
    await fs.ensureDir(path.dirname(destinationPath));

    if (source.type === 'local-import' && source.path) {
      await fs.copyFile(source.path, destinationPath);
      const stat = await fs.stat(destinationPath);
      options.onProgress?.({resourceId: resource.id, file: resource.filename, downloadedBytes: stat.size, totalBytes: stat.size, percentage: 100, source: source.path, retryCount});
      return;
    }

    if (!source.url) throw new Error(`Source ${source.type} missing url/path`);

    const response = await fetch(source.url, {signal: AbortSignal.timeout(source.timeoutMs ?? options.timeoutMs ?? 30000)});
    if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${resource.id}`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(destinationPath, buffer);
    const totalBytes = buffer.byteLength;
    options.onProgress?.({resourceId: resource.id, file: resource.filename, downloadedBytes: totalBytes, totalBytes, percentage: 100, source: source.url, retryCount});
  }
}
