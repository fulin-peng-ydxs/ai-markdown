# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。当前已完成第一阶段 T1～T15，T16 已实现尚待远端执行的双平台 CI：具备 Tauri/React 工程、受控工作区授权、文件扫描与安全写入底座、文件操作/监听、原生窗口菜单、工作区窗口协调、真实 P2 启动页、P1 只读工作台以及隔离的 P1/P2 桌面 E2E；编辑器、页签、Windows runner 与 CI 结果尚未完成。

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
```

`pnpm test:e2e` 会构建独立 identifier/capability 的测试版本，以临时状态目录启动 embedded WebDriver，覆盖 P2 与 P1 fixture 工作区真 IPC；测试 feature 默认关闭，不进入正式构建。Windows 桌面 E2E 已进入 T16 workflow，但只有分支推送并取得 GitHub Actions 结果后才算验证。

开发模式在依赖安装完成后运行：

```bash
pnpm tauri dev
```

需求、阶段计划和验证边界见 `agent-works/markdown-editor-desktop/`。当前 P1/P2、文件/窗口底座和本地 CI 实现不等于编辑器、完整 R1/R2/R5/R14、T16 或第一阶段整体已经验收；Windows 与远端 CI 证据仍未取得。
