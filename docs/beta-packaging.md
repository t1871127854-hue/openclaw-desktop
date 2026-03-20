# OpenClaw Desktop Beta 打包与测试分发说明

> 目标：尽快产出可在其他电脑安装 / 运行 / 测试的 Beta 测试包。  
> 范围：不处理正式签名、自动更新、商店分发，只覆盖最小可用 Beta 打包。

---

## 1. 当前可打包产物

### Windows

- **便携包**：`portable.exe`
  - 适合内部快速验证。
  - 不需要安装，可直接分发给测试人员。
- **安装包**：`nsis setup.exe`
  - 适合在其他测试机做更接近真实安装的验证。

### macOS

- **DMG**
  - 适合给测试人员拖拽安装。
- **ZIP**
  - 适合内部快速传输与解压测试。

---

## 2. 当前仓库实际打包命令

### 开发构建

```bash
npm run build
```

用途：

- 生成 `dist/` 与 `dist-electron/`，用于本地验证前端与 Electron 主进程构建是否通过。

### 生产构建（通用）

```bash
npm run build:desktop
```

用途：

- 先执行 Vite/Electron 构建，再调用 `electron-builder --publish never`。
- 产物输出到 `release/`。

### Windows 打包

```bash
npm run dist:win
```

产物：

- Windows portable 包
- Windows NSIS 安装包

### macOS 打包

```bash
npm run dist:mac
```

产物：

- macOS DMG
- macOS ZIP

### 目录包（仅验证打包结构）

```bash
npm run pack:dir
```

用途：

- 不产出安装器，只生成 unpacked 目录，适合快速检查 `files` / `extraResources` 是否正确。

---

## 3. 测试包必须包含哪些资源

### 必带

- 打包产物本体（Windows portable / setup，或 macOS dmg / zip）
- `offline_resources/` 目录（若要测试 full-offline、hybrid、import-local）
- `README.md`（已随包）

### 视测试目标决定是否必须附带

- 如果只测 UI、配置、日志、基础状态刷新：**可以不带完整 offline_resources**。
- 如果要测：
  - full-offline
  - hybrid
  - import-local
  - runtime install
  - staging/upgrade 资源链  
  则**必须提供真实 `offline_resources/` 内容**，至少包括 manifest、rootfs、Node 离线包及校验资源。

### 当前策略

- 打包配置已把仓库根目录 `offline_resources/` 作为 `extraResources` 带入安装包。
- 若构建机上的 `offline_resources/` 只有占位说明文件，则测试包内也只会带占位说明，不会凭空生成真实离线资源。
- 因此：**离线测试仍需要构建前先把真实离线资源放入仓库根目录 `offline_resources/`，或另外打 sidecar 包分发给测试人员。**

---

## 4. 测试人员拿到什么文件

### Windows 测试人员

推荐至少拿到：

- `OpenClaw Launcher-<version>-windows-x64-setup.exe`
- 或 `OpenClaw Launcher-<version>-windows-x64-portable.exe`
- 如需离线测试，再附带完整 `offline_resources/` 目录

### macOS 测试人员

推荐至少拿到：

- `OpenClaw Launcher-<version>-mac-*.dmg`
- 或 `OpenClaw Launcher-<version>-mac-*.zip`
- 如需离线测试，再附带完整 `offline_resources/` 目录

---

## 5. 第一次启动会发生什么

- 应用启动后会做环境检测。
- 会检查 Node、WSL、Gateway、offline resources、upgrade plan 等状态。
- 会在应用目录附近生成：
  - `openclaw_launcher.log`
  - `install_state.json`
- 若执行安装 / 升级流程，日志会持续写入。

---

## 6. 测试重点看什么

优先级最高：

1. 能否启动并正常显示状态页。
2. 日志是否真实写入。
3. 安装链是否会出现假成功。
4. Gateway start/stop 是否真实反映端口和运行状态。
5. 升级链是否只到 staged / validate / finalize plan，而不会伪装成已 finalize。

若测试离线能力，再重点看：

6. `offline_resources/` 是否被正确带入或正确旁路分发。
7. manifest / hash / 缺失资源失败摘要是否可读。

---

## 7. 出问题后日志在哪

### 打包版默认重点文件

- 应用旁边 / 可执行文件同级：
  - `openclaw_launcher.log`
  - `install_state.json`

### 其他需要一并回传的内容

- 测试机器系统版本、架构
- 使用的安装模式
- 是否带了 `offline_resources/`
- 操作步骤与复现次数
- 若有升级问题，附上 upgrade blockers / failure summary 截图

---

## 8. 当前打包限制

1. **尚未接入正式签名**  
   - Windows / macOS 可能出现系统安全提示。

2. **尚未接入正式图标资源**  
   - 当前 Beta 以“能安装/运行/测试”为主，图标与品牌资源仍可后补。

3. **offline_resources 不会自动生成真实内容**  
   - 必须在构建前放入，或作为 sidecar 目录另外分发。

4. **升级 finalize / live rollback 仍是保守骨架**  
   - Beta 包适合测试准备链、校验链、失败摘要和 blockers，不适合承诺正式升级能力。
