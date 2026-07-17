# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。当前代码只完成第一阶段 T1：Tauri 2、React、TypeScript 与 Vite 8 的可重复构建空壳；文件系统、窗口协调和正式页面能力尚未进入开发。

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
pnpm build
pnpm test:licenses
pnpm licenses:check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

开发模式在依赖安装完成后运行：

```bash
pnpm tauri dev
```

需求、阶段计划和验证边界见 `agent-works/markdown-editor-desktop/`。不要把当前空壳视为后续需求已经完成。
