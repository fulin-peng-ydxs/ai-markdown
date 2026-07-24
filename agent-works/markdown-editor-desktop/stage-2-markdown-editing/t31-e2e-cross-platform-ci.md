# T31 桌面 E2E、跨模块回归与跨平台 CI 留痕

## 1. 任务范围

- 对应任务：第二阶段计划 T31。
- 对应需求：R1、R2、R3、R5、R6、R10、R11、R14、R30、R31 的桌面回归与平台验证子集。
- 本次边界：扩展真实 Tauri IPC 桌面 E2E，运行第一阶段底座与第二阶段编辑链的完整本机回归，修复测试实际暴露的跨层问题，并确认正式构建不包含 E2E 测试缝。
- 未扩张范围：不实现页签、大纲、工作区搜索、阅读、主题或新的产品配置；不新增数据库、SQL、seed、业务环境变量、正式 capability、菜单或持久化格式。

T31 的完成标准包含“最新提交取得 GitHub Actions macOS/Windows 双绿”。提交 `2084489fa078cdcd02d640d0c00dd57971a9e0a2` 已按用户授权推送；首次远端 run `30060302937` 的 Windows Rust lint 失败，因此任务仍为“进行中”，不能提前标记完成，也不进入 T32。

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
| `pnpm tauri build --no-bundle` | 通过，产出正式 release 二进制 |
| 正式产物 E2E 标记扫描 | 前端与 release 二进制均未发现测试标记 |
| GitHub Actions run `30060302937` | 已执行；macOS 桌面 E2E 通过，Windows 在 Rust lint 阶段失败，不是双绿 |

首次 Windows runner 暴露两处本机 macOS 不会编译出的 `-D warnings`：

- `assets.rs` 的 symlink 重定向测试只在 Unix 有业务意义，但 fixture 曾在 Windows 仍被创建，触发未使用变量；
- `recovery.rs` 的仓储根字段只服务 Unix `0700` 权限收紧，却在 Windows 结构体中保留，触发未读取字段。

修复将整个 symlink 测试和 `root` 字段按 `#[cfg(unix)]` 门控，没有添加宽泛 `allow`。修复后本机 `cargo fmt`、全目标/全 feature Clippy 和 Rust 全量测试通过（176/176，另 1 项手工性能探针忽略）。本机虽已安装 `x86_64-pc-windows-msvc` target，但 Tauri Windows 资源构建因 macOS 缺少 `llvm-rc` 在进入 crate lint 前停止；该项明确未通过本机交叉验证，必须由下一次真实 Windows runner 复验。

WDIO 运行时仍会输出“未安装外部 `tauri-driver`”的可选诊断和 session 结束后的 mock 清理提示；当前套件使用编译期 embedded driver，8 条用例和进程退出码均为成功。该输出不能替代远端 runner 实测，若远端首次运行失败必须按真实日志修复，不能屏蔽。

## 5. 未验证与后续

- 首次推送已触发 run `30060302937`，但 Windows Rust lint 失败；它只能证明门禁真实生效，不能作为双平台通过、artifact 或 Windows WebView2 证据。修复提交必须重新运行完整矩阵。
- WebView `DataTransfer/File` 验证了页面事件、raw IPC 和磁盘链路，但不等于系统剪贴板、Finder/Explorer 原生拖入或原生图片选择器人工证据。
- 系统 IME 候选窗、原生保存/另存对话框、系统关闭/应用退出、系统辅助技术、峰值内存、网络卷/休眠/卸载与超大目录长时行为未执行。
- JPEG/WebP 尾字节兼容、图片 Blob 并发总量和引用式图片移动改写仍是既有非阻塞边界，本任务没有把它们伪装为已解决。
- 应以修复后最新提交的 macOS/Windows 两个作业均绿为准补齐 T31；红灯修复后重跑完整矩阵。T31 真正完成前不得开始 T32 总体验收。

## 6. 关联文档同步

- `plan.md`：更新 T31 状态、实际落地、R 映射、测试与发布边界；T32 保持未开始。
- `requirement.md`：只回写阶段 2 的真实开发/验证状态，不改 R 编号、需求范围、建议项处理、验收标准或遗留确认结论。
- `architecture/desktop-foundation.md`：补充隔离桌面回归、adapter 本地版本单调、恢复 hash 格式和生产隔离不变量；阶段 2 专项架构仍按 T32 生成。
- `README.md`、`AGENTS.md`：更新稳定命令、8 条桌面基线、测试计数与远端未验证边界。
- `DESIGN.md`：无需更新；本任务没有页面布局、样式、token、组件契约或交互信息层级变化。
- `CLAUDE.md`：无需更新；它仍是指向 `AGENTS.md` 的薄入口，没有新增长期规则。
- 页面原型与页面开发流程：无需更新；本任务只扩展验证并修复内部契约，没有改变 P1/P2 产品流程。
