import fs from 'fs-extra';
import path from 'node:path';
import type {ActionResult, LogEntry, LogLevel, LogSource} from '../../src/types/api';

export class LogService {
  private entries: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();

  constructor(private readonly logFile: string, private readonly workspaceDir: string) {}

  async init() {
    await fs.ensureDir(path.dirname(this.logFile));
    await fs.ensureDir(this.workspaceDir);

    if (await fs.pathExists(this.logFile)) {
      const content = await fs.readFile(this.logFile, 'utf8');
      const lines = content.split('\n').filter(Boolean).slice(-500);
      this.entries = lines.map((line, index) => ({
        id: `boot-${index}`,
        message: line,
        level: this.inferLevel(line),
        source: this.inferSource(line),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  subscribe(listener: (entry: LogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async append(message: string, source: LogSource = 'system', level: LogLevel = 'info') {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      source,
      level,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);
    this.entries = this.entries.slice(-2000);

    const line = `[${entry.timestamp}] [${source.toUpperCase()}] [${level.toUpperCase()}] ${message}`;
    await fs.appendFile(this.logFile, `${line}\n`);
    this.listeners.forEach((listener) => listener(entry));
  }

  async info(message: string, source: LogSource = 'system') {
    await this.append(message, source, 'info');
  }

  async warn(message: string, source: LogSource = 'system') {
    await this.append(message, source, 'warn');
  }

  async error(message: string, source: LogSource = 'system') {
    await this.append(message, source, 'error');
  }

  async success(message: string, source: LogSource = 'system') {
    await this.append(message, source, 'success');
  }

  getSnapshot() {
    return this.entries
      .map((entry) => `[${entry.timestamp}] [${entry.source.toUpperCase()}] [${entry.level.toUpperCase()}] ${entry.message}`)
      .join('\n');
  }

  async exportLogs(): Promise<ActionResult> {
    const exportPath = path.join(this.workspaceDir, `openclaw-logs-${Date.now()}.log`);
    await fs.writeFile(exportPath, this.getSnapshot(), 'utf8');
    return {success: true, result: `日志已导出到 ${exportPath}`, details: {exportPath}};
  }

  async clear() {
    this.entries = [];
    await fs.writeFile(this.logFile, '');
  }

  private inferSource(line: string): LogSource {
    if (line.includes('[POWERSHELL]')) return 'powershell';
    if (line.includes('[GATEWAY]')) return 'gateway';
    if (line.includes('[DIAGNOSTICS]')) return 'diagnostics';
    if (line.includes('[PLATFORM]')) return 'platform';
    if (line.includes('[RESOURCES]')) return 'resources';
    if (line.includes('[INSTALLER]')) return 'installer';
    return 'system';
  }

  private inferLevel(line: string): LogLevel {
    if (line.includes('[ERROR]')) return 'error';
    if (line.includes('[WARN]')) return 'warn';
    if (line.includes('[SUCCESS]')) return 'success';
    return 'info';
  }
}
