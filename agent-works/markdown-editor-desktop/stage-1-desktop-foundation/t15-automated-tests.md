# T15 第一阶段自动化测试与故障注入留痕

## 1. 详细需求

- 沿用 R1、R2、R5、R8、R11、R14、R30、R31，不新增或改变需求编号含义。
- 建立不触碰用户文档、无本机固定路径的临时工作区工厂，复用到 Rust 文件系统测试和 Node/E2E fixture。
- 把路径/授权、扫描、文件 CRUD、删除、监听、安全写、状态仓储、窗口协调及 P1/P2 状态纳入可重复回归；关键失败必须断言磁盘与内容安全结果。
- 建立真实 Tauri 桌面 E2E，覆盖 P2 启动、IPC、关键宽度、主任务顺序和焦点基础；测试权限不得进入正式应用。
- macOS 必须从正式 P2 入口真实触发文件夹和 Markdown 文件选择器，验证过滤、取消零副作用、父目录范围确认、授权与 P1 初始文件读取，不能用路径注入单测代替。
- Windows 编译、WebView2 E2E 与系统交互归 T16；T15 不外推为双平台通过，也不提前开发 T16。

## 2. 实际结果

- 新增统一 `pnpm test`、`pnpm test:fixtures`、`pnpm test:e2e:build` 和 `pnpm test:e2e`；冻结安装、前端构建、Rust 门禁、许可证和生产构建均已实跑。
- 建立 Rust `TestDirectory` 与 Node `createWorkspaceFixture`。前者替换路径、工作区、窗口测试中的三份重复临时目录实现；后者从仓库 fixture 创建隔离副本并提供幂等清理。
- 修复 T10 遗留风险：清理日志中已不属于当前授权根的记录从活动预算剔除，但不删除磁盘候选；32 条失效记录不会再全局禁用后续安全写。
- 建立 macOS embedded WebKit 桌面 E2E，3 个用例真实通过：Tauri IPC 启动进入 P2、1100/740 逻辑像素无横向溢出且主任务顺序正确、两个打开入口具备稳定可聚焦顺序。
- 从正式 P2 实机验证文件夹/Markdown 文件原生面板。两类取消均不产生最近记录；文件面板对 `.txt` 禁用打开、对 `.md` 允许打开；单文件授权对话框展示 canonical 父目录，确认后 P1 选中并读取初始 Markdown。测试最近记录、临时目录与应用进程均已清理。
- 最终基线：112/112 Rust、3/3 许可证策略、18/18 树 reducer、4/4 删除反馈、32/32 React、1/1 fixture、3/3 桌面 E2E；许可证扫描 531 个 Node、487 个 Rust、0 个阻断。

## 3. 实现说明

### 3.1 测试隔离与复用判断

- 开工前检索了 Rust 测试目录、前端 gateway/fixture 和既有 P1/P2 组件测试。
- 三处同职责 Rust 临时目录实现已形成重复，抽取到 `src-tauri/src/test_support.rs`，以进程号、时间戳和原子序列保证并行唯一，Drop 时递归清理。
- Node 侧新增 `tests/support/workspace-fixture.mjs`，从 `tests/fixtures/workspaces/basic/` 复制脱敏 Markdown、子目录和非 Markdown 文件，用于隔离副本、过滤和清理验证。
- launcher 与 workbench gateway 没有合并：两者分别承载启动/恢复协调与已授权工作区文件生命周期，输入、错误恢复和提交边界不同，强行抽取会制造参数化变体。

### 3.2 安全写故障回归

- 启动清理仍只处理重新通过授权根与临时文件名校验的候选。
- 对不再授权的历史根，清理日志条目被丢弃以释放 32 条预算，磁盘文件保持不动，避免扩大删除权限。
- 新测试构造满额失效日志，再对有效工作区执行安全写，断言保存成功、日志清空且所有失效根文件仍存在。

### 3.3 桌面 E2E 隔离

- `src-tauri/tauri.e2e.conf.json` 使用独立 product/identifier，只为 `plainroot-window-*` 增加 `wdio:default` 与测试调宽权限。
- Cargo `e2e` feature 才注册 `tauri-plugin-wdio` 和 `tauri-plugin-wdio-webdriver`，且保持 single-instance 仍为首个插件；前端也只在 Vite `e2e` mode 动态导入 WDIO bridge。
- 正式 `tauri.conf.json` 显式只加载 `default` capability。E2E 结束后重新执行默认生产构建，并从正常 Cargo 依赖图、`dist` 和 release 二进制三个层次确认无 WDIO/WebDriver。
- Retina 窗口测试使用 Tauri `LogicalSize`，避免把物理像素误当 CSS/逻辑像素。嵌入式 WebKit 接收 WebDriver Tab action 但不执行 macOS 系统默认焦点遍历，因此自动化只断言真实 DOM 顺序与逐控件聚焦能力；真实 Tab 遍历留 T17 实机验收。

### 3.4 依赖与许可证

- WDIO 锁定 9.29.1，Tauri service/plugin 锁定 1.2.0；`@wdio/tauri-service@1.2.0` 依赖的 `@wdio/native-utils@2.4.0` 缺少其实际导入，`pnpm-workspace.yaml` 固定到兼容的 2.5.0。
- 安装脚本只允许 `esbuild`，未使用的 `edgedriver`/`geckodriver` 明确禁止执行。
- 许可证脚本按 `OR` 许可选择判断，不再把可选 MIT 的 `jszip` 误判为强制 GPL；`css-value@0.0.1` 仅在包内 `Readme.md` 的 MIT 原文标记存在时采用人工复核结果。GPL-only、缺失许可和仅 license_file 仍为阻断项，并有策略测试。

## 4. 部署、配置与回滚

- 本任务不涉及数据库、SQL、seed、业务账号、服务端权限或环境变量。
- `pnpm-workspace.yaml` 在冻结安装时生效，影响开发/E2E 依赖；回滚时须连同 WDIO 依赖和锁文件一起回退并重新安装。
- E2E identifier、capability 和 Cargo feature 只在 `pnpm test:e2e` 构建时生效；默认生产构建 feature 关闭。回滚 E2E 配置不会修改 Markdown、最近记录或正式状态 schema。
- `tests/fixtures/` 只作为源模板，运行时复制到系统临时目录。测试失败时 Node fixture cleanup 与 Rust Drop 负责清理；本次实机额外记录已人工核对并清除。
- `@wdio/tauri-service@1.2.0` 在 embedded provider 成功运行时仍会误报缺少未使用的独立 `tauri-driver`，并在 afterSession 输出 mock store 清理告警。当前不静默过滤，升级依赖时必须重跑 E2E 与生产隔离检查。

## 5. 验证证据与未验证项

已执行并通过：

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm test:licenses
pnpm licenses:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml --features e2e
pnpm test:e2e
pnpm tauri build --no-bundle
```

- `pnpm test:e2e` 完整执行 E2E 构建和 3 个真实桌面用例，退出码为 0；上游 service 的两条非致命日志仍可见。
- 默认生产构建后，正常 Cargo 依赖图、前端 `dist` 和 release 二进制均未发现 WDIO/WebDriver 标记。
- macOS 实机选择器证据来自正式 P2 页面和生产 `.app`，不是浏览器 mock；临时 fixture、最近记录和运行进程已清理。
- 未验证：Windows Rust/Tauri 编译、WebView2 E2E、Windows 原生选择器/回收站/Explorer/菜单，归 T16；macOS 系统废纸篓/Finder、双进程 single-instance、长时 watch/safe-write 与系统级 Tab 遍历归 T17。
- 未执行远端 CI：T16 尚未开始，当前分支未推送，不得把本机结果表述为 CI 或双平台通过。
