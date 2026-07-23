# Plainroot AI 协作规则

## 文档职责与事实源

- 本文件是仓库级 AI 协作权威入口；`CLAUDE.md` 仅是 Claude Code 薄入口，不复制完整规则。
- 产品范围、状态机和验收口径以 `agent-works/markdown-editor-desktop/requirement.md` 为准；需求闭环理由见同目录 `requirement-closure.md`。
- 当前阶段做什么、暂不做什么，以对应阶段目录中的 `plan.md` 为准。阶段计划不得改变需求编号含义或把后续能力伪装为当前已完成。
- 当前已落地桌面底座的模块边界、数据流和运行约束见 `agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`；代码、清单、配置和自动化测试是更高优先级的技术事实源。
- 前端视觉、布局和交互规范以 `DESIGN.md` 为准；页面开发步骤以 `agent-works/markdown-editor-desktop/page-development-workflow.md` 为准。
- `agent-works/markdown-editor-desktop/prototypes/` 是交互与视觉证据，不是生产实现。原型中的固定路径、计时器、假数据和说明控件不得进入正式产品。
- 工程建立后，代码、清单、锁文件、脚本和自动化测试是技术事实源。它们与计划中的候选路径或命令冲突时，先核实当前实现并同步文档。
## 项目概览与当前阶段

- Plainroot 是面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器，核心体验是目录工作区、多文档页签、所见即所得与源码无损切换、长文阅读和可编辑颜色预设。
- T1 已建立并验证技术基线：Node 24.11.1、pnpm 11.5.1、Rust 1.97.1、Tauri 2.11.5、React 19.2.7、TypeScript 6.0.2 与 Vite 8.1.4；精确版本以当前清单和锁文件为准。
- Markdown 内容事实源始终是用户授权目录中的真实 `.md` 文件；首版不建立云端账号、在线协作、插件市场或私有内容数据库。
- 当前仓库已完成 T1～T17 的本地开发、macOS 实机与 macOS/Windows 双平台 CI 验收；提交 `9a1690a` 的远端矩阵已确认许可证、类型、前端/Rust 测试、4/4 桌面 E2E、未签名生产构建和 artifact 上传全部通过。当前具备真实系统选择器、最近记录、根目录决策、渐进文件树、只读 Markdown、文件 CRUD/删除/定位入口、窄窗目录抽屉、多窗口打开和可重复隔离的 P1/P2 桌面测试；Windows 原生选择器、回收站、Explorer、菜单和辅助技术仍无人工实机证据。产品尚无自动保存触发、恢复快照产品链路、完整外部冲突状态机、编辑器/页签/大纲，第一阶段完成不得表述为完整 R1、R2、R5 或 R14 完成。
- 第二阶段当前分支为 `codex/plainroot-stage-2`，执行计划位于 `agent-works/markdown-editor-desktop/stage-2-markdown-editing/plan.md`；T18～T20 已完成，T21 待开始。Milkdown 7.21.3、CodeMirror 6 及其 React/Markdown adapter 已精确锁定并通过隔离 PoC，但未接入正式 P1；当前已建立单一 `DocumentSession`、有界可逆 patch 历史、adapter/read gateway 契约、文档级陈旧读取保护，以及独立版本化、原子、有界并保护活动脏会话最后快照的 recovery 仓储与 IPC/TS 契约。恢复正文大 I/O 不持有全局 manifest 锁，并用读取租约保护并发清理；正文读取和删除均绑定当前授权 workspace。P1 只读链路已消费 session，但 recovery 尚无页面消费者。T18 的 jsdom 测试只覆盖程序化中文插入，不构成真实 IME 证据，真实 AST parser、WebView IME 和大文档挂载仍由 T23/T26/T31 验证；自动保存、恢复弹层、另存和资源目录仍未实现。

## 当前与目标代码边界

- `agent-works/markdown-editor-desktop/`：本产品的需求、计划、原型和后续开发留痕；同一产品能力继续复用该目录或其语义明确的阶段子目录。
- `src/`、`src-tauri/`：已建立 P1/P2、共享 `AppDialog`/类型化 `AsyncStatePanel`/`focusContainment`、`WorkspaceTree`、工作区相对路径工具 `workspacePath`、单文档 `DocumentSession`/有界 patch history/adapter 契约、独立 recovery repository/desktop service、完整浅色运行时 token、桌面契约/调用封装、渐进文件树/变更/监听状态、永久删除对话框、窗口协调、版本化状态仓储，以及工作区选择、扫描、读取、CRUD、删除、定位、监听、安全写入和恢复快照命令；公共焦点工具由对话框和窄窗抽屉共同消费，路径工具由树 reducer 和 P1 页面共同消费，P1 只读内容消费统一 session，公共状态组件负责状态优先级、非颜色标签和 live-region。当前 P1 中央区仍仅真实只读查看，不含自动保存触发/恢复弹层/完整冲突状态机、可编辑 adapter、页签、大纲或搜索。
- `tests/`：已建立脱敏工作区 fixture、Node 临时目录工厂和隔离的 P1/P2 Tauri E2E；`.github/workflows/ci.yml` 已实现并跑通 T16 双平台门禁。macOS 与 Windows 均已通过 Rust lint、平台适用测试、4/4 桌面 E2E、未签名生产构建和 artifact 上传；该自动化证据不替代 Windows 原生系统交互的人工验收。
- 前端只负责视图、用户意图和可观察状态；不得直接拼接任意绝对路径执行磁盘写操作。
- Rust 命令层集中负责授权根、路径规范化、越界检查、文件扫描与 CRUD、安全写入、回收站和窗口协调。
- 跨平台能力必须通过适配层表达。不得用 macOS 原型外观替代 Windows 原生窗口控制、菜单、快捷键和文件系统语义。

## 产品核心契约

- 本地与授权：只访问用户明确选择的目录或文件；所有相对路径必须在 Rust 侧基于规范化根目录校验。第一阶段默认不跟随符号链接越过授权根。
- 一目录一窗口：同一规范化目录已有窗口时聚焦原窗口，不创建第二个可写会话；一个窗口首版只绑定一个根目录。
- 磁盘先于界面：新建、重命名、移动、删除和保存必须先得到磁盘操作成功结果，再更新正式 UI 状态；失败时保留原路径、原内容和可重试入口。
- 内容安全：安全写入、保存失败、只读、外部修改、外部删除和关闭保护不得静默丢失内容，也不得展示虚假保存成功。
- 单一内容源：排版编辑、Markdown 源码和分页阅读共享同一 Markdown 内容；切换模式先提交当前编辑状态，并以语义锚点恢复位置，不生成第二份内容。
- 页签一致性：活动页签是中央内容、文件树选中、大纲、状态栏和窗口标题的唯一来源；每个页签独立维护内容、撤销栈、光标、滚动、模式和保存状态。
- 主题边界：颜色预设只改变应用和阅读渲染，不向 Markdown 写入颜色、HTML 或私有元数据；未保存主题草稿只影响当前窗口。
- 状态诚实：未进入当前阶段或尚无真实数据链路的能力必须隐藏或禁用并说明，不用假按钮、固定结果或 toast 伪装完成。
- 异常隔离：单个文件、最近记录或窗口恢复失败不得阻断其他安全内容和窗口继续使用。

## AI 开发流程

1. 开工前读取本文件、正式需求相关章节、当前阶段计划和同类实现；页面任务再读取 `DESIGN.md` 与页面开发流程。
2. 先确认任务属于当前阶段，并把需求编号、入口、状态、异常和验收映射到计划。发现越期能力时停止扩张范围。
3. 新增或修改前先全局查找同类页面、组件、hook、服务和 Rust 命令。职责相同的第二处实现优先抽取或消费复用单元；不复用时在计划中写清差异原因。
4. 技术方案、交互设计、关键业务规则或破坏性文件语义存在多种合理选择时，先给出推荐方案和理由，得到确认后再实现。
5. 实现保持职责边界和状态机完整；关键的文件安全、权限边界、跨平台差异、状态流转和兼容取舍必须有必要注释。
6. 完成后先自审，再按改动风险执行单元、集成、构建、桌面 E2E、关键窗口尺寸和真实平台冒烟；只报告实际取得的证据。
7. 代码改变稳定事实时，同步 `AGENTS.md`、`DESIGN.md`、页面流程或对应功能目录文档，避免文档继续描述候选方案。

## 页面与交互开发

- 新页面、窗口、弹窗、页签、布局、样式、主题 token 或点击链路，必须执行 `agent-works/markdown-editor-desktop/page-development-workflow.md`。
- 计划必须覆盖页面职责、需求编号、真实数据来源、状态集合、磁盘或 Store 提交边界、复用判断、滚动归属、窄窗口退化、键盘与焦点、验证方式。
- 视觉必须消费 `DESIGN.md` 的语义 token。相同颜色、间距、控件状态和窗口材质不得在页面内复制成第二套私有体系。
- 工作台以编辑内容为主区；启动页以打开本地内容为唯一主任务；主题工作室以令牌编辑和实时预览为主流程。不要把页面改造成通用后台、营销页或卡片仪表盘。
- 点击类交互必须验证真实状态变化；系统选择器、窗口、回收站、菜单等原生能力不能只用浏览器 mock 作为最终验收。

## 编码、测试与安全

- TypeScript 和 Rust 类型应表达稳定领域状态，避免用散落字符串和布尔组合模拟文件、页签、窗口或主题状态机。
- 前端不得信任路径文本或自行宣称文件操作成功；Rust 返回稳定错误码和安全的用户提示字段，原始系统堆栈不直接展示。
- 测试文件系统能力时只使用临时工作区或仓库 fixtures，不触碰用户真实文档目录。
- 必测高风险链路包括路径越界、符号链接、只读、权限撤销、写入中断、外部修改、同目录窗口去重、部分恢复失败和主题草稿回退。
- 密钥、个人绝对路径、本机应用数据、日志、构建产物和测试截图不得进入版本库；需要示例时使用脱敏相对路径或 fixtures。
- 不执行未经用户授权的提交、推送、发布、删除或其他破坏性操作。

## 命令与验证状态

- 2026-07-22 已在 macOS arm64 实际验证：`nvm use`、`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:ui`、`pnpm test:workspace-path`、`pnpm test:workspace-tree`、`pnpm test:permanent-delete-feedback`、`pnpm test:fixtures`、`pnpm test:editor-poc`、`pnpm test:editor-poc:performance`、`pnpm test:licenses`、`pnpm licenses:check`、`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --no-default-features`、`cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`、`cargo check --locked --manifest-path src-tauri/Cargo.toml --features e2e`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`、`pnpm test:e2e`、`pnpm tauri build --no-bundle` 与 `pnpm tauri build --bundles app`。2026-07-23 的 T19 改动另实际通过 `pnpm test:document-session`、`pnpm test:document-session:performance`、`pnpm typecheck`、`pnpm test` 与 `pnpm build`；T20 及复核整改另实际通过 21 个恢复仓储专项测试、136 个 Rust 全量测试（all-features 与 no-default-features）、Rust fmt/Clippy、`pnpm typecheck`、`pnpm test`、`pnpm build` 和许可证扫描。本阶段尚未重跑桌面 E2E 或 Tauri 打包。
- `pnpm test:e2e` 每次使用独立临时状态目录，真实 macOS Tauri/WebKit 4/4 通过：P2 IPC、1100/740px 布局、入口焦点顺序，以及 fixture 工作区经真实授权/窗口绑定/启动快照/文件树扫描读取 P1 Markdown。默认生产依赖图、前端产物和 release 二进制均确认不含 WDIO/WebDriver 或测试命令。T17 另在生产 `.app` 实测 P1/P2、窄窗抽屉焦点链、原生多窗口、Finder、系统废纸篓、外部监听和同状态目录第二实例退出；这些 macOS 证据不替代 Windows 原生人工验收。
- 本机具备 Xcode Command Line Tools，未安装完整 Xcode；桌面构建已通过，移动端不在当前范围。T16 已在 GitHub `windows-latest` 上验证锁定的 Node/Rust 工具链、Windows 编译、测试、WebView2 E2E 和未签名生产构建；原生系统交互仍保留人工未验证状态。
- 当前自动化测试覆盖许可证策略、T2～T11 底座、Rust↔TypeScript 契约 parity、T12 launcher、T13 workbench、T14 公共组件、T17 焦点/快捷键契约、T18 编辑器 PoC、T19 session/history/AST 契约与 P1 陈旧读取、T20 recovery 原子/容量/损坏/活动保护、根启动错误去重、工作区路径代数、临时 fixture、失效清理日志满额回归、平台原子替换和 P1/P2 桌面 E2E，共 133 个 Rust 单元测试、3 个工作区路径测试、18 个前端树状态测试、4 个永久删除反馈测试、71 个 React UI/状态/编辑器测试、1 个 fixture 测试、4 个许可证策略测试和 4 个桌面 E2E；提交 `9a1690a` 的 Windows runner 已通过 105 个平台适用 Rust 用例、4/4 桌面 E2E 和未签名生产构建。T18～T20 改动尚无远端 Windows 证据，且 Windows 原生系统 UI 仍未人工验证。许可证扫描覆盖默认与 `e2e` Cargo feature，为 727 个 Node 包、508 个 Rust 包、0 个阻断项。新增长期启动命令或测试后，必须同时验证启动、就绪、停止和失败方式，再更新本节。

## 文档、协作与 Git

- 除命令、代码、日志和原文外，面向用户使用简体中文。
- 需求、计划、开发留痕、业务核查、测试证据和 SQL（若未来确有）放入 `agent-works/{feature-slug}/`；同一功能复用同一语义目录，不在根目录堆零散 Markdown。
- 已确认任务在既有功能目录内的常规开发留痕，随代码、计划状态和验证证据直接同步，不再单独请求确认；只有功能目录、范围拆分或归档边界存在真实歧义时才确认。
- 修改代码或文档前检查最近一次远端同步时间；超过 2 小时先同步并解决冲突。最近一次远端同步：2026-07-23 10:24 CST（已抓取 `origin`；当前 `codex/plainroot-stage-2` 尚无 upstream，未推送）。
- 工作区可能包含用户未提交改动；先读 `git status`，保留无关改动，不覆盖、不清理、不顺手格式化。
- 未经用户要求不创建提交或推送。需要提交时按用户确认范围处理，提交信息使用中文语义化描述。
