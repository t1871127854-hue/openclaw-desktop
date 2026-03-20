import type {
  DiagnosticIssue,
  NodeDetectionResult,
  OfflineResourcesResult,
  PortUsageResult,
  WSLStatusResult,
} from '../../src/types/api';

export function buildDiagnostics(params: {
  node: NodeDetectionResult;
  wsl: WSLStatusResult;
  offlineResources: OfflineResourcesResult;
  port18789: PortUsageResult;
}): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  issues.push(buildPortIssue(params.port18789));
  issues.push(buildNodeIssue(params.node));
  issues.push(buildWslIssue(params.wsl));
  issues.push(buildOfflineResourcesIssue(params.offlineResources));

  return issues;
}

function buildPortIssue(port: PortUsageResult): DiagnosticIssue {
  if (!port.occupied) {
    return {
      id: 'port-18789-in-use',
      title: 'Port 18789 检查',
      status: 'healthy',
      summary: '端口 18789 当前空闲。',
      details: ['Gateway 默认端口未被其他进程占用。'],
      repairable: false,
    };
  }

  return {
    id: 'port-18789-in-use',
    title: 'Port 18789 被占用',
    status: 'error',
    summary: `端口 18789 当前被 PID ${port.pid ?? '未知'} 占用。`,
    details: [port.rawOutput || '检测到 netstat 返回了占用信息。'],
    repairable: Boolean(port.pid),
    repairAction: 'killPortProcess',
  };
}

function buildNodeIssue(node: NodeDetectionResult): DiagnosticIssue {
  if (node.installed && node.supported) {
    return {
      id: 'node-missing-or-unsupported',
      title: 'Node.js 版本检查',
      status: 'healthy',
      summary: `Node.js ${node.version ?? 'unknown'} 已安装且满足 >= 22。`,
      details: node.advice,
      repairable: false,
    };
  }

  return {
    id: 'node-missing-or-unsupported',
    title: 'Node.js 缺失或版本不受支持',
    status: 'error',
    summary: node.installed
      ? `当前 Node.js ${node.version ?? 'unknown'} 不满足 >= 22。`
      : '当前系统未检测到 Node.js。',
    details: node.advice,
    repairable: true,
    repairAction: 'installNodeOffline',
  };
}

function buildWslIssue(wsl: WSLStatusResult): DiagnosticIssue {
  if (wsl.available && wsl.installed) {
    return {
      id: 'wsl-unavailable-or-not-installed',
      title: 'WSL 检查',
      status: 'healthy',
      summary: wsl.defaultDistro
        ? `WSL 已启用，默认发行版为 ${wsl.defaultDistro}。`
        : 'WSL 已启用，但尚未设置默认发行版。',
      details: wsl.advice,
      repairable: false,
    };
  }

  return {
    id: 'wsl-unavailable-or-not-installed',
    title: 'WSL 不可用或未安装',
    status: 'error',
    summary: '未检测到可用的 WSL 运行环境。',
    details: wsl.advice,
    repairable: true,
    repairAction: 'repairWSL',
  };
}

function buildOfflineResourcesIssue(resources: OfflineResourcesResult): DiagnosticIssue {
  if (resources.exists && resources.missingFiles.length === 0 && resources.invalidFiles.length === 0) {
    return {
      id: 'offline-resources-incomplete',
      title: '离线资源检查',
      status: 'healthy',
      summary: '离线资源目录完整，可优先走 offline 模式。',
      details: resources.advice,
      repairable: false,
    };
  }

  return {
    id: 'offline-resources-incomplete',
    title: '离线资源不完整',
    status: 'warning',
    summary: '当前 offline_resources 不完整，建议切换 online 模式或补齐资源。',
    details: resources.advice,
    repairable: true,
    repairAction: 'repairOfflineResources',
  };
}
