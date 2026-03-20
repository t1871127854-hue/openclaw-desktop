import {open as openFile} from 'node:fs/promises';
import fs from 'fs-extra';
import path from 'node:path';
import type {InstallState, OperationFailureInfo, UpgradeExecutionResult} from '../../src/types/api';
import type {LogService} from './logService';

interface RuntimePersistenceState extends InstallState {
  [key: string]: unknown;
  workflow?: unknown;
  installFailure?: OperationFailureInfo;
  upgradeFailure?: OperationFailureInfo;
  upgradeExecution?: UpgradeExecutionResult;
}

const DEFAULT_STATE: RuntimePersistenceState = {currentStep: 0, completed: [], isInstalling: false};

export class StorageService {
  constructor(
    readonly configFile: string,
    readonly stateFile: string,
    private readonly logService?: LogService,
  ) {}

  async readConfig() {
    return this.readJsonFile(this.configFile, {});
  }

  async writeConfig(fragment: Record<string, any>) {
    const current = await this.readConfig();
    const merged = this.deepMerge(current, fragment);
    await this.atomicWriteJson(this.configFile, merged);
    return merged;
  }

  async deleteConfig() {
    if (await fs.pathExists(this.configFile)) {
      await fs.remove(this.configFile);
    }
  }

  async readState() {
    return this.readJsonFile(this.stateFile, DEFAULT_STATE, {backupCorrupt: true, label: 'state'});
  }

  async writeState(state: Record<string, any>) {
    try {
      await this.atomicWriteJson(this.stateFile, state);
      return {success: true};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logService?.warn(
        `State persistence failed on Windows, but the operation result is still available in memory. Reason: ${message}`,
        'system',
      );
      return {success: false, error: message, degraded: true};
    }
  }

  private async readJsonFile<T>(
    filePath: string,
    fallback: T,
    options: {backupCorrupt?: boolean; label?: string} = {},
  ): Promise<T> {
    if (!(await fs.pathExists(filePath))) {
      return fallback;
    }

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.trim()) {
        throw new SyntaxError(`${path.basename(filePath)} is empty`);
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.backupCorrupt) {
        const backupPath = await this.backupCorruptFile(filePath);
        await this.logService?.warn(
          `Recovered from corrupt ${options.label ?? 'json'} file at ${filePath}; backed up to ${backupPath}. Reason: ${message}`,
          'system',
        );
      } else {
        await this.logService?.warn(`Failed to read JSON file ${filePath}; falling back to default. Reason: ${message}`, 'system');
      }
      return fallback;
    }
  }

  private async atomicWriteJson(filePath: string, value: Record<string, any>) {
    await fs.ensureDir(path.dirname(filePath));
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await this.cleanupTempFiles(filePath);
    const handle = await openFile(tempPath, 'w');

    try {
      await this.logService?.info(`Persistence tmp file path: ${tempPath}`, 'system');
      await this.logService?.info(`Persistence target file path: ${filePath}`, 'system');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await this.replaceFileWithRetries(tempPath, filePath);
    await this.logService?.success(`Persistence success for ${filePath}`, 'system');
  }

  private async backupCorruptFile(filePath: string) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const parsed = path.parse(filePath);
    const backupPath = path.join(parsed.dir, `${parsed.name}.corrupt.${timestamp}${parsed.ext || '.json'}`);
    await fs.copy(filePath, backupPath, {overwrite: true}).catch(() => undefined);
    await fs.remove(filePath).catch(() => undefined);
    return backupPath;
  }

  private deepMerge(target: Record<string, any>, source: Record<string, any>) {
    const output = {...target};

    Object.entries(source).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        output[key] = this.deepMerge(output[key] ?? {}, value as Record<string, any>);
      } else {
        output[key] = value;
      }
    });

    return output;
  }

  private async replaceFileWithRetries(tempPath: string, targetPath: string) {
    const maxAttempts = process.platform === 'win32' ? 5 : 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.logService?.info(`Persistence rename retries: attempt ${attempt}/${maxAttempts}`, 'system');
        await fs.move(tempPath, targetPath, {overwrite: true});
        return;
      } catch (error) {
        lastError = error;
        const code = error && typeof error === 'object' && 'code' in error ? String((error as {code?: unknown}).code ?? '') : '';
        if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
          await this.logService?.warn(`Persistence rename failed with ${code}; retrying replace flow for ${targetPath}.`, 'system');
          await fs.remove(targetPath).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, attempt * 50));
          continue;
        }
        break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async cleanupTempFiles(filePath: string) {
    const directory = path.dirname(filePath);
    const base = path.basename(filePath);
    const entries = await fs.readdir(directory).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith('.tmp'))
        .map((entry) => fs.remove(path.join(directory, entry)).catch(() => undefined)),
    );
  }
}
