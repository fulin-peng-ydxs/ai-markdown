# T30 契约 parity、单元测试与服务集成门禁

## 功能的详细需求

T30 对应 R1、R2、R3、R5、R6、R10、R11、R14、R30、R31 的第二阶段非桌面验证子集。目标是在 T18～T29 已完成的统一 `DocumentSession`、两种生产编辑 adapter、保存/恢复/冲突/另存、图片资源和原生菜单链路之上，建立可独立执行的契约防漂移、Markdown 往返、纯状态和 Rust 服务门禁。

本任务必须沿用正式 R 编号，不扩大到 T31 的桌面 E2E、跨模块桌面回归或远端 macOS/Windows CI。测试只能使用仓库脱敏语料和隔离临时目录，不能访问用户真实文档。新增 TypeScript DTO、tagged union、字符串枚举与 Rust 序列化必须有自动 parity 证据；保存追赶、恢复容量和安全写失败路径不能只靠快照或最终定时器结果“补绿”。

## 功能开发的实际结果

- 新增 `test:editor`、`test:roundtrip`、`test:rust` 三个稳定脚本。`pnpm test` 现统一运行 Node 独立回归、全部 Vitest 和无桌面 feature 的 Rust 服务测试；现有 CI 已执行 `pnpm test`，T30 无需修改 workflow。
- 新增生产 Markdown 往返测试：使用 `MilkdownVisualAdapter` 验证 CommonMark/GFM、链接、列表、任务列表、表格、代码围栏和图片稳定语义；验证受支持 raw HTML 保留且不执行脚本；使用 `CodeMirrorSourceAdapter` 验证 frontmatter、wiki link、directive 和 MDX 语法在 source-only 路径字节不变。
- `contract_test.rs` 新增全局登记守卫。它扫描 `contracts.ts` 的所有导出 interface 和字符串常量，并要求 Rust 测试源码存在对应字段或枚举/tag parity 断言；新契约若只改一端，门禁会失败。图片导入选择结果又补充 `cancelled` 精确形状和 `ready.proposal` 字段断言。
- 修复安全写测试夹具的并行目录碰撞。旧夹具仅使用当前时间纳秒命名，并行线程可能共享工作区和 cleanup journal；修复前默认全量 `cargo test` 在第 3 次真实复现两个 `SafeWriteUnavailable`。现统一使用带进程 ID、时间和原子序号的 `TestDirectory`，并增加 16 路并发唯一性回归。修复后默认全量命令连续 10/10 通过，没有通过单线程或缩小范围规避。
- 收紧保存中继续编辑的测试：首个写入完成后必须立即开始追赶写入，不能等待 fake timer 推进后由普通自动保存补偿。该改动使追赶状态被故意关闭时测试稳定失败。

当前未完成且不得外推：

- 未执行或扩展 Tauri 桌面 E2E、系统输入法候选窗、原生选择器/剪贴板/拖放、系统关闭/退出和双进程流程；这些属于 T31。
- 未取得本分支最新 macOS/Windows 远端 CI 证据；Windows 原生系统 UI 仍是长期人工项。
- 未进行页面视觉、响应式或辅助技术新验收，因为 T30 没有修改生产页面、样式、组件交互或设计 token。
- 未重新校准 release/WebView 大文档输入、首次进入源码模式和峰值内存；现有性能门槛与保存防抖保持不变。

## 功能开发的具体实施方案

1. 保留已有逐 DTO 的 `assert_interface_matches` 和逐枚举的 `typescript_string_constant_values`，再从 Rust 测试源码汇总实际 assertion 名称，与 `contracts.ts` 导出集合做双向相等比较。这样新增 interface、枚举或 tagged union 状态时，遗漏 parity 登记会在总守卫处失败。
2. 复用 `tests/fixtures/markdown/` 的脱敏语料，但改由生产 Milkdown/CodeMirror adapter 读取、序列化和再次载入，避免把 T18 PoC 结果当成生产实现证据。测试检查结构性 Markdown 标记，不以全文字节相等错误限制允许的语义规范化；source-only 语料则要求字节不变。
3. 将 `safe_write` 测试夹具接入既有 `TestDirectory`。夹具对象持有目录生命周期，测试退出后递归清理；16 路并发测试同时检查根目录和 cleanup journal 路径没有重复。
4. 保留保存控制器生产逻辑不变，只收紧既有追赶测试的观察时点。故意把 `shouldChase` 置为 `false` 后，测试会在写入次数仍为 1 时失败，证明追赶门禁不依赖后续计时器。
5. 按计划分别注入并还原四类回归：
   - TypeScript `RecoverySnapshotMetadata` 增加伪字段，Rust 字段 parity 如期失败。
   - `RECOVERY_PERSIST_STATUSES` 增加伪枚举，Rust 枚举 parity 如期失败。
   - 禁用保存追赶，保存控制器测试如期失败。
   - 把恢复容量常量增加 1 字节，128 MiB 容量测试如期失败。
6. 运行统一脚本、专项脚本、类型/构建、Rust fmt/Clippy/default 全量测试与许可证扫描；所有临时注入均在最终验证前还原。

## 上线部署操作

本次无额外上线部署操作：

- 无数据库、SQL、seed、数据迁移、初始化数据、账号、密钥、远端服务或业务环境变量。
- 无依赖版本和 lockfile 变化；许可证仍为 727 个 Node 包、508 个 Rust 包、0 个阻断项。
- 无新增 Tauri capability、插件、菜单、原生权限、持久配置或 schema。
- `package.json` 新增测试脚本并扩展 `pnpm test`。现有 `.github/workflows/ci.yml` 已调用该脚本，因此会自动消费 T30 非桌面门禁；T31 再负责完整桌面矩阵和远端证据。
- 回滚 T30 时可回退测试脚本、往返测试、契约总守卫和夹具改造，不会修改用户 Markdown、恢复快照或资源文件。

## 验证情况

已执行并通过：

- `pnpm install --offline --frozen-lockfile --trust-lockfile`：锁文件不变、依赖已是最新。
- `pnpm test`：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、树状态 18/18、fixture 1/1、Vitest 171/171、Rust 176/176；另 1 项手动性能探针按设计忽略。
- `pnpm test:editor`：17 个测试文件、125/125。
- `pnpm test:roundtrip`：1 个测试文件、3/3。
- `pnpm typecheck`、`pnpm build`：通过。生产构建为入口 442.85 kB、排版 chunk 336.88 kB、源码 chunk 544.22 kB；源码 chunk 仍有既有 500 kB 告警。
- `cargo fmt --check`、all-targets/all-features Clippy `-D warnings`：通过。
- 默认 `cargo test --locked --manifest-path src-tauri/Cargo.toml`：176/176，通过；修复并行夹具后同一默认全量命令连续 10/10 通过。
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- DTO 字段、枚举、保存追赶和恢复容量四类故障注入均取得预期非零退出并已还原。

验证环境说明：

- 本机内部 npm registry 在本任务期间不可达。依赖没有变化；为避免 pnpm 11 的依赖状态预检把网络重试混入测试，先使用本地 store 执行 `--offline --frozen-lockfile --trust-lockfile` 同步状态，再运行实际脚本。该处理没有跳过任何测试或许可证扫描。
- 未执行 `pnpm test:e2e`、Tauri 打包、GitHub Actions 或 Windows 构建/运行，因为它们属于 T31；不得把 T30 的本机非桌面证据写成桌面或双平台通过。

## 关联文档同步

- 已更新第二阶段 `plan.md` 的 T30 状态、需求映射、实际落地、回归/接口测试、验证命令、性能风险和 T31 边界。
- 已更新 `requirement.md` 的当前阶段状态、第 12 章开发阶段和第 13 章验证边界。需求范围、R 编号、建议实现处理状态、产品验收标准和遗留确认项没有变化。
- 已更新 `architecture/desktop-foundation.md` 的契约/非桌面门禁模块、生产往返证据、临时目录不变量和桌面验证边界；现有架构文档足以承接本次稳定事实，不需要新建第二份架构文档。
- 已更新 `README.md`、`AGENTS.md` 的阶段状态、稳定脚本、测试数量和未验证边界。
- `DESIGN.md`、页面原型和页面开发流程无需更新：本任务没有页面、交互、布局、token 或组件登记变化。
- `CLAUDE.md` 无需更新：其薄入口职责和长期规则没有变化。
- SQL、seed、数据库、产品权限、菜单、配置、环境变量和初始化数据无需更新：本任务未产生对应稳定事实变化。
