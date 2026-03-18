import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// --- Portable Path Logic ---
// 1. Get the REAL directory where the .exe resides (Portable support)
const EXE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const BASE_PATH = isDev ? process.cwd() : EXE_DIR;

// 2. Hardcoded Permanent WSL Target Directory (Avoid Temp!)
const WSL_TARGET_ROOT = path.join(app.getPath('userData'), 'WSL_Runtime');

const LOG_FILE = path.join(BASE_PATH, "openclaw_launcher.log");
const STATE_FILE = path.join(BASE_PATH, "install_state.json");
const CONFIG_DIR = path.join(app.getPath('home'), ".openclaw");
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");

// Helper to log messages
async function log(message: string) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  console.log(logEntry.trim());
  try {
    await fs.appendFile(LOG_FILE, logEntry);
  } catch (err) {
    console.error("Failed to write to log file", err);
  }
}

// Helper to execute PowerShell commands with timeout and error handling
function runPowerShell(command: string): Promise<{ stdout: string; stderr: string; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Use EncodedCommand to avoid quoting hell in PowerShell
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const fullCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
    
    // Remove timeout and increase buffer for long-running WSL imports
    const child = exec(fullCommand, { timeout: 0, maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ stdout, stderr, success: false, error: error.message });
      } else {
        resolve({ stdout, stderr, success: true });
      }
    });
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "OpenClaw Launcher",
    icon: path.join(__dirname, '../public/favicon.ico'),
    webPreferences: {
      nodeIntegration: false, // Security best practice
      contextIsolation: true,  // Security best practice
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false
    },
  });

  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL;
    if (url) {
      mainWindow.loadURL(url);
    } else {
      mainWindow.loadURL('http://localhost:5173');
    }
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.setMenuBarVisibility(false);
}

// --- IPC Handlers ---

ipcMain.handle('get-status', async () => {
  try {
    const status: any = {};

    // 1. Admin Check
    const adminRes = await runPowerShell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')");
    status.isAdmin = adminRes.success && adminRes.stdout.trim() === "True";

    // 2. Node.js & npm Check (Inside WSL)
    const nodeRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime node -v");
    if (nodeRes.success) {
      const version = nodeRes.stdout.trim().replace("v", "");
      const major = parseInt(version.split(".")[0]);
      status.node = { version, isOk: major >= 22 };
    } else {
      status.node = { version: "not_installed", isOk: false };
    }

    // 3. Git Check (Inside WSL)
    const gitRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime git --version");
    if (gitRes.success) {
      const versionMatch = gitRes.stdout.match(/(\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : "unknown";
      status.git = { version, isOk: gitRes.stdout.includes("git version") };
    } else {
      status.git = { version: "not_installed", isOk: false };
    }

    status.is64Bit = process.arch === "x64";

    // 6. WSL Check
    const wslRes = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux");
    status.wsl = (wslRes.success && wslRes.stdout.includes("Enabled")) ? "installed" : "not_installed";

    // 7. VM Platform Check
    const vmRes = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform");
    status.vmPlatform = (vmRes.success && vmRes.stdout.includes("Enabled")) ? "installed" : "not_installed";

    // 8. Windows Sandbox Check
    const sbRes = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName " + (process.arch === "x64" ? "Containers-DisposableClientVM" : "Windows-Sandbox"));
    status.sandboxFeature = (sbRes.success && sbRes.stdout.includes("Enabled")) ? "installed" : "not_installed";

    // 9. Runtime Check
    const rtRes = await runPowerShell("wsl.exe -l -v");
    status.runtime = (rtRes.success && rtRes.stdout.includes("OpenClaw-Runtime")) ? "installed" : "not_installed";

    // 10. Gateway Check
    const gwRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime systemctl is-active openclaw-gateway");
    status.gateway = (gwRes.success && gwRes.stdout.includes("active")) ? "running" : "stopped";

    status.configExists = await fs.pathExists(CONFIG_FILE);
    const skillPackPath = path.join(BASE_PATH, "skills-pack.tar.gz");
    status.skillPackExists = await fs.pathExists(skillPackPath);

    // 12. Local Resource Check (Portable Logic)
    const rootfsPath = path.join(BASE_PATH, "resources", "openclaw-rootfs.tar");
    const rootfsExists = await fs.pathExists(rootfsPath);

    status.localResources = {
      folderExists: rootfsExists,
      rootfsExists: rootfsExists,
      path: rootfsExists ? rootfsPath : `未检测到本地资源包 (检测路径: ${path.join(BASE_PATH, 'resources')})`
    };

    return status;
  } catch (error: any) {
    console.error("Status check failed", error);
    return { error: error.message };
  }
});

// Helper for deep merging objects
function isObject(item: any) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

function deepMerge(target: any, source: any) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  return output;
}

async function executeActionLogic(step: string, action?: string, extra: any = {}) {
  let result = "";
  switch (step) {
    // --- 环境检测与基础安装 ---
    case "admin":
      const adminCheck = await runPowerShell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')");
      if (adminCheck.success && adminCheck.stdout.trim() === "True") {
        result = "当前已具备管理员权限。";
      } else {
        throw new Error("请右键以管理员身份运行此程序，或在属性中勾选“以管理员身份运行”。");
      }
      break;

    case "wsl":
      await log("Enabling WSL feature...");
      const wslEnable = await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart");
      if (!wslEnable.success) throw new Error(`开启 WSL 失败: ${wslEnable.error}`);
      result = "WSL 功能已开启，建议重启电脑以生效。";
      break;

    case "vmPlatform":
      await log("Enabling Virtual Machine Platform...");
      const vmEnable = await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart");
      if (!vmEnable.success) throw new Error(`开启虚拟机平台失败: ${vmEnable.error}`);
      result = "虚拟机平台已开启，建议重启电脑以生效。";
      break;

    case "importRuntime":
    case "installRuntime":
    case "runtime": // 兼容修复页面的 issue.id
      await log("Importing OpenClaw Runtime...");
      const sourcePath = path.join(BASE_PATH, "resources", "openclaw-rootfs.tar");
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`资源缺失: ${sourcePath}\n请确保 resources 文件夹内包含 openclaw-rootfs.tar`);
      }
      const installPath = path.join(WSL_TARGET_ROOT, "runtime");
      
      await log("Releasing WSL file locks...");
      // 1. Shutdown WSL to stop background processes
      await runPowerShell("wsl.exe --shutdown");
      // 2. Unregister to release the VHDX file handle (crucial for EBUSY fix)
      // Use try-catch or ignore error if distro doesn't exist
      await runPowerShell("wsl.exe --unregister OpenClaw-Runtime").catch(() => {});
      
      await log(`Preparing clean target directory: ${installPath}`);
      // Now it's safe to delete/empty the directory
      await fs.ensureDir(installPath);
      await fs.emptyDir(installPath);
      
      await log(`Ensuring WSL 2 is default...`);
      await runPowerShell("wsl.exe --set-default-version 2");
      
      await log(`Importing to: ${installPath} (this may take a while)`);
      // Use double quotes for paths in the command string
      const importRes = await runPowerShell(`wsl.exe --import OpenClaw-Runtime "${installPath}" "${sourcePath}"`);
      if (!importRes.success) {
        const fullError = importRes.stderr || importRes.error || "未知错误";
        throw new Error(`导入失败: ${fullError}`);
      }
      result = "环境镜像导入成功";
      break;

    // --- Gateway 服务控制 ---
    case "gateway":
    case "setupGateway":
    case "startGatewayAndOpen":
      await log("Configuring and starting Gateway...");
      
      // 检查分发是否存在
      const listRes = await runPowerShell("wsl.exe -l -v");
      if (!listRes.stdout.includes("OpenClaw-Runtime")) {
        await log("Runtime not found, attempting to import first...");
        await executeActionLogic("importRuntime");
      }

      // 1. 强制开启 systemd
      await log("Enabling systemd in wsl.conf...");
      await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- bash -c \"echo -e '[boot]\\nsystemd=true' > /etc/wsl.conf\"");
      await runPowerShell("wsl.exe --terminate OpenClaw-Runtime");
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 2. 检查并安装必要组件 (Node.js 22, Git)
      await log("Checking for Node.js and Git inside WSL...");
      const checkNode = await runPowerShell("wsl.exe -d OpenClaw-Runtime node -v");
      if (!checkNode.success || !checkNode.stdout.includes("v22")) {
        await log("Node.js 22 not found or version mismatch, attempting to install...");
        const installCmd = "apt-get update && apt-get install -y curl && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git";
        const installRes = await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- bash -c "${installCmd}"`);
        if (!installRes.success) await log(`Warning: Component installation might have failed: ${installRes.error}`);
      }

      // 3. 启动服务
      await log("Starting openclaw-gateway service...");
      await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl daemon-reload");
      await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl enable openclaw-gateway");
      const startRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl restart openclaw-gateway");
      
      if (!startRes.success) {
        // 如果服务不存在，尝试手动部署服务文件
        await log("Service failed to start, attempting to deploy service file manually...");
        const serviceContent = `[Unit]
Description=OpenClaw Gateway Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/bin/node /root/gateway.js
Restart=always

[Install]
WantedBy=multi-user.target`;
        // 写入临时文件再拷贝，避免转义地狱
        const tempServicePath = path.join(BASE_PATH, "openclaw-gateway.service");
        await fs.writeFile(tempServicePath, serviceContent);
        await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- cp "$(wslpath '${tempServicePath}')" /etc/systemd/system/openclaw-gateway.service`);
        await fs.remove(tempServicePath);
        
        await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl daemon-reload");
        await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl enable openclaw-gateway");
        const retryStart = await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl restart openclaw-gateway");
        if (!retryStart.success) throw new Error(`Gateway 服务启动失败: ${retryStart.error}`);
      }
      
      // 4. 如果是“启动并打开”或 extra 要求打开
      if (step === "startGatewayAndOpen" || extra.openSession) {
        await log("Opening browser session...");
        setTimeout(() => shell.openExternal("http://127.0.0.1:8080"), 2000);
      }
      result = "Gateway 服务已就绪并启动";
      break;

    case "stopGateway":
      await log("Stopping Gateway...");
      await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl stop openclaw-gateway");
      await runPowerShell("wsl.exe --terminate OpenClaw-Runtime");
      result = "Gateway 服务已停止";
      break;

    // --- 沙盒功能 ---
    case "sandbox":
    case "sandboxInstall":
      await log("Generating Sandbox configuration...");
      const wsbContent = `<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${BASE_PATH}</HostFolder>
      <SandboxFolder>C:\\OpenClaw</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>C:\\OpenClaw\\resources\\setup_sandbox.bat</Command>
  </LogonCommand>
</Configuration>`;
      const wsbPath = path.join(BASE_PATH, "OpenClaw_Sandbox.wsb");
      await fs.writeFile(wsbPath, wsbContent, 'utf-8');
      result = `沙盒配置文件已生成: ${wsbPath}`;
      break;

    // --- 配置管理 ---
    case "writeConfig":
      await log("Updating configuration file...");
      await fs.ensureDir(CONFIG_DIR);
      let currentConf = {};
      if (await fs.pathExists(CONFIG_FILE)) {
        try {
          currentConf = await fs.readJson(CONFIG_FILE);
        } catch (e) {
          await log("Failed to read existing config, starting fresh.");
        }
      }
      
      // 使用深度合并
      const mergedConf = deepMerge(currentConf, extra.config);
      await fs.writeJson(CONFIG_FILE, mergedConf, { spaces: 2 });
      
      // 安全地同步到 WSL 内部
      const wslConfigPath = "/root/.openclaw/openclaw.json";
      const tempConfigPath = path.join(BASE_PATH, "temp_config.json");
      try {
        await fs.writeJson(tempConfigPath, mergedConf);
        await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- mkdir -p /root/.openclaw`);
        await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- cp "$(wslpath '${tempConfigPath}')" ${wslConfigPath}`);
        await fs.remove(tempConfigPath);
        result = "配置文件已更新并同步到 WSL";
      } catch (e: any) {
        await log(`Sync to WSL failed (distro might not be ready): ${e.message}`);
        result = "配置文件已更新 (WSL 同步跳过)";
      }
      break;

    case "deleteConfig":
      await log("Deleting local configuration...");
      if (await fs.pathExists(CONFIG_DIR)) {
        await fs.remove(CONFIG_DIR);
        result = "本地配置目录已清理";
      } else {
        result = "配置目录不存在，无需清理";
      }
      break;

    case "deleteRuntime":
      await log("Deleting runtime files...");
      await log("Shutting down WSL...");
      await runPowerShell("wsl.exe --shutdown").catch(() => {});
      await log("Unregistering distro to release locks...");
      await runPowerShell("wsl.exe --unregister OpenClaw-Runtime").catch(() => {});
      
      if (await fs.pathExists(WSL_TARGET_ROOT)) {
        try {
          await fs.remove(WSL_TARGET_ROOT);
          result = "运行时目录已清理";
        } catch (e) {
          result = `OpenClaw 实例已注销。若目录仍存在，请手动删除以释放空间: ${WSL_TARGET_ROOT}`;
        }
      } else {
        result = "运行时目录已清理";
      }
      break;

    // --- 修复与卸载 ---
    case "repair":
    case "node":
    case "git":
    case "perm":
    case "path":
    case "wsl_conn":
      await log(`Running repair for: ${step}`);
      await runPowerShell("wsl.exe --shutdown");
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await executeActionLogic("setupGateway", "setup", {});

    case "fixError":
      const code = extra.errorCode;
      await log(`Fixing specific error: ${code}`);
      if (code === '0x80370102') {
        await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart");
        result = "已尝试开启虚拟机平台，请重启电脑。";
      } else if (code === '0x80070003') {
        await runPowerShell("wsl.exe --update");
        await runPowerShell("wsl.exe --shutdown");
        result = "已尝试更新 WSL 内核并重启服务。";
      } else {
        await runPowerShell("wsl.exe --update");
        await runPowerShell("wsl.exe --shutdown");
        result = `已尝试针对错误 ${code} 执行通用修复（更新 WSL 内核并重启）。`;
      }
      break;

    case "uninstall":
      await log("Uninstalling OpenClaw...");
      await runPowerShell("wsl.exe --terminate OpenClaw-Runtime").catch(() => {});
      await runPowerShell("wsl.exe --unregister OpenClaw-Runtime").catch(() => {});
      if (action === "thorough") {
        await runPowerShell("Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart");
        result = "深度卸载完成，WSL 功能已禁用，请重启电脑。";
      } else {
        result = "OpenClaw 实例已注销。";
      }
      break;

    case "openUrl":
      if (extra.url) await shell.openExternal(extra.url);
      result = `已打开: ${extra.url}`;
      break;

    default:
      await log(`Error: Unhandled step: ${step}`);
      throw new Error(`未实现的后端逻辑: ${step}`);
  }
  return { success: true, result };
}

ipcMain.handle('execute-action', async (_event, { step, action, ...extra }) => {
  await log(`IPC Action Received - Step: ${step}, Action: ${action}, Extra: ${JSON.stringify(extra)}`);
  try {
    return await executeActionLogic(step, action, extra);
  } catch (error: any) {
    await log(`Action Failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-logs', async () => {
  try {
    let content = "";
    if (await fs.pathExists(LOG_FILE)) content = await fs.readFile(LOG_FILE, "utf-8");
    const gwLogs = await runPowerShell("wsl.exe -d OpenClaw-Runtime journalctl -u openclaw-gateway -n 50 --no-pager");
    if (gwLogs.success && gwLogs.stdout.trim()) content += "\n--- Real-time Gateway Logs ---\n" + gwLogs.stdout;
    return content;
  } catch { return "Error fetching logs."; }
});

ipcMain.handle('get-state', async () => {
  try {
    if (await fs.pathExists(STATE_FILE)) return await fs.readJson(STATE_FILE);
    return { currentStep: 0, completed: [] };
  } catch { return { currentStep: 0, completed: [] }; }
});

ipcMain.handle('set-state', async (_event, state) => {
  try {
    await fs.writeJson(STATE_FILE, state);
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('read-config', async () => {
  try {
    if (await fs.pathExists(CONFIG_FILE)) return await fs.readJson(CONFIG_FILE);
    return {};
  } catch { return {}; }
});

ipcMain.handle('test-model', async (_event, { provider, config }) => {
  try {
    let testUrl = "";
    let headers: any = { "Content-Type": "application/json" };
    let body: any = {};
    const apiKey = config.apiKey || config.api_key;

    switch (provider) {
      case "bailian":
        testUrl = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = { model: "qwen-turbo", input: { messages: [{ role: "user", content: "hi" }] } };
        break;
      case "deepseek":
        testUrl = "https://api.deepseek.com/chat/completions";
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] };
        break;
      case "gemini":
        testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
        body = { contents: [{ parts: [{ text: "hi" }] }] };
        break;
      case "openai":
        testUrl = (config.baseUrl || "https://api.openai.com/v1") + "/chat/completions";
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = { model: config.model || "gpt-3.5-turbo", messages: [{ role: "user", content: "hi" }] };
        break;
      case "zhipu":
        testUrl = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = { model: "glm-4", messages: [{ role: "user", content: "hi" }] };
        break;
      case "anthropic":
        testUrl = "https://api.anthropic.com/v1/messages";
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
        body = { model: "claude-3-haiku-20240307", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
        break;
      case "ollama":
        testUrl = (config.baseUrl || "http://localhost:11434") + "/api/generate";
        body = { model: config.model || "llama3", prompt: "hi", stream: false };
        break;
      case "codex":
        // Codex usually uses session token, we can't easily test it via simple POST
        // but we can check if the token looks like a valid JWT or session string
        if (apiKey && apiKey.length > 50) {
          return { success: true, message: "Token 格式校验通过 (Session 登录无法直接测试连接)" };
        } else {
          return { success: false, message: "Token 格式不正确" };
        }
      default:
        throw new Error(`不支持的模型提供商: ${provider}`);
    }

    const response = await fetch(testUrl, { 
      method: "POST", 
      headers, 
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (response.ok) return { success: true, message: "连接成功！" };
    const errText = await response.text();
    return { success: false, message: `失败 (HTTP ${response.status}): ${errText.substring(0, 100)}...` };
  } catch (error: any) {
    return { success: false, message: `错误: ${error.message}` };
  }
});

ipcMain.handle('test-channel', async (_event, { channel, config }) => {
  try {
    let testUrl = "";
    let body: any = {};
    let headers: any = { "Content-Type": "application/json" };

    switch (channel) {
      case "feishu":
        // Feishu test: get tenant_access_token
        testUrl = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
        body = { app_id: config.app_id, app_secret: config.app_secret };
        break;
      case "dingtalk":
        // DingTalk test: simple webhook test (requires a message)
        testUrl = `https://oapi.dingtalk.com/robot/send?access_token=${config.access_token}`;
        body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
        break;
      case "wechat_work":
        // WeChat Work test: simple webhook test
        testUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${config.key}`;
        body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
        break;
      case "qq":
        // QQ Bot test: requires more complex auth, just check if ID/Token exist for now
        if (config.bot_id && config.bot_token) {
          return { success: true, message: "配置格式校验通过 (QQ 机器人需在运行时测试)" };
        } else {
          return { success: false, message: "机器人 ID 或 Token 缺失" };
        }
      default:
        throw new Error(`不支持的渠道: ${channel}`);
    }

    const response = await fetch(testUrl, { 
      method: "POST", 
      headers, 
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      const data = await response.json();
      if (channel === 'feishu' && !data.tenant_access_token) {
        return { success: false, message: `失败: ${data.msg || '未知错误'}` };
      }
      return { success: true, message: "连接测试成功！" };
    }
    const errText = await response.text();
    return { success: false, message: `失败 (HTTP ${response.status}): ${errText.substring(0, 100)}...` };
  } catch (error: any) {
    return { success: false, message: `错误: ${error.message}` };
  }
});

ipcMain.handle('clear-logs', async () => {
  try {
    if (await fs.pathExists(LOG_FILE)) await fs.writeFile(LOG_FILE, "");
    return { success: true };
  } catch { return { success: false }; }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
