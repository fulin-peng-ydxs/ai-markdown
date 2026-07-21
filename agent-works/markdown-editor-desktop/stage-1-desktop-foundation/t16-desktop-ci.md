# T16 双平台 CI 与构建产物留痕

## 1. 范围与状态

- 沿用 R1、R2、R5、R8、R11、R14、R30、R31，不新增或改变需求编号。
- 本任务建立 macOS/Windows CI 门禁、平台文件替换回归、P1 真 IPC 桌面 E2E、失败诊断和未签名测试产物。
- 当前状态为“macOS 远端通过，Windows 编译问题整改后待复跑”。第二轮 GitHub Actions 的 macOS 作业完整成功，Windows 作业在 Rust lint 暴露稳定 API 兼容问题后停止；修复尚需远端复验，因此 T16 不标记完成。
- Windows 原生选择器、回收站、Explorer、菜单和辅助技术的视觉/键鼠可用性不能由 WebView 自动化替代，继续登记为人工未验证。

## 2. 实际实现

### 2.1 CI 门禁与产物

- 新增 `.github/workflows/ci.yml`，对 `macos-latest`、`windows-latest` 运行同一矩阵。
- 固定 Node 24.11.1、pnpm 11.5.1、Rust 1.97.1；缓存运行时解析出的 pnpm store、Cargo registry/git/target。
- 首轮远端运行暴露 `rustup --component rustfmt clippy` 会把 `clippy` 解析为第二个工具链；现改为逗号分隔的 `rustfmt,clippy`。同时在工具链安装前初始化最小诊断文件，确保早期失败也有可上传证据。
- GitHub 提示旧版 JavaScript action 运行时已弃用；`setup-node`、`cache`、`upload-artifact` 已分别更新到当前主版本 v7、v6、v7，`checkout` 保持 v6。
- 硬门禁依次覆盖许可证、TypeScript 类型、前端测试/构建、Rust fmt、clippy all-features、Rust all-features 测试、桌面 E2E 和默认生产构建。
- E2E 失败最多重试一次；日志始终写入 artifact，失败时额外截图。成功后收集当前平台未签名二进制与 SHA-256，保留 14 天，不发布、不签名。
- 生产构建在 E2E 构建之后重新执行，避免把带 WebDriver feature 的测试二进制误当产品产物。

### 2.2 Windows 文件语义

- macOS 上的 Windows 目标交叉检查先发现 Tauri 资源编译缺少 `src-tauri/icons/icon.ico`；已从仓库既有、明确标为占位的 `icon.png` 同源生成 `.ico`，不引入新品牌设计，正式发布前仍需替换占位图标。
- 共享原子适配新增替换已有目标与禁止覆盖已有目标测试，两类测试在目标平台真实调用各自平台实现。
- Windows 条件测试通过 `OpenOptionsExt::share_mode(0)` 独占打开目标，要求 `MoveFileExW` 替换失败，并断言临时源与旧目标内容均保留。
- 补齐 `.ico` 后，交叉检查继续到 Windows 资源编译并因本机缺少 `llvm-rc` 停止；因此 Windows 条件代码和测试仍未完成编译或运行，必须以远端 `windows-latest` 日志为准。
- 第二轮远端编译确认稳定 Rust 1.97.1 仍不开放 `MetadataExt::volume_serial_number/file_index`。现以 `GetFileInformationByHandle` 读取卷序列号与 64 位文件索引，复用到永久删除目标防替换和大小写重命名的同文件判断；句柄只请求属性、允许读写删除共享，并用 `FILE_FLAG_BACKUP_SEMANTICS` 支持目录。
- 同轮还发现 `menu` 与 `atomic` 的平台条件会在 Windows 产生 `unused_mut`/`unused_imports`；现改为条件遮蔽构建器和条件导入，不用 `allow` 掩盖警告。

### 2.3 P1 真 IPC E2E 与隔离

- 新增第 4 个桌面 E2E：从仓库脱敏 fixture 准备工作区，依次调用真实 Rust 授权与窗口协调命令，刷新后由正式启动快照进入 P1，再通过真实渐进扫描与读取命令打开 `note.md`。
- 路径准备命令只在 Cargo `e2e` feature 下编译和注册；授权、canonical root、窗口绑定、持久化、扫描和读取仍走生产服务。
- `scripts/run-desktop-e2e.mjs` 每轮创建独立临时状态目录，退出后递归清理。状态仓储和安全写清理日志仅在 `e2e` feature 下消费该目录；生产构建始终使用系统应用数据目录。
- 失败截图进入 `artifacts/e2e/`；测试成功不制造截图。当前上游 embedded provider 的非致命 driver/mock-store 日志仍保留可见。

### 2.4 许可证闭环

- 许可证脚本扫描默认 Cargo 图与 `e2e` feature 图的并集并按 package id 去重。
- 新增策略测试锁定 `e2e` feature 必须进入 metadata 参数，修复“产品无风险但开发工具依赖不可见”的缺口。
- 当前结果为 531 个 Node 包、508 个 Rust 包、0 个阻断项。

## 3. 配置、权限与回滚

- 本任务不涉及数据库、SQL、seed、账号、服务端权限或用户内容迁移。
- GitHub workflow 只授予 `contents: read`；未签名产物仅供测试，保留 14 天。
- E2E-only 命令、状态目录覆盖和 WDIO capability 只存在于 `e2e` feature/config。回滚时需一起回退 workflow、E2E runner/命令、测试和许可证 feature 集，再执行默认生产构建确认无测试入口。
- 回滚 CI 或测试设施不修改用户 Markdown、正式应用状态或最近记录。

## 4. 本地验证证据

已在 macOS arm64 执行并通过：

```text
pnpm typecheck
pnpm test
pnpm build
pnpm test:licenses
pnpm licenses:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
pnpm test:e2e
node scripts/run-desktop-e2e.mjs
pnpm tauri build --no-bundle
node scripts/collect-ci-artifact.mjs macos
```

- Rust：114/114。
- 前端：4/4 许可证策略、4/4 删除反馈、18/18 树 reducer、1/1 fixture、32/32 React。
- 桌面 E2E：隔离完整构建 4/4；随后不重建直接复跑仍为 4/4，证明跨运行状态不污染。
- 许可证：531 Node、508 Rust、0 阻断。
- 本机未签名二进制 SHA-256：`cac39dcbb2182d8efe68c04d7c1e68a55ba23ed5cc04ea1273ad5ef5a84e4d32`。该本地产物已在核对后清理，不进入版本库。
- 默认 release 二进制未发现 `prepare_e2e_workspace` 或 `PLAINROOT_E2E_DATA_DIR` 标记。

## 5. 远端结果、未验证与下一步

- 首轮 GitHub Actions：[Desktop CI #1](https://github.com/fulin-peng-ydxs/ai-markdown/actions/runs/29841645380) 已真实触发，但 macOS 与 Windows 均在 Rust 工具链安装步骤失败；失败原因是 workflow 的组件参数格式，不是产品代码或平台分支结论。其后编译、测试、E2E 与生产构建全部跳过，不得据此声称任何平台通过或失败。
- 首轮还因工具链失败发生在 `artifacts/` 创建前，导致诊断上传报告无文件；现已在早期步骤建立最小诊断文件，整改提交推送后须重新观察上传行为。
- 第二轮 GitHub Actions：[Desktop CI #2](https://github.com/fulin-peng-ydxs/ai-markdown/actions/runs/29842058884) 中 macOS 完整成功，包含许可证、类型、前端/Rust 测试、4 个桌面 E2E、生产构建与 artifact；Windows 已通过工具链、依赖、许可证、类型和前端门禁，在 Rust lint 因 8 处不稳定文件标识 API 与 1 处 `unused_mut` 失败。两个平台均成功上传 artifact，证明早期诊断初始化整改有效。
- Windows 文件标识已改用稳定 Win32 API；本机用临时资源编译占位器仅绕过 Tauri `.res` 生成后，`x86_64-pc-windows-msvc` 的 `cargo check --all-features` 与 `cargo clippy --all-targets --all-features -- -D warnings` 通过。该证据验证 Rust 条件代码，但不替代真实 Windows 资源、链接、测试或运行结果。
- 本机执行 `cargo check --target x86_64-pc-windows-msvc --tests --all-features`：首次发现并修复缺少 `.ico`；复跑停在 macOS 缺少 `llvm-rc`。该失败不计为 Windows 编译证据，也不等同远端 runner 失败。
- 未编译/执行 Windows `MoveFileExW`、目标独占失败、Dialog/WebView2、watch、回收站或 Explorer 分支；macOS 结果不得外推。
- 自动化验证了选择/授权服务的取消和过滤规则单测、Dialog 插件/命令编译边界及 P1/P2 IPC；Windows 原生面板的真实过滤展示、取消键鼠行为仍需人工设备。
- 下一步推送 Windows 稳定 API 整改并复跑矩阵；两个平台全部通过并记录运行链接、artifact 哈希后，才能把 T16 改为完成并进入 T17。
