# OpenClaw Launcher Desktop

一个从 Google AI Studio Apps 原型演进而来的 Electron + React + TypeScript 桌面应用，用于在 Windows 上完成 OpenClaw 的环境检测、WSL Runtime 导入、Gateway 控制、模型配置、渠道配置与日志查看。

## 当前架构

```text
.
├─ electron/
│  ├─ ipc/                 # IPC 注册
│  ├─ services/            # Runtime / 日志 / 存储服务
│  ├─ main.ts              # Electron 主进程入口
│  └─ preload.ts           # 安全桥接层
├─ src/
│  ├─ services/            # Renderer API client / mock client
│  ├─ types/               # 前后端共享类型
│  ├─ App.tsx              # 保留的 UI 与页面结构
│  └─ main.tsx             # React 入口
├─ server.ts               # 浏览器模式下的 mock API
├─ vite.config.ts          # Vite + Electron + /api 代理
└─ package.json            # 桌面/浏览器双模式脚本
```

## 页面结构

当前 UI 仍保持原型中的 6 个页面：

1. 环境检测
2. 模型配置
3. 渠道配置
4. 运行状态
5. 修复与卸载
6. 运行日志

## 运行方式

### 1) 桌面模式（推荐）

```bash
npm install
npm run dev
```

这会启动 Vite，并由 `vite-plugin-electron` 拉起 Electron 主进程与 preload。

### 2) 浏览器 + Mock API 模式

```bash
npm install
npm run dev:web
```

该模式会：

- 启动 `server.ts` 暴露 `/api/*` mock 接口。
- 启动 Vite 开发服务器。
- 通过 `vite.config.ts` 中的 `/api` 代理把前端请求转发到 mock server。

### 3) 生产构建

```bash
npm run build
npm run build:desktop
```

## Runtime Service 设计

Electron 主进程中的 `RuntimeService` 负责：

- 执行 PowerShell / WSL / systemd 相关命令。
- 检查管理员权限、WSL、Virtual Machine Platform、Sandbox、Runtime、Gateway 状态。
- 导入 `resources/openclaw-rootfs.tar`。
- 同步配置到 `~/.openclaw/openclaw.json` 与 WSL 内 `/root/.openclaw/openclaw.json`。
- 预留真实系统调用入口，后续可以继续拆出更细粒度的 WSL / PowerShell provider。

## 日志系统

日志系统已从“前端轮询文本文件”升级为“主进程 stdout/stderr 实时流 + 快照读取”的双轨机制：

- `LogService.append()` 持久化日志到本地文件。
- `RuntimeService.runPowerShell()` 通过 `spawn()` 捕获 stdout/stderr。
- 新日志会通过 `openclaw:log-entry` IPC 推送到 renderer。
- renderer 仍保留快照拉取，兼容浏览器 mock 模式。

## Mock API 保留策略

`server.ts` 现在是显式的 mock backend，保留 `/api/status`、`/api/execute`、`/api/logs` 等接口，用于：

- 浏览器预览 UI。
- 联调前端交互。
- 在没有 Windows / WSL 的环境中验证页面流程。

## 配置与数据落点

### 桌面模式

- 配置文件：`~/.openclaw/openclaw.json`
- 状态文件：`<app-base>/install_state.json`
- 日志文件：`<app-base>/openclaw_launcher.log`

### Mock 模式

- mock 数据目录：`.mock-data/`

## 后续建议

- 将 `RuntimeService` 再拆分为 `PowerShellService`、`WslService`、`GatewayService`。
- 对 `openUrl`、`startGatewayAndOpen`、服务启动过程增加更细致的状态事件。
- 为 mock server 增加 SSE，以便浏览器模式也能看到实时日志流。
