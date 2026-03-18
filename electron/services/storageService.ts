import fs from 'fs-extra';
import path from 'node:path';

export class StorageService {
  constructor(
    readonly configFile: string,
    readonly stateFile: string,
  ) {}

  async readConfig() {
    if (!(await fs.pathExists(this.configFile))) {
      return {};
    }

    return fs.readJson(this.configFile);
  }

  async writeConfig(fragment: Record<string, any>) {
    await fs.ensureDir(path.dirname(this.configFile));
    const current = await this.readConfig();
    const merged = this.deepMerge(current, fragment);
    await fs.writeJson(this.configFile, merged, {spaces: 2});
    return merged;
  }

  async deleteConfig() {
    if (await fs.pathExists(this.configFile)) {
      await fs.remove(this.configFile);
    }
  }

  async readState() {
    if (!(await fs.pathExists(this.stateFile))) {
      return {currentStep: 0, completed: [], isInstalling: false};
    }

    return fs.readJson(this.stateFile);
  }

  async writeState(state: Record<string, any>) {
    await fs.writeJson(this.stateFile, state, {spaces: 2});
    return {success: true};
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
