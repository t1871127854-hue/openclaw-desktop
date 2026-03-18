import React, { useState, useEffect, useRef } from 'react';
import {appApi} from './services/appApi';
import type {DiagnosticIssue, EnvironmentStatus, InstallState, OperationFailureInfo, StatusType} from './types/api';
import { 
  Shield, 
  Monitor, 
  Cpu, 
  Settings, 
  Activity, 
  Wrench, 
  FileText, 
  RefreshCw, 
  Play, 
  CheckCircle2, 
  XCircle, 
  AlertCircle,
  Terminal,
  Trash2,
  ChevronRight,
  Download,
  ExternalLink,
  MessageSquare,
  Package,
  Key,
  FolderCheck,
  FileArchive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Components ---

const SidebarItem = ({ icon: Icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    className={cn(
      "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200",
      active 
        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
    )}
  >
    <Icon size={18} />
    <span className="font-medium">{label}</span>
  </button>
);

const StatusBadge = ({ status }: { status: StatusType }) => {
  const config = {
    installed: { color: "text-emerald-400 bg-emerald-400/10", label: "已安装", icon: CheckCircle2 },
    not_installed: { color: "text-zinc-500 bg-zinc-500/10", label: "未安装", icon: XCircle },
    reboot_required: { color: "text-amber-400 bg-amber-400/10", label: "需重启", icon: RefreshCw },
    configured: { color: "text-emerald-400 bg-emerald-400/10", label: "已配置", icon: CheckCircle2 },
    not_configured: { color: "text-amber-400 bg-amber-400/10", label: "未配置", icon: AlertCircle },
    running: { color: "text-emerald-400 bg-emerald-400/10", label: "运行中", icon: Activity },
    stopped: { color: "text-rose-400 bg-rose-400/10", label: "已停止", icon: XCircle },
    error: { color: "text-rose-400 bg-rose-400/10", label: "异常", icon: AlertCircle },
    loading: { color: "text-zinc-400 bg-zinc-400/10", label: "检测中...", icon: RefreshCw },
  }[status] || { color: "text-zinc-400 bg-zinc-400/10", label: status, icon: AlertCircle };

  const Icon = config.icon;

  return (
    <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold", config.color)}>
      <Icon size={12} className={status === 'loading' ? 'animate-spin' : ''} />
      {config.label}
    </div>
  );
};

const Card = ({ children, className }: { children: React.ReactNode, className?: string }) => (
  <div className={cn("bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden", className)}>
    {children}
  </div>
);

// --- Main App ---

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [envStatus, setEnvStatus] = useState<EnvironmentStatus>({
    isAdmin: false,
    node: { isOk: false, version: '' },
    git: { isOk: false, version: '' },
    wsl: 'loading',
    vmPlatform: 'loading',
    sandboxFeature: 'loading',
    runtime: 'loading',
    gateway: 'loading',
    configExists: false,
    skillPackExists: false
  });
  const [installState, setInstallState] = useState<InstallState>({ currentStep: 0, completed: [], isInstalling: false });
  const [logs, setLogs] = useState('');
  const [diagnostics, setDiagnostics] = useState<DiagnosticIssue[]>([]);
  const [bailianKey, setBailianKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [zhipuKey, setZhipuKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [codexToken, setCodexToken] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [feishuId, setFeishuId] = useState('');
  const [feishuSecret, setFeishuSecret] = useState('');
  const [qqBotId, setQqBotId] = useState('');
  const [qqBotToken, setQqBotToken] = useState('');
  const [dingtalkToken, setDingtalkToken] = useState('');
  const [wechatWorkKey, setWechatWorkKey] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStartingGateway, setIsStartingGateway] = useState(false);
  const [testResult, setTestResult] = useState<{ provider: string, message: string, success: boolean } | null>(null);
  const [channelTestResult, setChannelTestResult] = useState<{ channel: string, message: string, success: boolean } | null>(null);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ message: string, onConfirm: () => void } | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const askConfirm = (message: string, onConfirm: () => void) => {
    setConfirmModal({ message, onConfirm });
  };

  const refreshStatus = async () => {
    setIsRefreshing(true);
    try {
      const data = await appApi.getStatus();
      if (data.error) {
        console.error("Status check error", data.error);
      } else {
        setEnvStatus(data);
        setDiagnostics(data.diagnostics || []);
        setInstallState((prev) => ({...prev, isInstalling: Boolean(data.installWorkflow?.active)}));
      }
    } catch (err) {
      console.error("Failed to invoke get-status", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const loadConfig = async () => {
    try {
      const config = await appApi.readConfig();
      
      // Load Channels
      if (config.channels?.feishu) {
        setFeishuId(config.channels.feishu.app_id || "");
        setFeishuSecret(config.channels.feishu.app_secret || "");
      }
      if (config.channels?.qq) {
        setQqBotId(config.channels.qq.bot_id || "");
        setQqBotToken(config.channels.qq.bot_token || "");
      }
      if (config.channels?.dingtalk) {
        setDingtalkToken(config.channels.dingtalk.access_token || "");
      }
      if (config.channels?.wechat_work) {
        setWechatWorkKey(config.channels.wechat_work.key || "");
      }

      // Load Models
      const providers = config.models?.providers || {};
      if (providers.bailian) setBailianKey(providers.bailian.api_key || "");
      if (providers.deepseek) setDeepseekKey(providers.deepseek.api_key || "");
      if (providers.zhipu) setZhipuKey(providers.zhipu.api_key || "");
      if (providers.openai) setOpenaiKey(providers.openai.api_key || "");
      if (providers.codex) setCodexToken(providers.codex.session_token || "");
      if (providers.anthropic) setAnthropicKey(providers.anthropic.api_key || "");
      if (providers.gemini) setGeminiKey(providers.gemini.api_key || "");
      if (providers.ollama) setOllamaUrl(providers.ollama.base_url || "http://localhost:11434");

    } catch (err) {
      console.error("Failed to load config", err);
    }
  };

  const testModel = async (provider: string, config: any) => {
    setTestResult({ provider, message: "测试中...", success: true });
    try {
      const data = await appApi.testModel({ provider, config });
      setTestResult({ provider, message: data.message, success: data.success });
    } catch (err: any) {
      setTestResult({ provider, message: `测试失败: ${err.message}`, success: false });
    }
  };

  const testChannel = async (channel: string, config: any) => {
    setChannelTestResult({ channel, message: "测试中...", success: true });
    try {
      const data = await appApi.testChannel({ channel, config });
      setChannelTestResult({ channel, message: data.message, success: data.success });
    } catch (err: any) {
      setChannelTestResult({ channel, message: `测试失败: ${err.message}`, success: false });
    }
  };

  const fetchLogs = async () => {
    try {
      const data = await appApi.getLogs();
      setLogs(data);
    } catch (err) {
      console.error("Failed to fetch logs", err);
    }
  };

  const runDiagnostics = async () => {
    try {
      const issues = await appApi.runDiagnostics();
      setDiagnostics(issues);
      return issues;
    } catch (err) {
      console.error('Failed to run diagnostics', err);
      return [];
    }
  };

  const repairDiagnostic = async (id: string) => {
    showNotification(`正在修复: ${id}...`, 'info');
    try {
      const result = await appApi.repairDiagnostic(id);
      if (result.success) {
        showNotification(result.result || '修复完成', 'success');
      } else {
        showNotification(result.error || '修复失败', 'error');
      }
      await refreshStatus();
      await runDiagnostics();
      await fetchLogs();
    } catch (err: any) {
      showNotification(err.message || '修复执行失败', 'error');
    }
  };

  const executeAction = async (step: string, action?: string, extra?: any) => {
    showNotification(`正在执行: ${step}...`, 'info');
    try {
      const data = await appApi.executeAction({ step, action, ...extra });
      await refreshStatus();
      await runDiagnostics();
      await fetchLogs();
      if (data.success) {
        showNotification(data.result || "操作成功完成", 'success');
        return true;
      } else {
        showNotification(`操作失败: ${data.error}`, 'error');
        return false;
      }
    } catch (err: any) {
      console.error("Execution failed", err);
      showNotification(`执行异常: ${err.message}`, 'error');
      return false;
    }
  };

  useEffect(() => {
    const init = async () => {
      await refreshStatus();
      await fetchLogs();
      await loadConfig();
      await runDiagnostics();

      try {
        const state = await appApi.getState();
        setInstallState(state);
      } catch (err) {
        console.error("Failed to fetch state", err);
      }
    };

    void init();

    const unsubscribe = appApi.subscribeLogs((entry) => {
      setLogs((prev) => `${prev}${prev ? '\n' : ''}[${entry.timestamp}] [${entry.source.toUpperCase()}] [${entry.level.toUpperCase()}] ${entry.message}`);
    });

    const interval = window.openClaw ? undefined : setInterval(fetchLogs, 2000);

    return () => {
      unsubscribe();
      if (interval) clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    appApi.setState(installState);
  }, [installState]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);


  const workflowStages = ['detect-environment', 'choose-mode', 'resolve-resources', 'import-download-resources', 'install-runtime', 'validate-post-install', 'start-gateway', 'completed'];
  const workflowStageIndex = envStatus.installWorkflow ? workflowStages.indexOf(envStatus.installWorkflow.stage) : -1;
  const workflowProgress = workflowStageIndex >= 0 ? Math.min(((workflowStageIndex + 1) / workflowStages.length) * 100, 100) : 0;

  const installSteps = [
    { id: 'admin', name: '管理员权限', check: () => envStatus.isAdmin },
    { id: 'wsl', name: 'WSL 功能', check: () => envStatus.wsl === 'installed' },
    { id: 'vmPlatform', name: '虚拟机平台', check: () => envStatus.vmPlatform === 'installed' },
    { id: 'importRuntime', name: '导入运行时', check: () => envStatus.runtime === 'installed' },
    { id: 'node', name: 'WSL Node.js (22+)', check: () => envStatus.node?.isOk },
    { id: 'git', name: 'WSL Git', check: () => envStatus.git?.isOk },
    { id: 'setupGateway', name: '配置 Gateway', check: () => envStatus.gateway === 'running' },
  ];

  const installProgressItems = (envStatus.installWorkflow?.history.length
    ? envStatus.installWorkflow.history.map((step, index) => ({
        id: `${step.stage}-${index}`,
        label: step.message,
        status: step.status,
      }))
    : installSteps.map((step) => ({
        id: step.id,
        label: step.name,
        status: step.check() ? 'completed' : 'running',
      })));

  const handleInstallAll = async () => {
    showNotification("正在开始安装向导...", 'info');
    setInstallState(prev => ({ ...prev, isInstalling: true }));
    const success = await executeAction('runInstallWizard', undefined, { mode: 'hybrid' });
    setInstallState(prev => ({ ...prev, isInstalling: false }));
    if (success) {
      showNotification("安装向导已完成！", 'success');
    }
  };

  const EnvItem = ({ icon: Icon, label, status, sub, onFix }: any) => (
    <Card className="p-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-zinc-800 rounded-lg text-zinc-400">
          <Icon size={18} />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-zinc-200">{label}</h4>
          <p className="text-[10px] text-zinc-500">{sub}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={status} />
        {status !== 'installed' && status !== 'running' && (
          <button 
            onClick={onFix}
            className="text-[10px] px-2 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded hover:bg-emerald-500/20 transition-colors"
          >
            修复
          </button>
        )}
      </div>
    </Card>
  );

  const FailureSummaryCard = ({
    title,
    failure,
  }: {
    title: string;
    failure?: OperationFailureInfo;
  }) => {
    if (!failure) return null;

    return (
      <Card className="p-4 border-rose-500/20 bg-rose-500/5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white">{title}</h3>
            <p className="text-xs text-rose-300 mt-1">{failure.userFacingMessage}</p>
          </div>
          <StatusBadge status="error" />
        </div>
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-zinc-300">
            <span className="text-zinc-500">失败阶段：</span>
            <code className="bg-zinc-950 px-1.5 py-0.5 rounded text-zinc-200">{failure.stage}</code>
          </p>
          <p className="text-zinc-300">
            <span className="text-zinc-500">可重试：</span>
            {failure.retryable ? '是' : '否'}
          </p>
          {failure.recommendedModeSwitch && (
            <p className="text-zinc-300">
              <span className="text-zinc-500">建议模式：</span>
              <span className="text-amber-300">{failure.recommendedModeSwitch}</span>
            </p>
          )}
          {failure.suggestedActions.length > 0 && (
            <div>
              <p className="text-zinc-500 mb-1">建议操作：</p>
              <ul className="space-y-1 list-disc pl-4 text-zinc-300">
                {failure.suggestedActions.map((action, index) => (
                  <li key={`${title}-action-${index}`}>{action}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
    );
  };

  const DownloadItem = ({ name, url, desc }: any) => (
    <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center justify-between group">
      <div className="overflow-hidden">
        <h4 className="text-xs font-bold text-zinc-200 truncate">{name}</h4>
        <p className="text-[10px] text-zinc-600 truncate">{desc}</p>
      </div>
      <button 
        onClick={() => executeAction('openUrl', undefined, { url })}
        className="p-2 text-zinc-500 hover:text-emerald-500 transition-colors"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );

  const renderHome = () => (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">环境检测</h2>
          <p className="text-zinc-400 text-sm mt-1">请根据您的需求选择安装方案</p>
        </div>
        <button 
          onClick={refreshStatus}
          disabled={isRefreshing}
          className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg transition-all"
        >
          <RefreshCw size={20} className={isRefreshing ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Node</span>
            <StatusBadge status={envStatus.node?.isOk ? 'installed' : 'error'} />
          </div>
          <p className="text-sm text-zinc-200">{envStatus.nodeDetails?.version || '未检测到'}</p>
        </Card>
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">WSL</span>
            <StatusBadge status={envStatus.wsl || 'loading'} />
          </div>
          <p className="text-sm text-zinc-200 truncate">{envStatus.wslDetails?.defaultDistro || '未设置默认发行版'}</p>
        </Card>
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Port 18789</span>
            <StatusBadge status={envStatus.port18789?.occupied ? 'error' : 'installed'} />
          </div>
          <p className="text-sm text-zinc-200">{envStatus.port18789?.occupied ? `PID ${envStatus.port18789.pid || '未知'} 占用` : '端口空闲'}</p>
        </Card>
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Gateway</span>
            <StatusBadge status={envStatus.gateway || 'loading'} />
          </div>
          <p className="text-sm text-zinc-200">{envStatus.gatewayDetails?.pid ? `PID ${envStatus.gatewayDetails.pid}` : '未启动 / placeholder'}</p>
        </Card>
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">安装阶段</span>
            <StatusBadge status={envStatus.installWorkflow?.stage === 'failed' ? 'error' : envStatus.installWorkflow?.stage === 'completed' ? 'installed' : envStatus.installWorkflow?.active ? 'loading' : 'stopped'} />
          </div>
          <p className="text-sm text-zinc-200">{envStatus.installWorkflow?.stage || 'idle'}</p>
        </Card>
        <Card className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">升级计划</span>
            <StatusBadge status={envStatus.upgradePlan?.status === 'required-update' ? 'error' : envStatus.upgradePlan?.status === 'optional-update' ? 'configured' : envStatus.upgradePlan?.status === 'no-update' ? 'installed' : 'stopped'} />
          </div>
          <p className="text-sm text-zinc-200">{envStatus.upgradePlan?.status || 'blocked'}</p>
        </Card>
      </div>

      {(envStatus.installFailure || envStatus.upgradeFailure) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FailureSummaryCard title="安装失败摘要" failure={envStatus.installFailure} />
          <FailureSummaryCard title="升级失败摘要" failure={envStatus.upgradeFailure} />
        </div>
      )}

      {envStatus.upgradeExecution && (
        <Card className="p-4 border-zinc-700/80">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">升级执行摘要</h3>
              <p className="text-xs text-zinc-400 mt-1">仅展示半执行骨架结果，不表示已完成真实替换。</p>
            </div>
            <StatusBadge status={envStatus.upgradeExecution.status === 'blocked' || envStatus.upgradeExecution.status === 'failed' ? 'error' : envStatus.upgradeExecution.status === 'rolled-back' ? 'stopped' : 'configured'} />
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-2">
              <p className="text-zinc-300"><span className="text-zinc-500">状态：</span>{envStatus.upgradeExecution.status}</p>
              <p className="text-zinc-300"><span className="text-zinc-500">Rollback 可用：</span>{envStatus.upgradeExecution.rollbackAvailable ? '是' : '否'}</p>
              <p className="text-zinc-500">已执行步骤：</p>
              <ul className="space-y-1 text-zinc-300">
                {envStatus.upgradeExecution.executedSteps.length > 0 ? envStatus.upgradeExecution.executedSteps.map((step) => (
                  <li key={step.id}>• {step.id}: {step.detail}</li>
                )) : <li>• 暂无</li>}
              </ul>
            </div>
            <div className="space-y-2">
              <p className="text-zinc-500">跳过 / 阻塞：</p>
              <ul className="space-y-1 text-zinc-300">
                {envStatus.upgradeExecution.skippedSteps.length > 0 ? envStatus.upgradeExecution.skippedSteps.map((step) => (
                  <li key={step.id}>• {step.id}: {step.detail}</li>
                )) : <li>• 暂无</li>}
              </ul>
              {envStatus.upgradeExecution.blockers.length > 0 && (
                <>
                  <p className="text-zinc-500 pt-1">Blockers：</p>
                  <ul className="space-y-1 text-rose-300">
                    {envStatus.upgradeExecution.blockers.map((blocker, index) => (
                      <li key={`blocker-${index}`}>• {blocker}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Official Path */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-4 bg-emerald-500 rounded-full" />
            <h3 className="font-bold text-zinc-100">官方标准安装方案</h3>
          </div>
          <div className="space-y-3">
            <EnvItem 
              icon={Cpu} 
              label="WSL 核心功能" 
              status={envStatus.wsl || 'loading'} 
              sub="Windows Subsystem for Linux"
              onFix={() => executeAction('wsl')}
            />
            <EnvItem 
              icon={Settings} 
              label="虚拟机平台" 
              status={envStatus.vmPlatform || 'loading'} 
              sub="Virtual Machine Platform"
              onFix={() => executeAction('vmPlatform')}
            />
            <EnvItem 
              icon={Package} 
              label="OpenClaw Runtime" 
              status={envStatus.runtime || 'loading'} 
              sub="核心运行环境镜像 (rootfs)"
              onFix={() => executeAction('importRuntime')}
            />
            <div className="pt-2 pb-1 border-t border-zinc-800/50">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">WSL 内部组件检测</span>
            </div>
            <EnvItem 
              icon={Terminal} 
              label="Node.js 运行时" 
              status={envStatus.node?.isOk ? 'installed' : 'error'} 
              sub={envStatus.nodeDetails?.version ? `Windows 版本: ${envStatus.nodeDetails.version}` : 'Windows 未检测到 Node'}
              onFix={() => executeAction('installNodeOffline')}
            />
            <EnvItem 
              icon={Terminal} 
              label="Git (WSL)" 
              status={envStatus.git?.isOk ? 'installed' : 'error'} 
              sub={envStatus.git?.version !== 'not_installed' ? `Windows Git 版本: ${envStatus.git?.version}` : 'Windows 未检测到 Git'}
              onFix={() => refreshStatus()}
            />
          </div>
          <button 
            onClick={handleInstallAll}
            disabled={installState.isInstalling}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold shadow-lg shadow-emerald-900/20 transition-all disabled:opacity-50"
          >
            {installState.isInstalling ? "正在安装/修复..." : "一键官方安装/修复"}
          </button>
        </div>

        {/* Sandbox Path */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-4 bg-blue-500 rounded-full" />
            <h3 className="font-bold text-zinc-100">沙盒隔离安装方案</h3>
          </div>
          <div className="space-y-3">
            <EnvItem 
              icon={Shield} 
              label="Windows 沙盒功能" 
              status={envStatus.sandboxFeature || 'loading'} 
              sub="Windows Sandbox (仅限专业版/企业版)"
              onFix={() => executeAction('openUrl', undefined, { url: 'ms-settings:optionalfeatures' })}
            />
            <Card className="p-4 bg-blue-500/5 border-blue-500/20">
              <p className="text-xs text-blue-400 leading-relaxed">
                沙盒方案将在一个完全隔离的临时环境中运行 OpenClaw。关闭沙盒后，所有数据将自动清除，适合临时测试或高度安全需求。
              </p>
            </Card>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl space-y-2">
              <h4 className="text-xs font-bold text-zinc-400 uppercase">沙盒准备清单</h4>
              <ul className="text-[10px] text-zinc-500 space-y-1 list-disc pl-4">
                <li>确保 BIOS 已开启虚拟化 (VT-x/AMD-V)</li>
                <li>确保桌面“一键安装小龙虾本地环境”文件夹内有 openclaw-rootfs.tar</li>
              </ul>
            </div>
          </div>
          <button 
            onClick={async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              await executeAction('sandboxInstall');
              btn.disabled = false;
            }}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold shadow-lg shadow-blue-900/20 transition-all disabled:opacity-50"
          >
            一键生成沙盒配置 (.wsb)
          </button>
        </div>
      </div>

      {/* Local Resource Status */}
      <Card className="p-6 border-emerald-500/20 bg-emerald-500/5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <FolderCheck size={20} className="text-emerald-500" />
            <h3 className="font-bold text-white">本地资源包状态</h3>
          </div>
          <StatusBadge status={envStatus.localResources?.folderExists ? 'installed' : 'not_installed'} />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-zinc-900/50 rounded-lg border border-zinc-800">
            <div className="flex items-center gap-2">
              <FileArchive size={14} className={envStatus.localResources?.rootfsExists ? "text-emerald-500" : "text-zinc-600"} />
              <span className="text-xs text-zinc-300">openclaw-rootfs.tar</span>
            </div>
            <span className="text-[10px] text-zinc-500">{envStatus.localResources?.rootfsExists ? "已就绪" : "未找到"}</span>
          </div>
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            检测路径: <code className="bg-zinc-950 px-1 rounded text-zinc-400">{envStatus.localResources?.path}</code>
            <br />
模式建议: <strong className="text-zinc-300">{envStatus.offlineResources?.modeSuggestion || 'online'}</strong>。
            <br />
            {envStatus.offlineResources?.advice?.join('；')}
          </p>
        </div>
      </Card>
    </div>
  );

  const renderModelConfig = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">模型配置</h2>
        <p className="text-zinc-400 text-sm mt-1">配置并测试 AI 模型提供商</p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {/* Alibaba Bailian */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
                <Package size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">阿里云百炼 (Bailian)</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://bailian.console.aliyun.com/' })}
              className="text-xs text-emerald-500 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
                <input 
                  type="password" 
                  value={bailianKey}
                  onChange={(e) => setBailianKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 pl-10 pr-4 text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { bailian: { api_key: bailianKey, type: 'openai' } } } } })}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('bailian', { apiKey: bailianKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'bailian' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* DeepSeek */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
                <Cpu size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">DeepSeek</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://platform.deepseek.com/' })}
              className="text-xs text-blue-500 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
                <input 
                  type="password" 
                  value={deepseekKey}
                  onChange={(e) => setDeepseekKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 pl-10 pr-4 text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors"
                />
              </div>
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { deepseek: { api_key: deepseekKey, type: 'openai' } } } } })}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('deepseek', { apiKey: deepseekKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'deepseek' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* OpenAI */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-zinc-100/10 text-zinc-100 rounded-lg">
                <Package size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">OpenAI</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://platform.openai.com/' })}
              className="text-xs text-zinc-400 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <input 
                type="password" 
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-zinc-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { openai: { api_key: openaiKey, type: 'openai' } } } } })}
                className="flex-1 py-2 bg-zinc-100 text-zinc-950 rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('openai', { apiKey: openaiKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'openai' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* OpenAI Codex / Session Login */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
                <Key size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">OpenAI Codex (Session 登录)</h3>
            </div>
          </div>
          <p className="text-xs text-zinc-500">通过浏览器 Session Token 登录，适用于没有 API Key 的情况。</p>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">Session Token</span>
              <input 
                type="password" 
                value={codexToken}
                onChange={(e) => setCodexToken(e.target.value)}
                placeholder="__Secure-next-auth.session-token"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { codex: { session_token: codexToken, type: 'codex' } } } } })}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('codex', { apiKey: codexToken })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                校验 Token
              </button>
            </div>
            {testResult?.provider === 'codex' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* Zhipu AI */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/10 text-purple-400 rounded-lg">
                <Activity size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">智谱 AI (Zhipu)</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://open.bigmodel.cn/' })}
              className="text-xs text-purple-500 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <input 
                type="password" 
                value={zhipuKey}
                onChange={(e) => setZhipuKey(e.target.value)}
                placeholder="API Key"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-purple-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { zhipu: { api_key: zhipuKey, type: 'openai' } } } } })}
                className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('zhipu', { apiKey: zhipuKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'zhipu' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* Anthropic */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg">
                <Package size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">Anthropic (Claude)</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://console.anthropic.com/' })}
              className="text-xs text-amber-500 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <input 
                type="password" 
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-amber-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { anthropic: { api_key: anthropicKey, type: 'anthropic' } } } } })}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('anthropic', { apiKey: anthropicKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'anthropic' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* Google Gemini */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-lg">
                <Activity size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">Google Gemini</h3>
            </div>
            <button 
              onClick={() => executeAction('openUrl', undefined, { url: 'https://aistudio.google.com/app/apikey' })}
              className="text-xs text-indigo-500 hover:underline flex items-center gap-1"
            >
              获取 API Key <ExternalLink size={12} />
            </button>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API Key</span>
              <input 
                type="password" 
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIza..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { gemini: { api_key: geminiKey, type: 'gemini' } } } } })}
                className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('gemini', { apiKey: geminiKey })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'gemini' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* Ollama (Local) */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-zinc-800 text-zinc-200 rounded-lg">
              <Cpu size={20} />
            </div>
            <h3 className="font-bold text-zinc-100">Ollama (本地运行)</h3>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">API 地址</span>
              <input 
                type="text" 
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-zinc-500/50 transition-colors"
              />
            </label>
            <div className="flex gap-3">
              <button 
                onClick={() => executeAction('writeConfig', undefined, { config: { models: { providers: { ollama: { base_url: ollamaUrl, type: 'ollama' } } } } })}
                className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                保存配置
              </button>
              <button 
                onClick={() => testModel('ollama', { baseUrl: ollamaUrl })}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
              >
                测试连接
              </button>
            </div>
            {testResult?.provider === 'ollama' && (
              <div className={cn("text-xs p-2 rounded", testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
                {testResult.message}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );

  const renderChannelConfig = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">渠道配置</h2>
        <p className="text-zinc-400 text-sm mt-1">配置国内友好的协作渠道</p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
              <MessageSquare size={20} />
            </div>
            <h3 className="font-bold text-zinc-100">飞书 (Feishu / Lark)</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">App ID</span>
              <input 
                type="text" 
                value={feishuId}
                onChange={(e) => setFeishuId(e.target.value)}
                placeholder="cli_..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
            </label>
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">App Secret</span>
              <input 
                type="password" 
                value={feishuSecret}
                onChange={(e) => setFeishuSecret(e.target.value)}
                placeholder="******"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
            </label>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={() => executeAction('writeConfig', undefined, { config: { channels: { feishu: { app_id: feishuId, app_secret: feishuSecret } } } })}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
            >
              保存并应用
            </button>
            <button 
              onClick={() => testChannel('feishu', { app_id: feishuId, app_secret: feishuSecret })}
              className="px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
            >
              测试连接
            </button>
          </div>
          {channelTestResult?.channel === 'feishu' && (
            <div className={cn("text-xs p-2 rounded", channelTestResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
              {channelTestResult.message}
            </div>
          )}
        </Card>

        {/* QQ Bot */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
              <MessageSquare size={20} />
            </div>
            <h3 className="font-bold text-zinc-100">QQ 机器人</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">机器人 ID</span>
              <input 
                type="text" 
                value={qqBotId}
                onChange={(e) => setQqBotId(e.target.value)}
                placeholder="Bot ID"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors"
              />
            </label>
            <label className="block">
              <span className="text-zinc-300 text-sm font-medium mb-2 block">机器人 Token</span>
              <input 
                type="password" 
                value={qqBotToken}
                onChange={(e) => setQqBotToken(e.target.value)}
                placeholder="Token"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors"
              />
            </label>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={() => executeAction('writeConfig', undefined, { config: { channels: { qq: { bot_id: qqBotId, bot_token: qqBotToken } } } })}
              className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
            >
              保存并应用
            </button>
            <button 
              onClick={() => testChannel('qq', { bot_id: qqBotId, bot_token: qqBotToken })}
              className="px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
            >
              测试连接
            </button>
          </div>
          {channelTestResult?.channel === 'qq' && (
            <div className={cn("text-xs p-2 rounded", channelTestResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
              {channelTestResult.message}
            </div>
          )}
        </Card>

        {/* DingTalk */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/10 text-blue-500 rounded-lg">
              <MessageSquare size={20} />
            </div>
            <h3 className="font-bold text-zinc-100">钉钉 (DingTalk)</h3>
          </div>
          <label className="block">
            <span className="text-zinc-300 text-sm font-medium mb-2 block">Webhook Access Token</span>
            <input 
              type="password" 
              value={dingtalkToken}
              onChange={(e) => setDingtalkToken(e.target.value)}
              placeholder="Access Token"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors"
            />
          </label>
          <div className="flex gap-3">
            <button 
              onClick={() => executeAction('writeConfig', undefined, { config: { channels: { dingtalk: { access_token: dingtalkToken } } } })}
              className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
            >
              保存并应用
            </button>
            <button 
              onClick={() => testChannel('dingtalk', { access_token: dingtalkToken })}
              className="px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
            >
              测试连接
            </button>
          </div>
          {channelTestResult?.channel === 'dingtalk' && (
            <div className={cn("text-xs p-2 rounded", channelTestResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
              {channelTestResult.message}
            </div>
          )}
        </Card>

        {/* WeChat Work */}
        <Card className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-600/10 text-emerald-500 rounded-lg">
              <MessageSquare size={20} />
            </div>
            <h3 className="font-bold text-zinc-100">企业微信 (WeChat Work)</h3>
          </div>
          <label className="block">
            <span className="text-zinc-300 text-sm font-medium mb-2 block">Webhook Key</span>
            <input 
              type="password" 
              value={wechatWorkKey}
              onChange={(e) => setWechatWorkKey(e.target.value)}
              placeholder="Key"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-4 text-zinc-200 focus:outline-none focus:border-emerald-500/50 transition-colors"
            />
          </label>
          <div className="flex gap-3">
            <button 
              onClick={() => executeAction('writeConfig', undefined, { config: { channels: { wechat_work: { key: wechatWorkKey } } } })}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors"
            >
              保存并应用
            </button>
            <button 
              onClick={() => testChannel('wechat_work', { key: wechatWorkKey })}
              className="px-6 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
            >
              测试连接
            </button>
          </div>
          {channelTestResult?.channel === 'wechat_work' && (
            <div className={cn("text-xs p-2 rounded", channelTestResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400")}>
              {channelTestResult.message}
            </div>
          )}
        </Card>

        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
                <ExternalLink size={20} />
              </div>
              <h3 className="font-bold text-zinc-100">WebChat (内置网页对话)</h3>
            </div>
            <StatusBadge status="installed" />
          </div>
          <p className="text-xs text-zinc-500">OpenClaw 默认开启的网页对话界面，无需额外配置，启动 Gateway 后即可通过 127.0.0.1:18789 访问。</p>
          <button 
            onClick={() => executeAction('openUrl', undefined, { url: 'http://127.0.0.1:18789' })}
            className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-medium transition-colors"
          >
            立即访问
          </button>
        </Card>
      </div>
    </div>
  );

  const renderStatus = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">运行状态</h2>
        <p className="text-zinc-400 text-sm mt-1">监控 Node / WSL / 端口 / Gateway 的真实检测结果</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Node</span>
            <StatusBadge status={envStatus.node?.isOk ? 'installed' : 'error'} />
          </div>
          <div className="text-sm text-zinc-300">{envStatus.nodeDetails?.version || '未检测到'}</div>
        </Card>
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">WSL</span>
            <StatusBadge status={envStatus.wsl || 'loading'} />
          </div>
          <div className="text-sm text-zinc-300 truncate">{envStatus.wslDetails?.defaultDistro || '无默认发行版'}</div>
        </Card>
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Port 18789</span>
            <StatusBadge status={envStatus.port18789?.occupied ? 'error' : 'installed'} />
          </div>
          <div className="text-sm text-zinc-300">{envStatus.port18789?.occupied ? `PID ${envStatus.port18789.pid || '未知'} 占用` : '端口空闲'}</div>
        </Card>
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Gateway</span>
            <StatusBadge status={envStatus.gateway || 'loading'} />
          </div>
          <div className="text-sm text-zinc-300 truncate">{envStatus.gatewayDetails?.entryPoint || 'placeholder / future integration point'}</div>
        </Card>
      </div>

      <Card className="p-6 space-y-4">
        <h3 className="text-lg font-bold text-white">运行时与端口信息</h3>
        <div className="space-y-2 text-sm text-zinc-400">
          <p>离线资源模式建议：<span className="text-zinc-200">{envStatus.offlineResources?.modeSuggestion || 'online'}</span></p>
          <p>离线资源缺失：<span className="text-zinc-200">{envStatus.offlineResources?.missingFiles?.join('、') || '无'}</span></p>
          <p>WSL 诊断建议：<span className="text-zinc-200">{envStatus.wslDetails?.advice?.join('；') || '无'}</span></p>
          <p>端口检测原始结果：<span className="text-zinc-200 break-all">{envStatus.port18789?.rawOutput || '无'}</span></p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button 
            onClick={async () => {
              setIsStartingGateway(true);
              await executeAction('startGateway');
              setIsStartingGateway(false);
            }}
            disabled={isStartingGateway}
            className="flex items-center justify-center gap-3 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all shadow-lg shadow-emerald-900/20 group disabled:opacity-50"
          >
            {isStartingGateway ? <RefreshCw size={24} className="animate-spin" /> : <Play size={24} className="group-hover:scale-110 transition-transform" />}
            <div className="text-left">
              <span className="block font-bold">启动 Gateway 骨架</span>
              <span className="block text-[10px] opacity-70">检查入口并尝试以独立进程启动</span>
            </div>
          </button>
          <div className="grid grid-cols-2 gap-4">
            <button onClick={() => executeAction('restartGateway')} className="py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl flex flex-col items-center gap-2 transition-all">
              <RefreshCw size={20} />
              <span className="text-xs font-medium">重启 Gateway</span>
            </button>
            <button onClick={() => executeAction('killPortProcess', undefined, { port: 18789 })} className="py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl flex flex-col items-center gap-2 transition-all">
              <Trash2 size={20} />
              <span className="text-xs font-medium">释放端口 18789</span>
            </button>
          </div>
        </div>
      </Card>
    </div>
  );

  const renderRepair = () => {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">修复与卸载</h2>
            <p className="text-zinc-400 text-sm mt-1">第一批真实诊断规则与可观察修复入口</p>
          </div>
          <button 
            onClick={runDiagnostics}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-bold"
          >
            重新执行诊断
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <Card className="p-6 border-rose-500/20 bg-rose-500/5">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="text-rose-500" />
              <h3 className="font-bold text-white">智能诊断报告</h3>
            </div>
            {diagnostics.length > 0 ? (
              <div className="space-y-3">
                {diagnostics.map((issue) => (
                  <div key={issue.id} className="flex items-start gap-3 p-3 bg-zinc-900/50 rounded-lg border border-zinc-800">
                    <div className={cn(
                      'mt-1 p-1 rounded',
                      issue.status === 'healthy' ? 'bg-emerald-500/10 text-emerald-400' : issue.status === 'warning' ? 'bg-amber-500/10 text-amber-400' : 'bg-rose-500/10 text-rose-400'
                    )}>
                      {issue.status === 'healthy' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-bold text-zinc-200">{issue.title}</h4>
                      <p className="text-xs text-zinc-400 mt-1">{issue.summary}</p>
                      <ul className="mt-2 text-[11px] text-zinc-500 list-disc pl-4 space-y-1">
                        {issue.details.map((detail, index) => <li key={index}>{detail}</li>)}
                      </ul>
                    </div>
                    {issue.repairable && (
                      <button 
                        onClick={() => repairDiagnostic(issue.id)}
                        className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded border border-zinc-700"
                      >
                        一键修复
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <CheckCircle2 size={48} className="text-emerald-500 mx-auto mb-3 opacity-20" />
                <p className="text-zinc-400">暂无诊断结果，请点击“重新执行诊断”</p>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2">
                <Wrench size={18} className="text-emerald-500" />
                定向修复工具
              </h3>
              <div className="grid grid-cols-1 gap-2">
                <button onClick={() => executeAction('killPortProcess', undefined, { port: 18789 })} className="w-full text-left p-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors flex justify-between items-center">
                  <span>释放 Gateway 默认端口 18789</span>
                  <ChevronRight size={14} className="text-zinc-600" />
                </button>
                <button onClick={() => executeAction('installNodeOffline')} className="w-full text-left p-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors flex justify-between items-center">
                  <span>Node 离线安装入口（占位）</span>
                  <ChevronRight size={14} className="text-zinc-600" />
                </button>
                <button onClick={() => executeAction('repairWSL')} className="w-full text-left p-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors flex justify-between items-center">
                  <span>WSL 修复骨架</span>
                  <ChevronRight size={14} className="text-zinc-600" />
                </button>
                <button onClick={() => executeAction('repairOfflineResources')} className="w-full text-left p-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-xs text-zinc-300 transition-colors flex justify-between items-center">
                  <span>离线资源修复建议</span>
                  <ChevronRight size={14} className="text-zinc-600" />
                </button>
              </div>
            </Card>

            <Card className="p-4 space-y-4 border-rose-500/30">
              <h3 className="font-bold text-white flex items-center gap-2">
                <Trash2 size={18} className="text-rose-500" />
                危险操作 (真实骨架)
              </h3>
              <div className="space-y-2">
                <button 
                  onClick={() => askConfirm('确定要停止所有 Gateway 服务吗？', () => executeAction('stopGateway'))}
                  className="w-full text-left p-2 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-[10px] text-zinc-400 transition-colors"
                >
                  1. 停止 Gateway 独立进程
                </button>
                <button 
                  onClick={() => askConfirm('确定要执行深度重置吗？该操作会清理 OpenClaw 运行时目录、WSL 发行版、状态和日志，但保留工作区。', () => executeAction('resetRuntime'))}
                  className="w-full text-left p-2 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-[10px] text-zinc-400 transition-colors"
                >
                  2. 深度重置运行时（保留工作区）
                </button>
                <button 
                  onClick={() => askConfirm('确定要删除本地配置文件吗？', () => executeAction('deleteConfig'))}
                  className="w-full text-left p-2 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg text-[10px] text-zinc-400 transition-colors"
                >
                  3. 清理 ~/.openclaw 配置文件
                </button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    );
  };

  const renderLogs = () => (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">运行日志</h2>
          <p className="text-zinc-400 text-sm mt-1">优先展示真实系统 / PowerShell / Gateway / Diagnostics 日志流</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={async () => {
              const result = await appApi.exportLogs();
              showNotification(result.result || result.error || '日志导出完成', result.success ? 'success' : 'error');
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            导出日志
          </button>
          <button 
            onClick={async () => {
              await appApi.clearLogs();
              setLogs('');
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            清空显示
          </button>
        </div>
      </div>

      <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl p-4 font-mono text-xs overflow-auto custom-scrollbar">
        <div className="space-y-1">
          {logs.split('\n').filter(Boolean).map((line, i) => (
            <div key={i} className={cn(
              'flex gap-3',
              line.includes('[ERROR]') ? 'text-rose-400' : 
              line.includes('[SUCCESS]') ? 'text-emerald-400' :
              line.includes('[WARN]') ? 'text-amber-400' : 'text-zinc-400'
            )}>
              <span className="text-zinc-600 select-none">[{i + 1}]</span>
              <span>{line}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 flex font-sans selection:bg-emerald-500/30">
      {/* Notification Toast */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 20, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            className={cn(
              "fixed top-0 left-1/2 z-50 px-6 py-3 rounded-xl shadow-2xl border flex items-center gap-3 min-w-[300px]",
              notification.type === 'success' ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" :
              notification.type === 'error' ? "bg-rose-500/10 border-rose-500/20 text-rose-400" :
              "bg-zinc-800 border-zinc-700 text-zinc-200"
            )}
          >
            {notification.type === 'success' ? <CheckCircle2 size={18} /> : 
             notification.type === 'error' ? <XCircle size={18} /> : 
             <AlertCircle size={18} />}
            <span className="font-medium">{notification.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {confirmModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl shadow-2xl max-w-md w-full space-y-6"
            >
              <div className="flex items-center gap-3 text-amber-400">
                <AlertCircle size={24} />
                <h3 className="text-lg font-bold text-white">确认操作</h3>
              </div>
              <p className="text-zinc-400 text-sm leading-relaxed">{confirmModal.message}</p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setConfirmModal(null)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg font-medium transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    confirmModal.onConfirm();
                    setConfirmModal(null);
                  }}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-medium transition-colors"
                >
                  确认
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-800 p-6 flex flex-col gap-8">
        <div className="flex items-center gap-3 px-2">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-zinc-950 shadow-lg shadow-emerald-500/20">
            <Terminal size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white leading-tight">OpenClaw</h1>
            <p className="text-[10px] text-emerald-500 font-bold tracking-widest uppercase">Launcher</p>
          </div>
        </div>

        <nav className="flex-1 flex flex-col gap-2">
          <SidebarItem icon={Monitor} label="环境检测" active={activeTab === 'home'} onClick={() => setActiveTab('home')} />
          <SidebarItem icon={Cpu} label="模型配置" active={activeTab === 'model'} onClick={() => setActiveTab('model')} />
          <SidebarItem icon={MessageSquare} label="渠道配置" active={activeTab === 'channel'} onClick={() => setActiveTab('channel')} />
          <SidebarItem icon={Activity} label="运行状态" active={activeTab === 'status'} onClick={() => setActiveTab('status')} />
          <SidebarItem icon={Wrench} label="修复与卸载" active={activeTab === 'repair'} onClick={() => setActiveTab('repair')} />
          <SidebarItem icon={FileText} label="运行日志" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} />
        </nav>

        <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">版本信息</span>
            <span className="text-[10px] font-bold text-emerald-500">v1.2.0</span>
          </div>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            OpenClaw 官方 Windows 启动器，为您提供一键式部署体验。
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-auto">
        <div className="max-w-4xl mx-auto h-full">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              {activeTab === 'home' && renderHome()}
              {activeTab === 'model' && renderModelConfig()}
              {activeTab === 'channel' && renderChannelConfig()}
              {activeTab === 'status' && renderStatus()}
              {activeTab === 'repair' && renderRepair()}
              {activeTab === 'logs' && renderLogs()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Global Progress Overlay */}
      {installState.isInstalling && (
        <div className="fixed inset-0 bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-8 space-y-6 shadow-2xl shadow-emerald-500/10">
            <div className="text-center">
              <RefreshCw size={48} className="mx-auto text-emerald-500 animate-spin mb-4" />
              <h3 className="text-xl font-bold text-white">正在安装 OpenClaw</h3>
              <p className="text-zinc-400 text-sm mt-2">{envStatus.installWorkflow?.history.at(-1)?.message || '请勿关闭程序，这可能需要几分钟时间...'}</p>
            </div>
            
            <div className="space-y-3">
              {installProgressItems.map((step, i) => (
                <div key={step.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold",
                      step.status === 'completed' ? "bg-emerald-500 text-zinc-950" : "bg-zinc-800 text-zinc-500"
                    )}>
                      {step.status === 'completed' ? <CheckCircle2 size={14} /> : i + 1}
                    </div>
                    <span className={cn("text-sm", step.status === 'completed' ? "text-zinc-200" : "text-zinc-500")}>{step.label}</span>
                  </div>
                  {step.status === 'completed' ? (
                    <span className="text-[10px] font-bold text-emerald-500 uppercase">完成</span>
                  ) : (
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-800 animate-pulse" />
                  )}
                </div>
              ))}
            </div>

            <div className="pt-4">
              <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                <motion.div 
                  className="bg-emerald-500 h-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${workflowProgress}%` }}
                />
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
