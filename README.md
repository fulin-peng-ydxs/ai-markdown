# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。第一阶段 T1～T17 已完成本地、macOS 实机与 macOS/Windows 双平台 CI 验收：当前具备 Tauri/React 工程、受控工作区授权、文件扫描与安全写入底座、文件操作/监听、原生窗口菜单、工作区窗口协调、真实 P2 启动页、P1 只读工作台以及隔离的 P1/P2 桌面 E2E。第二阶段 T18～T21 已完成编辑器技术门禁、统一单文档会话、有界跨模式历史、陈旧读取保护、独立恢复快照仓储，以及一次性冲突覆盖和原生单目标安全另存后端契约，T22 待开始；这些后端能力尚未接入正式 P1 产品流程，当前仍没有可用的产品编辑器、页签、大纲、自动保存或可见冲突/恢复流程。

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

`pnpm test:e2e` 会构建独立 identifier/capability 的测试版本，以临时状态目录启动 embedded WebDriver，覆盖 P2 与 P1 fixture 工作区真 IPC；测试 feature 默认关闭，不进入正式构建。提交 `9a1690a` 已在 GitHub Actions 的 macOS/Windows runner 上通过 4/4 桌面 E2E 和生产构建。

开发模式在依赖安装完成后运行：

```bash
pnpm tauri dev
```

## 文档入口

- 产品范围与验收：`agent-works/markdown-editor-desktop/requirement.md`
- 第一阶段计划与实际状态：`agent-works/markdown-editor-desktop/stage-1-desktop-foundation/plan.md`
- 第二阶段编辑与保存计划：`agent-works/markdown-editor-desktop/stage-2-markdown-editing/plan.md`
- 当前桌面底座架构：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`
- 视觉与交互规范：`DESIGN.md`

第一阶段验收只代表 P1/P2 与文件/窗口底座达到当前阶段里程碑，不等于完整 R1/R2/R5/R14 或编辑器产品完成。Windows 原生选择器、回收站、Explorer、菜单与辅助技术仍缺人工实机证据。
