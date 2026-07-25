# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。第一阶段 T1～T17 已完成桌面底座验收；第二阶段 T18～T34 已完成单文档编辑阶段验收及目录图片移动风险、编辑工作台信息层级补强。当前具备受控工作区授权、文件扫描与安全写入、窗口协调、真实 P1/P2、统一 `DocumentSession`、Milkdown/CodeMirror 两种投影、自动/手动保存、恢复/冲突/另存、图片资源、目录图片移动风险提示、固定主操作工具栏，以及单一保存状态和当前路径的持续状态栏。第二阶段基线的 9/9 隔离桌面回归已在 macOS/Windows runner 通过；第三阶段 T35～T36 已建立尚未接入 P1 的纯页签模型、内容无关窗口页签会话仓储和 Rust 平台路径身份契约并取得本地非桌面证据，仍没有可用多页签、大纲、工作区搜索、分页阅读或主题工作室。

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

`pnpm test:tabs` 包含可失败的轻量页签身份、状态、容量和序列化门禁；`pnpm test:tabs:performance` 只输出当前机器的纯 reducer 基准样本，不代表真实编辑器 adapter 或进程内存门禁。

`pnpm test:e2e` 会构建独立 identifier/capability 的测试版本，以临时状态目录和每套件独立复制的工作区启动 embedded WebDriver。当前 9 条用例覆盖 P2/P1 真 IPC、P2 1100/740 px 布局与焦点、P1 1100/1050/820/740 px 编辑 chrome、两模式编辑、图片输入/上传、保存重开、外部修改、恢复，以及含图片目录移动前的风险确认与取消零副作用；确定性业务流程不启用测试重试。测试 feature 默认关闭，生产前端产物和 release 二进制均不包含 WDIO、fixture 或 E2E 命令。提交 `914ad8413b30569ab1c704dc1a55f15d3ed78c59` 对应的 GitHub Actions run `30082725332` 已在 macOS/Windows runner 完成 9/9 套件、非桌面门禁、未签名生产构建和 artifact 上传。

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
- 当前桌面底座架构：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`
- Markdown 文档编辑架构：`agent-works/markdown-editor-desktop/architecture/markdown-document-editing.md`
- 视觉与交互规范：`DESIGN.md`

阶段验收只代表对应计划里程碑完成，不等于完整 R1/R2/R5/R11/R14/R30/R31 或完整产品完成。Windows 原生选择器、回收站、Explorer、菜单与辅助技术仍缺人工实机证据。
