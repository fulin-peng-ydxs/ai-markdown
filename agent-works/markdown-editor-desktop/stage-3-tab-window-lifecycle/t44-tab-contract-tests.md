# T44 契约 parity、单元与服务集成门禁留痕

## 1. 任务边界

- 对应任务：第三阶段 `T44`。
- 对应需求：R2、R3、R5、R6、R10、R11、R13、R14、R30、R31 的非桌面契约与状态机回归子集。
- 本次只收紧 Rust/TypeScript 契约守卫、整合阶段专项与一键非桌面门禁，不进入 T45 真实桌面 E2E、远端双平台 CI 或 T46 阶段验收。
- 未修改生产页面、IPC、磁盘格式、数据库、SQL、seed、capability、菜单、产品配置、环境变量、依赖或初始化数据。

## 2. 实际实现

### 2.1 Tagged union 按变体精确校验

`src-tauri/src/contract_test.rs` 的 tagged-union parity 从“所有变体字段并集相等”收紧为“按 `kind` 标签逐变体字段集合相等”：

- 从 TypeScript `kind: (typeof CONSTANT)[index]` 解析真实标签值；
- 从 Rust 序列化样本提取同名 `kind`；
- 每个标签分别比较字段集合，因而能识别字段被放错变体，而不仅是字段增删；
- 重复标签、缺失 `kind`、越界标签索引、未闭合变体均会失败。

新增反向测试故意把 `WindowTabSelection` 的 visual/source 字段互换；旧守卫会误放行，新守卫按预期 panic。现有正确 Rust/TypeScript 契约继续通过。

### 2.2 可重复验证入口

`package.json` 新增：

- `pnpm test:stage-3:contracts`：一次执行页签/工作台阶段专项和无桌面 feature 的完整 Rust 服务测试；
- `pnpm verify:non-desktop`：依次执行 Node、Vitest、无桌面 Rust、all-features Rust、fmt、全 target Clippy、TypeScript、生产前端构建和许可证门禁。

统一入口只编排现有测试与工具，不建立第二套测试框架。Rust 仓储、窗口和文件系统故障测试继续使用各自唯一临时 app-data/workspace；前端继续使用隔离 mock gateway/fixture，不读取用户文档或本机应用数据。

## 3. 验证证据

### 3.1 阶段专项

- `pnpm test:stage-3:contracts`：
  - 9 个 Vitest 文件、110/110；
  - Rust 204 项通过，另 1 项手动性能探针忽略。
- `cargo test ... contract_test::`：2/2，包含“字段位于错误变体时必须失败”的反向守卫。

### 3.2 一键非桌面总门禁

`pnpm verify:non-desktop` 从头完整执行通过：

- Node 独立回归 30/30；
- Vitest 32 个文件、267/267；
- Rust no-default-features：204 项通过，另 1 项忽略；
- Rust all-features：204 项通过，另 1 项忽略；
- Rust fmt：通过；
- Rust all-targets/all-features Clippy `-D warnings`：通过；
- TypeScript：通过；
- Vite 生产构建：通过；
- 许可证：727 个 Node 包、511 个 Rust 包、0 个阻断项。

首次完整运行在 `cargo fmt --check` 处真实失败并停止，格式化后从头重跑才取得上述绿灯，证明该入口会拦截失败而不是只输出报告。构建仍有既有的两个编辑器懒加载 chunk 超过 500 kB 警告；本任务未改变生产依赖或包体，不把警告伪装成已解决。

## 4. 已确认产品行为与未验证项

- `Cmd/Ctrl+W` 关闭最后一个页签后保留已绑定工作区的空窗口；用户可继续从文件树打开文档。关闭原生窗口继续使用 `Cmd/Ctrl+Shift+W`。这是“一目录一窗口”下的明确产品行为，不是遗漏。
- `Ctrl+Tab` / `Ctrl+Shift+Tab` 在真实 macOS/Windows 系统菜单中的绑定、真实重启/多窗口恢复、窗口 intent、跨平台页面和远端 CI 仍由 T45 承接。
- T44 没有页面或交互变化，因此没有新的截图或浏览器验证；T43 的 11/11 macOS 桌面证据不外推为 T44 的双平台证据。

## 5. 文档同步

- `plan.md`：T44 标记完成，任务映射和后续依赖改为 T45～T46。
- `../requirement.md`：第三阶段状态回写为 T35～T44，明确仍未完成桌面/双平台验收。
- `README.md`：登记两个统一命令与 T44 留痕入口。
- `../architecture/desktop-foundation.md`：契约门禁职责更新为逐变体 parity 与一键非桌面验证。
- `AGENTS.md`：只沉淀新的稳定门禁与当前真实计数；未新增临时业务规则。
- `DESIGN.md`、`CLAUDE.md`、页面流程、SQL/seed/权限/capability/config/env 文档无需更新：本任务没有改变视觉、协作入口、数据结构、授权面或产品配置。
