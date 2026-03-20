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
    await this.atomicWriteJson(this.stateFile, state);
    return {success: true};
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
    const handle = await openFile(tempPath, 'w');

    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.move(tempPath, filePath, {overwrite: true});
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
}
