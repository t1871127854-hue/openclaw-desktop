import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import fs from "fs-extra";
import cors from "cors";
import bodyParser from "body-parser";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants (Consistent with main.ts)
const BASE_PATH = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
const CONFIG_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const LOG_FILE = path.join(BASE_PATH, "openclaw-launcher.log");
const STATE_FILE = path.join(BASE_PATH, "install-state.json");
const WSL_TARGET_ROOT = path.join(os.homedir(), "AppData", "Roaming", "openclaw-launcher", "WSL_Runtime");

// Helpers
function deepMerge(target: any, source: any) {
  if (!source) return target;
  if (typeof source !== 'object') return source;
  
  const output = { ...target };
  if (typeof target === 'object' && typeof source === 'object') {
    Object.keys(source).forEach(key => {
      if (typeof source[key] === 'object' && source[key] !== null) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

async function log(message: string) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  console.log(logEntry.trim());
  try {
    await fs.appendFile(LOG_FILE, logEntry);
  } catch (e) {
    console.error("Failed to write to log file", e);
  }
}

function runPowerShell(command: string): Promise<{ stdout: string; stderr: string; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const fullCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
    
    exec(fullCommand, { timeout: 0, maxBuffer: 1024 * 1024 * 100, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // Strip the encoded command from the error message to avoid garbled text in UI
        const cleanError = stderr || error.message.split(' -EncodedCommand ')[0] || "PowerShell execution failed";
        resolve({ stdout, stderr, success: false, error: cleanError });
      } else {
        resolve({ stdout, stderr, success: true });
      }
    });
  });
}

export async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(bodyParser.json());

  // --- API Routes ---

  app.get("/api/status", async (req, res) => {
    try {
      const status: any = {};

      // 1. Admin Check
      try {
        const { stdout } = await runPowerShell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')");
        status.isAdmin = stdout.trim() === "True";
      } catch { status.isAdmin = false; }

      // 2. Node.js & npm Check (Inside WSL)
      try {
        const { stdout } = await runPowerShell("wsl.exe -d OpenClaw-Runtime node -v");
        const version = stdout.trim().replace("v", "");
        const major = parseInt(version.split(".")[0]);
        status.node = { version, isOk: major >= 22 };
      } catch { 
        status.node = { version: "not_installed", isOk: false }; 
      }

      // 3. Git Check (Inside WSL)
      try {
        const { stdout } = await runPowerShell("wsl.exe -d OpenClaw-Runtime git --version");
        const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
        const version = versionMatch ? versionMatch[1] : "unknown";
        status.git = { version, isOk: stdout.includes("git version") };
      } catch { 
        status.git = { version: "not_installed", isOk: false }; 
      }

      status.is64Bit = process.arch === "x64";

      // 6. WSL Check
      try {
        const { stdout } = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux");
        status.wsl = stdout.includes("Enabled") ? "installed" : "not_installed";
      } catch { status.wsl = "not_installed"; }

      // 7. VM Platform Check
      try {
        const { stdout } = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform");
        status.vmPlatform = stdout.includes("Enabled") ? "installed" : "not_installed";
      } catch { status.vmPlatform = "not_installed"; }

      // 8. Windows Sandbox Check
      try {
        const { stdout } = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName " + (process.arch === "x64" ? "Containers-DisposableClientVM" : "Windows-Sandbox"));
        status.sandboxFeature = stdout.includes("Enabled") ? "installed" : "not_installed";
      } catch { status.sandboxFeature = "not_installed"; }

      // 9. Runtime Check
      try {
        const { stdout } = await runPowerShell("wsl.exe -l -v");
        status.runtime = stdout.includes("OpenClaw-Runtime") ? "installed" : "not_installed";
      } catch { status.runtime = "not_installed"; }

      // 9. Gateway Check
      try {
        const { stdout } = await runPowerShell("wsl.exe -d OpenClaw-Runtime systemctl is-active openclaw-gateway");
        status.gateway = stdout.includes("active") ? "running" : "stopped";
      } catch { status.gateway = "not_installed"; }

      status.configExists = await fs.pathExists(CONFIG_FILE);
      const skillPackPath = path.join(BASE_PATH, "skills-pack.tar.gz");
      status.skillPackExists = await fs.pathExists(skillPackPath);

      const rootfsPath = path.join(BASE_PATH, "resources", "openclaw-rootfs.tar");
      const rootfsExists = await fs.pathExists(rootfsPath);

      status.localResources = {
        folderExists: rootfsExists,
        rootfsExists: rootfsExists,
        path: rootfsExists ? rootfsPath : `未检测到本地资源包 (检测路径: ${path.join(BASE_PATH, 'resources')})`
      };

      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-model", async (req, res) => {
    const { provider, config } = req.body;
    await log(`Testing connectivity for ${provider}`);
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
        default:
          throw new Error(`不支持的模型提供商: ${provider}`);
      }

      const response = await fetch(testUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        res.json({ success: true, message: "连接成功！" });
      } else {
        const errText = await response.text();
        res.json({ success: false, message: `失败 (HTTP ${response.status}): ${errText.substring(0, 100)}...` });
      }
    } catch (error: any) {
      res.json({ success: false, message: `错误: ${error.message}` });
    }
  });

  app.post("/api/test-channel", async (req, res) => {
    const { channel, config } = req.body;
    await log(`Testing connectivity for ${channel}`);
    try {
      let testUrl = "";
      let body: any = {};
      let headers: any = { "Content-Type": "application/json" };

      switch (channel) {
        case "feishu":
          testUrl = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
          body = { app_id: config.app_id, app_secret: config.app_secret };
          break;
        case "dingtalk":
          testUrl = `https://oapi.dingtalk.com/robot/send?access_token=${config.access_token}`;
          body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
          break;
        case "wechat_work":
          testUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${config.key}`;
          body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
          break;
        case "qq":
          if (config.bot_id && config.bot_token) {
            return res.json({ success: true, message: "配置格式校验通过 (QQ 机器人需在运行时测试)" });
          } else {
            return res.json({ success: false, message: "机器人 ID 或 Token 缺失" });
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
          return res.json({ success: false, message: `失败: ${data.msg || '未知错误'}` });
        }
        res.json({ success: true, message: "连接测试成功！" });
      } else {
        const errText = await response.text();
        res.json({ success: false, message: `失败 (HTTP ${response.status}): ${errText.substring(0, 100)}...` });
      }
    } catch (error: any) {
      res.json({ success: false, message: `错误: ${error.message}` });
    }
  });

  app.post("/api/execute", async (req, res) => {
    const { step, action, ...extra } = req.body;
    await log(`Executing step: ${step}, action: ${action}, extra: ${JSON.stringify(extra)}`);

    try {
      let result = "";
      switch (step) {
        case "admin":
          result = "管理员权限检查已触发。如果是网页预览，此项为模拟通过。";
          break;
        case "wsl":
          await log("正在开启 WSL 功能...");
          const wslEnable = await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart");
          if (!wslEnable.success) throw new Error(wslEnable.error);
          result = "WSL 核心功能已开启，可能需要重启电脑生效。";
          break;
        case "vmPlatform":
          await log("正在开启虚拟机平台...");
          const vmEnable = await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart");
          if (!vmEnable.success) throw new Error(vmEnable.error);
          result = "虚拟机平台功能已开启，可能需要重启电脑生效。";
          break;
        case "importRuntime":
        case "installRuntime":
        case "runtime":
          await log("正在从本地资源导入 OpenClaw 运行时...");
          const possiblePaths = [
            path.join(BASE_PATH, "resources", "openclaw-rootfs.tar"),
            path.join(os.homedir(), 'Desktop', '一键安装小龙虾本地环境', 'openclaw-rootfs.tar'),
            path.join(BASE_PATH, "openclaw-rootfs.tar")
          ];
          
          let sourcePath = "";
          for (const p of possiblePaths) {
            if (await fs.pathExists(p)) {
              sourcePath = p;
              break;
            }
          }

          if (!sourcePath) {
            throw new Error("未找到本地环境包 (openclaw-rootfs.tar)。请确保资源已放入 resources 文件夹或桌面指定目录。");
          }

          await log(`使用本地资源路径: ${sourcePath}`);
          const installPath = path.join(WSL_TARGET_ROOT, "runtime");
          
          await log("正在释放 WSL 文件锁并清理旧环境...");
          await runPowerShell("wsl.exe --shutdown");
          await runPowerShell("wsl.exe --unregister OpenClaw-Runtime").catch(() => {});
          
          await log(`准备安装目录: ${installPath}`);
          await fs.ensureDir(installPath);
          await fs.emptyDir(installPath);
          
          await log(`设置 WSL 2 为默认版本...`);
          await runPowerShell("wsl.exe --set-default-version 2");
          
          await log(`正在导入镜像 (这可能需要几分钟，请耐心等待)...`);
          const importRes = await runPowerShell(`wsl.exe --import OpenClaw-Runtime "${installPath}" "${sourcePath}"`);
          if (importRes.success) {
            result = "OpenClaw 运行时环境导入成功！";
          } else {
            throw new Error(`导入失败: ${importRes.error}`);
          }
          break;
        case "repair":
        case "node":
        case "git":
        case "perm":
        case "path":
        case "wsl_conn":
          await log(`正在执行深度修复: ${step}`);
          await runPowerShell("wsl.exe --shutdown");
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          await log("正在配置 WSL 内部 systemd 环境...");
          await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- bash -c \"echo -e '[boot]\\nsystemd=true' > /etc/wsl.conf\"");
          await runPowerShell("wsl.exe --terminate OpenClaw-Runtime");
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          await log("正在同步系统组件 (Node.js/Git)...");
          const pkgRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- bash -c \"apt-get update && apt-get install -y nodejs npm git\"");
          if (!pkgRes.success) await log("警告: 自动组件安装失败，可能无网络连接。");

          await log("正在启动 Gateway 服务...");
          await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl enable openclaw-gateway");
          await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl start openclaw-gateway");
          result = `修复流程已完成 (${step})。Gateway 服务已尝试重新启动。`;
          break;
        case "setupGateway":
        case "startGatewayAndOpen":
          await log("正在启动 OpenClaw Gateway 服务...");
          // Ensure systemd
          await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- bash -c \"echo -e '[boot]\\nsystemd=true' > /etc/wsl.conf\"");
          
          const startRes = await runPowerShell("wsl.exe -d OpenClaw-Runtime -u root -- systemctl start openclaw-gateway");
          if (!startRes.success) {
            throw new Error(`Gateway 启动失败: ${startRes.error}`);
          }
          
          if (step === "startGatewayAndOpen") {
            await log("正在打开浏览器对话界面...");
            await new Promise(resolve => setTimeout(resolve, 2000));
            await runPowerShell("start http://127.0.0.1:8080");
          }
          result = "Gateway 服务已成功启动。";
          break;
        case "stopGateway":
          await log("正在停止 Gateway 服务...");
          await runPowerShell("wsl.exe -d OpenClaw-Runtime systemctl stop openclaw-gateway");
          result = "Gateway 服务已停止。";
          break;
        case "fixError":
          const { errorCode } = req.body;
          await log(`正在针对错误代码执行修复: ${errorCode}`);
          switch (errorCode) {
            case '0x80070003':
              await runPowerShell("wsl.exe --shutdown");
              await runPowerShell("netsh winsock reset");
              result = "已重置网络堆栈并关闭 WSL，请尝试重新启动。";
              break;
            case '0x80370102':
              await runPowerShell("Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart");
              result = "已尝试开启虚拟化平台支持。如果问题持续，请检查 BIOS 中的 VT-x/AMD-V 设置。";
              break;
            case '0x80040326':
              await runPowerShell("wsl.exe --update");
              result = "正在执行 WSL 内核更新，请等待更新完成后重试。";
              break;
            case 'EACCES':
              await runPowerShell(`icacls "${process.cwd()}" /grant Everyone:(OI)(CI)F /T`);
              result = "已尝试重置当前目录的文件访问权限。";
              break;
            default:
              throw new Error(`未定义的错误代码修复逻辑: ${errorCode}`);
          }
          break;
        case "deleteConfig":
          await log("正在清理配置文件...");
          if (await fs.pathExists(CONFIG_DIR)) {
            await fs.remove(CONFIG_DIR);
            result = "本地配置文件已成功删除。";
          } else {
            result = "未找到配置文件目录，无需清理。";
          }
          break;
        case "deleteRuntime":
          await log("正在删除运行时物理文件...");
          if (await fs.pathExists(WSL_TARGET_ROOT)) {
            await fs.remove(WSL_TARGET_ROOT);
            result = "运行时物理目录已移除。";
          } else {
            result = "未找到运行时目录。";
          }
          break;
        case "sandboxInstall":
          await log("正在生成沙盒配置文件...");
          const sbCheck = await runPowerShell("Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM");
          if (!sbCheck.stdout.includes("Enabled")) {
            throw new Error("Windows 沙盒功能未开启，请先在‘启用或关闭 Windows 功能’中开启它。");
          }
          const wsbContent = `
<Configuration>
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
          result = `沙盒配置文件已生成至: ${wsbPath}，您可以双击此文件启动隔离环境。`;
          break;
        case "writeConfig":
          await log("正在更新配置文件...");
          await fs.ensureDir(CONFIG_DIR);
          let currentConf = {};
          if (await fs.pathExists(CONFIG_FILE)) {
            try {
              currentConf = await fs.readJson(CONFIG_FILE);
            } catch (e) {
              await log("读取旧配置失败，将创建新配置。");
            }
          }
          const mergedConf = deepMerge(currentConf, extra.config);
          await fs.writeJson(CONFIG_FILE, mergedConf, { spaces: 2 });
          
          const wslConfigPath = "/root/.openclaw/openclaw.json";
          const tempConfigPath = path.join(BASE_PATH, "temp_config.json");
          try {
            await fs.writeJson(tempConfigPath, mergedConf);
            await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- mkdir -p /root/.openclaw`);
            await runPowerShell(`wsl.exe -d OpenClaw-Runtime -u root -- cp "$(wslpath '${tempConfigPath}')" ${wslConfigPath}`);
            await fs.remove(tempConfigPath);
            await log("配置已同步至 WSL 内部。");
          } catch (e) {
            await log("警告: 无法同步配置到 WSL，可能运行时尚未安装。");
          }
          result = "配置文件已更新并尝试同步。";
          break;
        case "uninstall":
          await log("正在注销 OpenClaw WSL 实例...");
          const unregRes = await runPowerShell("wsl.exe --unregister OpenClaw-Runtime");
          
          if (action === "thorough") {
            await log("正在执行深度清理...");
            if (await fs.pathExists(WSL_TARGET_ROOT)) await fs.remove(WSL_TARGET_ROOT);
            if (await fs.pathExists(CONFIG_DIR)) await fs.remove(CONFIG_DIR);
            await runPowerShell("Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart");
            await runPowerShell("Disable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart");
            result = "OpenClaw 已从系统中彻底卸载，WSL 功能已禁用。";
          } else {
            result = "OpenClaw WSL 实例已注销，数据已清理。";
          }
          break;
        case "openUrl":
          await runPowerShell(`start ${extra.url}`);
          result = `已尝试打开链接: ${extra.url}`;
          break;
        default:
          throw new Error(`未实现的后端逻辑: ${step}`);
      }
      await log(`操作成功完成: ${result}`);
      res.json({ success: true, result });
    } catch (error: any) {
      const errorMsg = error.error || error.message || "未知错误";
      await log(`操作失败: ${errorMsg}`);
      res.status(500).json({ success: false, error: errorMsg });
    }
  });

  app.post("/api/test-channel", async (req, res) => {
    const { channel, config } = req.body;
    await log(`Testing connectivity for ${channel}`);
    try {
      let testUrl = "";
      let body: any = {};
      let headers: any = { "Content-Type": "application/json" };

      switch (channel) {
        case "feishu":
          testUrl = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
          body = { app_id: config.app_id, app_secret: config.app_secret };
          break;
        case "dingtalk":
          testUrl = `https://oapi.dingtalk.com/robot/send?access_token=${config.access_token}`;
          body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
          break;
        case "wechat_work":
          testUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${config.key}`;
          body = { msgtype: "text", text: { content: "OpenClaw 渠道测试成功" } };
          break;
        case "qq":
          if (config.bot_id && config.bot_token) {
            return res.json({ success: true, message: "配置格式校验通过 (QQ 机器人需在运行时测试)" });
          } else {
            return res.json({ success: false, message: "机器人 ID 或 Token 缺失" });
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
          return res.json({ success: false, message: `失败: ${data.msg || '未知错误'}` });
        }
        res.json({ success: true, message: "连接测试成功！" });
      } else {
        const errText = await response.text();
        res.json({ success: false, message: `失败 (HTTP ${response.status}): ${errText.substring(0, 100)}...` });
      }
    } catch (error: any) {
      res.json({ success: false, message: `错误: ${error.message}` });
    }
  });

  app.get("/api/logs", async (req, res) => {
    try {
      let content = "";
      if (await fs.pathExists(LOG_FILE)) content = await fs.readFile(LOG_FILE, "utf-8");
      try {
        const { stdout: gwLogs } = await runPowerShell("wsl.exe -d OpenClaw-Runtime journalctl -u openclaw-gateway -n 50 --no-pager");
        if (gwLogs.trim()) content += "\n--- Real-time Gateway Logs ---\n" + gwLogs;
      } catch (e) {}
      res.send(content);
    } catch (error) {
      res.send("Error fetching logs.");
    }
  });

  app.post("/api/clear-logs", async (req, res) => {
    try {
      if (await fs.pathExists(LOG_FILE)) await fs.writeFile(LOG_FILE, "");
      res.json({ success: true });
    } catch { res.json({ success: false }); }
  });

  app.get("/api/read-config", async (req, res) => {
    try {
      if (await fs.pathExists(CONFIG_FILE)) {
        res.json(await fs.readJson(CONFIG_FILE));
      } else {
        res.json({});
      }
    } catch { res.json({}); }
  });

  app.get("/api/get-state", async (req, res) => {
    try {
      if (await fs.pathExists(STATE_FILE)) {
        res.json(await fs.readJson(STATE_FILE));
      } else {
        res.json({ currentStep: 0, completed: [] });
      }
    } catch { res.json({ currentStep: 0, completed: [] }); }
  });

  app.post("/api/set-state", async (req, res) => {
    try {
      await fs.writeJson(STATE_FILE, req.body);
      res.json({ success: true });
    } catch { res.json({ success: false }); }
  });

  app.get("/api/logs", async (req, res) => {
    try {
      let content = "";
      if (await fs.pathExists(LOG_FILE)) content = await fs.readFile(LOG_FILE, "utf-8");
      res.send(content);
    } catch { res.send("Error fetching logs."); }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
