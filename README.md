# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。第一阶段 T1～T17 已完成本地、macOS 实机与 macOS/Windows 双平台 CI 验收：当前具备 Tauri/React 工程、受控工作区授权、文件扫描与安全写入底座、文件操作/监听、原生窗口菜单、工作区窗口协调、真实 P2 启动页、P1 只读工作台以及隔离的 P1/P2 桌面 E2E。编辑器、页签、大纲、自动保存与完整冲突状态机尚未进入开发。

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
pnpm test:workspace-tree
pnpm test:permanent-delete-feedback
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

需求、阶段计划和验证边界见 `agent-works/markdown-editor-desktop/`。第一阶段验收只代表 P1/P2 与文件/窗口底座达到当前阶段里程碑，不等于完整 R1/R2/R5/R14 或编辑器产品完成。Windows 原生选择器、回收站、Explorer、菜单与辅助技术仍缺人工实机证据。
