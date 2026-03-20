import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs-extra';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockDir = path.join(__dirname, '.mock-data');
const configFile = path.join(mockDir, 'openclaw.json');
const stateFile = path.join(mockDir, 'install-state.json');
const logFile = path.join(mockDir, 'openclaw.log');
const statusFile = path.join(mockDir, 'status.json');
const PORT = Number(process.env.MOCK_API_PORT ?? 3000);

const defaultStatus = {
  isAdmin: false,
  is64Bit: true,
  node: {isOk: false, version: 'not_installed'},
  git: {isOk: false, version: 'not_installed'},
  wsl: 'not_installed',
  vmPlatform: 'not_installed',
  sandboxFeature: 'not_installed',
  runtime: 'not_installed',
  gateway: 'stopped',
  configExists: false,
  skillPackExists: false,
  port18789: {
    occupied: false,
    port: 18789,
    pid: null,
    protocol: null,
    rawOutput: '',
    advice: ['Mock：端口空闲。'],
  },
  offlineResources: {
    exists: false,
    basePath: 'offline_resources',
    missingFiles: ['WSL 包', 'Node 离线包', 'rootfs / 镜像包', '校验文件'],
    invalidFiles: [],
    detectedFiles: [],
    modeSuggestion: 'online',
    advice: ['Mock：离线资源目录不存在。'],
  },
  gatewayDetails: {
    running: false,
    pid: null,
    port: 18789,
    workingDirectory: null,
    entryPoint: null,
    commandLine: null,
    placeholder: true,
    advice: ['Mock：Gateway 尚未启动。'],
  },
  localResources: {
    folderExists: false,
    rootfsExists: false,
    path: 'Mock 模式：未挂载 resources/openclaw-rootfs.tar',
  },
};

function deepMerge(target: Record<string, any>, source: Record<string, any>) {
  const output = {...target};
  Object.entries(source).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(output[key] ?? {}, value as Record<string, any>);
    } else {
      output[key] = value;
    }
  });
  return output;
}

async function ensureFiles() {
  await fs.ensureDir(mockDir);
  if (!(await fs.pathExists(statusFile))) await fs.writeJson(statusFile, defaultStatus, {spaces: 2});
  if (!(await fs.pathExists(stateFile))) await fs.writeJson(stateFile, {currentStep: 0, completed: [], isInstalling: false}, {spaces: 2});
  if (!(await fs.pathExists(logFile))) await fs.writeFile(logFile, '');
}

async function appendLog(message: string) {
  await fs.appendFile(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

async function readStatus() {
  const current = (await fs.readJson(statusFile)) as Partial<typeof defaultStatus>;
  return deepMerge(defaultStatus, current) as typeof defaultStatus;
}

async function writeStatus(patch: Partial<typeof defaultStatus>) {
  const next = deepMerge(await readStatus(), patch) as typeof defaultStatus;
  await fs.writeJson(statusFile, next, {spaces: 2});
  return next;
}

function diagnosticsFromStatus(status: typeof defaultStatus) {
  return [
    {
      id: 'port-18789-in-use',
      title: 'Port 18789 检查',
      status: status.port18789.occupied ? 'error' : 'healthy',
      summary: status.port18789.occupied ? 'Mock：端口被占用' : 'Mock：端口空闲',
      details: status.port18789.advice,
      repairable: Boolean(status.port18789.pid),
      repairAction: 'killPortProcess',
    },
    {
      id: 'node-missing-or-unsupported',
      title: 'Node.js 版本检查',
      status: status.node.isOk ? 'healthy' : 'error',
      summary: status.node.isOk ? 'Mock：Node 可用' : 'Mock：Node 缺失',
      details: ['Mock：浏览器模式仅用于 UI 骨架预览。'],
      repairable: true,
      repairAction: 'installNodeOffline',
    },
  ];
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get('/api/status', async (_req, res) => {
  const status = await readStatus();
  res.json({...status, diagnostics: diagnosticsFromStatus(status)});
});
app.get('/api/read-config', async (_req, res) => {
  res.json((await fs.pathExists(configFile)) ? await fs.readJson(configFile) : {});
});
app.post('/api/test-model', async (req, res) => {
  await appendLog(`Mock model test: ${req.body.provider}`);
  res.json({success: true, message: `Mock 模式：${req.body.provider} 配置校验通过`});
});
app.post('/api/test-channel', async (req, res) => {
  await appendLog(`Mock channel test: ${req.body.channel}`);
  res.json({success: true, message: `Mock 模式：${req.body.channel} 渠道测试通过`});
});
app.get('/api/logs', async (_req, res) => {
  res.type('text/plain').send((await fs.pathExists(logFile)) ? await fs.readFile(logFile, 'utf8') : '');
});
app.post('/api/export-logs', async (_req, res) => {
  const exportPath = path.join(mockDir, `export-${Date.now()}.log`);
  await fs.copyFile(logFile, exportPath);
  res.json({success: true, result: `Mock 日志已导出到 ${exportPath}`, details: {exportPath}});
});
app.post('/api/execute', async (req, res) => {
  const {step, config, url} = req.body;
  await appendLog(`Mock execute: ${step}`);

  switch (step) {
    case 'startGateway':
    case 'startGatewayAndOpen':
    case 'restartGateway':
    case 'setupGateway':
      await writeStatus({
        gateway: 'running',
        port18789: {occupied: true, port: 18789, pid: 9527, protocol: 'TCP', rawOutput: 'LISTENING 9527', advice: ['Mock：Gateway 占用端口。']},
      });
      break;
    case 'stopGateway':
    case 'killPortProcess':
      await writeStatus({
        gateway: 'stopped',
        port18789: {occupied: false, port: 18789, pid: null, protocol: null, rawOutput: '', advice: ['Mock：端口已释放。']},
      });
      break;
    case 'writeConfig': {
      const current = (await fs.pathExists(configFile)) ? await fs.readJson(configFile) : {};
      const merged = deepMerge(current, config ?? {});
      await fs.writeJson(configFile, merged, {spaces: 2});
      await writeStatus({configExists: true});
      break;
    }
    case 'deleteConfig':
      await fs.remove(configFile);
      await writeStatus({configExists: false});
      break;
    case 'resetRuntime':
    case 'deleteRuntime':
    case 'uninstall':
      await fs.writeJson(statusFile, defaultStatus, {spaces: 2});
      break;
    case 'openUrl':
      await appendLog(`Mock skip openUrl: ${url}`);
      break;
    default:
      break;
  }

  res.json({success: true, result: `Mock 已执行 ${step}`});
});
app.get('/api/get-state', async (_req, res) => res.json(await fs.readJson(stateFile)));
app.post('/api/set-state', async (req, res) => {
  await fs.writeJson(stateFile, req.body, {spaces: 2});
  res.json({success: true});
});
app.post('/api/clear-logs', async (_req, res) => {
  await fs.writeFile(logFile, '');
  res.json({success: true});
});
app.get('/api/diagnostics', async (_req, res) => {
  res.json(diagnosticsFromStatus(await readStatus()));
});
app.post('/api/repair-diagnostic', async (req, res) => {
  await appendLog(`Mock repair diagnostic: ${req.body.id}`);
  res.json({success: true, result: `Mock 已修复 ${req.body.id}`});
});

ensureFiles().then(() => {
  app.listen(PORT, () => {
    console.log(`OpenClaw mock API listening on http://localhost:${PORT}`);
  });
});
