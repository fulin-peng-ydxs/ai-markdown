# T3 原生窗口壳与菜单记录

## 范围与状态

- 任务：第一阶段 T3，承接 R1 的原生桌面窗口/菜单子集和 R30 的真实菜单快捷键子集。
- 状态：已完成。
- 页面承接：为 P1 工作台与 P2 启动页提供同一套系统窗口壳；本任务没有创建页面、工作区、文件选择器、扫描、CRUD、Store、数据库或 Tauri 文件命令，不进入 T4。

## 页面开发流程承接

- 页面职责：原生层只提供窗口生命周期、系统标题栏、顶层菜单和后续 P1/P2 可复用的命令入口，不在 WebView 内自绘窗口控制。
- 事实来源：标题和窗口状态来自 Rust window service；菜单状态来自编译期菜单定义与已落地处理器，不使用原型假数据。
- 状态集合：launcher 窗口、按标签可聚焦窗口、当前聚焦窗口、窗口不存在、创建失败、聚焦失败、关闭失败。
- 提交边界：窗口创建成功后才返回窗口实例；聚焦与关闭失败返回稳定错误，不发成功 toast。T3 没有磁盘或 Store 提交。
- 复用判断：P1/P2 均消费 `window.rs` 与 `menu.rs`，不分别复制窗口尺寸、标题规则或菜单处理器。
- 布局与滚动：原生窗口默认 1100×720，最小 720×520，启用系统装饰、缩放、居中和工作区防溢出；WebView 滚动与 1180/1050/820/760 页面退化由 T12～T15 验证。
- 键盘与焦点：`CmdOrCtrl+Shift+N` 新建窗口，`CmdOrCtrl+W` 关闭聚焦窗口；新窗口初始聚焦，按标签聚焦时先取消最小化、显示并聚焦。未实现命令即使展示预定快捷键也处于系统禁用态，不触发处理器。
- 权限：`src-tauri/capabilities/default.json` 仅允许 `main` 与 `launcher-*` 使用 `core:default`；没有文件、Shell、网络、Store 或数据库权限。

## 窗口与标题契约

- 启动页/launcher：`Plainroot`。
- 已绑定工作区、无活动文件：`工作区 — Plainroot`。
- 已绑定工作区和活动文件：`工作区 — 当前文件 — Plainroot`。
- 动态 launcher 标签按现有窗口选择首个空闲 `launcher-N`，不会覆盖已存在窗口。
- 1100×720 与 720×520 是阶段实现默认值，不改变需求中的响应式断点，也不替代后续用户窗口状态恢复。

## 菜单状态矩阵

| 菜单区域 | T3 启用项 | T3 禁用项 | 后续归属 |
|---|---|---|---|
| 应用（macOS） | 关于、服务、隐藏、退出等系统动作 | - | 系统原生 |
| 文件 | 新建窗口、关闭窗口；非 macOS 的退出 | 打开文件夹、打开 Markdown 文件 | T5 接入真实选择器后再启用打开项 |
| 编辑 | - | 撤销、重做、剪切、复制、粘贴、全选 | 编辑器阶段 |
| 显示 | macOS 系统全屏 | 切换侧栏、搜索工作区 | T12～T15 与搜索阶段 |
| 窗口 | 最小化、缩放；macOS 前置全部窗口 | - | 只展示平台实际支持的系统动作；R14 协调由 T11 扩展 |
| 帮助 | 非 macOS 的关于 Plainroot | Plainroot 帮助 | macOS“关于”位于应用菜单；有真实帮助内容后再启用帮助项 |

## 稳定错误与配置

- 新增 `window_not_found`、`window_create_failed`、`window_focus_failed`、`window_close_failed`，对应安全 message key；Rust 与 TypeScript 错误码全集测试会阻止单侧漂移。
- `src-tauri/tauri.conf.json`：应用启动时消费窗口尺寸、系统装饰和 CSP；回滚时可恢复上一版本配置，不涉及用户文件或迁移。
- `src-tauri/capabilities/default.json`：动态 launcher 创建时消费窗口标签范围；回滚可移除 `launcher-*`，影响仅为新窗口失去 capability，不涉及用户数据。
- `src-tauri/Cargo.toml` 的 Tauri `test` feature 仅用于测试目标，使窗口协调可在 mock runtime 下验证；生产依赖仍不启用额外插件能力。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：21 个单元测试通过；覆盖标题格式、动态窗口唯一标签、创建/聚焦/关闭和不存在窗口稳定错误，以及菜单启用态与跨语言错误码 parity。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `pnpm build`：通过，TypeScript 错误码镜像纳入严格类型检查。
- `pnpm tauri build --bundles app`：通过，生成 macOS `Plainroot.app`。
- macOS 实机：可见系统关闭/最小化/全屏控件和 `Plainroot` 标题；应用、文件、编辑、显示、窗口、帮助菜单可见；打开目录/文件及编辑命令为禁用态；新建窗口后关闭当前窗口，原窗口仍正常存在。
- 长期进程验证：首次在缺少 Cargo PATH 时启动失败并返回明确命令错误；补齐本机 Rust PATH 后 `tauri dev` 达到 Vite ready、Rust build finished 和应用运行状态，随后正常停止。

## 未验证

- 未执行 Windows 构建、原生菜单、窗口控件或快捷键验证；由 T16 的 Windows CI/E2E 与人工证据承接，R1 仍是部分覆盖。
- 未执行稳定桌面 E2E；本轮实机证据来自辅助功能树和真实菜单点击，T15/T16 仍需建立可重复自动化。
- 未验证 P1/P2 页面布局、滚动、焦点环、文件状态或业务异常；这些页面尚未实现。
