# OpenClaw Desktop Beta 验收执行表

> 目的：把 `docs/release-checklist.md` 转成可直接执行、可记录、可分级、可判断是否阻断发布的 Beta 验收材料。  
> 说明：本文档中的“静态发布评审”属于基于当前仓库与文档状态的静态判断，不等同于实机全量测试结论。

---

## 1. 使用说明

- 建议在每次 Beta 候选版本冻结后，复制本文档或配合 `docs/beta-validation-template.md` 逐条填写。
- 每条验收项必须至少填写：
  - 实测环境
  - 实际结果
  - 是否通过
  - 严重级别
  - 是否阻断发布
- 若发现缺陷，必须同步记录：
  - 复现步骤
  - 日志位置
  - 责任人 / 跟进人
  - 是否要求 Beta 前修复

---

## 2. 缺陷分级标准

### P0 / Blocker

适用标准：

- 会导致用户根本无法完成安装、启动或升级主流程。
- 会导致“假成功 / 假通过 / 假 finalize / 假 rollback”。
- 会导致误删、不可恢复的数据或运行时破坏。
- 会导致 Gateway 无法启动且没有清晰失败提示。
- 会导致关键状态、日志或 blocker 无法暴露，发布团队无法判断风险。

该项目中的典型 P0：

- 安装链显示完成，但 runtime 实际未安装成功。
- 升级链把 `validated` 或 `planned` 误报为 `finalized/success`。
- reset / uninstall 有越界删除风险。
- Gateway 主入口无法启动，且 UI / 日志没有把失败暴露出来。

处理要求：

- 必须在 Beta 发布前关闭。
- 默认判定为“阻断发布”。

### P1 / High

适用标准：

- 主流程可走通，但某一关键模式/平台高概率失败。
- 有明确失败提示，但会使重要 Beta 场景无法覆盖。
- 失败后可恢复性弱，需要人工介入才能继续。

该项目中的典型 P1：

- Windows full-offline / hybrid 其中一种模式稳定失败。
- 升级链虽然不伪造成功，但 blocker / rollback 信息不完整，人工难以判断是否可继续。
- WSL 导入失败可提示，但日志不足以定位问题。

处理要求：

- 原则上 Beta 前应修。
- 若不能修，必须在 Beta 范围限制和发布说明中明确。

### P2 / Medium

适用标准：

- 不阻断主流程，但会降低验收效率、定位效率或用户理解。
- 某些边缘场景表现不稳定，但已有可读提示和替代路径。

该项目中的典型 P2：

- 建议文案不完整，模式切换建议不够准确。
- 某些 upgrade/failure 摘要缺少上下文，但仍能从日志定位。
- macOS 侧主要是 stub，但状态表达清楚，没有伪装成成功。

处理要求：

- 可作为 Beta 可接受缺陷。
- 需记录优先级和后续版本修复计划。

### P3 / Low

适用标准：

- 不影响主流程真实性与可恢复性。
- 主要是文档、提示文本、展示一致性或轻微可用性问题。

该项目中的典型 P3：

- 表述不统一。
- 日志文案不够友好。
- 文档示例缺少个别补充说明。

处理要求：

- 可进入后续增强项。
- 不阻断 Beta 发布。

---

## 3. 可执行 Beta 验收表

> 字段说明：  
> - **实际结果** / **是否通过** / **备注** 为执行时填写。  
> - **严重级别** 建议默认值，实际执行时可调整。  
> - **是否阻断发布** 为默认建议，最终由发布负责人确认。

| ID | 模块 | 验收项名称 | 测试环境 | 前置条件 | 操作步骤 | 预期结果 | 实际结果（留空） | 是否通过（留空） | 严重级别 | 是否阻断发布 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INS-WIN-01 | 安装链 | Windows 安装总流程 | Windows 10/11 x64 | 管理员权限；桌面端可启动 | 1) 启动应用 2) 刷新状态 3) 执行安装向导 | 能看到环境状态、安装阶段流转、日志持续更新 |  |  | P0 | 是 | 核心主链 |
| INS-MAC-01 | 安装链 | macOS 状态与计划可用 | macOS arm64/x64 | Electron 可启动 | 1) 启动应用 2) 刷新状态 3) 检查 plan / stub 日志 | 不崩溃；stub 明确；不伪装成功 |  |  | P1 | 否 | Beta 允许 stub，但不可假成功 |
| INS-OFF-01 | 安装链 | full offline 安装 | Windows/macOS 对应环境 | `offline_resources` 完整；manifest 可读 | 1) 断网 2) 执行离线安装 3) 查看日志 | 不依赖远端下载；资源校验通过；失败时给出准确摘要 |  |  | P0 | 是 | 离线是关键模式 |
| INS-HYB-01 | 安装链 | hybrid 安装 | Windows 优先 | 本地资源部分缺失；网络可访问 | 1) 保留部分离线资源 2) 执行安装 3) 观察下载/缓存 | 能从 cache/remote 补齐，最终资源可 verify |  |  | P1 | 是 | 需验证 fallback |
| INS-ONL-01 | 安装链 | online 安装 | Windows/macOS | 远端 manifest 与资源可访问 | 1) 清空缓存 2) 执行安装 3) 检查下载日志 | 能从远端获取 manifest/资源；失败时不假成功 |  |  | P1 | 是 | 取决于远端配置 |
| INS-IMP-01 | 安装链 | import local 安装 | Windows/macOS | 本地导入目录与 manifest 准备完成 | 1) 放入导入资源 2) 执行 import-local 3) 检查 cache index | 仅导入匹配平台/架构资源；导入后 verify 通过 |  |  | P1 | 否 | 适合作为 Beta 限定入口 |
| RUN-GW-01 | 运行链 | Gateway start | Windows/macOS | runtime 已准备；入口文件存在 | 1) 执行 startGateway 2) 观察端口/日志 | Gateway 进入 running，端口状态与日志一致 |  |  | P0 | 是 | 主可用性 |
| RUN-GW-02 | 运行链 | Gateway stop | Windows/macOS | Gateway 已运行 | 1) 执行 stop/restart 2) 检查端口与进程 | 进程正常退出，无僵尸残留 |  |  | P1 | 否 | 与 RUN-GW-01 成对 |
| RUN-WSL-01 | 运行链 | WSL import | Windows | WSL 可用；rootfs 已准备 | 1) 执行 runtime/import 相关流程 2) 查看日志与状态 | 能识别导入成功或准确暴露导入失败 |  |  | P0 | 是 | Windows 特有高风险点 |
| RUN-NODE-01 | 运行链 | Node detection | Windows/macOS | 安装不同版本 Node 或模拟缺失 | 1) 刷新状态 2) 检查 Node 状态与建议 | 正确区分未安装 / 版本过低 / 可用 |  |  | P1 | 否 | 影响配置链 |
| RUN-VAL-01 | 运行链 | runtime validation | Windows/macOS | 已执行 install 或 validate | 1) 执行 validateRuntime 2) 检查日志与状态 | validate 失败不会继续下一阶段 |  |  | P0 | 是 | 防止假成功 |
| RUN-RST-01 | 运行链 | reset | Windows/macOS | 已有 runtime / 配置 / 缓存 | 1) 执行 reset/uninstall 2) 查看结果详情 | 仅清理受控路径；removed/skipped/warnings 清晰 |  |  | P0 | 是 | 涉及误删风险 |
| UPG-NO-01 | 升级链 | no-update | 任一平台 | manifest 可解析；版本一致 | 1) 执行 checkUpgrade / runUpgrade 2) 观察 execution | 生成 skipped 状态，不进入伪升级 |  |  | P1 | 否 | 真实性检查 |
| UPG-OPT-01 | 升级链 | optional update | 任一平台 | manifest 中存在 optional 目标 | 1) 执行 runUpgrade 2) 查看 executed/skipped/finalize | 生成 prepare/verify/stage/validate 及 finalize plan |  |  | P1 | 否 | Beta 可接受半执行 |
| UPG-REQ-01 | 升级链 | required update | 任一平台 | manifest 中存在 required 目标 | 1) 执行 runUpgrade 2) 观察结果 | 进入升级骨架；不满足 finalize 时明确 blocked/validated-not-finalized |  |  | P0 | 是 | 不可假成功 |
| UPG-BLK-01 | 升级链 | blocked 升级 | 任一平台 | 缺失远端 manifest 或资源 | 1) 执行 runUpgrade 2) 查看 blocker | blocker 准确进入 execution 与 failure 摘要 |  |  | P0 | 是 | 阻断必须清晰 |
| UPG-STG-01 | 升级链 | staging validation | 任一平台 | staged 文件可生成 | 1) 执行 runUpgrade 2) 篡改或保留 staged 文件 3) 检查 hash 校验 | staged hash 通过后才出 finalize plan；失败会 rollback staging |  |  | P0 | 是 | 真实性关键 |
| UPG-RBK-01 | 升级链 | rollback path | 任一平台 | 已生成 staged artifacts 或 rollback plan | 1) 执行 runUpgrade 2) 触发 staged validation failure | staging rollback 可执行；live rollback 明确为 future integration point |  |  | P1 | 否 | Beta 可接受 live rollback stub |
| FAIL-MAN-01 | 失败场景 | manifest 不可达 | 任一平台 | 配置错误 URL 或断网 | 1) 执行安装/升级 2) 查看摘要 | 显示 manifest 不可达、给出建议动作与 retryable |  |  | P1 | 是 | 远端链关键 |
| FAIL-RES-01 | 失败场景 | 资源缺失 | 任一平台 | 删除部分资源/缓存 | 1) 执行安装/升级 2) 查看失败摘要 | 明确缺失资源、建议切换模式或补资源 |  |  | P1 | 是 | 常见失败场景 |
| FAIL-HASH-01 | 失败场景 | hash 校验失败 | 任一平台 | 构造错误 hash 或损坏资源 | 1) 执行下载/升级 2) 检查日志与摘要 | 失败被阻断；提示重下/切换本地导入 |  |  | P0 | 是 | 防伪成功 |
| FAIL-WSL-01 | 失败场景 | WSL 导入失败 | Windows | WSL 环境异常或 rootfs 无效 | 1) 执行 install-runtime 2) 查看摘要 | 能映射到 WSL/rootfs/distro 失败语义 |  |  | P1 | 是 | Windows Beta 高风险 |
| FAIL-GW-01 | 失败场景 | Gateway 启动失败 | 任一平台 | 占用端口或破坏入口文件 | 1) 执行 startGateway 2) 查看日志/摘要 | 不误报运行成功；给出端口/入口排查建议 |  |  | P0 | 是 | 直接影响可用性 |
| FAIL-RMT-01 | 失败场景 | 远端 manifest 未配置 | 任一平台 | 不设置 `OPENCLAW_REMOTE_MANIFEST_URL` | 1) 执行 runUpgrade 2) 查看 execution/failure | 明确 blocked；不进入伪 finalize |  |  | P1 | 是 | 当前实现强依赖此项 |

---

## 4. 静态发布评审

> 以下内容分为两类：  
> - **代码/文档证据支持**：可以直接从当前仓库实现与文档得出。  
> - **高风险推断**：尚未完成全量实机验证，但从实现方式可合理推断为高风险。

### 4.1 当前最可能的发布阻断项

1. **升级链仍未真正执行 live finalize / live rollback。**  
   - 类型与 execution 已区分 `validated`、`finalizePlan`、`rollbackPlan`，但 live finalize 仍是 stub。  
   - 如果 Beta 对外承诺“可正式升级 / 自动回滚”，这是阻断项。  
   - 结论：**代码/文档证据支持**。

2. **远端 manifest 未配置会直接阻断升级链。**  
   - 这是当前实现中的显式 blocker。  
   - 若 Beta 计划包含“在线升级验证”，这是阻断项。  
   - 结论：**代码/文档证据支持**。

3. **Windows WSL import / runtime install 仍需人工重点验证。**  
   - Windows 是主链，但平台 adapter 下仍有 stub / future integration point。  
   - 若导入流程在真机上不稳定，会直接阻断 Beta 安装闭环。  
   - 结论：**高风险推断**。

4. **reset / uninstall 必须人工验证路径边界。**  
   - 文档已将误删列为高风险；若边界控制失误将属于 P0。  
   - 结论：**高风险推断**。

### 4.2 当前最可能的 Beta 可接受缺陷

1. **macOS 路径以 plan/stub 为主，只要状态真实、不伪装成功，可作为 Beta 可接受缺陷。**
2. **升级链可做到 prepare/verify/stage/validate/failure summary，但不真正 finalize，可作为 Beta 限定能力。**
3. **部分提示文案、建议模式、日志友好度不足，可作为 P2/P3。**

这些判断主要基于当前仓库对“真实性优先、保守返回”的实现方式。  
结论：**代码/文档证据支持 + 少量高风险推断**。

### 4.3 当前明确仍是 stub / integration point 的地方

1. live finalize replacement。  
2. live rollback（依赖 backup snapshot integration）。  
3. launcher self-update / self-replacement。  
4. 部分平台 adapter 的 install/start/validate 仍可能是 stub。  

结论：**代码/文档证据支持**。

### 4.4 Beta 前建议必须人工重点验证

1. Windows full-offline 安装闭环。  
2. Windows hybrid 安装与资源补齐。  
3. Gateway start/stop + 端口占用冲突。  
4. WSL import 失败摘要是否真的可读、可定位。  
5. online upgrade 在“远端 manifest 正常 / 不可达 / 未配置”三种状态下的行为。  
6. staged validation failure 时 rollback path 是否真实写日志并正确清理 staged artifact。  
7. reset 是否严格限制在受控目录。  

---

## 5. 发布阻断项 / 可接受缺陷 / 后续增强项判定表

### 5.1 发布阻断项（Beta 前必须关闭）

- 安装链主流程在目标平台上无法完成。
- runtime / Gateway 出现假成功。
- 升级链把未 finalize 的结果误报为成功。
- reset 存在越界删除风险。
- blocker / failure summary / logs 无法支持人工定位。

### 5.2 Beta 可接受缺陷

- 某些非主推平台仍以 stub 为主，但状态真实。
- 升级链只做到 staged validation + finalize/rollback 计划，未真正 live replacement。
- 文案、建议项、日志可读性仍需打磨，但不影响真假判断。

### 5.3 后续增强项

- 真正执行 live finalize replacement。
- 真正执行 live rollback 与 backup snapshot 恢复。
- 更完整的跨平台自动化验收与 CI。
- 更细粒度的升级/安装可视化与操作引导。

