import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandResult,
  FeishuConfigForm,
  ItemStatus,
  LauncherLogEntry,
  LauncherOverview,
  PersistedWorkflowState,
  RepairReport,
  ResourceFileStatus,
  RuntimeConfig,
  StatusItem,
  WorkflowStep,
  ModelConfigForm,
} from '../src/types/api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DISTRO_NAME = 'OpenClaw-Runtime';
const DASHBOARD_URL = 'http://127.0.0.1:3000';
const DEFAULT_MODEL = 'bailian/qwen3.5-plus';
const GATEWAY_SERVICE = 'openclaw-gateway.service';

const isWindows = process.platform === 'win32';
const isDev = !app.isPackaged;
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const appBaseDir = isDev ? path.join(process.cwd(), '.openclaw-launcher') : path.join(exeDir, 'OpenClawLauncherData');
const resourcesDir = isDev ? path.join(process.cwd(), 'resources') : path.join(process.resourcesPath, 'resources');
const logsFile = path.join(appBaseDir, 'openclaw-launcher.log');
const stateFile = path.join(appBaseDir, 'install-state.json');
const runtimeRoot = path.join(appBaseDir, 'runtime');
const installPath = path.join(runtimeRoot, DISTRO_NAME);
const configPathWindows = path.join(appBaseDir, 'openclaw.json');
const configPathLinux = '/home/openclaw/.openclaw/openclaw.json';
const skillsManifestPath = path.join(appBaseDir, 'skills-manifest.json');
const rootfsPath = path.join(resourcesDir, 'openclaw-rootfs.tar');
const skillsPackPath = path.join(resourcesDir, 'skills-pack.tar.gz');
const bailianKeyPath = path.join(resourcesDir, 'bailian_api_key.txt');
let mainWindow: BrowserWindow | null = null;
let lastError: CommandResult | null = null;
let lastRepair: RepairReport | null = null;
let workflowState: PersistedWorkflowState = {
  active: false,
  requiresReboot: false,
  lastCompletedStepIndex: -1,
  steps: [],
  resumedFromReboot: false,
  updatedAt: new Date().toISOString(),
};
const logEntries: LauncherLogEntry[] = [];

const runtimeConfig: RuntimeConfig = {
  installPath,
  runtimeDistro: DISTRO_NAME,
  dashboardUrl: DASHBOARD_URL,
  configPathLinux,
  configPathWindows,
};

function now() { return new Date().toISOString(); }
function ensureDirSync(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
async function ensureDir(dir: string) { await fsp.mkdir(dir, { recursive: true }); }
function emitWorkflow() { mainWindow?.webContents.send('openclaw:workflow', workflowState); }
function emitLog(entry: LauncherLogEntry) { mainWindow?.webContents.send('openclaw:log', entry); }
async function appendLog(level: LauncherLogEntry['level'], scope: string, message: string, command?: string, args?: string[]) {
  ensureDirSync(appBaseDir);
  const entry: LauncherLogEntry = { id: `${Date.now()}-${Math.random()}`, timestamp: now(), level, scope, message, command, args };
  logEntries.push(entry);
  if (logEntries.length > 500) logEntries.shift();
  const line = `[${entry.timestamp}] [${level.toUpperCase()}] [${scope}] ${message}${command ? ` :: ${command} ${args?.join(' ') ?? ''}` : ''}${os.EOL}`;
  await fsp.appendFile(logsFile, line, 'utf8');
  emitLog(entry);
}

async function saveWorkflow() {
  workflowState.updatedAt = now();
  await ensureDir(appBaseDir);
  await fsp.writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf8');
  emitWorkflow();
}

async function loadWorkflow() {
  try {
    workflowState = JSON.parse(await fsp.readFile(stateFile, 'utf8')) as PersistedWorkflowState;
  } catch {
    await saveWorkflow();
  }
}

function makeResult(step: string, command: string, args: string[], exitCode: number | null, stdout: string, stderr: string, startedAt: string, suggestion?: string): CommandResult {
  return { success: exitCode === 0, step, command, args, exitCode, stdout, stderr, startedAt, finishedAt: now(), suggestion };
}

async function runExe(step: string, file: string, args: string[], options?: { cwd?: string; input?: string | Buffer; allowFailure?: boolean }): Promise<CommandResult> {
  const startedAt = now();
  await appendLog('info', 'exec', `Running ${file}`, file, args);
  return await new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options?.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      const result = makeResult(step, file, args, -1, stdout, `${stderr}\n${String(error)}`, startedAt, '请确认当前环境为 Windows 且依赖命令存在。');
      lastError = result;
      void appendLog('error', 'exec', `Failed to start ${file}: ${error.message}`, file, args);
      resolve(result);
    });
    child.on('close', (code) => {
      const result = makeResult(step, file, args, code, stdout, stderr, startedAt);
      if (!result.success && !options?.allowFailure) {
        lastError = result;
        void appendLog('error', 'exec', `${file} exited with code ${String(code)}`, file, args);
      } else {
        void appendLog(result.success ? 'success' : 'warn', 'exec', `${file} finished with code ${String(code)}`, file, args);
      }
      resolve(result);
    });
    if (options?.input) {
      child.stdin.write(options.input as any);
      child.stdin.end();
    }
  });
}

async function runPowerShellFile(step: string, scriptPath: string, args: string[]) {
  return runExe(step, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]);
}

async function runWsl(step: string, args: string[], options?: { input?: string | Buffer; allowFailure?: boolean }) {
  return runExe(step, 'wsl.exe', args, options);
}

async function readConfigJson(): Promise<Record<string, any>> {
  try { return JSON.parse(await fsp.readFile(configPathWindows, 'utf8')); } catch { return {}; }
}
async function writeConfigJson(data: Record<string, any>) {
  await ensureDir(path.dirname(configPathWindows));
  await fsp.writeFile(configPathWindows, JSON.stringify(data, null, 2), 'utf8');
}
async function pushConfigIntoWsl(json: Record<string, any>) {
  const payload = JSON.stringify(json, null, 2);
  const results: CommandResult[] = [];
  results.push(await runWsl('ensure-config-dir', ['-d', DISTRO_NAME, '-u', 'root', '--', 'install', '-d', '-m', '755', '-o', 'openclaw', '-g', 'openclaw', '/home/openclaw/.openclaw']));
  results.push(await runWsl('write-linux-config', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'tee', configPathLinux], { input: payload }));
  return results;
}
async function readOptionalFile(filePath: string) {
  try { return (await fsp.readFile(filePath, 'utf8')).trim(); } catch { return ''; }
}
function resourceStatus(filePath: string, required: boolean): ResourceFileStatus {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, path: filePath, required, size: stat.size, message: `${path.basename(filePath)} 已找到` };
  } catch {
    return { exists: false, path: filePath, required, size: null, message: `${path.basename(filePath)} ${required ? '缺失' : '未提供'}` };
  }
}
async function detectAdmin(): Promise<boolean> {
  if (!isWindows) return false;
  const result = await runExe('detect-admin', 'net', ['session'], { allowFailure: true });
  return result.success;
}
async function queryWindowsFeature(name: string) {
  if (!isWindows) return { status: 'error' as ItemStatus, detail: '仅支持 Windows' };
  const result = await runExe(`feature-${name}`, 'dism.exe', ['/online', '/Get-FeatureInfo', `/FeatureName:${name}`], { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/Enable Pending/i.test(output)) return { status: 'reboot_required' as ItemStatus, detail: '功能已启用，等待重启' };
  if (/State : Enabled/i.test(output)) return { status: 'installed' as ItemStatus, detail: '功能已启用' };
  if (/State : Disabled/i.test(output)) return { status: 'not_installed' as ItemStatus, detail: '功能未启用' };
  return { status: 'error' as ItemStatus, detail: output.trim() || '无法检测功能状态' };
}
async function ensureWindowsFeature(name: string) {
  return runExe(`enable-${name}`, 'dism.exe', ['/online', '/Enable-Feature', `/FeatureName:${name}`, '/All', '/NoRestart']);
}
async function detectRuntime() {
  const list = await runWsl('wsl-list', ['-l', '-v'], { allowFailure: true });
  const whoami = await runWsl('runtime-whoami', ['-d', DISTRO_NAME, '--', 'whoami'], { allowFailure: true });
  const version = await runWsl('runtime-version', ['-d', DISTRO_NAME, '--', 'openclaw', '--version'], { allowFailure: true });
  return { list, whoami, version };
}
async function serviceCheck(subcommand: 'is-active' | 'is-enabled') {
  return runWsl(`systemctl-${subcommand}`, ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'systemctl', '--user', subcommand, GATEWAY_SERVICE], { allowFailure: true });
}
async function dashboardCheck() {
  return runWsl('dashboard-check', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'openclaw', 'dashboard', 'url'], { allowFailure: true });
}
async function detectSkills() {
  try {
    const manifest = JSON.parse(await fsp.readFile(skillsManifestPath, 'utf8')) as { count: number; importedAt: string };
    return { imported: true, count: manifest.count, detail: `已导入 ${manifest.count} 个技能（${manifest.importedAt}）` };
  } catch {
    return { imported: false, count: null, detail: '尚未导入技能包' };
  }
}

function makeCheck(key: string, title: string, status: ItemStatus, description: string, detail: string, actionLabel?: string): StatusItem {
  return { key, title, status, description, detail, actionLabel };
}

async function getOverview(): Promise<LauncherOverview> {
  const config = await readConfigJson();
  const admin = await detectAdmin();
  const wslFeature = await queryWindowsFeature('Microsoft-Windows-Subsystem-Linux');
  const vmpFeature = await queryWindowsFeature('VirtualMachinePlatform');
  const runtime = await detectRuntime();
  const active = await serviceCheck('is-active');
  const enabled = await serviceCheck('is-enabled');
  const dashboard = await dashboardCheck();
  const skills = await detectSkills();
  const checks: StatusItem[] = [
    makeCheck('admin', '管理员权限', admin ? 'installed' : 'error', '必须以管理员权限运行，才能启用系统功能和导入 Runtime。', admin ? '已检测到管理员权限。' : '当前未检测到管理员权限。', '重新以管理员身份启动'),
    makeCheck('windows64', 'Windows 64 位支持', os.arch() === 'x64' ? 'installed' : 'error', '只支持 64 位 Windows。', `${os.platform()} / ${os.arch()}`),
    makeCheck('wsl', 'WSL 功能', wslFeature.status, 'Windows Subsystem for Linux 功能状态。', wslFeature.detail, '启用 WSL'),
    makeCheck('vmp', 'VirtualMachinePlatform', vmpFeature.status, 'WSL2 所需的虚拟机平台功能。', vmpFeature.detail, '启用 VirtualMachinePlatform'),
    makeCheck('resume', '重启恢复状态', workflowState.requiresReboot ? 'reboot_required' : 'configured', '安装流程支持重启后恢复。', workflowState.requiresReboot ? '等待系统重启后恢复安装。' : '未等待重启。'),
    makeCheck('runtime', 'OpenClaw Runtime', runtime.list.stdout.includes(DISTRO_NAME) ? 'installed' : 'not_installed', 'WSL 发行版导入状态。', runtime.list.stdout || runtime.list.stderr || '尚未导入 Runtime。', '导入 Runtime'),
    makeCheck('systemd', 'systemd 用户服务', runtime.whoami.success && runtime.whoami.stdout.trim() === 'openclaw' ? 'configured' : 'fixable', '默认用户必须是 openclaw，且启用 systemd。', runtime.whoami.stdout.trim() || runtime.whoami.stderr || '无法验证默认用户。', '修复 systemd'),
    makeCheck('gateway', 'Gateway 服务', active.success && active.stdout.trim() === 'active' ? 'running' : enabled.success ? 'stopped' : 'fixable', 'OpenClaw Gateway 用户级服务。', `${active.stdout || active.stderr} ${enabled.stdout || enabled.stderr}`.trim() || '服务未安装', '重启 Gateway'),
    makeCheck('config', '主配置文件', fs.existsSync(configPathWindows) ? 'configured' : 'not_configured', '配置必须同步到 Windows 侧和 WSL 内的 /home/openclaw。', fs.existsSync(configPathWindows) ? configPathWindows : '配置文件不存在。', '生成配置'),
    makeCheck('bailian', 'Bailian 模型配置', config.models?.providers?.bailian?.api_key ? 'configured' : 'not_configured', 'Bailian API Key 与默认模型。', config.models?.defaults?.primary || '尚未配置默认模型。', '写入 Bailian 配置'),
    makeCheck('feishu', '飞书对接状态', config.channels?.feishu?.app_id && config.channels?.feishu?.app_secret ? 'configured' : 'not_configured', '飞书 App ID / App Secret。', config.channels?.feishu?.app_id ? '已保存 App ID' : '未配置飞书信息。', '写入飞书配置'),
    makeCheck('skills', '技能包状态', skills.imported ? 'configured' : 'not_configured', 'skills-pack.tar.gz 导入状态。', skills.detail, '导入技能包'),
    makeCheck('final', '最终验收状态', runtime.version.success && active.success && dashboard.success ? 'running' : 'fixable', '安装完成后需要通过 Runtime / Gateway / Dashboard 验收。', [runtime.version.stdout, active.stdout, dashboard.stdout].filter(Boolean).join(' | ') || '尚未完成最终验收。'),
  ];
  return {
    generatedAt: now(),
    platform: `${process.platform}/${os.arch()}`,
    runtime: runtimeConfig,
    paths: { appBaseDir, logsFile, stateFile, resourcesDir, rootfsPath, skillsPackPath, bailianKeyPath },
    resources: { rootfs: resourceStatus(rootfsPath, true), skillsPack: resourceStatus(skillsPackPath, false), bailianApiKey: resourceStatus(bailianKeyPath, false) },
    checks,
    workflow: workflowState,
    modelConfig: {
      configured: Boolean(config.models?.providers?.bailian?.api_key),
      apiKeyPresent: Boolean(config.models?.providers?.bailian?.api_key),
      defaultModel: config.models?.defaults?.primary ?? null,
    },
    feishuConfig: {
      configured: Boolean(config.channels?.feishu?.app_id && config.channels?.feishu?.app_secret),
      appIdPresent: Boolean(config.channels?.feishu?.app_id),
      appSecretPresent: Boolean(config.channels?.feishu?.app_secret),
    },
    skills,
    lastError,
    lastRepair,
    logsTail: logEntries.slice(-20),
  };
}

async function updateStep(index: number, patch: Partial<WorkflowStep>) {
  workflowState.steps[index] = { ...workflowState.steps[index], ...patch, updatedAt: now() };
  if (patch.status === 'completed') workflowState.lastCompletedStepIndex = index;
  await saveWorkflow();
}

async function initializeWorkflow() {
  workflowState = {
    active: true,
    requiresReboot: false,
    lastCompletedStepIndex: -1,
    resumedFromReboot: workflowState.resumedFromReboot,
    updatedAt: now(),
    steps: [
      { id: 'system-checks', title: '系统层检查与启用', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'reboot-recovery', title: '重启恢复注册', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'import-runtime', title: 'Runtime 导入', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'systemd', title: 'systemd 与默认用户修复', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'gateway-install', title: 'Gateway 官方安装', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'write-config', title: '主配置生成', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'bailian-config', title: 'Bailian 默认模型写入', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'skills-pack', title: '技能包导入', status: 'pending', message: '等待执行', updatedAt: now() },
      { id: 'final-acceptance', title: '最终验收', status: 'pending', message: '等待执行', updatedAt: now() },
    ],
  };
  await saveWorkflow();
}

async function registerRebootResume() {
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--resume-install'] });
  workflowState.requiresReboot = true;
  await saveWorkflow();
}

async function clearRebootResume() {
  app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--resume-install'] });
  workflowState.requiresReboot = false;
  workflowState.resumedFromReboot = false;
  await saveWorkflow();
}

async function performSystemChecks() {
  const results: CommandResult[] = [];
  if (!isWindows) {
    const failure = makeResult('platform', 'platform-check', [], -1, '', 'This installer requires Windows.', now(), '请在 Windows 10/11 x64 环境运行。');
    lastError = failure;
    return [failure];
  }
  results.push(await runExe('check-arch', 'cmd.exe', ['/c', 'echo', process.arch]));
  const wsl = await queryWindowsFeature('Microsoft-Windows-Subsystem-Linux');
  if (wsl.status === 'not_installed') results.push(await ensureWindowsFeature('Microsoft-Windows-Subsystem-Linux'));
  const vmp = await queryWindowsFeature('VirtualMachinePlatform');
  if (vmp.status === 'not_installed') results.push(await ensureWindowsFeature('VirtualMachinePlatform'));
  if ([wsl.status, vmp.status].includes('reboot_required')) {
    workflowState.requiresReboot = true;
  }
  return results;
}

async function importRuntime() {
  const results: CommandResult[] = [];
  const stat = await fsp.stat(rootfsPath);
  if (stat.size < 10 * 1024 * 1024) throw new Error(`rootfs 文件过小: ${stat.size}`);
  results.push(await runWsl('shutdown-wsl', ['--shutdown'], { allowFailure: true }));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  results.push(await runWsl('unregister-old-runtime', ['--unregister', DISTRO_NAME], { allowFailure: true }));
  await fsp.rm(installPath, { recursive: true, force: true });
  await ensureDir(installPath);
  results.push(await runWsl('import-runtime', ['--import', DISTRO_NAME, installPath, rootfsPath]));
  results.push(await runWsl('verify-runtime-list', ['-l', '-v']));
  results.push(await runWsl('verify-openclaw-version', ['-d', DISTRO_NAME, '--', 'openclaw', '--version']));
  return results;
}

async function configureSystemd() {
  const results: CommandResult[] = [];
  const wslConf = '[boot]\nsystemd=true\n[user]\ndefault=openclaw\n';
  results.push(await runWsl('write-wsl-conf', ['-d', DISTRO_NAME, '-u', 'root', '--', 'tee', '/etc/wsl.conf'], { input: wslConf }));
  results.push(await runWsl('enable-linger', ['-d', DISTRO_NAME, '-u', 'root', '--', 'loginctl', 'enable-linger', 'openclaw'], { allowFailure: true }));
  return results;
}

async function installGateway() {
  const results: CommandResult[] = [];
  results.push(await runWsl('onboard-daemon', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'openclaw', 'onboard', '--non-interactive', '--install-daemon'], { allowFailure: true }));
  results.push(await runWsl('gateway-install', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'openclaw', 'gateway', 'install'], { allowFailure: true }));
  results.push(await serviceCheck('is-enabled'));
  results.push(await serviceCheck('is-active'));
  return results;
}

function withBaseConfig(existing: Record<string, any>, defaultModel: string, apiKey?: string) {
  const next = structuredClone(existing ?? {});
  next.gateway = { ...(next.gateway ?? {}), mode: 'local' };
  next.models = next.models ?? {};
  next.models.providers = next.models.providers ?? {};
  next.models.providers.bailian = {
    ...(next.models.providers.bailian ?? {}),
    api_key: apiKey ?? next.models.providers.bailian?.api_key ?? '',
    model: defaultModel,
  };
  next.models.defaults = { ...(next.models.defaults ?? {}), primary: defaultModel };
  next.agents = next.agents ?? {};
  next.agents.defaults = next.agents.defaults ?? {};
  next.agents.defaults.models = [defaultModel];
  return next;
}

async function writeModelConfig(payload: ModelConfigForm) {
  const apiKey = payload.apiKey || (await readOptionalFile(bailianKeyPath));
  const config = withBaseConfig(await readConfigJson(), payload.defaultModel || DEFAULT_MODEL, apiKey);
  await writeConfigJson(config);
  const syncResults = await pushConfigIntoWsl(config);
  const restartResults = await restartGateway();
  return [...syncResults, ...restartResults];
}

async function writeFeishuConfig(payload: FeishuConfigForm) {
  const config = await readConfigJson();
  config.channels = config.channels ?? {};
  config.channels.feishu = { app_id: payload.appId, app_secret: payload.appSecret };
  await writeConfigJson(config);
  const syncResults = await pushConfigIntoWsl(config);
  const restartResults = await restartGateway();
  return [...syncResults, ...restartResults];
}

async function importSkillsPack() {
  const results: CommandResult[] = [];
  if (!fs.existsSync(skillsPackPath)) throw new Error('skills-pack.tar.gz 不存在');
  results.push(await runWsl('skills-dir', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'install', '-d', '/home/openclaw/.openclaw/skills']));
  results.push(await runWsl('skills-import', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'tar', '-xzf', '-', '-C', '/home/openclaw/.openclaw/skills'], { input: await fsp.readFile(skillsPackPath) }));
  const listResult = await runWsl('skills-count', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'find', '/home/openclaw/.openclaw/skills', '-mindepth', '1', '-maxdepth', '1', '-type', 'd'], { allowFailure: true });
  results.push(listResult);
  const count = listResult.stdout.split('\n').filter(Boolean).length;
  await fsp.writeFile(skillsManifestPath, JSON.stringify({ count, importedAt: now() }, null, 2), 'utf8');
  return results;
}

async function restartGateway() {
  return [
    await runWsl('restart-gateway', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'systemctl', '--user', 'restart', GATEWAY_SERVICE], { allowFailure: true }),
    await serviceCheck('is-active'),
  ];
}

async function finalAcceptance() {
  return [
    ...(await detectRuntime()).version ? [await runWsl('accept-version', ['-d', DISTRO_NAME, '--', 'openclaw', '--version'], { allowFailure: true })] : [],
    await serviceCheck('is-active'),
    await dashboardCheck(),
  ];
}

async function executeWorkflow(startIndex = 0) {
  const allResults: CommandResult[] = [];
  const runners: Array<() => Promise<CommandResult[]>> = [
    performSystemChecks,
    async () => { await registerRebootResume(); return [makeResult('reboot-recovery', 'login-item', ['--resume-install'], 0, 'Registered', '', now())]; },
    importRuntime,
    configureSystemd,
    installGateway,
    async () => {
      const config = withBaseConfig(await readConfigJson(), DEFAULT_MODEL, await readOptionalFile(bailianKeyPath));
      await writeConfigJson(config);
      return pushConfigIntoWsl(config);
    },
    async () => writeModelConfig({ apiKey: await readOptionalFile(bailianKeyPath), defaultModel: DEFAULT_MODEL }),
    async () => fs.existsSync(skillsPackPath) ? importSkillsPack() : [makeResult('skills-pack', 'resource-check', [skillsPackPath], 0, 'skills-pack.tar.gz not provided', '', now())],
    finalAcceptance,
  ];
  for (let index = startIndex; index < workflowState.steps.length; index += 1) {
    await updateStep(index, { status: 'running', message: '执行中' });
    try {
      const results = await runners[index]();
      allResults.push(...results);
      const failed = results.find((item) => !item.success && item.exitCode !== 0);
      if (failed) {
        await updateStep(index, { status: 'failed', message: failed.stderr || failed.stdout || '步骤失败', result: failed });
        throw new Error(failed.stderr || failed.stdout || `步骤 ${workflowState.steps[index].title} 失败`);
      }
      await updateStep(index, { status: 'completed', message: '已完成', result: results.at(-1) });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const fallback = makeResult(workflowState.steps[index].id, 'internal', [], -1, '', failure, now(), '请查看日志并根据 stderr 修复环境。');
      lastError = fallback;
      await updateStep(index, { status: 'failed', message: failure, result: fallback });
      throw error;
    }
  }
  workflowState.active = false;
  await clearRebootResume();
  await saveWorkflow();
  return allResults;
}

async function installAll() {
  await initializeWorkflow();
  return executeWorkflow(0);
}
async function resumeInstall() {
  if (!workflowState.steps.length) await loadWorkflow();
  workflowState.active = true;
  workflowState.resumedFromReboot = true;
  await saveWorkflow();
  return executeWorkflow(workflowState.lastCompletedStepIndex + 1);
}
async function repairAll(): Promise<RepairReport> {
  const results = [
    ...(await configureSystemd()),
    ...(await installGateway()),
    ...(await writeModelConfig({ apiKey: await readOptionalFile(bailianKeyPath), defaultModel: DEFAULT_MODEL })),
    ...(await restartGateway()),
    ...(await finalAcceptance()),
  ];
  lastRepair = { title: '一键修复全部', results };
  return lastRepair;
}
async function uninstallOpenClaw() {
  const results = [
    await runWsl('stop-gateway', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'systemctl', '--user', 'stop', GATEWAY_SERVICE], { allowFailure: true }),
    await runWsl('shutdown-runtime', ['--shutdown'], { allowFailure: true }),
    await runWsl('unregister-runtime', ['--unregister', DISTRO_NAME], { allowFailure: true }),
  ];
  await fsp.rm(runtimeRoot, { recursive: true, force: true });
  await fsp.rm(configPathWindows, { force: true });
  await fsp.rm(stateFile, { force: true });
  await fsp.rm(skillsManifestPath, { force: true });
  await clearRebootResume();
  return results;
}
async function uninstallEverything() {
  const results = await uninstallOpenClaw();
  results.push(await runExe('disable-wsl', 'dism.exe', ['/online', '/Disable-Feature', '/FeatureName:Microsoft-Windows-Subsystem-Linux', '/NoRestart'], { allowFailure: true }));
  results.push(await runExe('disable-vmp', 'dism.exe', ['/online', '/Disable-Feature', '/FeatureName:VirtualMachinePlatform', '/NoRestart'], { allowFailure: true }));
  return results;
}
async function testModelConfig(payload: ModelConfigForm) {
  return runWsl('test-model', ['-d', DISTRO_NAME, '-u', 'openclaw', '--', 'openclaw', 'models', 'test', '--provider', 'bailian', '--model', payload.defaultModel || DEFAULT_MODEL], { allowFailure: true });
}
async function openDashboard() {
  const result = makeResult('open-dashboard', 'shell.openExternal', [DASHBOARD_URL], 0, DASHBOARD_URL, '', now());
  await shell.openExternal(DASHBOARD_URL);
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    title: 'OpenClaw Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  mainWindow.removeMenu();
}

function registerIpc() {
  ipcMain.handle('openclaw:get-overview', () => getOverview());
  ipcMain.handle('openclaw:get-logs', async () => {
    try { return await fsp.readFile(logsFile, 'utf8'); } catch { return ''; }
  });
  ipcMain.handle('openclaw:install-all', () => installAll());
  ipcMain.handle('openclaw:resume-install', () => resumeInstall());
  ipcMain.handle('openclaw:repair-all', () => repairAll());
  ipcMain.handle('openclaw:write-model-config', (_e, payload: ModelConfigForm) => writeModelConfig(payload));
  ipcMain.handle('openclaw:test-model-config', (_e, payload: ModelConfigForm) => testModelConfig(payload));
  ipcMain.handle('openclaw:write-feishu-config', (_e, payload: FeishuConfigForm) => writeFeishuConfig(payload));
  ipcMain.handle('openclaw:import-skills-pack', () => importSkillsPack());
  ipcMain.handle('openclaw:restart-gateway', () => restartGateway());
  ipcMain.handle('openclaw:open-dashboard', () => openDashboard());
  ipcMain.handle('openclaw:uninstall-openclaw', () => uninstallOpenClaw());
  ipcMain.handle('openclaw:uninstall-everything', () => uninstallEverything());
  ipcMain.handle('openclaw:clear-logs', async () => {
    logEntries.length = 0;
    await fsp.writeFile(logsFile, '', 'utf8');
  });
}

app.whenReady().then(async () => {
  ensureDirSync(appBaseDir);
  await loadWorkflow();
  await appendLog('info', 'launcher', 'OpenClaw Launcher main process ready');
  registerIpc();
  createWindow();
  if (process.argv.includes('--resume-install') && workflowState.active) {
    void resumeInstall();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

export { runExe, runPowerShellFile };
