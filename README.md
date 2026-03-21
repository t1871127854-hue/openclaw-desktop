# OpenClaw Launcher Desktop

OpenClaw Launcher 是一个面向 Windows 普通用户的 Electron + React + TypeScript 桌面安装器，目标是把 OpenClaw Runtime / Gateway / 模型配置 / 飞书对接 / 技能包导入 / 卸载与修复都统一到图形界面完成。

## 当前实现重点

- 环境检测首页，默认显示管理员权限、WSL、VirtualMachinePlatform、Runtime、Gateway、配置、技能包等关键状态。
- Electron 主进程负责所有真实系统动作：`wsl.exe`、`dism.exe`、资源读取、状态保存、日志写入、配置同步。
- preload 只暴露 `window.openclawApi`，前端不直接触碰系统命令。
- 所有命令返回结构化结果：`success / step / command / args / exitCode / stdout / stderr`。
- 安装流程具备顺序执行、日志记录、重启恢复注册和恢复继续执行能力。
- 打包通过 `extraResources` 把 `resources/` 中的 rootfs、技能包、默认 Bailian API Key 一起带入发布产物。

## 资源目录

将以下文件放到仓库根目录的 `resources/`：

- `openclaw-rootfs.tar`（必需）
- `skills-pack.tar.gz`（可选）
- `bailian_api_key.txt`（可选）

开发环境读取 `./resources`，打包后读取 `process.resourcesPath/resources`。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm run build:desktop
```

## 说明

当前仓库在 Linux 容器中可以完成类型检查与前端 / Electron 构建；但真正的 WSL、DISM、管理员权限、portable Windows 打包与真实安装链路，需要在 Windows 10/11 x64 机器上验证。
