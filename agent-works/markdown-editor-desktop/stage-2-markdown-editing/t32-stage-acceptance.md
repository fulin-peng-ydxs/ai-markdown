# T32 第二阶段整体复核与验收

## 功能的详细需求

T32 不新增产品能力，负责以当前代码、测试和远端运行证据收口第二阶段：

- 逐项复核 R1～R34、P1/P2、T18～T31 的实际覆盖和未覆盖边界。
- 核对单文档编辑、保存、恢复、冲突、另存、图片、菜单、权限、配置和回滚是否形成可追溯闭环。
- 建立 Markdown 文档编辑专项架构文档，并明确它与桌面底座架构的职责边界。
- 将第二阶段真实完成状态回写到需求、计划、README 和仓库协作入口。
- 重新运行计划规定的本地验证；未运行或仍需人工验证的事项保持显式，不把 macOS/WebView/CI 证据外推为 Windows 原生人工通过。

需求事实源为 `../requirement.md`，阶段事实源为 `plan.md`，专项技术事实源为 `../architecture/markdown-document-editing.md`。

> 验收后补强：用户于 2026-07-24 确认目录图片移动风险策略，T33 已在不改变需求编号的前提下补上“资源目录或含图片目录移动前提示未打开文档可能断链”的确认链路。T32 以下 8/8 和远端双绿数字仍是当时验收证据；T33 的最新本地证据为 9/9，尚未取得新远端双平台结果，详见 `t33-directory-image-move-warning.md`。
>
> 页面审查补强：T34 已把保存状态收敛为状态栏单一位置，恢复当前文档路径，并让工具栏固定保存/另存/查找、只滚动模式与格式区；本地 9/9 在 1100/1050/820/740 px 验证上述编辑 chrome，仍未取得新远端双平台结果，详见 `t34-editor-chrome-ux-refinement.md`。

## 功能开发的实际结果

### 1. 阶段结论

第二阶段本地验收通过。T18～T31 已形成一个可在 P1 中真实使用的单文档编辑闭环：

- `DocumentSession` 是排版/源码、选择、锚点、历史、保存和内容安全的单一前端事实源。
- Milkdown 与 CodeMirror 通过统一 adapter 接入；模式切换先提交当前内容，跨模式撤销只消费一套有界历史。
- 自动/手动保存共用 `DocumentSaveController` 和 Rust safe-write；外部修改、外部删除、恢复、冲突覆盖、另存和窗口结算都有明确状态和失败保护。
- 图片选择、粘贴、拖放、资源目录偏好、受控预览、相对链接和移动后内联图片链接调整已接入真实页面。
- 聚焦窗口菜单和持续状态栏消费真实 session；未实现的页签、大纲、工作区搜索、阅读和主题入口没有被伪装为已完成。

阶段完成不改变产品范围：R13 多页签、完整 R14 全页签结算、R4 大纲、R12 工作区搜索、R9 阅读、R15 主题和 R7/R8/R32 视觉布局定稿仍未开始。R1、R2、R5、R11、R14、R30、R31 等跨阶段需求继续保持“部分覆盖”。

### 2. 需求与页面复核

| 范围 | 第二阶段结果 | 仍未完成或未验证 |
| --- | --- | --- |
| R3 | Milkdown 排版编辑、常用语法、格式命令、统一历史和真实保存已落地 | 系统 IME 候选窗仍需人工验证 |
| R5 | 单文档自动保存、恢复快照、外部冲突、外部删除保护和当前窗口结算已落地 | 阶段 3 全页签关闭检查、阶段 7 搜索索引异常协同未完成 |
| R6 | PNG/JPEG/GIF/WebP 受控导入、目录偏好、相对链接、缺失重定位和当前文档移动调整已落地；T33 又补上资源目录/含图片目录移动前的潜在断链提示 | 不建立跨文档引用索引、不批量改写其他文档；系统剪贴板、Finder/Explorer 原生拖入和多图峰值内存仍需人工/性能证据 |
| R10 | CodeMirror 源码、高亮、行号、查找替换、原始换行投影和模式切换已落地 | 系统 IME 仍需人工验证 |
| R11 | 编辑、保存、恢复、冲突、只读、图片和菜单状态均为真实状态 | 后续页面状态与系统辅助技术仍属后续/人工验收 |
| R14 | 当前单文档的关闭、当前窗口替换和应用退出结算底座已落地 | 多页签集合结算与完整恢复属于阶段 3 |
| R30/R31 | 本阶段编辑命令、快捷键、弹层焦点、live-region 和非颜色状态已落地 | 页签/阅读/工作区搜索快捷键、Windows 原生辅助技术未完成 |
| P1 | 已从只读预览升级为真实单文档编辑工作台 | 页签、大纲、阅读、工作区搜索仍隐藏/禁用 |
| P2 | 保持打开/恢复入口；恢复失败隔离 | 不承担正文编辑或设置中心 |
| P3 | 未注册、未开发 | 阶段 5 实现 |

R16、R17、R24～R26、R33、R34 继续作为未纳入建议项；R18～R23、R27～R29 继续为暂不实现。复核未发现需要新增、重排或改变含义的需求编号。

### 3. 配置、菜单、权限与数据

- 无数据库、SQL、seed、业务账号、密钥或生产环境变量变化。
- 新增稳定数据只有独立 recovery v1 仓储和 preferences v1 文件；未知 schema 均不覆盖。
- 正式 Tauri capability 仍只有 `core:default`，没有通用 filesystem/dialog 权限。
- 保存、另存、撤销/重做、当前文档查找和排版/源码菜单只在聚焦窗口存在真实消费者时启用。
- 用户已保存的 Markdown、另存副本和图片资源不随应用版本回滚自动删除或改写。

### 4. 架构与文档

- 新增 `../architecture/markdown-document-editing.md`，沉淀统一会话、adapter、保存/恢复、冲突、资源、窗口结算和权限边界。
- `../architecture/desktop-foundation.md` 继续负责跨模块底座概览，并将编辑子系统细节指向专项文档。
- `requirement.md`、`plan.md`、仓库 `README.md` 与 `AGENTS.md` 已同步第二阶段完成状态和最新证据。
- `DESIGN.md` 不需要更新：T32 没有新增页面、组件、token、布局或交互规范，T25～T29 已完成相关登记。
- `CLAUDE.md` 不需要更新：它仍是指向 `AGENTS.md` 的薄入口，没有新增独立约束。
- 页面原型和页面开发流程不需要更新：T32 不改变交互事实或原型承载范围。

## 功能开发的具体实施方案

### 1. 事实交叉检查

复核以代码和配置为技术事实源，重点对照：

- 前端：`src/features/editor/`、`src/features/workbench/WorkspaceWorkbench.tsx`、`src/services/desktop/`。
- Rust：`src-tauri/src/editor/`、`src-tauri/src/fs/`、`src-tauri/src/commands/editor.rs`、`preferences.rs`、`menu.rs`、`window.rs`。
- 权限/配置：`src-tauri/capabilities/default.json`、`tauri.conf.json`、`package.json`、`.github/workflows/ci.yml`。
- 测试：编辑器 Vitest、Rust 服务/契约测试、Node 独立回归和 8 条 Tauri E2E。

复核确认没有第二份 Markdown 保存通道、前端绝对路径写入、宽泛 capability、数据库或阶段外页签/大纲/搜索实现。

### 2. 文档职责收敛

- 需求文档只描述产品范围、验收和阶段状态。
- 阶段计划记录任务、实际落地、验证和偏差。
- 专项架构文档只记录当前稳定模块、状态机和边界，不复制任务流水账。
- AGENTS/README 只沉淀当前入口、稳定命令和长期约束，不写临时失败过程。

### 3. 状态一致性原则

- “第二阶段完成”指本阶段计划和里程碑完成，不表示完整产品或所有关联 R 项完成。
- 远端双平台证据以已推送的 `71cab73070bce27ec59fc8e35c670680d6ee2021` / run `30063241410` 为准。
- T32 是本地文档与验收提交；未推送前没有针对该提交的新远端 CI，不把父提交绿灯冒充为 T32 提交绿灯。

## 上线部署操作

本任务不发布产品、不签名、不公证、不上传安装包，也不修改用户数据。

- 代码和数据迁移：无。
- SQL/seed：无。
- 新生产环境变量：无。
- capability 或系统权限变化：无。
- 回滚：可直接回退 T32 文档提交；不会改动 Markdown、恢复快照、资源偏好或图片文件。
- 下一阶段输入：阶段 3 计划必须从单一 `DocumentSession` 提升为页签容器，并复用本文的单文档结算接口，不得重写第二套保存或历史状态机。

## 验证情况

### 已执行

- 代码、契约、配置、菜单、权限、数据文件和文档交叉扫描。
- R1～R34、P1/P2/P3 与 T18～T32 编号/状态一致性复核。
- `nvm use`
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:editor`
- `pnpm test:roundtrip`
- `pnpm test:rust`
- `pnpm test:licenses`
- `pnpm licenses:check`
- `pnpm build`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`
- `pnpm test:e2e`
- `pnpm tauri build --no-bundle`

最终结果：

- Node `24.11.1`、pnpm `11.5.1` 与冻结锁文件安装通过。
- TypeScript 检查通过；生产 Web 构建通过。入口为 442.90 kB，排版 chunk 337.06 kB，源码 chunk 544.41 kB；源码 chunk 的 500 kB 告警继续作为已知性能边界。
- `pnpm test` 通过：Node 独立回归 30/30、Vitest 23 个文件 173/173、Rust 176/176，另 1 项手动性能探针忽略。
- 编辑器专项 17 个文件 127/127，生产 adapter 往返 3/3。
- Rust fmt、全 feature Clippy 和全 feature tests 通过；全 feature tests 同为 176 项通过、1 项忽略。
- 许可证策略 4/4；依赖清单 727 个 Node 包、508 个 Rust 包、0 个阻断项。
- 真实 macOS Tauri/WebKit E2E 8/8 通过，`pnpm tauri build --no-bundle` 生成 release 二进制成功。
- 首次在当前非交互 shell 中执行统一 `pnpm test` 时，Node/Vitest 已通过，但 `cargo` 因 `PATH` 未包含 `/Users/pengshuaifeng/.cargo/bin` 而未启动。补入已安装的固定 Rust 工具链路径后重新执行完整 `pnpm test` 并通过；这是执行环境失败，不计为测试用例失败。
- E2E runner 输出了 `tauri-driver not found`、窗口切换和会话清理诊断噪声，但 embedded WebDriver 会话实际建立，8 项均通过且命令退出码为 0；本任务没有把这些诊断当作原生系统人工证据。

### 远端证据

- GitHub Actions run `30063241410` 对应提交 `71cab73070bce27ec59fc8e35c670680d6ee2021`，macOS/Windows 双绿。
- 两个平台均为 23 个 Vitest 文件、173 项通过，8/8 桌面 E2E 通过，并完成 Rust 门禁、未签名生产构建与 artifact 上传。
- macOS artifact digest：`7587bca0661f2b3383d1f96f619b056f679609f6cb323045b6432d35c7c801a8`。
- Windows artifact digest：`79370e5f83bc7254dfa9f88061b2e1aefea88202713502f5dac3a11bf457c665`。

### 未执行或不适用

- Windows 原生选择器、系统剪贴板、Explorer 拖入、菜单和辅助技术人工验收：无用户侧 Windows 环境，未执行。
- macOS/Windows 系统 IME 候选窗、强制终止、磁盘满、休眠、网络卷和超大目录长时测试：未形成本阶段可复现实证。
- 图片链仍保留已登记的非阻塞微边界：T33 已把移动资源目录/含图片目录时的静默断链收敛为明确风险提示，但不建立跨文档引用索引或批量改写；JPEG/WebP 采用保守签名信封，带尾随数据的合法文件可能被拒绝；引用式图片定义不在当前文档移动后的自动链接改写范围；多图 Blob 读取尚无全局并发和总量预算。具体实现证据与验证边界见 `t28-image-assets-ui.md`、`t31-e2e-cross-platform-ci.md`、`t33-directory-image-move-warning.md` 及 `../architecture/markdown-document-editing.md` 第 9 节。
- 正式签名、公证、安装包发布和自动更新：不属于第二阶段。
- T32 本地提交的远端 CI：未推送前不适用。
