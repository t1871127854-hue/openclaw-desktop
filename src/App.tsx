import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FolderCog, LayoutDashboard, RefreshCcw, Rocket, Settings2, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import type { CommandResult, FeishuConfigForm, ItemStatus, LauncherOverview, PersistedWorkflowState, RepairReport } from './types/api';
import { BAILIAN_MODELS } from './lib/models';

const api = window.openclawApi;
const tabs = [
  { key: 'detect', label: '环境检测', icon: ShieldAlert },
  { key: 'model', label: '模型配置', icon: Settings2 },
  { key: 'feishu', label: '飞书配置', icon: FolderCog },
  { key: 'runtime', label: '运行状态', icon: Rocket },
  { key: 'repair', label: '修复与卸载', icon: Wrench },
  { key: 'logs', label: '日志', icon: LayoutDashboard },
] as const;

function statusLabel(status: ItemStatus) {
  return {
    installed: '已安装', not_installed: '未安装', reboot_required: '需重启', configured: '已配置', not_configured: '未配置', running: '运行中', stopped: '已停止', error: '异常', fixable: '可修复', warning: '警告', unknown: '未知',
  }[status] ?? status;
}

function CommandResultView({ result }: { result: CommandResult }) {
  return (
    <div className="command-result">
      <div><strong>Step:</strong> {result.step}</div>
      <div><strong>Command:</strong> {result.command} {result.args.join(' ')}</div>
      <div><strong>Exit:</strong> {String(result.exitCode)}</div>
      <div><strong>Stdout:</strong><pre>{result.stdout || '(empty)'}</pre></div>
      <div><strong>Stderr:</strong><pre>{result.stderr || '(empty)'}</pre></div>
      {result.suggestion ? <div className="muted">建议：{result.suggestion}</div> : null}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('detect');
  const [overview, setOverview] = useState<LauncherOverview | null>(null);
  const [workflow, setWorkflow] = useState<PersistedWorkflowState | null>(null);
  const [logs, setLogs] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<CommandResult[]>([]);
  const [repairReport, setRepairReport] = useState<RepairReport | null>(null);
  const [modelForm, setModelForm] = useState({ apiKey: '', defaultModel: BAILIAN_MODELS[0] });
  const [feishuForm, setFeishuForm] = useState<FeishuConfigForm>({ appId: '', appSecret: '' });

  const refresh = async () => {
    if (!api) return;
    const [nextOverview, nextLogs] = await Promise.all([api.getOverview(), api.getLogs()]);
    setOverview(nextOverview);
    setWorkflow(nextOverview.workflow);
    setLogs(nextLogs);
    if (!modelForm.apiKey) {
      setModelForm((current) => ({ ...current, defaultModel: nextOverview.modelConfig.defaultModel ?? current.defaultModel }));
    }
  };

  useEffect(() => {
    void refresh();
    if (!api) return;
    const unLog = api.subscribeLogs(() => { void refresh(); });
    const unWorkflow = api.subscribeWorkflow((state) => setWorkflow(state));
    return () => { unLog(); unWorkflow(); };
  }, []);

  const kpis = useMemo(() => {
    if (!overview) return [];
    const running = overview.checks.filter((item) => ['installed', 'configured', 'running'].includes(item.status)).length;
    const blocking = overview.checks.filter((item) => ['error', 'not_installed', 'not_configured', 'fixable'].includes(item.status)).length;
    return [
      { title: '通过项', value: `${running}/${overview.checks.length}`, detail: '已通过或已配置的检测项' },
      { title: '阻塞项', value: String(blocking), detail: '需要安装、修复或配置' },
      { title: 'Dashboard', value: overview.runtime.dashboardUrl, detail: '本地 Dashboard 地址' },
    ];
  }, [overview]);

  const runAction = async (label: string, fn: () => Promise<CommandResult[] | RepairReport | CommandResult>) => {
    setBusy(label);
    try {
      const output = await fn();
      if (Array.isArray(output)) {
        setResults(output);
      } else if ('results' in output) {
        setRepairReport(output);
        setResults(output.results);
      } else {
        setResults([output]);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!api) return <div className="content"><div className="hero"><h1>IPC 未就绪</h1><p>当前页面必须在 Electron preload 环境中运行。</p></div></div>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">OpenClaw Launcher</div>
        <div className="subtitle">从零重建的 Windows Launcher / Installer。所有系统动作都走 Electron 主进程 + preload + IPC。</div>
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.key} className={`nav-button ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}>
              <Icon size={16} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
              {item.label}
            </button>
          );
        })}
      </aside>
      <main className="content">
        <section className="hero">
          <h1>环境检测优先，按钮全部真实执行</h1>
          <p className="muted">首页即环境检测页；所有按钮都返回结构化执行结果：success / step / command / args / exitCode / stdout / stderr。</p>
          <div className="grid cols-3">
            {kpis.map((item) => <div className="kpi" key={item.title}><strong>{item.title}</strong><div>{item.value}</div><div className="muted">{item.detail}</div></div>)}
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={() => void refresh()}><RefreshCcw size={16} /> 重新检测</button>
            <button className="primary" disabled={busy !== null} onClick={() => void runAction('install', () => api.installAll())}><Download size={16} /> 一键安装全部</button>
            <button className="secondary" disabled={busy !== null} onClick={() => void runAction('repair', () => api.repairAll())}><Wrench size={16} /> 一键修复全部</button>
            <button className="secondary" disabled={busy !== null} onClick={() => void runAction('resume', () => api.resumeInstall())}><Rocket size={16} /> 恢复安装</button>
            <button className="secondary" disabled={busy !== null} onClick={() => void runAction('dashboard', () => api.openDashboard())}><ExternalLink size={16} /> 打开 Dashboard</button>
            <button className="danger" disabled={busy !== null} onClick={() => void runAction('uninstall', () => api.uninstallOpenClaw())}><Trash2 size={16} /> 一键卸载 OpenClaw</button>
            <button className="danger" disabled={busy !== null} onClick={() => void runAction('uninstall-all', () => api.uninstallEverything())}><AlertTriangle size={16} /> 一键彻底卸载全部环境</button>
          </div>
          {busy ? <p className="muted">正在执行：{busy}</p> : null}
        </section>

        {tab === 'detect' && overview ? (
          <section className="card">
            <h2>环境检测</h2>
            <div className="status-grid">
              {overview.checks.map((item) => (
                <article className="status-item" key={item.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <strong>{item.title}</strong>
                    <span className={`badge ${item.status}`}>{statusLabel(item.status)}</span>
                  </div>
                  <p className="muted">{item.description}</p>
                  <div>{item.detail}</div>
                  {item.actionLabel ? <div className="muted" style={{ marginTop: 8 }}>建议动作：{item.actionLabel}</div> : null}
                </article>
              ))}
            </div>
            <div className="grid cols-3" style={{ marginTop: 16 }}>
              <div className="kpi"><strong>rootfs</strong><div>{overview.resources.rootfs.message}</div><div className="muted">{overview.resources.rootfs.path}</div></div>
              <div className="kpi"><strong>skills-pack</strong><div>{overview.resources.skillsPack.message}</div><div className="muted">{overview.resources.skillsPack.path}</div></div>
              <div className="kpi"><strong>bailian_api_key</strong><div>{overview.resources.bailianApiKey.message}</div><div className="muted">{overview.resources.bailianApiKey.path}</div></div>
            </div>
          </section>
        ) : null}

        {tab === 'model' && overview ? (
          <section className="card">
            <h2>模型配置</h2>
            <div className="form-grid">
              <label>Bailian API Key<input type="password" value={modelForm.apiKey} onChange={(e) => setModelForm({ ...modelForm, apiKey: e.target.value })} placeholder="从 resources/bailian_api_key.txt 自动读取或手动填写" /></label>
              <label>默认模型<select value={modelForm.defaultModel} onChange={(e) => setModelForm({ ...modelForm, defaultModel: e.target.value })}>{BAILIAN_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              <div className="actions">
                <button className="primary" disabled={busy !== null} onClick={() => void runAction('write-model', () => api.writeModelConfig(modelForm))}>写入 Bailian 配置</button>
                <button className="secondary" disabled={busy !== null} onClick={() => void runAction('test-model', () => api.testModelConfig(modelForm))}>一键测试</button>
                <button className="secondary" disabled={busy !== null} onClick={() => void runAction('restart-gateway', () => api.restartGateway())}>写入后重启 Gateway</button>
              </div>
            </div>
            <ul className="list">
              <li>当前状态：{overview.modelConfig.configured ? '已配置' : '未配置'}</li>
              <li>默认模型：{overview.modelConfig.defaultModel ?? '未设置'}</li>
              <li>写入目标：/home/openclaw/.openclaw/openclaw.json</li>
            </ul>
          </section>
        ) : null}

        {tab === 'feishu' && overview ? (
          <section className="card">
            <h2>飞书 / Lark 配置</h2>
            <div className="form-grid">
              <label>Feishu App ID<input value={feishuForm.appId} onChange={(e) => setFeishuForm({ ...feishuForm, appId: e.target.value })} /></label>
              <label>Feishu App Secret<input type="password" value={feishuForm.appSecret} onChange={(e) => setFeishuForm({ ...feishuForm, appSecret: e.target.value })} /></label>
              <div className="actions">
                <button className="primary" disabled={busy !== null} onClick={() => void runAction('write-feishu', () => api.writeFeishuConfig(feishuForm))}>一键写入配置</button>
                <button className="secondary" disabled={busy !== null} onClick={() => void runAction('restart-gateway', () => api.restartGateway())}>写入后自动重启 Gateway</button>
              </div>
            </div>
            <ul className="list">
              <li>当前状态：{overview.feishuConfig.configured ? '已配置' : '未配置'}</li>
              <li>App ID：{overview.feishuConfig.appIdPresent ? '已保存' : '未保存'}</li>
              <li>App Secret：{overview.feishuConfig.appSecretPresent ? '已保存' : '未保存'}</li>
            </ul>
          </section>
        ) : null}

        {tab === 'runtime' && overview ? (
          <section className="grid cols-2">
            <div className="card">
              <h2>运行状态</h2>
              <ul className="list">
                <li>Runtime：{overview.checks.find((item) => item.key === 'runtime')?.detail}</li>
                <li>Gateway：{overview.checks.find((item) => item.key === 'gateway')?.detail}</li>
                <li>配置：{overview.runtime.configPathLinux}</li>
                <li>Dashboard：{overview.runtime.dashboardUrl}</li>
                <li>技能状态：{overview.skills.detail}</li>
              </ul>
              <div className="actions" style={{ marginTop: 16 }}>
                <button className="secondary" onClick={() => void refresh()}>刷新状态</button>
                <button className="secondary" onClick={() => void runAction('dashboard', () => api.openDashboard())}>打开 Dashboard</button>
                <button className="secondary" onClick={() => void runAction('restart-gateway', () => api.restartGateway())}>重启 Gateway</button>
              </div>
            </div>
            <div className="card">
              <h2>最近错误 / 最近修复</h2>
              {overview.lastError ? <CommandResultView result={overview.lastError} /> : <p className="muted">暂无最近错误。</p>}
              {repairReport ?? overview.lastRepair ? <div><h3>{(repairReport ?? overview.lastRepair)?.title}</h3><div className="muted">共 {(repairReport ?? overview.lastRepair)?.results.length} 条结果。</div></div> : null}
            </div>
          </section>
        ) : null}

        {tab === 'repair' && overview ? (
          <section className="grid cols-2">
            <div className="card">
              <h2>修复</h2>
              <ul className="list">
                <li>修复 systemd</li>
                <li>修复 Gateway</li>
                <li>修复主配置</li>
                <li>修复模型配置</li>
                <li>重启 Gateway</li>
                <li>基础诊断与最终验收</li>
              </ul>
              <div className="actions" style={{ marginTop: 16 }}>
                <button className="primary" disabled={busy !== null} onClick={() => void runAction('repair-all', () => api.repairAll())}><Wrench size={16} /> 一键修复全部</button>
                <button className="secondary" disabled={busy !== null} onClick={() => void runAction('import-skills', () => api.importSkillsPack())}><Download size={16} /> 导入技能包</button>
              </div>
            </div>
            <div className="card">
              <h2>卸载</h2>
              <p className="muted">彻底卸载会关闭 WSL 与 VirtualMachinePlatform，可能影响其他 WSL 环境。</p>
              <div className="actions">
                <button className="danger" disabled={busy !== null} onClick={() => void runAction('uninstall-openclaw', () => api.uninstallOpenClaw())}>一键卸载 OpenClaw</button>
                <button className="danger" disabled={busy !== null} onClick={() => void runAction('uninstall-everything', () => api.uninstallEverything())}>一键彻底卸载全部环境</button>
              </div>
            </div>
          </section>
        ) : null}

        {tab === 'logs' ? (
          <section className="card">
            <h2>真实日志</h2>
            <div className="actions">
              <button className="secondary" onClick={() => void refresh()}>刷新日志</button>
              <button className="secondary" onClick={() => void api.clearLogs().then(refresh)}>清空日志</button>
            </div>
            <div className="log-box" style={{ marginTop: 16, minHeight: 380, whiteSpace: 'pre-wrap' }}>{logs || '暂无日志。'}</div>
          </section>
        ) : null}

        <section className="card">
          <h2>安装进度 / 结构化结果</h2>
          {workflow ? (
            <div className="grid cols-2">
              <div>
                {workflow.steps.map((step) => (
                  <div className="status-item" key={step.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>{step.title}</strong>
                      <span className={`badge ${step.status === 'failed' ? 'error' : step.status === 'completed' ? 'installed' : step.status === 'running' ? 'warning' : 'unknown'}`}>{step.status}</span>
                    </div>
                    <div className="muted">{step.message}</div>
                    {step.result ? <CommandResultView result={step.result} /> : null}
                  </div>
                ))}
              </div>
              <div>
                {results.length > 0 ? results.map((result, index) => <div key={`${result.step}-${index}`}><CommandResultView result={result} /></div>) : <p className="muted">执行任何动作后，会在这里展示完整命令、参数、stdout 和 stderr。</p>}
              </div>
            </div>
          ) : <p className="muted">正在加载工作流状态…</p>}
        </section>
      </main>
    </div>
  );
}
