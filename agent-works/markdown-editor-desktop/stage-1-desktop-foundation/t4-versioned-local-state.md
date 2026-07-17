# T4 版本化本地状态开发记录

## 范围与状态

- 任务：第一阶段 T4，承接 R14 的最近工作区与根窗口会话持久化底座，以及 P2 的状态数据源。
- 状态：已完成。
- 本任务不实现系统选择器、最近列表页面、根窗口恢复协调、打开方式偏好或设置页；这些仍由 T5、T11、T12 及后续任务承接。
- 本任务不读写 Markdown，不创建数据库、SQL、seed、账号、服务端或工作区内私有文件。

## 状态契约

- 文件位置：Tauri `appDataDir()/plainroot-state-v1.json`，不进入用户授权工作区和版本库。
- schema：`schemaVersion: 1`、`recentWorkspaces: RecentWorkspace[]`、`workspaceSessions: WorkspaceSessionRoot[]`。
- 初始化：应用 setup 时读取；文件不存在则原子写入版本 1 与两个空数组。
- 明确排除：schema 不包含 `openDisposition`、`openPreference` 或其他打开方式偏好，避免在没有设置回退入口时形成不可恢复配置。
- 容量边界：状态文件最大 8 MiB；读取至上限加 1 字节即停止，超限按损坏状态备份恢复；生成内容超限在写临时文件前拒绝。
- 完整性：重复最近工作区 ID、重复会话工作区 ID 或重复窗口标签均视为非法状态。

## 读写、恢复与异常

- 正常更新先复制当前状态、应用变更并校验，再写同目录唯一临时文件、`sync_all` 并原子替换；只有磁盘成功后才提交内存状态。
- Unix 新建状态/临时文件使用 `0600`；同文件系统 `rename` 完成替换。
- Windows 适配使用 `MoveFileExW` 与 `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`；本机没有 Windows target 或实机，本次只核对了锁定 `windows-sys` 0.61.2 的函数签名，真实编译和文件系统语义由 T16 验证。
- 无效 JSON、非法结构、重复身份和超限文件先改名为 `plainroot-state-v1.json.corrupt-{timestamp}`，发生同名时追加序号，再写默认状态。
- 未知 schema 版本保持原文件字节不变，仓储进入 `UnsupportedVersion`，禁止更新，作为未来迁移入口。
- 读取失败或损坏文件无法备份时进入 `Unavailable`，不得用默认状态覆盖原文件；写入失败保留磁盘和内存旧状态并清理临时文件。
- appData 路径不可用时应用仍可启动并取得空内存快照，但状态明确为不可用；后续 P2 必须把稳定错误承接为可见、可恢复状态。

## 为什么没有接入 Tauri Store 插件

T4 的完成标准要求原子更新。复核 Tauri Store v2 当前文档与 2.4.3 源码后，确认其保存实现使用直接文件写入，不能证明替换中断时保留旧文件。因此本任务采用 Rust 私有 JSON 仓储，没有注册 Store 插件、前端 command 或 capability；这缩小了权限面，也避免前端绕过领域校验直接修改状态。

- 官方文档：<https://v2.tauri.app/plugin/store/>
- 核对源码：<https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/store/src/store.rs>

这只是 T4 对原子状态文件的实现选择，不禁止后续任务在有独立需求和回滚闭环时重新评估插件。

## 配置、影响与回滚

- 定义与校验：`src-tauri/src/state.rs`。
- 生命周期接入：`src-tauri/src/lib.rs` 的 Tauri setup。
- Rust/TypeScript 契约：`src-tauri/src/error.rs`、`src/services/desktop/contracts.ts`。
- 平台依赖：`src-tauri/Cargo.toml` 仅在 Windows 目标引入已锁定的 `windows-sys` 文件系统 API；没有新增运行时网络依赖。
- 影响范围：只影响 Plainroot appData 下的辅助状态；不影响 Markdown、授权目录或其他应用。
- 回滚：退出应用后先备份再删除状态文件，下次启动生成空状态；代码回滚时保留未知版本文件，不以旧代码覆盖。不存在 SQL 或 seed 回滚。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：30 个单元测试通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `pnpm build`：通过，Rust/TypeScript schema 字段与 24 个错误码 parity 纳入测试。
- `pnpm test:licenses`：2/2 通过；`pnpm licenses:check`：29 个 Node 包、417 个 Rust 包、0 个阻断项。
- `pnpm tauri build --no-bundle`：通过，生成 macOS arm64 release 可执行文件。
- 状态用例：首次启动、Unix `0600`、读写往返、损坏 JSON、超限读取、未知版本保留、appData 不可用、写入替换失败、临时文件清理、重复身份拒绝、超限写入不改变磁盘或内存。

## 未验证

- 未执行 Windows 编译、CI 或实机文件替换验证；归 T16，不外推为通过。
- 未执行页面、浏览器、选择器或桌面交互验证；T4 没有页面和可点击链路。
- 未验证最近工作区真实打开、重新授权或根会话恢复；这些消费者尚未进入 T5/T11/T12。
