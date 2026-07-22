# T17 第一阶段验收、证据与交接留痕

## 1. 功能的详细需求

T17 负责对第一阶段 T1～T16 的真实交付做最终验收、补齐页面与原生链路中的可验证缺口，并形成进入后续阶段前的事实基线。任务沿用 R1、R2、R5、R8、R11、R14、R30、R31，不改变需求编号含义，也不把第一阶段底座扩写成完整编辑器能力。

本次验收重点如下：

- 核对 P1 工作台与 P2 启动页是否持续消费 `DESIGN.md` 语义 token，关键宽度下是否无溢出，窄窗抽屉是否具备完整键盘与焦点闭环。
- 在真实 macOS 生产应用中验证原生选择器、文件读取、窗口创建与关闭、单实例、Finder 定位、系统废纸篓和外部文件变化监听。
- 对双平台 CI、测试工具隔离、许可证、生产构建和未验证边界做最终复核，不把 macOS 结果外推为 Windows 原生人工验收。
- 保持第一阶段范围：中央区仍是只读 Markdown 查看，不新增编辑器、页签、大纲、自动保存、恢复快照或完整冲突状态机。

## 2. 功能开发的实际结果

T17 已完成本地验收并修复 5 项真实问题：

1. P2 启动页移除页面私有渐变，恢复为中性纸面语义 token。
2. 永久删除对话框移除重复的私有阴影与遮罩色，统一消费公共对话框 token。
3. P2 快捷键提示按平台显示：macOS 使用 `⌘`，其他平台使用 `Ctrl`。
4. P1 窄窗文件树抽屉补齐打开后初始焦点、Tab/Shift+Tab 圈定、Esc 关闭和焦点返回；关闭态同时退出点击与键盘可达范围。
5. 原生“关闭窗口”快捷键调整为 `CmdOrCtrl+Shift+W`，为后续 R30 的 `CmdOrCtrl+W` 关闭页签保留语义。

第一阶段任务状态：T1～T17 的本地开发与 macOS 验收已完成。R1、R2、R5、R8、R11、R14、R30、R31 仅表示第一阶段子集完成，产品级需求仍是部分覆盖；编辑器、页签、大纲、自动保存、恢复快照、完整冲突状态机和主题工作室必须由后续阶段继续承接。

T16 基线提交 `0e25dae` 已取得 GitHub Actions 双平台绿灯。T17 当前增量在本地完成验证，尚未推送，因此不能把基线提交的 Windows 结果表述为当前增量的远端 Windows 验证。

## 3. 功能开发的具体实施方案

### 3.1 页面与设计合规收口

- 按 P1/P2 原型、`DESIGN.md` 和页面开发流程逐项核对布局、状态、响应式、焦点、快捷键和原生入口。
- 页面颜色、阴影、遮罩和背景只消费 `src/styles/tokens.css` 的语义 token，不在页面样式中复制 hex、rgb 或渐变。
- P1 在窄窗口中保持中央内容为主区，文件树退化为抽屉；关闭抽屉后不残留隐藏的可聚焦控件。

### 3.2 焦点能力复用

`AppDialog` 与 P1 窄窗抽屉出现了第二处相同的稳定职责：查找可聚焦元素、确定进入焦点、圈定 Tab/Shift+Tab 和关闭后恢复焦点。因此抽取 `src/components/focusContainment.ts`，两个消费者共享同一实现。

页面业务状态、打开关闭条件和 DOM 结构仍分别保留在组件内部；本次没有继续抽取页面状态机、按钮或列表，避免建立只有单一消费者的空抽象。

### 3.3 平台快捷键与原生窗口语义

- P2 根据运行平台显示 `⌘ O` / `⇧ ⌘ O` 或 `Ctrl O` / `Ctrl Shift O`，不再向 Windows 用户展示 macOS 符号。
- Rust 原生菜单将关闭窗口绑定到 `CmdOrCtrl+Shift+W`，并以单元测试固定该加速键契约。

### 3.4 真实 macOS 验收链路

使用未签名生产 `.app`、独立临时状态目录和脱敏 fixture 完成以下真实链路：

- P2 通过系统文件夹选择器打开 fixture，P1 扫描目录并读取 Markdown。
- 原生窗口缩至约 740px，文件树正确退化为抽屉；抽屉焦点进入、正反向循环、Esc 关闭和焦点返回均成立。
- 通过原生菜单创建第二窗口，并使用新快捷键关闭第二窗口，原 P1 工作区保持打开。
- Finder 定位到目标 Markdown；在隔离的临时 fixture 中执行系统废纸篓删除，磁盘成功后文件树与中央区同步更新。
- 外部创建 Markdown 后 watcher 自动更新文件树。
- 以同一状态目录启动第二个应用进程，第二进程正常退出且系统中只保留一个 Plainroot 进程。

真实删除仅作用于隔离临时工作区；仓库 fixture 和用户文档未被修改。测试结束后已停止应用并删除本次创建的临时状态与临时工作区。

## 4. 上线部署操作

- 本阶段不涉及数据库、SQL、seed、远端服务、账号、权限表或初始化数据。
- Tauri capability、应用状态 schema 和用户 Markdown 格式均未变化，不需要数据迁移。
- 生产构建继续使用默认 feature；WDIO/WebDriver 测试入口仍由编译期 `e2e` feature 隔离，不进入正式产物。
- 当前产物为本地验收用未签名应用，不构成公开发布。正式发布前仍需完成签名、公证、品牌图标和 Windows 原生系统交互人工验收。
- 回滚方式：回退 T17 提交即可；本次没有写入或迁移用户 Markdown。若回滚，P1 抽屉将失去本次焦点闭环，菜单关闭窗口快捷键也会恢复旧值。

## 5. 验证情况

### 5.1 本地自动化与构建

- `pnpm typecheck`：通过。
- `pnpm test`：通过，包含 4 个许可证策略测试、4 个永久删除反馈测试、18 个文件树 reducer 测试、1 个 fixture 测试和 34 个 React UI/状态测试。
- `pnpm build`：通过，生产前端产物约 247.89 kB JS / 22.42 kB CSS。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`：115/115 通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --no-default-features`：115/115 通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`：通过。
- `pnpm licenses:check`：531 个 Node 包、508 个 Rust 包、0 个阻断项。
- `pnpm test:e2e`：真实 macOS Tauri/WebKit 4/4 通过，覆盖 P2 IPC 与响应式、入口焦点顺序，以及 fixture 经授权、窗口绑定、扫描和读取进入 P1。
- `pnpm tauri build --bundles app`：通过，生成未签名 macOS `.app`。

许可证扫描首次调用时因当前 shell 未加载 Cargo 而失败；补齐锁定的 Node/Rust 环境后原命令通过。该次失败属于命令环境错误，不是许可证或代码失败。

### 5.2 真实平台与远端证据

- macOS 生产 `.app`：系统选择器、P1/P2、740px 抽屉焦点链、原生多窗口、关闭窗口快捷键、Finder 定位、系统废纸篓、外部变化监听和单实例均已人工实测通过。
- T16 基线 GitHub Actions：运行 `29885090733` 的 macOS/Windows 矩阵均为 Success；macOS artifact SHA-256 为 `e58d26fa0ff7ba2d8b3718efb84cc66aa8c9b6294b9b3e8e52aaa359d13ba23d`，Windows artifact SHA-256 为 `2e1a559f7c4a58cba77ce982f3e33c82c9b2d00f4a4555e63651e5ec931d8837`。

### 5.3 未验证边界

- T17 当前增量尚未推送，未取得包含本次焦点、样式和快捷键修复的 Windows runner 结果。
- Windows 原生选择器、回收站、Explorer、原生菜单与辅助技术仍缺人工实机验收；既有自动化绿灯不能替代这些系统 UI 证据。
- 系统休眠、网络卷、文件系统卸载和超大目录的长时行为未执行。
- P1 尚无编辑器，因此自动保存、恢复快照和完整外部冲突产品链路不适用；本阶段只验证了对应的底层安全写与修订原语。
