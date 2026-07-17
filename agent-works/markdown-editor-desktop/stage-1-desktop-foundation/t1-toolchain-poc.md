# T1 工具链、依赖与构建 PoC

> 执行日期：2026-07-17
>
> 执行范围：仅 T1；未进入 T2 或后续任务
>
> 本机平台：macOS arm64，Xcode Command Line Tools 已安装，完整 Xcode 未安装

## 1. 结论

T1 已完成。Plainroot 现有一个不承载业务功能的 Tauri 2 + React + TypeScript + Vite 8 空壳，Node、pnpm、Rust 与两套依赖锁文件均已固定；macOS 本机的 frozen-lockfile 安装、前端构建、Rust 检查、格式、Clippy、许可证审计和 Tauri release 空壳构建均通过。

本结论不包含 T2 路径安全模型、T3 窗口/菜单、任何文件操作、正式页面、自动化测试或 Windows 验证。Windows 构建与运行证据由 T16 承接。

## 2. 实际工具链与正式依赖

| 类别 | 版本 | 固定位置 | 许可证 |
| --- | --- | --- | --- |
| Node.js | 24.11.1 | `.nvmrc`、`package.json#engines` | Node.js 自有开源许可 |
| pnpm | 11.5.1 | `package.json#packageManager` | MIT |
| Rust / Cargo | 1.97.1 | `rust-toolchain.toml` | Apache-2.0 OR MIT |
| Tauri / tauri-build | 2.11.5 / 2.6.3 | `src-tauri/Cargo.toml`、`Cargo.lock` | Apache-2.0 OR MIT |
| React / React DOM | 19.2.7 | `package.json`、`pnpm-lock.yaml` | MIT |
| TypeScript | 6.0.2 | `package.json`、`pnpm-lock.yaml` | Apache-2.0 |
| Vite / React plugin | 8.1.4 / 6.0.3 | `package.json`、`pnpm-lock.yaml` | MIT |
| Tauri JavaScript API / CLI | 2.11.1 / 2.11.4 | `package.json`、`pnpm-lock.yaml` | Apache-2.0 OR MIT |

- Vite 8.1.5 在执行日刚发布，触发本机 pnpm 的最小发布时间保护；T1 没有提交供应链例外，而是选用仍受支持且已过冷静期的 8.1.4。
- Registry 当时已有 TypeScript 7，但 Vite 8 官方 React 模板仍采用 TypeScript 6.0.x；T1 选择 6.0.2，避免无需求驱动的主版本抢跑。
- 未安装 Milkdown、CodeMirror、SQLite，也没有预建其配置或空抽象。

## 3. 后续插件与回收站候选 PoC

下列候选只在 `/tmp/plainroot-t1-plugin-poc` 中以 Rust 1.97.1 编译验证，没有写入正式应用清单、capability 或运行时初始化。

| 候选 | 版本 | Registry 包体 | 许可证 | macOS 编译 | 正式接入任务 |
| --- | --- | ---: | --- | --- | --- |
| tauri-plugin-opener | 2.5.4 | 58,041 B；JS 14,093 B | Apache-2.0 OR MIT | 通过 | T8 |
| tauri-plugin-dialog | 2.7.1 | 129,783 B；JS 33,316 B | Apache-2.0 OR MIT | 通过 | T5 |
| tauri-plugin-store | 2.4.3 | 100,926 B；JS 27,512 B | Apache-2.0 OR MIT | 通过 | T4 |
| tauri-plugin-window-state | 2.4.1 | 95,023 B；JS 9,151 B | Apache-2.0 OR MIT | 通过 | T3/T4 |
| tauri-plugin-single-instance | 2.4.3 | 92,467 B；无独立 JS 包 | Apache-2.0 OR MIT | 通过 | T11 |
| trash | 5.2.6 | 69,585 B | MIT；Rust 下限 1.85.0 | 通过 | T8 |

PoC 只证明当前 macOS + Rust 组合能够解析和编译这些候选，不代替 Windows CI、平台行为或 capability 最小权限验收。

## 4. 许可证与包体结果

- `pnpm licenses:check` 扫描 `pnpm-lock.yaml` 对应的 29 个已安装 Node 包和 `Cargo.lock` 中的 417 个 Rust 包，缺失许可证、仅提供 `license_file` 而需人工复核，或命中 AGPL/GPL/SSPL/BUSL 阻断规则的包为 0。
- `pnpm test:licenses` 使用固定夹具验证带版本 GPL、裸 GPL/AGPL、缺失许可证和仅 `license_file` 四类输入均进入阻断列表，并验证 CLI 以退出码 1 失败；LGPL 与 MIT 的可选表达式不会被误判为 GPL。
- 完整明细可用 `pnpm licenses:inventory` 重新生成；该检查是工程准入辅助，不替代发布前法律审阅。
- 前端 `dist/` 为 192 KiB；macOS arm64 的无安装包 release 可执行文件为 10 MiB。
- `src-tauri/icons/icon.png` 是 Tauri 官方脚手架占位图标，只用于让空壳编译；`bundle.active` 当前为 `false`，正式打包前必须替换品牌图标并在对应任务验收。

## 5. 验证记录

| 验证 | 结果 |
| --- | --- |
| `nvm use` / `node --version` / `pnpm --version` | 通过：24.11.1 / 11.5.1 |
| `pnpm install --frozen-lockfile` | 通过；锁文件可复现 |
| `pnpm build` | 通过；Vite 8.1.4 生产构建成功 |
| `pnpm test:licenses` | 通过；2 个策略测试覆盖判定列表与非零退出码 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings` | 通过 |
| `pnpm licenses:check` | 通过：29 个 Node 包、417 个 Rust 包、0 个阻断项 |
| 临时候选插件与 trash crate `cargo check` | 通过；未进入正式依赖 |
| `pnpm tauri build --no-bundle` | 通过；生成 `src-tauri/target/release/plainroot` |

`pnpm tauri info` 报告完整 Xcode 未安装，但同时确认 Command Line Tools、Rust 1.97.1、Node 24.11.1 与 pnpm 11.5.1；Tauri 官方桌面前置条件允许只使用 Command Line Tools，且本次桌面 release 已实际构建通过。移动端不在当前范围。

## 6. T1 审查整改记录

- 清理早期提交遗留的 DuckDB、Parquet、Tushare、独立 `frontend/`、Python 与后端日志忽略项；`.gitignore` 仅保留当前 Tauri/React 工程、通用本地密钥和验证截图产物。
- `.claude/settings.json` 移除 AIOT 达梦 MCP、Claude Preview MCP、无限制 Bash/Edit、仓库外绝对路径 Read 与自动启用全部项目 MCP；只预授权仓库内 Read、Glob、Grep，其他能力恢复为显式确认。
- README 的 Cargo 可复现命令补齐 `--locked`；计划 T1 文件清单与验证命令同步到真实交付。
- 初始窗口 800×600 保持为空壳编译占位。`DESIGN.md` 只把 1180/1050/820/760 定义为响应式断点，没有定义产品默认窗口尺寸；T3/T12/T13 按各自任务确认默认值并完成多宽度验证。
