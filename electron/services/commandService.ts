import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {LogSource} from '../../src/types/api';
import {LogService} from './logService';

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  source?: LogSource;
  encoding?: BufferEncoding;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  durationMs: number;
  commandLine: string;
}

export class CommandService {
  constructor(private readonly logService: LogService) {}

  async runCommand(command: string, args: string[] = [], options: CommandOptions = {}) {
    return this.execute(command, args, options, false);
  }

  async streamCommand(command: string, args: string[] = [], options: CommandOptions = {}) {
    return this.execute(command, args, options, true);
  }

  async startManagedProcess(command: string, args: string[] = [], options: CommandOptions = {}) {
    const source = options.source ?? 'system';
    const commandLine = [command, ...args].join(' ');
    await this.logService.info(`Launching managed process: ${commandLine}`, source);

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.on('data', (chunk: Buffer) => {
      chunk.toString(options.encoding ?? 'utf8').split(/\r?\n/).filter(Boolean).forEach((line) => {
        void this.logService.info(line, source);
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      chunk.toString(options.encoding ?? 'utf8').split(/\r?\n/).filter(Boolean).forEach((line) => {
        void this.logService.error(line, source);
      });
    });

    child.on('error', (error) => {
      void this.logService.error(error.message, source);
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        void this.logService.success(`Managed process exited cleanly: ${commandLine}`, source);
      } else {
        void this.logService.warn(`Managed process exited with code ${exitCode ?? 'null'}: ${commandLine}`, source);
      }
    });

    return child;
  }

  async runPowerShell(script: string, options: Omit<CommandOptions, 'source'> = {}) {
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    return this.execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      {...options, source: 'powershell'},
      false,
    );
  }

  async streamPowerShell(script: string, options: Omit<CommandOptions, 'source'> = {}) {
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    return this.execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      {...options, source: 'powershell'},
      true,
    );
  }

  private async execute(command: string, args: string[], options: CommandOptions, streaming: boolean): Promise<CommandResult> {
    const source = options.source ?? 'system';
    const start = Date.now();
    const encoding = options.encoding ?? 'utf8';
    const commandLine = [command, ...args].join(' ');
    await this.logService.info(`${streaming ? 'Streaming' : 'Running'} command: ${commandLine}`, source);

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timeout: NodeJS.Timeout | undefined;
      let settled = false;

      const finish = async (exitCode: number | null, timedOut = false) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        const durationMs = Date.now() - start;
        const success = !timedOut && exitCode === 0;
        if (success) {
          await this.logService.success(`Command finished (${durationMs}ms): ${commandLine}`, source);
        } else {
          await this.logService.error(`Command failed (${durationMs}ms, exit=${exitCode ?? 'null'}): ${commandLine}`, source);
        }
        resolve({stdout, stderr, exitCode, success, durationMs, commandLine});
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          void this.logService.error(`Command timeout after ${options.timeoutMs}ms: ${commandLine}`, source);
          child.kill();
          void finish(-1, true);
        }, options.timeoutMs);
      }

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString(encoding);
        stdout += text;
        if (streaming || text.trim()) {
          text.split(/\r?\n/).filter(Boolean).forEach((line) => {
            void this.logService.info(line, source);
          });
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString(encoding);
        stderr += text;
        text.split(/\r?\n/).filter(Boolean).forEach((line) => {
          void this.logService.error(line, source);
        });
      });

      child.on('error', (error) => {
        stderr += error.message;
        void this.logService.error(error.message, source);
        void finish(-1);
      });

      child.on('close', (exitCode) => {
        void finish(exitCode);
      });
    });
  }
}
