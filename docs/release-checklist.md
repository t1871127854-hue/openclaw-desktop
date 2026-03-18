# OpenClaw Desktop 发布前验收清单

> 面向开发者 / 发布负责人。目标：在 Beta 或正式发布前，按平台、安装链、运行链、升级链与失败场景做一次可执行验收。

配套文档：

- 可执行 Beta 验收执行表：`docs/beta-validation-plan.md`
- Beta 验收记录模板：`docs/beta-validation-template.md`

## 0. 使用方式

- 每次准备发布前，新建一份本清单副本或在 PR / issue 中逐项打勾。
- 任一“发布阻断项”未关闭时，不应进入正式发布。
- 当前升级链中的 finalize / live rollback 仍为保守骨架，验收时必须明确记录是否仅允许 Beta 范围内试用。

---

## 1. 安装链验收

### 1.1 Windows

- [ ] 以管理员身份启动桌面端。
- [ ] 环境检测能正确展示 WSL、Virtual Machine Platform、Node、Gateway、offline resources 状态。
- [ ] `runInstallWizard` 在日志中输出完整阶段流转。
- [ ] 安装失败时 renderer 能看到失败阶段、可读提示、建议操作与是否可重试。

### 1.2 macOS

- [ ] 能完成状态检测，不出现崩溃或主进程 IPC 缺失。
- [ ] macOS adapter 能返回 install plan / validation 结果。
- [ ] stub 步骤在日志中有明确标记，不伪装成成功安装。

### 1.3 full offline

- [ ] `offline_resources/manifest.json` 可被解析。
- [ ] 必需资源齐全时，不发生网络拉取。
- [ ] manifest / hash 校验失败时，流程能中断并输出明确失败摘要。

### 1.4 hybrid

- [ ] 本地资源缺失时可以从缓存或远端继续补齐。
- [ ] 下载过程写入日志，失败可见 fallback / blocker。
- [ ] 下载后资源能进入 cache 并通过 verify。

### 1.5 online

- [ ] 远端 manifest 可访问时，资源可被下载并缓存。
- [ ] 远端 manifest 不可达时，流程中断并生成失败摘要。
- [ ] 没有资源时不会伪造 install success。

### 1.6 import local

- [ ] 本地导入目录能被扫描到。
- [ ] 平台 / 架构不匹配时会阻断导入。
- [ ] 导入成功后 cache index 更新，后续 verify 能通过。

---

## 2. 运行链验收

### 2.1 Gateway start / stop

- [ ] 启动前记录目标工作目录与入口文件。
- [ ] 启动失败时生成失败摘要与日志。
- [ ] stop / restart 行为不会留下僵尸进程。

### 2.2 WSL import

- [ ] Windows 环境下能检测到 `wsl.exe`。
- [ ] runtime/import 失败时能区分为 install-runtime 失败，而不是泛化错误。
- [ ] 出现 rootfs / distro 导入失败时，renderer 有可读提示。

### 2.3 Node detection

- [ ] Node 版本检测正确处理“未安装 / 版本过低 / 可用”三种状态。
- [ ] 日志里保留原始输出与建议。

### 2.4 runtime validation

- [ ] validate-post-install 失败时不会继续 Gateway 启动。
- [ ] validation 结果与 blocker 会写入日志。

### 2.5 reset

- [ ] reset/uninstall 入口不会误删工作区之外的路径。
- [ ] 删除 / 跳过 / warning 都会进入结果摘要。

---

## 3. 升级链验收

### 3.1 no-update

- [ ] `upgradePlan.status === no-update` 时不会进入伪升级。
- [ ] upgrade execution 应记录 skipped 组件。

### 3.2 optional update

- [ ] optional 目标会生成 prepare / verify / stage / validate 结果。
- [ ] finalize plan 中能看到 replacement targets、replacement order、risk summary。

### 3.3 required update

- [ ] required 目标会进入同样的 staging / validation 链路。
- [ ] 不满足 finalize 条件时，应明确返回 blocked / validated-but-not-finalized，而不是 success。

### 3.4 blocked

- [ ] 远端 manifest 未配置时，必须 blocked。
- [ ] 平台资源不存在时，必须 blocked。
- [ ] blocker 要进入 upgradeExecution 与 upgradeFailure。

### 3.5 staging validation

- [ ] staged 文件 hash 校验通过后，才允许生成 finalize plan。
- [ ] staged 文件 hash 校验失败时，会执行 staging rollback。

### 3.6 rollback path

- [ ] rollback plan 能列出 staging rollback 与 live rollback 的差异。
- [ ] rollback targets 中能看到 previousVersionPath / stagedPath / backupPath / blockers。
- [ ] 当前 live rollback 若仍为 future integration point，必须在结果里明确说明。

---

## 4. 失败场景验收

### 4.1 manifest 不可达

- [ ] install / upgrade 都能输出“manifest 不可达”的可读提示。
- [ ] 建议操作包含检查 URL / 网络 / 模式切换。

### 4.2 资源缺失

- [ ] install / upgrade 都能准确指出缺失资源或缺失组件。
- [ ] renderer 可看到 suggested actions。

### 4.3 hash 失败

- [ ] cache hash mismatch 与 staged hash mismatch 都能阻断流程。
- [ ] 错误摘要能指向重新下载或切换本地导入。

### 4.4 WSL 导入失败

- [ ] install-runtime 失败时能映射到 WSL / rootfs / distro 相关提示。
- [ ] 日志包含足够的技术细节用于问题定位。

### 4.5 Gateway 启动失败

- [ ] start-gateway 失败时不会误显示运行成功。
- [ ] 建议操作至少包含端口检查、bundle 准备、日志排查。

---

## 5. 风险清单

### 5.1 仍是 stub 的点

- [ ] live finalize replacement 尚未真正执行。
- [ ] live rollback 仍依赖未来的 backup snapshot 集成。
- [ ] launcher self-update / self-replacement 尚未接通。

### 5.2 平台差异风险

- [ ] Windows 与 macOS adapter 的 stub/implemented 行为不一致时已记录。
- [ ] WSL 专属链路不能假定在 macOS 可用。
- [ ] 文件锁、权限与路径差异已在发布说明中提示。

### 5.3 发布阻断项

- [ ] 任一平台 install wizard 崩溃。
- [ ] 远端 manifest 错误导致主流程挂起。
- [ ] 升级链把 validated 误报为 finalized/success。
- [ ] rollback blocker 未暴露到日志或状态。

### 5.4 建议 Beta 限制说明

- [ ] 升级功能仅建议 Beta 用户或内部测试使用。
- [ ] finalize / live rollback 仍属保守骨架，不建议承诺无感升级。
- [ ] 建议发布说明明确：升级前保留用户配置、资源缓存与运行时快照。

---

## 6. 发布结论模板

- 发布版本：
- 验收日期：
- 验收平台：
- install 结论：
- runtime 结论：
- upgrade 结论：
- blocker：
- 是否允许进入 Beta：
- 是否允许正式发布：
