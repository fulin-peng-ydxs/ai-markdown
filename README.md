# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。第一阶段 T1～T17 已完成桌面底座验收；第二阶段 T18～T34 已完成单文档编辑阶段验收及目录图片移动风险、编辑工作台信息层级补强。当前具备受控工作区授权、文件扫描与安全写入、窗口协调、真实 P1/P2、统一 `DocumentSession`、Milkdown/CodeMirror 两种投影、自动/手动保存、恢复/冲突/另存、图片资源、目录图片移动风险提示、固定主操作工具栏，以及单一保存状态和当前路径的持续状态栏。第二阶段基线的 9/9 隔离桌面回归已在 macOS/Windows runner 通过；第三阶段 T35～T43 已建立页签模型、内容无关窗口会话仓储、Rust 平台路径身份、P1 多 session runtime、可见页签条、最近关闭/会话元数据写入、全页签两阶段结算、窗口替换/关闭/退出保护、三值打开偏好、已有页签会话恢复，以及按聚焦窗口状态驱动的原生页签菜单。当前可在同一窗口切换、排序、重新打开并安全关闭当前/其他/右侧/全部页签；重命名、移动、删除命中打开页签时会先结算，并仅在磁盘成功后批量提交路径或移除。真实重启/多窗口桌面回归、`Ctrl+Tab` 的真实系统输入和第三阶段双平台验收尚未完成，因此仍不能表述为完整 R13/R14/R30 或第三阶段完成。

## 工具链

- Node.js `24.11.1`，由 `.nvmrc` 固定。
- pnpm `11.5.1`，由 `package.json#packageManager` 固定。
- Rust `1.97.1`，由 `rust-toolchain.toml` 固定，并包含 rustfmt 与 clippy。
- macOS 桌面构建需要 Xcode Command Line Tools；Windows 构建需要 Tauri 官方要求的 MSVC C++ Build Tools 与 WebView2。

## 安装与验证

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:editor
pnpm test:tabs
pnpm test:tabs:performance
pnpm test:roundtrip
pnpm test:rust
pnpm test:ui
pnpm test:workspace-path
pnpm test:workspace-tree
pnpm test:permanent-delete-feedback
pnpm test:fixtures
pnpm test:editor-poc
pnpm test:editor-poc:performance
pnpm test:document-session
pnpm test:document-session:performance
pnpm test:licenses
pnpm licenses:check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
pnpm test:e2e
pnpm tauri build --no-bundle
pnpm tauri build --bundles app
```

`pnpm test:tabs` 包含可失败的页签身份、状态、容量、序列化和 runtime manager 门禁；`pnpm test:tabs:performance` 只输出当前机器的纯 reducer 基准样本。真实单 editor adapter 与进程 RSS 门禁由隔离的 Tauri/WebKit E2E 承载。

`pnpm test:e2e` 会构建独立 identifier/capability 的测试版本，以临时状态目录和每套件独立复制的工作区启动 embedded WebDriver。最近一次本地 11 条用例在 T43 当前代码上通过，覆盖 P2/P1 真 IPC、P2 1100/740 px 布局与焦点、P1 1100/820/740 px 编辑 chrome、三文档可见页签切换、溢出菜单焦点返回、单 adapter/RSS 门禁、批量关闭、打开页签的真实改名/移动/删除及图片链接写回、两模式编辑、图片输入/上传、保存重开、外部修改、恢复，以及含图片目录移动前的风险确认与取消零副作用；确定性业务流程不启用测试重试。测试 feature 默认关闭，生产前端产物和 release 二进制均不包含 WDIO、fixture 或 E2E 命令。提交 `914ad8413b30569ab1c704dc1a55f15d3ed78c59` 对应的 GitHub Actions run `30082725332` 已在 macOS/Windows runner 完成第二阶段 9/9 套件；T35～T43 尚未推送或取得远端双平台证据，窗口 intent、打开偏好、已有页签会话重启恢复和原生页签组合键的完整桌面覆盖由 T45 补齐。

开发模式在依赖安装完成后运行：

```bash
pnpm tauri dev
```

## 文档入口

- 产品范围与验收：`agent-works/markdown-editor-desktop/requirement.md`
- 第一阶段计划与实际状态：`agent-works/markdown-editor-desktop/stage-1-desktop-foundation/plan.md`
- 第二阶段编辑与保存计划：`agent-works/markdown-editor-desktop/stage-2-markdown-editing/plan.md`
- 第二阶段验收：`agent-works/markdown-editor-desktop/stage-2-markdown-editing/t32-stage-acceptance.md`
- 第三阶段页签与窗口生命周期计划：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/plan.md`
- T35 页签模型与整改证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t35-tab-state-model.md`
- T36 窗口页签会话仓储证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t36-window-session-store.md`
- T37 每页签运行时管理器证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t37-tab-session-manager.md`
- T38 可见页签与菜单证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t38-tab-bar.md`
- T39 最近关闭、持久化与路径影响证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t39-tab-file-integration.md`
- T40 全页签安全结算证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t40-tab-settlement.md`
- T41 窗口结算与打开偏好证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t41-window-lifecycle.md`
- T42 已有页签会话恢复证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t42-tab-session-restore.md`
- T43 原生页签菜单与快捷键证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t43-tab-menu-keyboard.md`
- 当前桌面底座架构：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`
- Markdown 文档编辑架构：`agent-works/markdown-editor-desktop/architecture/markdown-document-editing.md`
- 视觉与交互规范：`DESIGN.md`

阶段验收只代表对应计划里程碑完成，不等于完整 R1/R2/R5/R11/R14/R30/R31 或完整产品完成。Windows 原生选择器、回收站、Explorer、菜单与辅助技术仍缺人工实机证据。
