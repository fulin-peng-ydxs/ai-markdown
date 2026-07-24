# T31 桌面 E2E、跨模块回归与跨平台 CI 留痕

## 1. 任务范围

- 对应任务：第二阶段计划 T31。
- 对应需求：R1、R2、R3、R5、R6、R10、R11、R14、R30、R31 的桌面回归与平台验证子集。
- 本次边界：扩展真实 Tauri IPC 桌面 E2E，运行第一阶段底座与第二阶段编辑链的完整本机回归，修复测试实际暴露的跨层问题，并确认正式构建不包含 E2E 测试缝。
- 未扩张范围：不实现页签、大纲、工作区搜索、阅读、主题或新的产品配置；不新增数据库、SQL、seed、业务环境变量、正式 capability、菜单或持久化格式。

T31 的完成标准包含“最新代码提交取得 GitHub Actions macOS/Windows 双绿”。提交 `bd583db452352c6410fbdaa8b05a68c2df122872` 对应的 run `30062045288` 已于 2026-07-24 完整通过：macOS 6 分 12 秒、Windows 18 分 38 秒，两个作业均完成许可证、类型与前端、Rust lint/测试、8/8 桌面 E2E、未签名生产构建、校验和收集和 artifact 上传。T31 据此标记完成；T32 仍未开始。

## 2. 实际改动

### 2.1 桌面 E2E 从 4 条扩展为 8 条

`tests/e2e/specs/desktop-shell.e2e.mjs` 现在覆盖：

1. 通过真实 Tauri IPC capability 进入 P2；
2. 1100/740 px 启动页布局、主操作顺序和无页面溢出；
3. 主要打开入口的稳定焦点顺序；
4. 通过真实 IPC 打开独立 fixture 工作区并读取初始 Markdown；
5. 排版与源码两种模式编辑，使用 WebView `DataTransfer/File` 输入有效 PNG，经 Rust raw upload/confirm 写入资源，保存并重新打开真实文件；
6. 对子目录文档执行真实恢复仓储 upsert/delete；
7. 外部磁盘修改后保留本地编辑内容，并由控制器持久化恢复证据；
8. 显式载入恢复快照，确认在用户保存前不会先覆盖源 `.md`。

套件不再直接使用仓库 fixture。`before` 创建独立复制工作区，`after` 回收临时目录；macOS `/var` 与 `/private/var` 通过 `realpath` 归一后再比较。源码正文从 CodeMirror `.cm-line` 按行重建，避免 DOM `textContent` 丢失换行造成伪断言。

`tests/e2e/wdio.conf.mjs` 将 Mocha 业务用例重试从 1 改为 0。打开工作区、保存、图片和外部修改都是有磁盘副作用的确定性流程，失败后重试会继承首次状态并可能产生 `already_open` 或假绿；WebDriver 启动连接仍保留单独的一次有界重试。

### 2.2 真 IPC 暴露并修复的跨层缺陷

#### 恢复 revision hash 格式不一致

真实 `FileRevision.contentHash` 是 `sha256:<64 位十六进制>`，恢复仓储原先却复用内部快照裸摘要的 64 位校验，因此真实 `upsert_recovery_snapshot` 会返回 `recovery_unavailable`，而 Rust fixture 使用裸值使单测一直通过。

`src-tauri/src/editor/recovery.rs` 现将两种契约分开：

- `valid_sha256_digest` 只校验恢复正文内部摘要；
- `valid_revision_content_hash` 校验 `sha256:` 前缀和后续摘要；
- metadata/input 与测试 fixture 统一消费真实 `FileRevision` 格式。

#### 恢复定时器重复注册活动会话

`DocumentSaveController.observe()` 已在会话进入 dirty 时完成活动快照注册，定时器触发后又调用 `ensureActive()`，会对同一身份重复 IPC。控制器现在在相同会话已注册时直接复用完成状态，并补充“注册完成后定时器不得再次注册”的单测。

#### 连续编辑事务复用旧 editVersion

在 React 把 session 投影回 adapter 前，Milkdown/CodeMirror 的连续本地事务曾复用旧 `editVersion`；后续事务会被 session 当作陈旧变更拒绝，较旧的 React 投影也可能覆盖较新的 editor 内容。

两种 adapter 现在：

- 在通知上层前先单调推进本地 `editVersion`、Markdown、选择与锚点；
- 对相同 generation 的低版本投影直接忽略；
- 以两次连续事务和陈旧投影回放测试锁定该不变量。

## 3. 数据、权限与生产隔离

- 测试文件系统只使用临时复制工作区和临时 app data，不读取或修改用户真实 Markdown。
- 图片链仍通过 Rust 授权根、签名、大小、opaque upload id 和 confirm 约束；E2E 没有给前端新增绝对路径写权限。
- `.github/workflows/ci.yml` 已运行 `pnpm test`、`pnpm test:e2e` 和生产构建，会自动消费扩展后的套件，本次无必要修改 workflow。
- 正式前端产物与 release 二进制已扫描，未发现 `PLAINROOT_E2E_DATA_DIR`、WDIO、fixture 或 E2E 命令标记；E2E capability/driver 仍由 Cargo feature 编译期隔离。
- SQL、数据库 schema、seed、产品环境变量、正式 capability、菜单和持久配置均未变化，因此这些文档/配置不需要更新。

## 4. 验证结果

本机环境：macOS arm64、Node 24.11.1、pnpm 11.5.1、Rust 1.97.1。

| 验证 | 结果 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 通过：Node 30/30、Vitest 173/173、Rust 176/176，另 1 项手动性能探针忽略 |
| `pnpm build` | 通过；源码 editor chunk 544.41 kB，仍有既有 500 kB 告警 |
| `pnpm licenses:check` | 727 Node / 508 Rust / 0 阻断 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features` | 176/176，通过；另 1 项手动性能探针忽略 |
| `pnpm test:e2e` | 重新构建 E2E 应用后真实 macOS Tauri/WebKit 8/8 通过 |
| Windows CRLF 与恢复断言收敛后再次执行 `pnpm test:e2e` | 真实 macOS Tauri/WebKit 8/8 通过；确定性业务流程仍为 0 次重试 |
| `pnpm tauri build --no-bundle` | 通过，产出正式 release 二进制 |
| 正式产物 E2E 标记扫描 | 前端与 release 二进制均未发现测试标记 |
| GitHub Actions run `30060302937` | 已执行；macOS 桌面 E2E 通过，Windows 在 Rust lint 阶段失败，不是双绿 |
| GitHub Actions run `30060937964` | 已执行；macOS 通过，Windows 已越过 Rust lint/测试，但桌面 E2E 暴露 CRLF 测试假设，不是双绿 |
| GitHub Actions run `30062045288` | 通过；提交 `bd583db452352c6410fbdaa8b05a68c2df122872` 的 macOS/Windows 两个作业均绿，总时长 18 分 48 秒 |
| 远端测试摘要 | macOS/Windows 均为 23 个 Vitest 文件、173 项 Vitest 通过；桌面 E2E 均为 8/8 |
| 远端 artifacts | `plainroot-macos-30062045288`（3.74 MB，digest `75c830745bd3343aa8b6ae5b0ec9c7a5b0a3f90cc1fb876f51ed9a7308b24657`）；`plainroot-windows-30062045288`（3.63 MB，digest `2733ae904da905b254f8c7cae09a8e8e56bbabb7ec39b23cf7c18842c8f6d9ef`） |

首次 Windows runner 暴露两处本机 macOS 不会编译出的 `-D warnings`：

- `assets.rs` 的 symlink 重定向测试只在 Unix 有业务意义，但 fixture 曾在 Windows 仍被创建，触发未使用变量；
- `recovery.rs` 的仓储根字段只服务 Unix `0700` 权限收紧，却在 Windows 结构体中保留，触发未读取字段。

修复将整个 symlink 测试和 `root` 字段按 `#[cfg(unix)]` 门控，没有添加宽泛 `allow`。修复后本机 `cargo fmt`、全目标/全 feature Clippy 和 Rust 全量测试通过（176/176，另 1 项手工性能探针忽略）。本机虽已安装 `x86_64-pc-windows-msvc` target，但 Tauri Windows 资源构建因 macOS 缺少 `llvm-rc` 在进入 crate lint 前停止；该项明确未通过本机交叉验证，必须由下一次真实 Windows runner 复验。

修复提交 `11e3857fbdd0a9cc45ba908fef3923b71322d23a` 对应 run `30060937964` 随后证明 Windows Rust lint 与 Rust tests 均已通过；Windows Desktop E2E 继续暴露第二层跨平台假设：

- GitHub Windows checkout 将未指定 `eol` 的 fixture Markdown 转为 CRLF，首条文件断言却固定要求 LF；
- CodeMirror 可见源码按 LF 投影，磁盘安全写入按需求保留原 CRLF，保存用例用前者直接对子串匹配后者，因换行不同误判为“保存不完整”；
- 外部修改测试固定追加 LF，在 Windows CRLF fixture 上还会人为制造 mixed EOL，污染原本只验证冲突保护的场景。

测试现将文档内容比较归一到 LF 语义，仍对标题、正文、两模式编辑标记和图片链接逐项断言；制造外部修改时改为沿用磁盘现有换行。该处理不改变产品保存实现，也没有添加业务用例重试。

换行修复后的本机完整 E2E 首次复跑还暴露了恢复用例的时间边界不精确：原断言在载入恢复内容、等待页面状态并切换到源码模式之后才读取磁盘，已经可能超过 800 ms 正常自动保存防抖。需求只禁止恢复动作未经确认直接覆盖原文件；用户确认载入后会形成普通 dirty session，随后进入既有自动保存链路。用例现改为在点击“恢复到编辑区”前记录磁盘字节，并在页面确认恢复内容已载入后、进入模式切换前断言磁盘仍完全一致，再继续验证恢复正文；不再把后续正常自动保存误判为恢复动作直接写盘。

WDIO 运行时仍会输出“未安装外部 `tauri-driver`”的可选诊断和 session 结束后的 mock 清理提示；当前套件使用编译期 embedded driver，8 条用例和进程退出码均为成功。run `30062045288` 已在 macOS 与 Windows runner 取得真实绿灯，说明这些提示没有被当作失败或通过判据。

## 5. 未验证与后续

- run `30060302937` 在 Windows Rust lint 失败；run `30060937964` 已越过 lint 与 Rust tests，但在 Windows E2E 的 CRLF 测试假设处失败。两次红灯均按真实日志修复且没有削弱 `-D warnings`、断言或业务重试策略；run `30062045288` 已重新运行完整矩阵并取得双绿、Windows WebView2 E2E、生产构建与 artifact 证据。
- WebView `DataTransfer/File` 验证了页面事件、raw IPC 和磁盘链路，但不等于系统剪贴板、Finder/Explorer 原生拖入或原生图片选择器人工证据。
- 系统 IME 候选窗、原生保存/另存对话框、系统关闭/应用退出、系统辅助技术、峰值内存、网络卷/休眠/卸载与超大目录长时行为未执行。
- JPEG/WebP 尾字节兼容、图片 Blob 并发总量和引用式图片移动改写仍是既有非阻塞边界，本任务没有把它们伪装为已解决。
- T31 的自动化和跨平台 CI 验收已完成。T32 仍需独立执行第二阶段整体复核、专项架构文档和阶段验收；本任务不提前认领 T32。

## 6. 关联文档同步

- `plan.md`：更新 T31 状态、实际落地、R 映射、测试与发布边界；T32 保持未开始。
- `requirement.md`：只回写阶段 2 的真实开发/验证状态，不改 R 编号、需求范围、建议项处理、验收标准或遗留确认结论。
- `architecture/desktop-foundation.md`：补充隔离桌面回归、adapter 本地版本单调、恢复 hash 格式和生产隔离不变量；阶段 2 专项架构仍按 T32 生成。
- `README.md`、`AGENTS.md`：更新稳定命令、8 条桌面基线、测试计数与远端未验证边界。
- `DESIGN.md`：无需更新；本任务没有页面布局、样式、token、组件契约或交互信息层级变化。
- `CLAUDE.md`：无需更新；它仍是指向 `AGENTS.md` 的薄入口，没有新增长期规则。
- 页面原型与页面开发流程：无需更新；本任务只扩展验证并修复内部契约，没有改变 P1/P2 产品流程。
