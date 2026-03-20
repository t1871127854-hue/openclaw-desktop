import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type {ActionResult, GatewayStatus} from '../../src/types/api';
import {CommandService} from './commandService';
import {LogService} from './logService';

interface GatewayPaths {
  basePath: string;
  workspacePath: string;
}

interface ResolvedGatewayTarget {
  cwd: string;
  command: string;
  args: string[];
  entryPoint: string;
  useShell: boolean;
}

export class GatewayService {
  private gatewayProcess: ChildProcessWithoutNullStreams | null = null;
  private gatewayPid: number | null = null;
  private gatewayCommandLine: string | null = null;
  private gatewayEntryPoint: string | null = null;
  private gatewayWorkingDirectory: string | null = null;

  constructor(
    private readonly paths: GatewayPaths,
    private readonly commandService: CommandService,
    private readonly logService: LogService,
  ) {}

  async getStatus(portInfo?: {occupied: boolean; pid: number | null}): Promise<GatewayStatus> {
    return {
      running: Boolean(this.gatewayProcess && !this.gatewayProcess.killed) || Boolean(portInfo?.occupied),
      pid: this.gatewayPid ?? portInfo?.pid ?? null,
      port: 18789,
      workingDirectory: this.gatewayWorkingDirectory,
      entryPoint: this.gatewayEntryPoint,
      commandLine: this.gatewayCommandLine,
      placeholder: !this.gatewayEntryPoint,
      gatewayBundleReady: Boolean(this.gatewayWorkingDirectory),
      gatewayEntrypointReady: Boolean(this.gatewayEntryPoint),
      gatewaySpawnable: Boolean(this.gatewayEntryPoint),
      degradedButUsable: !this.gatewayEntryPoint,
      advice: this.gatewayEntryPoint
        ? []
        : [
            'OpenClaw 运行时已就绪，Gateway 启动资源尚未配置。',
            '可导入 gateway bundle，或通过 OPENCLAW_GATEWAY_DIR 指定真实 OpenClaw 工作目录。',
          ],
    };
  }

  async startGateway(): Promise<ActionResult> {
    const target = await this.resolveGatewayTarget();
    if (!target) {
      await this.logService.warn('No real Gateway entrypoint found in workspace/base path/env override.', 'gateway');
      return {
        success: false,
        error: '未找到真实 Gateway 启动入口。请配置 OPENCLAW_GATEWAY_DIR 或补充 OpenClaw 工作目录。',
      };
    }

    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      return {success: true, result: 'Gateway 已在运行中', details: {pid: this.gatewayPid, entryPoint: this.gatewayEntryPoint}};
    }

    await this.logService.info(`Starting Gateway from ${target.cwd}`, 'gateway');
    const child = await this.commandService.startManagedProcess(target.command, target.args, {
      cwd: target.cwd,
      env: process.env,
      shell: target.useShell,
      source: 'gateway',
    });

    this.gatewayProcess = child;
    this.gatewayPid = child.pid ?? null;
    this.gatewayCommandLine = [target.command, ...target.args].join(' ');
    this.gatewayEntryPoint = target.entryPoint;
    this.gatewayWorkingDirectory = target.cwd;

    child.on('exit', (code) => {
      void this.logService.warn(`Gateway process exited with code ${code ?? 'null'}`, 'gateway');
      this.gatewayProcess = null;
      this.gatewayPid = null;
    });

    return {
      success: true,
      result: 'Gateway 已启动',
      details: {pid: this.gatewayPid, entryPoint: this.gatewayEntryPoint, cwd: this.gatewayWorkingDirectory},
    };
  }

  async stopGateway(): Promise<ActionResult> {
    if (!this.gatewayProcess || this.gatewayProcess.killed) {
      return {success: true, result: 'Gateway 当前未运行'};
    }

    await this.logService.warn(`Stopping Gateway process pid=${this.gatewayPid ?? 'unknown'}`, 'gateway');
    this.gatewayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (this.gatewayProcess && !this.gatewayProcess.killed) {
        this.gatewayProcess.kill('SIGKILL');
      }
    }, 3000);

    return {success: true, result: 'Gateway 停止信号已发送'};
  }

  async restartGateway(): Promise<ActionResult> {
    await this.stopGateway();
    return this.startGateway();
  }

  private async resolveGatewayTarget(): Promise<ResolvedGatewayTarget | null> {
    const configured = process.env.OPENCLAW_GATEWAY_DIR;
    const candidates = [
      configured,
      path.join(this.paths.workspacePath, 'gateway'),
      this.paths.workspacePath,
      path.join(this.paths.basePath, 'gateway'),
      path.join(this.paths.basePath, 'openclaw-gateway'),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (!this.isAllowedGatewayPath(candidate, configured)) {
        await this.logService.warn(`Blocked non-whitelisted gateway path: ${candidate}`, 'gateway');
        continue;
      }

      const resolved = await this.resolveFromDirectory(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  private async resolveFromDirectory(candidate: string): Promise<ResolvedGatewayTarget | null> {
    const packageJsonPath = path.join(candidate, 'package.json');
    const nodeEntrypoints = [
      path.join(candidate, 'dist', 'index.js'),
      path.join(candidate, 'server.js'),
      path.join(candidate, 'index.js'),
      path.join(candidate, 'app.js'),
    ];

    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath).catch(() => ({}));
      const scripts = packageJson.scripts ?? {};
      for (const scriptName of ['start:gateway', 'gateway:start', 'start']) {
        if (scripts[scriptName]) {
          return {
            cwd: candidate,
            command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
            args: ['run', scriptName],
            entryPoint: `npm run ${scriptName}`,
            useShell: false,
          };
        }
      }
    }

    for (const entry of nodeEntrypoints) {
      if (await fs.pathExists(entry)) {
        return {
          cwd: candidate,
          command: 'node',
          args: [entry],
          entryPoint: entry,
          useShell: false,
        };
      }
    }

    return null;
  }

  private isAllowedGatewayPath(target: string, configuredPath?: string) {
    const normalized = path.resolve(target).toLowerCase();
    const defaults = [
      path.resolve(this.paths.workspacePath).toLowerCase(),
      path.resolve(this.paths.basePath).toLowerCase(),
    ];
    const explicit = configuredPath ? [path.resolve(configuredPath).toLowerCase()] : [];
    const whitelist = [...defaults, ...explicit];
    return whitelist.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`));
  }
}
