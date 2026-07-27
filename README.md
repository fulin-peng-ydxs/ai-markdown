# Plainroot

Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器。第一阶段 T1～T17 已完成桌面底座验收；第二阶段 T18～T34 已完成单文档编辑阶段验收及目录图片移动风险、编辑工作台信息层级补强。第三阶段 T35～T44 已建立页签模型、内容无关窗口会话仓储、Rust 平台路径身份、P1 多 session runtime、可见页签、最近关闭、全页签结算、窗口生命周期保护、打开偏好、已有会话恢复、聚焦窗口原生页签菜单和统一非桌面门禁。T45 本地实现已在 macOS 以 15 条隔离桌面用例验证真实窗口替换拒绝、原生页签组合键和跨进程恢复；Windows 远端已通过非桌面门禁和 12/12 主桌面链，原生页签快捷键、跨进程恢复、生产构建及最新提交双平台 artifact 尚待同轮验证，因此 T45、R13/R14/R30 和第三阶段仍不能表述为完成。

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
pnpm verify:non-desktop
pnpm build
pnpm test:editor
pnpm test:tabs
pnpm test:stage-3:contracts
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

`pnpm test:tabs` 包含可失败的页签身份、状态、容量、序列化和 runtime manager 门禁；`pnpm test:stage-3:contracts` 组合页签/工作台专项与完整 Rust 服务测试；`pnpm verify:non-desktop` 是提交前一键非桌面门禁，串联 Node、Vitest、两种 Rust feature 口径、fmt、Clippy、类型、生产构建和许可证检查。`pnpm test:tabs:performance` 只输出当前机器的纯 reducer 基准样本。真实单 editor adapter 与进程 RSS 门禁由隔离的 Tauri/WebKit E2E 承载。

`pnpm test:e2e` 会构建独立 identifier/capability 的测试版本，并顺序运行四个隔离桌面进程：12 条 P1/P2 主链、1 条平台原生页签组合键、1 条重启前会话写入和 1 条重启后恢复。每段使用独立临时状态目录与复制工作区；跨进程恢复会在两次启动之间删除一个 fixture 文件，验证失败项隔离和其他页签继续可用。当前 macOS 本地 15/15 通过，并覆盖 1100/1050/820/760/740 px、真实窗口替换拒绝和 `Cmd+Option+Right/Left` 首次系统输入；确定性业务流程重试为 0。Windows 保留 `Ctrl+Tab` / `Ctrl+Shift+Tab`，第六次远端运行已通过非桌面门禁和 12/12 主桌面链，原生快捷键与后续恢复/构建仍待最新 runner 实证。测试 feature 默认关闭，生产前端产物和 release 二进制均不包含 WDIO、fixture 或 E2E 命令。第三阶段递进证据见 T45 留痕；尚无一轮同一最新提交的 macOS/Windows 双绿与成对生产 artifact。

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
- T44 契约与非桌面门禁证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t44-tab-contract-tests.md`
- T45 桌面 E2E 本地证据：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/t45-tab-desktop-e2e.md`
- 当前桌面底座架构：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`
- Markdown 文档编辑架构：`agent-works/markdown-editor-desktop/architecture/markdown-document-editing.md`
- 视觉与交互规范：`DESIGN.md`

阶段验收只代表对应计划里程碑完成，不等于完整 R1/R2/R5/R11/R14/R30/R31 或完整产品完成。Windows 原生选择器、回收站、Explorer、菜单与辅助技术仍缺人工实机证据。
