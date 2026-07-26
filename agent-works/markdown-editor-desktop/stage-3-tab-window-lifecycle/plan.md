# Plainroot 第三阶段开发计划

> 当前执行分支：`codex/plainroot-stage-3`
>
> 分支基线：第二阶段已验收提交 `9906a6f581fcc4e16d6f81dc06e16f31df528a3f`
>
> 当前阶段：阶段 3——多文档页签状态机、窗口会话恢复与全页签生命周期保护
>
> 计划状态：执行中（T35～T37 已完成；T38～T46 未实施）
>
> 需求编号规则：完全沿用 `requirement.md` 的 R1～R34，不新增、重排或改变 R 编号含义。

## 1. 需求来源与目标

- 需求文档：`agent-works/markdown-editor-desktop/requirement.md`。
- 上游闭环：`agent-works/markdown-editor-desktop/requirement-closure.md`。
- 第一阶段计划与验收：`stage-1-desktop-foundation/plan.md`、`stage-1-desktop-foundation/t17-stage-acceptance.md`。
- 第二阶段计划与验收：`stage-2-markdown-editing/plan.md`、`stage-2-markdown-editing/t32-stage-acceptance.md`。
- 当前架构：`architecture/desktop-foundation.md`、`architecture/markdown-document-editing.md`。
- 页面与设计依据：仓库根 `DESIGN.md`、`page-development-workflow.md`。
- 已完整读取的页面原型：
  - P1：`prototypes/markdown-workbench.html`；
  - P2：`prototypes/workspace-launcher.html`；
  - P3：`prototypes/theme-preset-studio.html`。
- 阶段目标：把第二阶段的“每窗口单一 `DocumentSession`”升级为“每窗口一个真实页签集合、每页签一个独立文档会话”，完成打开、聚焦、排序、关闭、最近关闭、会话恢复、全页签结算、当前窗口工作区替换保护和页签/窗口键盘命令。
- 本阶段重点实现：
  - R13 多文档页签与最近关闭文档；
  - R14 的页签会话、工作区打开偏好、当前窗口替换保护和多窗口独立恢复子集；
  - R5 从单文档结算扩展为全页签关闭/替换/退出结算；
  - R30 的页签与窗口快捷键子集；
  - R11/R31 的页签状态反馈、焦点和非颜色状态子集。
- 本阶段承接但不重新定义：
  - R2 的文件树打开、重命名、移动和删除对多个打开页签的联动；
  - R3/R6/R10 的排版、源码、图片和保存能力在页签间保持独立；
  - R1 的 Windows/macOS 原生窗口与离线桌面回归。
- 本阶段不做：
  - R4 大纲、R7/R8 完整布局调宽、R9 阅读分页、R12 工作区搜索、R15 主题工作室、R32 长文视觉定稿；
  - R24/R33 固定页签、R24/R34 预览页签、R25 跨窗口拖拽页签；
  - 窗口位置、尺寸和三栏布局持久化，继续由阶段 4 承接；
  - 把恢复快照扩张为历史版本，或把页签元数据扩张为 Markdown 正文副本。
- 阶段外必须实现项采用“跳过 + 未覆盖/部分覆盖 + 后续阶段说明”登记，不创建未来阶段占位任务；这不取消产品义务。
- 计划输出目录：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/`。

## 2. 当前项目依据

### 2.1 工程与验证基线

- 当前技术基线为 Node 24.11.1、pnpm 11.5.1、Rust 1.97.1、Tauri 2.11.5、React 19.2.7、TypeScript 6.0.2 与 Vite 8.1.4；精确版本以清单和锁文件为准。
- 2026-07-26 已在 T37 当前本地状态重新执行完整门禁：Node 独立回归 30/30、Vitest 25 个文件 211/211、Rust 200 项通过且 1 项手动性能探针忽略；类型检查和生产构建通过。T37 主实现还取得 Rust fmt/全 feature Clippy、锁定 e2e check、许可证 727/511/0 与 macOS Tauri/WebKit 桌面套件 10/10 证据；本次评审整改未重跑这些未受影响的重型门禁。T32、T35、T36 留痕中的测试数字只是各任务当时的历史快照。最新远端证据仍为 GitHub Actions run `30082725332` 在 macOS/Windows 通过第二阶段 9 条套件，尚未覆盖第三阶段本地提交。
- 第三阶段不得删除、降低或用重试掩盖上述基线。新增页签测试必须加入统一 `pnpm test`、真实桌面 E2E 和双平台 CI。
- 当前产品依赖已能实现页签状态、拖动、菜单和持久化；T37 只为真实桌面内存门禁在 `e2e` feature 增加可选 `sysinfo`，默认产品构建不注册对应命令。若后续确认必须引入拖拽或状态库，先补许可证、包体、复用理由和回滚方案，再修改清单。

### 2.2 已有代码与可复用能力

- `DocumentSession` 已表达 Markdown、模式、选择/锚点、history、保存、恢复和冲突状态；它应成为单个页签的内容事实源，不再由 `WorkspaceWorkbench` 直接维护唯一会话。
- `DocumentSaveController` 已具备自动保存、恢复快照、追赶保存和单文档结算；T37 已让每个已加载 runtime 持有自己的控制器，切换时不释放其他页签的恢复身份。
- `WorkspaceWorkbench` 已消费唯一 `WorkspaceTabManager`，页面上的 `documentState`、`editorHandleRef` 和 `saveControllerRef` 只是活动 runtime 投影；可见页签层、持久恢复和多项阻塞决策仍由后续任务完成。
- `WorkspaceTree`、`workspacePath`、文件 CRUD、watch、目录图片移动风险、图片资源链、冲突/恢复/另存弹层均可复用。磁盘操作仍必须先成功，再提交页签路径与树状态。
- `WorkspaceWindowCoordinator`、`WindowSettlementCoordinator` 已实现一目录一窗口、当前/新窗口决策、关闭/替换/退出意图和失败回滚；第三阶段只扩展前端结算范围及会话引用，不另建第二套窗口协调器。
- `plainroot-state-v1.json` 的 `WorkspaceSessionRoot.windowStateRef` 已由 T36 接到独立窗口页签会话仓储；根状态仍不承载高频页签元数据或正文。
- `plainroot-preferences-v1.json` 已保存工作区资源目录。R14 的全局打开偏好可在向后兼容的可选字段中扩展，默认继续为“每次询问”。
- `AppDialog`、`AsyncStatePanel`、`focusContainment`、`plainroot-button` 和语义 token 是弹层、菜单和状态反馈的复用事实源。
- 原生菜单已将 `Cmd/Ctrl+Shift+W` 用于关闭窗口，并明确为阶段 3 保留 `Cmd/Ctrl+W` 关闭当前页签；React 不得再注册会与原生加速键双触发的全局 keydown。

### 2.3 原型与页面事实

- P1 原型已承载页签条、活动页签、非颜色状态点、关闭入口、横向滚动、全部页签溢出入口、单页签关闭确认和工作区替换保存检查。
- P1 原型中的页签内容仍是简化演示：它只保存少量模式/滚动字段，不是独立 `DocumentSession`，不能复制其固定内容、计时器或单一全局阅读页码。
- P1 原型没有承载拖动排序、关闭其他/右侧、完整最近关闭列表和真实全页签失败处理；这些流程以 R13、R30 和页面功能点 7.1.6 为事实源。
- P1 原型的工作区替换弹层只示意 dirty 文档列表；生产计划必须同时处理 dirty、saving、save_failed、readonly、conflict 和恢复快照状态，不能把“保存全部”当成无条件成功。
- P2 原型已承载逐窗口会话恢复、页签数量和单项失败状态；第三阶段必须恢复真实页签集合，不能继续只恢复根目录。
- P2 的设置图标在原型中未建模业务行为。R14 已明确要求打开偏好可恢复为“每次询问”，因此第三阶段将其升级为真实的“工作区打开方式”设置入口，并与原生设置菜单共用同一弹层和偏好。
- P3 与本阶段无消费者，不创建路由、页签或占位设置分类。
- 新增页签上下文菜单、最近关闭列表、全页签结算弹层和打开方式设置弹层没有完整 HTML 原型；其流程由 R5/R13/R14/R30、7.1.6、7.1.7、7.2.3 明确定义。普通菜单与少字段偏好弹层直接复用现有区域、`AppDialog` 和 DESIGN 规范；安全关键的全页签结算弹层已在 4.5.1 主动补齐布局/状态矩阵，并要求 T40 先新增独立补充原型、通过页面流程复核后再写生产组件。若补原型暴露会改变关闭结果或数据安全的新选择，暂停 T40 并升级为用户确认。

### 2.4 已确认与推荐的阶段决策

- 每个窗口只绑定一个工作区；同一规范化目录仍只允许一个可写窗口。
- 每个打开页签拥有独立 `DocumentSession`、`DocumentSaveController`、history、模式、选择和锚点；只有活动页签挂载 Milkdown/CodeMirror 重型视图，非活动页签不保留 editor DOM/adapter。
- 已打开且含未保存内容的页签必须保留内存会话；启动恢复的页签先恢复轻量描述，首次激活时再读取磁盘和恢复快照。
- 页签会话仓储只保存路径、顺序、活动项、模式、选择/锚点和最近关闭元数据，不保存 Markdown 正文和完整撤销栈。脏内容继续只由内存与第二阶段恢复仓储保护。
- `windowStateRef` 指向独立、版本化、原子写入的页签会话记录；同一工作区重新打开时也可按 `workspaceId` 找回最后会话。
- 运行时不人为设置产品级页签数量上限；持久化文件超过安全容量时明确报告“会话元数据未保存”，不静默截断正在打开的页签。
- 最近关闭列表使用有界保留，初始技术上限为每工作区 50 项；它只用于重新打开路径，不保存被放弃的正文。
- 工作区打开偏好默认为 `ask`；只有用户在真实设置入口选择后才保存 `current_window` 或 `new_window`，并可随时恢复 `ask`。同目录已打开时无论偏好为何都聚焦既有窗口。
- 关闭多个页签采用两阶段结算：先完成所有阻塞项决策，最后一次性提交页签移除或工作区替换；取消时保留所有未关闭页签。已经成功写入磁盘的保存不回滚，但不得因后续取消而丢失页签。

## 3. 实施范围

### 3.1 必须实现与本阶段承接

| 需求编号 | 第三阶段覆盖 | 开发状态 | 偏差判断 | 对应任务 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| R1 | 在现有 Windows/macOS 壳内增加真实多页签和会话恢复，不重做安装/授权 | 待开始 | 部分覆盖 | T41～T46 | 双平台桌面 E2E、生产构建；原生系统 UI 人工项如实保留 |
| R2 | 文件树打开、重命名、移动、删除同步作用于全部相关页签 | 进行中 | 部分覆盖 | T37、T39～T40、T44～T45 | T37 已让文件树打开/聚焦真实 runtime；全体路径重映射与删除联动仍由 T39～T40 承接 |
| R3 | 每页签独立消费现有排版编辑与统一 history | 进行中 | 部分覆盖 | T35、T37、T39、T44～T45 | T37 已完成每页签独立 session/history 与活动 editor 单挂载；可见页签交互和后续整体回归未完成 |
| R4 | 阶段 6 实现大纲；本阶段只保证活动页签单一来源可供未来消费 | 跳过 | 未覆盖 | - | 确认无假大纲入口 |
| R5 | 将保存、恢复、冲突和关闭保护扩展为全页签结算 | 进行中 | 部分覆盖 | T37、T40～T46 | T37 已建立每页签 controller、后台保存/快照和窗口意图的全 runtime 安全结算；混合阻塞决策与两阶段提交仍由 T40 起完成 |
| R6 | 保持每页签图片链路；目录/文件移动时处理全部相关打开文档的链接和状态 | 进行中 | 部分覆盖 | T37、T39～T40、T44～T45 | T37 已保持活动页签既有图片链路并隔离 session；跨全部相关打开文档的路径/图片改写仍待 T39～T40 |
| R7 | 阶段 4/5 实现主题能力；本阶段只消费既有 token | 跳过 | 未覆盖 | - | CSS token 扫描，不计 R7 完成 |
| R8 | 阶段 4 实现完整三栏调宽与窗口布局持久化 | 跳过 | 未覆盖 | - | 只回归现有 820/760 px，不宣称 R8 完成 |
| R9 | 阶段 6 实现阅读分页；本阶段不创建阅读页签模式 | 跳过 | 未覆盖 | - | 阅读入口保持禁用/隐藏 |
| R10 | 每页签独立保留排版/源码模式和源码选择 | 进行中 | 部分覆盖 | T35、T37、T42、T44～T45 | T37 已验证同窗口文件切换保留独立模式、选择/锚点和 history；重启恢复仍待 T42 |
| R11 | 页签加载、保存、冲突、缺失、恢复和批量结算状态真实可见 | 待开始 | 部分覆盖 | T38～T46 | 状态优先级、文案、失败内容安全与页面测试 |
| R12 | 阶段 7 实现工作区全文搜索 | 跳过 | 未覆盖 | - | 搜索菜单继续禁用 |
| R13 | 完整纳入：真实页签、唯一打开、排序、批量关闭、溢出、最近关闭、独立会话和恢复 | 进行中 | 一致 | T35～T46 | T35～T37 已完成状态机、内容无关会话仓储、Rust 路径身份和 P1 真实多 session runtime；页签条、批量动作、持久恢复与完整结算未实施 |
| R14 | 纳入页签会话、打开偏好、全页签替换保护和独立窗口恢复；位置/尺寸/三栏布局留阶段 4 | 进行中 | 部分覆盖 | T36、T40～T46 | T36 已完成根会话引用与窗口页签会话元数据底座；偏好、全页签阻断和可见多窗口恢复仍待后续任务 |
| R15 | 阶段 5 实现主题工作室 | 跳过 | 未覆盖 | - | P3 不注册 |
| R30 | 纳入页签切换/关闭、重新打开、关闭窗口和弹层焦点子集 | 待开始 | 部分覆盖 | T38、T40～T46 | 原生菜单、键盘遍历、焦点恢复和双平台 E2E |
| R31 | 纳入 tablist/menu/dialog 的语义、焦点、非颜色状态和减少动态效果子集 | 待开始 | 部分覆盖 | T38、T40、T43～T46 | ARIA、roving tabindex、键盘、对比度与系统偏好回归 |
| R32 | 阶段 4 完成长文视觉定稿 | 跳过 | 未覆盖 | - | 不把页签样式记为 R32 完成 |

R11/R31 在第三阶段只承接真实页签、结算弹层、菜单和窗口流程不可缺少的状态反馈与无障碍子集；需求 §12 规定的完整桌面状态、布局、焦点、对比度和长文矩阵仍由阶段 4 验收。T46 不得把本阶段子集写成 R11/R31 产品级完成。

### 3.2 可选增强

| 需求编号 | 增强内容 | 需求处理状态 | 开发状态 | 对应任务 | 跳过原因 |
| --- | --- | --- | --- | --- | --- |
| R16 | 导出 HTML/PDF | 后续建议 | 跳过 | - | 等阅读渲染与主题稳定 |
| R17 | 本地历史版本与 Git 集成 | 后续建议 | 跳过 | - | 页签恢复与历史版本不是同一能力 |
| R24 | 固定/预览页签组合追溯项 | 后续建议 | 跳过 | - | 只保留 R33/R34 追溯，不直接开发 |
| R25 | 跨窗口拖拽页签 | 后续建议 | 跳过 | - | 本阶段拖动只允许当前窗口内排序 |
| R26 | Plainroot 预设本地导入导出 | 后续建议 | 跳过 | - | 等 R15 预设格式稳定 |
| R33 | 固定页签 | 后续建议 | 跳过 | - | 不混入基础关闭、排序和恢复状态机 |
| R34 | 预览页签 | 后续建议 | 跳过 | - | 不引入单击隐式替换语义 |

### 3.3 暂不实现

| 需求编号 | 内容 | 开发状态 | 跳过原因 |
| --- | --- | --- | --- |
| R18 | 双向链接知识图谱 | 跳过 | 不扩展为知识管理平台 |
| R19 | 云同步 | 跳过 | 页签会话只在本机应用数据目录 |
| R20 | 多人实时协作 | 跳过 | 不引入账号、协作协议或权限体系 |
| R21 | 插件市场 | 跳过 | 不开放用户插件执行边界 |
| R22 | 手机端 | 跳过 | 目标平台仍为 Windows/macOS |
| R23 | 任意文字任意颜色 | 跳过 | 不向 Markdown 写私有颜色语法 |
| R27 | 同一窗口附加多个根目录 | 跳过 | 保持一目录一窗口 |
| R28 | 同一目录多个可写窗口 | 跳过 | 保持聚焦已有窗口 |
| R29 | Obsidian 主题源码兼容层 | 跳过 | 与页签生命周期无关 |

## 4. 技术方案

### 4.1 模块边界与目标结构

```text
src/
├── features/tabs/
│   ├── tabTypes.ts
│   ├── WorkspaceTabManager.ts
│   ├── tabReducer.ts
│   ├── tabSessionGateway.ts
│   ├── components/
│   │   ├── WorkspaceTabBar.tsx
│   │   ├── TabOverflowMenu.tsx
│   │   ├── TabContextMenu.tsx
│   │   └── TabSettlementDialog.tsx
│   └── *.test.ts(x)
├── features/workbench/
├── features/launcher/
└── services/desktop/
src-tauri/src/
├── commands/window_session.rs
├── window_session.rs
├── preferences.rs
├── menu.rs
├── window.rs
└── contract_test.rs
```

- `WorkspaceTabManager` 负责页签集合、活动项、加载代次、最近关闭、每页签 session/controller 生命周期和批量结算，不负责磁盘路径授权。
- `DocumentSession` 与 `DocumentSaveController` 继续负责单文档内容和保存；不得把多页签状态塞回单文档 reducer。
- `WorkspaceWorkbench` 只消费活动页签投影，并把文件树、状态栏、窗口标题和菜单状态绑定到同一 `activeTabId`。
- Rust `WindowSessionRepository` 只负责版本化元数据、原子写、授权重校验和会话引用；不解析或保存 Markdown 正文。
- 新抽象必须由 P1/P2 真实消费，不创建只有类型没有运行时链路的“未来框架”。

### 4.2 页签与文档会话模型

`WorkspaceTab` 至少表达：

| 字段/状态 | 用途 | 事实来源 |
| --- | --- | --- |
| `tabId`、`incarnation` | `tabId` 是窗口内 UI key；incarnation 由集合单调分配且不复用，阻止关闭重开后的异步 ABA | manager、tab collection |
| `workspaceId`、`relativePath`、`pathIdentity` | 文档磁盘身份；relativePath 必须是 Rust 规范化结果，pathIdentity 是 Rust 返回的不透明平台身份，前端不得自行 lower-case | Rust 授权根、文件树 |
| `displayName`、`parentHint` | 同名消歧与 tooltip | 相对路径派生 |
| `loadState` | `idle/loading/ready/error/missing/permission_denied` | 文档读取 |
| `session` | `DocumentSession`，仅加载后存在 | T19 模型 |
| `saveController` | 每个已加载页签独立保存/恢复调度 | T26 控制器 |
| `lastActivatedAt` | 最近使用与恢复顺序 | manager |

`WorkspaceTabCollection` 至少表达：

- 有序 `tabIds`、`activeTabId`、`recentlyClosed`、结构版本和待持久化状态；
- 同一路径唯一约束使用 Rust 返回的不透明平台路径身份，不得以展示名、原始路径字符串或前端 lower-case 去重；
- 页签状态由 `loadState + session.saveState` 投影，不复制第二份可漂移保存状态；
- 同一页签同时命中多个状态时严格复用 DESIGN 公共优先级：`permission-denied > missing > conflict > error > unsupported > saving > loading > dirty > readonly > empty > unloaded > ready`；尚未读取的 lazy descriptor 使用 unloaded，不能误报 empty；权限、位置、冲突和错误使用 assertive alert，其余进度与稳定状态使用 polite status，页签不得另建私有优先级；
- 活动页签是编辑器、状态栏、文件树选中、窗口标题和原生菜单的唯一来源；
- 切换前先从活动 adapter 提交当前 Markdown、选择和锚点，再卸载重型 adapter；切换后挂载目标投影；
- 非活动已加载页签继续保留 session/history/controller，确保自动保存、恢复和撤销栈独立；
- 启动恢复的未激活页签只保留描述，首次激活再读取磁盘，避免窗口启动时同时解析全部文档。

### 4.3 版本化窗口页签会话仓储

新增 `appDataDir()/plainroot-window-sessions-v1/`：

```text
plainroot-window-sessions-v1/
├── manifest-v1.json
└── sessions/
    └── <opaque-ref>.json
```

- `manifest-v1.json` 按稳定 `workspaceId` 映射 opaque `windowStateRef`、最后活动时间和会话摘要；不存 Markdown、绝对路径或恢复正文。
- 单个 session 文件保存：
  - `schemaVersion`、`workspaceId`、`windowStateRef`、`revision`；
  - 有序打开项：相对路径、模式、选择/锚点、最后活动时间；
  - `activeRelativePath`；
  - 最近关闭项：相对路径、模式、选择/锚点、关闭时间。
- 正文、history patch、恢复快照正文、绝对 canonical root、窗口像素位置和三栏布局不得进入该文件。
- 写入使用私有同目录临时文件、`sync_all`、平台原子替换和父目录尽力同步；进程内 manifest 提交失败会恢复旧 session，若进程在 session 替换后、manifest 替换前终止，下一次初始化只接受同 workspace/ref 且恰好领先一个 revision 的已校验 session，并前滚 manifest。
- session 更新使用仓储 revision/CAS 拒绝陈旧异步写；前端同一窗口串行合并后重试，不能让晚到视图状态覆盖更新后的页签顺序。
- manifest 初始边界为 1 MiB/1000 个工作区，单 session 为 1 MiB，最近关闭最多 50 项；超限返回稳定错误并保留运行时页签，不静默截断打开项。
- 损坏单 session 备份并隔离，不阻断其他工作区；未知 schema 原文件不覆盖。孤儿只删除符合 Plainroot opaque 命名且未被 manifest/root session 引用的普通文件。
- `plainroot-state-v1.json` 继续只保存最近工作区与根窗口会话；根会话的 `windowStateRef` 指向上述记录。显式关闭窗口移除自动恢复根会话，但保留该工作区最后页签会话供再次打开；移除最近工作区记录时同步删除其页签会话元数据，不删除任何 `.md` 或恢复快照正文。
- 计划命令契约：
  - `get_workspace_tab_session(workspaceId, windowStateRef?)`：仅允许当前窗口已绑定工作区读取完整相对路径元数据；Rust 对每个恢复路径重新解析并返回规范化相对路径与当前平台不透明 path identity，失效/越界项按单项错误隔离；
  - `save_workspace_tab_session(workspaceId, expectedRevision, snapshot)`：Rust 重校验窗口绑定、路径、容量与 revision 后原子提交；
  - `remove_workspace_tab_session(workspaceId)`：仅允许当前授权窗口，或由 Rust 已确认的最近/根会话移除流程调用；
  - P2 所需 `tabCount`、最后活动时间和 session issue 合并进现有 launcher snapshot，不在未授权页面暴露页签文件名；
  - 所有新增 DTO、tag、enum 和错误码进入现有 Rust↔TS parity 总守卫。

### 4.4 打开、切换、排序与最近关闭

- 文件树、初始文件、恢复项和未来搜索结果统一调用 `openOrFocus(relativePath)`。
- 命中已打开路径时聚焦原页签，不创建重复 session，并恢复该页签选择/锚点。
- 新打开先插入 loading 页签；读取成功后建立 session/controller，失败保留可关闭/重试的错误页签，不回退成替换当前文档。
- 只有活动页签挂载 editor adapter；切换期间活动页签的内存内容和焦点不会被目标页签陈旧读取覆盖。
- 鼠标拖动只改变当前窗口顺序；键盘用户可通过上下文/溢出菜单执行“左移/右移”，不把拖动作为唯一排序路径。
- 页签宽度遵循 DESIGN 与 P1：不无限压缩文本，溢出后横向滚动；溢出菜单列出全部页签、父路径提示和非颜色状态。
- 最近关闭只记录已完成关闭的路径/视图元数据。重新打开时重新校验授权与磁盘；缺失/无权限项显示失败并可从列表移除，不伪装恢复成功。

### 4.5 全页签关闭与结算事务

新增 `TabSettlementCoordinator`，结算原因至少包括：

- `close_current`、`close_others`、`close_right`、`close_all`；
- `replace_workspace`、`close_window`、`quit_app`；
- `rename_entry`、`move_entry`、`delete_entry` 对相关页签集合的保护。

结算规则：

1. 固化目标页签顺序和各自 generation/editVersion，clean 页签直接标记可提交。
2. saving 页签等待其追赶保存完成；dirty/save_failed/conflict 进入真实阻塞列表。
3. 用户逐项选择重试保存、另存副本、放弃修改或保持页签打开；只读且无修改可关闭，有本地修改时仍需内容安全选择。
4. 重试/另存继续消费现有安全写、冲突和 save-copy 契约；证据过期时回到阻塞态。
5. “保持页签打开”或关闭弹层取消整个批次；此前已成功保存的磁盘结果保留，但页签集合不做部分移除。
6. 所有目标已解决后一次性提交页签移除/窗口替换，并在最后释放 recovery 活动身份和需放弃的快照。
7. 任何 Rust/磁盘失败保留页签、内存内容和可重试入口，不返回虚假成功。

#### 4.5.1 `TabSettlementDialog` 主动补充布局与状态矩阵

P1 既有原型没有覆盖多页签混合阻塞态。T40 生产组件编码前必须先新增补充原型 `prototypes/tab-settlement-dialog.html`，它只补充 P1 安全弹层证据，不替换或重写 `markdown-workbench.html`。补充原型须按 `page-development-workflow.md` 复核以下契约后才能进入组件实现：

- 固定头部：使用与结算原因一致的标题，例如“关闭 3 个页签前处理未保存内容”“替换当前工作区前处理 2 个页签”，同时展示已处理/总阻塞项。
- 主要增长区：可滚动的阻塞页签列表；每项展示文件名、父路径、非颜色主状态、内容当前安全位置和该项可执行动作。dialog 自身不随列表无限长高，低高度下只让列表滚动。
- 固定底部：始终提供“取消并保持全部页签”；只有所有目标已解决时才启用结果明确的主动作，如“关闭 3 个页签”“在当前窗口打开 {workspace}”“退出 Plainroot”。
- 焦点：打开后先聚焦标题/首个安全动作，不默认聚焦“放弃修改”；Esc 等同“取消并保持全部页签”；关闭后返回原页签关闭按钮、菜单项或工作区打开触发器。

| 页签主状态 | 列表说明 | 可执行动作 | 进入已解决的条件 |
| --- | --- | --- | --- |
| clean/已保存 | 磁盘已有当前内容 | 无需动作，仅显示“可关闭” | 自动解决 |
| saving | 正在完成哪次保存，当前内容是否仍有新修改 | 等待；允许取消整个批次 | 追赶保存成功后自动解决 |
| dirty | 当前修改仅在内存/恢复快照的安全说明 | “保存此文档”“另存副本…”“放弃此文档修改” | 保存成功、另存证据成功或明确放弃 |
| save_failed/error | 失败原因、内容安全位置和下一步 | “重试保存”“另存副本…”“放弃此文档修改” | 重试/另存成功或明确放弃 |
| conflict | 磁盘变化时间、当前页签状态和内容安全 | “处理冲突…”“另存副本…”“放弃本地修改” | 既有冲突流程产出新 revision、另存成功或明确放弃 |
| readonly/permission-denied | 是否有本地修改；磁盘不可写原因 | 无修改时自动解决；有修改时“另存副本…”或“放弃本地修改” | 无修改、另存成功或明确放弃 |
| missing | 原路径失效，当前内容位于内存/恢复快照何处 | “另存副本…”“放弃本地修改”；可取消整个批次 | 另存成功或明确放弃 |

- 每个“放弃”动作都先显示对象和后果的二次确认，不使用“确定”；单项放弃只把该项标为允许关闭，直到批次主动作提交前都不实际移除页签或删除恢复快照。
- 保存、另存或冲突子流程返回后回到同一列表与滚动位置；错误以行内 `AsyncStatePanel`/安全摘要承接，不使用 toast 替代待处理状态。
- `WorkspaceOpenPreferenceDialog` 是三项单选 + 保存/恢复“每次询问”+ 取消的少字段普通 dialog，直接复用 `AppDialog` 既有布局，不属于上述复杂批量弹层。

### 4.6 文件树操作与多页签联动

- 重命名/移动文件或目录前收集全部受影响打开页签，并先执行对应结算；任一阻塞取消磁盘操作。
- 磁盘成功后才批量重映射页签路径、session 身份、controller recovery 身份、文件树选择、展开路径和窗口会话元数据。
- 移动包含多个打开 Markdown 的目录时，对每个相关打开 session 计算现有内联图片链接调整；不能只修改活动页签。
- 目录资源风险提示继续只说明“未打开文档可能断链”，不虚构跨文档索引；打开页签的可计算链接调整与未打开文档风险提示并存。
- 用户删除包含打开页签的文件/目录时，先保证每个阻塞内容有安全去向；删除成功后关闭相应页签。外部删除仍保留现有 missing/recovery 保护。
- 磁盘操作失败时路径、页签顺序、活动项和正文状态均不变。

### 4.7 工作区打开偏好与窗口生命周期

- 全局偏好值：`ask | current_window | new_window`，默认 `ask`。
- P2 设置入口与原生“设置…”菜单打开同一个 `WorkspaceOpenPreferenceDialog`；保存后由 P1/P2/第二实例打开流程共同读取，重置立即恢复 `ask`。
- `ask` 显示当前/新窗口/取消；`current_window` 跳过选择弹层但不能跳过全页签结算；`new_window` 创建新窗口且不触碰原窗口页签。
- 同一目录已打开时优先聚焦已有窗口，忽略偏好，不创建重复可写窗口。
- 当前窗口替换顺序：取得选择提案 → 全页签结算 → 持久化旧页签会话 → Rust 提交窗口根替换 → 卸载旧 manager/watch → 加载或恢复新工作区。任一步失败不得留下第二个可写映射。
- 关闭窗口：先结算全部页签并持久化最后会话，再让现有 Rust 协调器关闭；取消保持窗口。
- 退出应用：每个窗口独立结算；任一窗口取消则退出取消，其他窗口不得被提前销毁。
- 启动恢复：先恢复根窗口，再按 `windowStateRef` 恢复轻量页签；目录权限或单文件失败只影响对应项。
- 窗口位置、尺寸和三栏布局仍由阶段 4 实现；第三阶段不得用固定值冒充该部分 R14。

### 4.8 页面功能点承接

“对应需求编号”严格沿用 requirement 各功能点原始编号；第三阶段额外需要的 R11/R31 页签反馈与无障碍子集写在“状态与异常处理”，不改写 7.1.6、7.1.7 或 7.2.3 的原编号。

| 页面功能点 | 对应需求编号 | 需求交互要点 | 技术实现 | 涉及组件/模块 | 数据/API | 状态与异常处理 | 对应任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7.1.1 打开工作区与文件导航 | R1、R2 | 左栏点击文件打开/聚焦页签；CRUD 影响全部相关页签 | 文件入口统一调用 `openOrFocus`；T39 计算路径影响，T40 结算后磁盘先行提交 | `WorkspaceTree`、`WorkspaceTabManager`、`workspacePath` | 既有 scan/watch/CRUD、tab manager | 保留原 loading/error/missing/readonly；磁盘失败不改页签；页签反馈承接 R11/R31 子集 | T37、T39～T40、T44～T45 |
| 7.1.2 编辑、源码与保存 | R3、R5、R6、R10、R11、R30、R31 | 中央区只挂载活动页签 editor；非活动 session/history/save 独立保留 | 每页签 `DocumentSession + DocumentSaveController`，活动 adapter 单挂载 | `DocumentEditorShell`、tab manager、recovery/assets | read/safe-write/recovery/conflict/save-copy/assets | 每页签独立 dirty/saving/save_failed/conflict/readonly；切换拒绝陈旧结果 | T35、T37、T40、T44～T45 |
| 7.1.3 自适应布局和区域调宽 | R8、R11、R30、R31 | 本阶段只加入页签层并回归现有窄窗，不实现分隔条与布局偏好 | 复用现有 P1 网格；页签自身横向滚动，完整 R8 留阶段 4 | `WorkspaceWorkbench`、`WorkspaceTabBar` | 无新布局配置/API | 820/760 px 无根滚动；只做 R11/R31 页签子集回归，不宣称该功能点完成 | T38、T45 |
| 7.1.4 大纲、专注与分页阅读 | R4、R7、R9、R30～R32 | 本阶段不实现大纲、专注或阅读 | 保持入口隐藏/禁用；不创建阅读页签状态 | 现有菜单/P1 | 无新增 API | 无假反馈；页签只保留已实现 visual/source 投影 | - |
| 7.1.5 全文搜索 | R12、R30 | 工作区搜索继续禁用；页签溢出列表不冒充搜索 | 无索引或结果组件 | 现有菜单 | 无新增索引/API | 无假结果或成功状态 | - |
| 7.1.6 多文档页签 | R5、R13、R30 | P1 页签条、关闭、拖动、溢出、批量关闭和最近关闭 | tab reducer/manager、窗口会话 repository、两阶段 settlement | `WorkspaceTabBar`、`TabOverflowMenu`、`TabContextMenu`、`TabSettlementDialog` | tab session commands、safe-write/recovery/save-copy | 全状态、同名消歧、取消零部分关闭、恢复失败；另承接 R31 tablist/menu/dialog 无障碍子集 | T35～T46 |
| 7.1.7 打开其他目录与多窗口 | R1、R5、R14、R30 | 当前/新窗口/取消、记住选择、同目录聚焦、全页签检查 | preference + collection settlement 接入既有 Rust window coordinator | `WorkspaceOpenPreferenceDialog`、P1/P2、原生菜单 | preference commands、coordinate/resolve settlement、`windowStateRef` | 重复目录聚焦、结算阻断、偏好重置；另承接 R31 焦点/弹层子集 | T36、T40～T46 |
| 7.2.1 打开文件夹或 Markdown 文件 | R1、R14 | P2 主入口按偏好决定询问/当前/新窗口 | 复用原生选择、授权和 coordinate open；current 仍先结算 | `WorkspaceLauncher`、偏好弹层 | selection、preference、coordinate open | 选择取消零副作用；同目录聚焦；偏好不能绕过权限或结算 | T41、T44～T45 |
| 7.2.2 最近工作区与失效记录 | R1、R14 | 最近项打开；设置按钮变为真实打开偏好入口 | launcher snapshot 增加非敏感 session 摘要；复用最近记录验证 | `WorkspaceLauncher`、`WorkspaceOpenPreferenceDialog` | launcher snapshot、preferences、remove recent/session | missing/permission-denied；移除只删元数据并写明不删本地文件 | T41～T45 |
| 7.2.3 窗口会话恢复 | R14 | P2 显示页签数量并逐窗口恢复 | 根窗口恢复后按 `windowStateRef` 建立 lazy tab descriptors；成功进入 P1 时联动 R13 | P2 恢复列表、tab manager、`AsyncStatePanel` | window session manifest/session、root state、recovery | 单窗口/单页签失败隔离，可重试/跳过/移除；未授权只显示摘要 | T36、T42、T44～T46 |
| 7.3.1 选择、新建与复制预设 | R15 | P3 不进入本阶段 | 不注册页面或状态 | 无 | 无 | 跳过 | - |
| 7.3.2 令牌编辑与双调色板校验 | R15 | P3 不进入本阶段 | 不注册页面或状态 | 无 | 无 | 跳过 | - |
| 7.3.3 实时预览、取消回退与保存 | R15 | P3 不进入本阶段 | 不注册页面或状态 | 无 | 无 | 跳过 | - |

### 4.9 组件复用与 DESIGN 闭环

- 复用 `AppDialog` 构建全页签结算与打开偏好设置，不创建第二套 modal/focus trap。
- 复用 `AsyncStatePanel` 表达会话恢复、页签加载和持久化错误；轻量菜单状态不得伪装为 toast 成功。
- 页签状态使用文字、图标/形状和 tooltip，不能只靠颜色点；颜色全部消费语义 token。
- `WorkspaceTabBar`、`TabOverflowMenu`、`TabContextMenu`、`TabSettlementDialog`、`WorkspaceOpenPreferenceDialog` 和 `WorkspaceTabManager` 形成稳定职责后登记到 `DESIGN.md`。
- tablist 使用 roving tabindex；活动 tab 为 `aria-selected=true`，关闭按钮有包含文件名的可访问名称；菜单支持方向键、Home/End、Esc 和关闭后焦点恢复。
- 系统减少动态效果时取消拖动/切换的非必要过渡。
- 新增页面/弹层实现前与完成后执行 `page-development-workflow.md`；真实页面状态必须在 Tauri 窗口验证，jsdom 不替代桌面视觉。

组件资产闭环：

| 页面/区域 | 运行时复用组件 | 布局或配置组件种类 | 组件配置字段/页面注册 | 设计规范或组件清单更新 | 真实消费与验证 | 对应任务 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 页签层 | 新增 `WorkspaceTabBar`，复用全局按钮、token 与 roving tabindex 模式 | 新增稳定页签栏；复用 P1 固定顶部区域 | 不新增页面路由；输入为 ordered tabs、activeTabId、状态与动作回调 | 实施后登记 `WorkspaceTabBar` 的职责、消费者和状态契约 | P1 真实消费；组件、四档视口与 Tauri E2E 验证 | T38、T45～T46 |
| P1 页签溢出 | 新增 `TabOverflowMenu`，复用 `focusContainment` 的可聚焦元素规则和现有按钮样式 | 新增可访问菜单，不新增抽屉/页面 | 输入为全部页签、最近关闭、可用动作和触发器引用 | 实施后登记菜单焦点、Esc 和返回契约 | P1 大量页签真实消费；50 项、键盘与焦点测试 | T38、T43～T45 |
| P1 页签上下文动作 | 新增 `TabContextMenu`，复用与溢出菜单相同的菜单基元，不另写第二套键盘逻辑 | 与溢出菜单共用菜单种类 | 输入为目标 tabId、左右位置和启用态；不注册页面 | DESIGN 只登记一个共享页签菜单基元及两个消费者 | 页签右键/键盘菜单真实消费；关闭/排序动作测试 | T38～T40、T43 |
| P1 全页签结算 | 新增 `TabSettlementDialog`，复用 `AppDialog`、`AsyncStatePanel`、`ContentSafetySummary`、既有 Conflict/SaveCopy 能力 | 新增安全关键批量结算 dialog | 输入为 reason、目标快照、逐项主状态、内容安全与动作；P1 注册单实例 | 实施前先补布局证据；实施后登记稳定安全职责和动作契约 | 关闭、替换、退出与文件变更真实消费；故障注入和桌面 E2E | T40～T41、T45～T46 |
| P1/P2 工作区打开方式 | 新增 `WorkspaceOpenPreferenceDialog`，复用 `AppDialog` 和全局按钮 | 新增单一偏好 dialog，不扩张成通用设置页 | `workspaceOpenDisposition` 默认/保存/读取/消费/重置；P2 按钮和原生设置菜单注册 | 实施后登记配置字段、双入口和回退职责 | P1/P2/menu 真实消费；三值、重置、损坏回退测试 | T41、T43～T45 |
| P1/P2 页签会话能力 | 新增 `WorkspaceTabManager`，复用 `DocumentSession`、`DocumentSaveController`、recovery/assets gateway | 新增非视觉运行时状态能力 | 不注册页面；通过 manager provider/props 供 P1，P2 恢复后创建 | DESIGN 运行时复用清单登记稳定职责；架构文档记录数据边界 | P1 活动会话、P2 恢复真实消费；manager、集成和 E2E | T35、T37、T42、T44～T46 |

## 5. 需求与开发内容映射和开发状态

| 范围类别 | 需求编号 | 需求内容/来源 | 计划开发内容 | 对应任务 | 状态 | 偏差判断 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 必须实现 | R1 | Windows/macOS 本地优先桌面应用 | 在既有桌面壳内接入多页签、窗口会话和双平台回归 | T41～T46 | 待开始 | 部分覆盖 | 不重做安装/授权；完整产品仍需后续阶段 |
| 必须实现 | R2 | 文件与目录管理 | 文件树入口、CRUD 与全部相关页签联动 | T37、T39～T40、T44～T45 | 进行中 | 部分覆盖 | T37 已让文件树打开/聚焦真实 runtime；全体路径重映射与删除联动仍待 T39～T40 |
| 必须实现 | R3 | 所见即所得 Markdown 编辑 | 每页签独立消费既有 DocumentSession/editor | T35、T37、T39、T44～T45 | 进行中 | 部分覆盖 | T37 已完成 P1 每页签独立 session/history 与活动 editor 单挂载；页签 UI 与阶段验收未完成 |
| 必须实现 | R4 | 当前文档大纲 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 6 实现；活动页签只预留单一来源 |
| 必须实现 | R5 | 自动保存、恢复和冲突 | 把单文档保护扩展为关闭、替换、退出的全页签结算 | T37、T40～T46 | 进行中 | 部分覆盖 | T37 已建立独立 controller、后台保存/快照和窗口意图全 runtime 结算；混合阻塞决策仍待 T40 |
| 必须实现 | R6 | 图片粘贴、拖放与资源管理 | 多页签路径/图片链接随文件树操作一致变更 | T37、T39～T40、T44～T45 | 进行中 | 部分覆盖 | 活动页签图片链路已由 runtime 保持；全体打开文档路径/图片改写仍待 T39～T40 |
| 必须实现 | R7 | 中性主题与颜色语义 | 只消费既有 token | - | 跳过 | 未覆盖 | 完整主题/令牌能力属阶段 4/5 |
| 必须实现 | R8 | 自适应与区域调宽 | 仅回归页签层与现有窄窗 | - | 跳过 | 未覆盖 | 分隔条、宽度和窗口布局持久化属阶段 4 |
| 必须实现 | R9 | 编辑/专注/分页阅读 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 6 实现，不创建假阅读态 |
| 必须实现 | R10 | Markdown 源码模式 | 每页签独立保留 visual/source 模式、选择与锚点 | T35、T37、T42、T44～T45 | 进行中 | 部分覆盖 | T37 已验证真实文件切换保留独立模式/选择/锚点；重启恢复仍待 T42 |
| 必须实现 | R11 | 操作与文件状态反馈 | 实现页签、结算、恢复和持久化新增状态 | T38～T46 | 待开始 | 部分覆盖 | 仅页签相关子集；完整验收仍属阶段 4 |
| 必须实现 | R12 | 工作区全文搜索 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 7 实现；页签列表不冒充搜索 |
| 必须实现 | R13 | 多文档页签与最近关闭文档 | 完整实现真实页签、排序、批量关闭、最近关闭和会话恢复 | T35～T46 | 进行中 | 一致 | T35～T37 已完成模型、仓储、路径身份和 P1 真实 runtime/单 adapter 门禁；可见页签、批量动作、持久恢复和阶段验收仍待后续任务 |
| 必须实现 | R14 | 一目录一窗口与多窗口生命周期 | 页签会话、偏好、全页签替换保护和独立窗口恢复 | T36、T40～T46 | 进行中 | 部分覆盖 | T36 已完成根会话引用和元数据仓储；窗口位置/尺寸/三栏布局仍属阶段 4 |
| 必须实现 | R15 | 颜色主题预设与实时预览 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 5 实现，P3 不注册 |
| 必须实现 | R30 | 核心命令键盘操作 | 页签切换/关闭/重开、关闭窗口与弹层焦点子集 | T38、T40～T46 | 待开始 | 部分覆盖 | 搜索、阅读、布局快捷键留对应阶段 |
| 必须实现 | R31 | 无障碍基础 | tablist/menu/dialog 的语义、焦点、非颜色状态与减少动态效果 | T38、T40、T43～T46 | 待开始 | 部分覆盖 | 完整桌面无障碍矩阵仍属阶段 4 |
| 必须实现 | R32 | 长文阅读排版 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 4 定稿 |
| 可选增强 | R16 | 导出 HTML/PDF | 暂不纳入 | - | 跳过 | 未覆盖 | 等阅读渲染与主题稳定 |
| 可选增强 | R17 | 本地历史版本与 Git 集成 | 暂不纳入 | - | 跳过 | 未覆盖 | 页签恢复不扩张成历史版本 |
| 暂不实现 | R18 | 双向链接知识图谱 | 不开发 | - | 跳过 | 未覆盖 | 保持首版产品边界 |
| 暂不实现 | R19 | 云同步 | 不开发 | - | 跳过 | 未覆盖 | 会话只保存在本机 |
| 暂不实现 | R20 | 多人实时协作 | 不开发 | - | 跳过 | 未覆盖 | 不引入账号或协作协议 |
| 暂不实现 | R21 | 插件市场 | 不开发 | - | 跳过 | 未覆盖 | 不开放用户插件执行 |
| 暂不实现 | R22 | 手机端 | 不开发 | - | 跳过 | 未覆盖 | 目标仍为 Windows/macOS |
| 暂不实现 | R23 | 任意文字任意颜色 | 不开发 | - | 跳过 | 未覆盖 | 不向 Markdown 写私有颜色 |
| 可选增强 | R24 | 固定/预览页签组合追溯项 | 只保留追溯 | - | 跳过 | 未覆盖 | 子项为 R33/R34，本编号不直接验收 |
| 可选增强 | R25 | 跨窗口拖拽页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 本阶段拖动仅限当前窗口排序 |
| 可选增强 | R26 | Plainroot 预设本地导入导出 | 暂不纳入 | - | 跳过 | 未覆盖 | 等 R15 预设格式稳定 |
| 暂不实现 | R27 | 同一窗口附加多个根目录 | 不开发 | - | 跳过 | 未覆盖 | 保持一目录一窗口 |
| 暂不实现 | R28 | 同一目录多个可写窗口 | 不开发 | - | 跳过 | 未覆盖 | 保持聚焦已有窗口 |
| 暂不实现 | R29 | Obsidian 主题源码兼容层 | 不开发 | - | 跳过 | 未覆盖 | 与页签生命周期无关 |
| 可选增强 | R33 | 固定页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 等基础页签状态机稳定 |
| 可选增强 | R34 | 预览页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 不引入隐式替换语义 |

## 6. 详细实施步骤与进度追踪

### 6.1 任务 T35：页签状态机、契约与轻量模型门禁

- 状态：已完成。
- 依赖：第二阶段 T18～T34。
- 涉及文件/模块：`src/features/tabs/tabPath.ts`、`tabTypes.ts`、`tabReducer.ts`、`src/components/asyncState.ts`、测试、计划留痕。
- 目标：先固定页签身份、状态、动作、结算原因和恢复 DTO，证明轻量集合不会产生第二份正文；真实 editor adapter 单挂载与进程内存门禁由 T37 在可观察 runtime manager 上完成。
- 操作：定义 discriminated unions、Rust 规范化相对路径与不透明平台路径身份、单调不可复用 incarnation、双向集合不变量、最近关闭和恢复描述；把 `loadState + saveState` 主状态投影绑定到 DESIGN 公共优先级与 assertive/polite 播报契约；建立 20/100 个轻量 descriptor/runtime 引用、恢复 DTO 容量和纯 reducer 延迟门禁。基准脚本只输出本机样本，不作为可失败门禁或真实 adapter/heap 证据。
- 产出：可测试的纯状态机、受控路径身份契约、轻量模型门禁、报告型性能样本和 `t35-tab-state-model.md`。
- 影响范围：仅模型/测试，不修改磁盘、菜单、权限或可见页面。
- 边界与异常：不得把 Markdown/history 复制到 tab DTO；不得为通过门禁设置产品级页签数量上限；T35 不宣称验证真实 adapter 生命周期、heap/RSS 或大文档多 session；性能结论只报告实测平台。
- 验证方式：Vitest 覆盖平台路径别名、非法/未规范化路径、顺序、活动项、关闭/恢复、generation+incarnation 陈旧结果、双向不变量、unloaded/empty 分离和轻量活动 runtime 投影；类型检查、生产构建、许可证扫描。
- 完成标准：身份、状态、不变量与序列化边界可执行，轻量模型可失败门禁通过；T38 前置由 T37 的真实 adapter 单挂载和当前平台可取得的可失败内存门禁闭合。macOS WebKit 未暴露 JS heap 时只以 DOM 单挂载与 RSS 门禁作为本阶段证据，JS heap 明确记为不可用并由 T45 在可观测平台继续补证，不得伪报通过。
- 实际落地情况：已新增 `src/features/tabs/tabPath.ts`、`tabTypes.ts` 与 `tabReducer.ts`，固化窗口内稳定 `tabId`、集合单调分配的 incarnation、Rust 规范化相对路径与不透明平台路径身份、派生文件名/父路径、`idle/loading/ready/error/missing/permission_denied` 加载状态、视图恢复描述、10 种结算原因和最近关闭 50 项边界。纯 reducer 使用有序 ID、平台身份索引、活动项、revision/persistedRevision 表达唯一打开、聚焦、排序、关闭相邻项接替、重新打开、generation/incarnation 双重陈旧拒绝和持久化待提交状态；不变量双向校验 map key、descriptor、order、path index、active、incarnation 与最近关闭。
  - 页签 DTO 只保存轻量描述；`DocumentSession` 与 `DocumentSaveController` 位于独立 runtime map，runtime 必须匹配当前 incarnation，活动 editor adapter 不进入集合或恢复 DTO。活动 selector 与 `projectWorkspaceTabStatus` 都独立拒绝旧 incarnation；最近关闭项也校验规范化路径、identity、派生文件名和父路径。
  - 复用审查确认 `AsyncStatePanel` 已是公共状态优先级事实源，因此把其纯契约提取到 `src/components/asyncState.ts`，现有面板和页签投影共同消费同一 `resolveAsyncState`/presentation，不复制私有优先级。页签状态把 load/session/save/recovery/content-safety 组合后严格遵循 DESIGN 的主状态和 assertive/polite 契约。
  - 页签专项 24/24 覆盖路径分隔符/点段/绝对路径拒绝、Windows 大小写别名身份、同一路径唯一打开、顺序、活动项、关闭/恢复、tabId 复用 ABA、generation、revision、打开项/最近关闭损坏矩阵、unloaded/empty 分离、状态优先级、恢复序列化边界和 incarnation selector/status 投影；统一 `pnpm test` 为 Vitest 200/200、Rust 180 通过且 1 项手动探针忽略、Node 独立回归 30/30。
  - 单元门禁要求 100 项恢复描述小于 64 KiB、不含 `markdown`、`history` 或 `saveController`，且固定 fixture 的轻量集合操作在本机阈值内完成。`pnpm test:tabs:performance` 仅为本机报告型样本，不会因均值漂移失败，不能作为 adapter 或内存门禁。
  - 未修改 Rust、磁盘、配置、菜单、权限、SQL/seed、环境变量或可见页面；未执行桌面 E2E，原因是 T35 尚无生产页面/IPC 消费者。证据见 `t35-tab-state-model.md`。

### 6.2 任务 T36：版本化窗口页签会话仓储与 Rust/TS 契约

- 状态：已完成。
- 依赖：T35。
- 涉及文件/模块：`src-tauri/src/window_session.rs`、`commands/window_session.rs`、`state.rs`、`window.rs`、`lib.rs`、`error.rs`、`src/services/desktop/contracts.ts`、服务与 parity 测试。
- 目标：建立内容无关、原子、有界、按工作区隔离的窗口页签会话仓储，并真实消费 `windowStateRef`。
- 操作：实现 manifest/session schema、CAS revision、原子读写、损坏备份、未知版本保护、孤儿清理、摘要读取和授权命令；新增 Rust→TypeScript 的规范化相对路径/不透明平台 path identity 契约并纳入 parity，恢复或打开路径都必须由 Rust 解析后返回该契约；根会话创建/更新时写入 ref；移除最近记录时只清理元数据。
- 产出：repository、命令、稳定错误码、Rust↔TS 契约、测试和 `t36-window-session-store.md`。
- 影响范围：应用数据目录和根会话引用；不修改 Markdown、恢复快照或数据库。
- 边界与异常：命令必须校验当前窗口↔workspace 绑定；P2 未授权时只能读取非敏感摘要；写失败保留旧文件并返回可观察错误；未知版本不覆盖。
- 验证方式：临时 app data 下的原子故障、CAS、损坏/未知版本、容量、并发、跨工作区、移除记录和 parity 测试；Rust fmt/Clippy/all-features。
- 完成标准：会话元数据可安全保存/读取/删除，正文不出现在 JSON，`windowStateRef` 不再是悬空字段；T37 不需要从前端路径文本自行推导 path identity。
- 实际落地情况：已新增 `src-tauri/src/window_session.rs` 与 `commands/window_session.rs`，在 `appDataDir()/plainroot-window-sessions-v1/` 建立 1 MiB manifest、1 MiB 单会话、1000 工作区和最近关闭 50 项边界。manifest 保存 workspace→opaque ref、revision、页签数和更新时间；session 只保存工作区相对路径、模式、选择/锚点、顺序、活动路径与最近关闭，不包含 Markdown、history、恢复正文、绝对路径、窗口像素或布局。
  - 写入使用私有同目录临时文件、`sync_all`、平台原子替换和父目录尽力同步；session 与 manifest 两次提交之间若进程内 manifest 写失败，会恢复旧 session 字节或移除未提交新文件；若进程在中间终止，重启仅对同 workspace/ref 且恰好领先一个 revision 的已校验 session 前滚 manifest，避免误判损坏。CAS revision 拒绝陈旧写，容量超限不截断运行时页签。
  - manifest 损坏先备份，再从文件名与内容均校验通过的 v1 session 重建；单 session 损坏只备份隔离该文件，未知 manifest/session schema 原文件不覆盖。启动孤儿清理只删除命名匹配且明确为 v1 的普通文件，不跟随 symlink，也不删除未来版本文件。
  - 新增 `resolve/get/save/remove` 四个 IPC。完整路径元数据必须同时通过当前窗口↔workspace 绑定和授权注册校验；P2 launcher 只获得 workspace、opaque ref、revision、页签数、更新时间和 issue，不暴露文件名。Rust 对打开/恢复路径重新解析授权根并返回 `workspace-path-v1-<sha256>` 不透明身份；失效项及解析后 identity 重复项进入 issues，不阻断同会话其他路径。
  - 根工作区成功绑定前先确保仓储引用，`WorkspaceSessionRoot.windowStateRef` 不再固定为 `null`；启动时也为既有根会话补齐真实引用。显式关闭/移除根恢复仍保留最后页签会话；移除最近记录每次都重试页签元数据清理，因此跨仓储部分失败后再次调用仍可收口，不修改 `.md` 或恢复快照。
  - Rust↔TypeScript 新增 editor mode、selection/anchor、snapshot/session/summary/path identity DTO 和 8 个稳定错误码，interface、枚举/tag 及 selection/anchor 联合类型内层字段均进入 parity 守卫；前端新增薄 `windowSession.ts` gateway，T37 无需自行 lower-case 或推导平台路径身份。
  - 专项测试覆盖 revision 0 空会话、CAS 并发单提交、跨工作区 ref、窗口未绑定拒绝、原子 session/manifest 故障回滚、崩溃中间态重启前滚、损坏/未知版本、manifest 重建、容量、孤儿清理、移除部分失败重试、移除不碰 Markdown、路径哈希不泄绝对根、解析后 identity 去重和单项失效隔离。统一门禁为 Vitest 200/200、Rust 200 通过且 1 项既有手动探针忽略、Node 30/30；类型、构建、fmt、全 feature Clippy 与许可证 727/508/0 通过。未执行桌面 E2E，因为 T36 没有 P1/P2 可见交互消费者；远端双平台证据仍只覆盖第二阶段。证据见 `t36-window-session-store.md`。

### 6.3 任务 T37：每页签 DocumentSession/SaveController 管理器

- 状态：已完成。
- 依赖：T35、T36。
- 涉及文件/模块：`WorkspaceTabManager.ts`、`tabSessionGateway.ts`、`WorkspaceWorkbench.tsx`、`DocumentSession`、`DocumentSaveController`、recovery/assets 集成与测试。
- 目标：把当前单一会话改为每页签独立会话，同时保持活动 editor、状态栏、标题和菜单只有一个来源。
- 操作：在 T36 已落地的 Rust 路径身份契约上，基于可注入的 `tabSessionGateway` 实现 open/focus/lazy-load/switch/destroy；gateway 只接收 Rust 返回的规范化路径与平台身份。为已加载页签创建独立保存控制器和恢复身份；切换前提交 adapter 状态；只挂载活动 adapter；inactive dirty 页签继续自动保存/快照。新增真实 Milkdown/CodeMirror adapter factory 计数测试缝和 WebView runtime 内存探针；T36 会话仓储与 manager 的完整恢复接线仍留到 T42。
- 产出：真实 manager、P1 活动页签投影、生命周期测试和 `t37-tab-session-manager.md`。
- 影响范围：P1 文档生命周期与内存；不改变 Rust 磁盘协议。
- 边界与异常：慢读取、慢 adapter、陈旧保存和陈旧恢复不得覆盖后来活动页签；manager 销毁必须结算/释放每个控制器；错误 tab 不阻断其他 tab。
- 验证方式：多 session history、模式/锚点、切换中输入、inactive autosave、恢复注册、StrictMode 生命周期；真实 adapter factory 断言任意时刻挂载数不超过 1、切换不重建 inactive session；固定 fixture 的真实 WebView 反复切换记录 heap/RSS，先校准再固化可失败阈值并归档平台证据。
- 完成标准：三个文档可在同一窗口保留独立内容/历史/模式并安全切换，单一文档替换实现被移除；真实单 adapter 生命周期与当前 macOS WebKit 可取得的可失败 RSS 门禁通过后允许开始 T38。JS heap 未暴露属于明确的平台观测缺口，由 T45 继续补证，不作为已通过项，也不阻塞 T38。
- 实际落地情况：已新增 `WorkspaceTabManager` 与薄 `tabSessionGateway`，P1 文件树打开 Markdown 时先消费 T36 Rust 返回的规范化相对路径和 opaque 平台身份，再创建或聚焦唯一 runtime。每个已加载页签独立持有 `DocumentSession`、统一 history、选择/锚点、模式和 `DocumentSaveController`；非活动 dirty 页签继续自动保存与恢复快照，慢读取通过 tabId/incarnation/generation 三重校验隔离，慢结果也不能回写活动窗口标题。
  - `DocumentEditorShell` 新增切换前真实投影提交句柄；P1 在激活其他 runtime 前提交当前 adapter Markdown、选择与锚点，只渲染活动 `tabId:incarnation` 对应的 editor。Milkdown/CodeMirror 包装层通过公共生命周期事件向 manager 报告真实创建/销毁，测试锁定两模式切换和三 session 反复激活时活动 adapter 峰值为 1。
  - `settleAll` 在遍历全部保存控制器前复用同一活动投影提交入口，使窗口结算和 manager 销毁也能保存最后的 selection/anchor；文件树只在 Rust 路径身份解析成功后提交 Markdown 选中项，解析失败时保留原选择和原活动文档。
  - P1 的中央内容、文件树选择、状态栏、标题和原生菜单继续只消费活动 runtime。冲突重载与恢复副本重新读取目标磁盘基线；恢复命中已有 dirty runtime 时先执行内容保护。窗口关闭/替换/退出 intent 已调用 manager 的全 runtime `settleAll`，但 T40 的混合阻塞列表、逐项决策和两阶段批量提交尚未实现。
  - 真实 macOS Tauri/WebKit E2E 新增三文档 session、36 次切换和单 adapter/进程 RSS 门禁；阈值为 RSS 增量不超过 128 MiB，WebKit 未提供 JS heap 时明确记为不可用而不伪造通过。E2E 测试命令通过仅在 `e2e` feature 启用的 `sysinfo` 命令读取当前测试进程 RSS，默认生产构建不注册该命令。
  - 当前本地非桌面门禁为 211/211 Vitest、200 个 Rust 通过且 1 项手动性能探针忽略、30/30 Node 独立回归，typecheck 与生产 build 通过；T37 主实现的 10/10 macOS 真桌面 E2E、Rust fmt、全 feature Clippy、锁定 e2e check 和许可证 727 Node / 511 Rust / 0 阻断证据继续有效，本次评审整改未重跑这些未受影响的门禁。第三阶段尚未推送，Windows/远端 CI、可见页签栏、会话重启恢复和完整批量结算均未验证或未实现。证据见 `t37-tab-session-manager.md`。

### 6.4 任务 T38：页签条、溢出菜单、上下文动作与无障碍

- 状态：待开始。
- 依赖：T35、T37。
- 涉及文件/模块：`WorkspaceTabBar.tsx/.css`、`TabOverflowMenu.tsx`、`TabContextMenu.tsx`、P1、tokens、`DESIGN.md`、组件测试。
- 目标：实现符合 P1/DESIGN 的真实 tablist，并在窄窗、同名和大量页签下保持可读可操作。
- 操作：实现活动态、保存状态、关闭按钮、同名父路径 tooltip、横向滚动、全部页签列表、拖动排序、键盘替代排序、roving tabindex、焦点恢复和减少动态效果。
- 产出：页签 UI、菜单、响应式样式、DESIGN 登记和 `t38-tab-bar.md`。
- 影响范围：P1 顶部区域；不新增根滚动或私有颜色。
- 边界与异常：状态不能只靠颜色，主状态与 `aria-live` 必须消费 T35 固化的 DESIGN 公共优先级；关闭按钮不得抢占 tab 聚焦语义；拖动取消不改顺序；溢出菜单关闭后回到触发器。
- 验证方式：组件测试、键盘遍历、同名/长路径、50 项溢出、拖动、820/760 px、对比度和 reduced-motion；真实浏览器仅作样式辅助，最终以 Tauri 为准。
- 完成标准：鼠标和纯键盘均可选择、关闭、排序和定位页签，页面无横向根溢出。
- 实际落地情况：待实施。

### 6.5 任务 T39：打开去重、最近关闭与路径影响分析

- 状态：待开始。
- 依赖：T37、T38。
- 涉及文件/模块：tab manager、`WorkspaceWorkbench.tsx`、`WorkspaceTree`、`workspacePath`、文件 CRUD、图片路径工具、测试。
- 目标：把所有文档入口统一到真实页签，并为文件/目录变化建立可测试的受影响页签集合与路径重映射原语。
- 操作：接入文件树和初始文件；实现同路径聚焦、最近关闭重开、拖动顺序持久化；实现重命名/移动/删除的受影响页签收集、路径映射和打开文档图片链接变换预案，但不在结算协调器完成前提交破坏性磁盘操作。
- 产出：完整打开链路、最近关闭 UI 数据、路径影响分析/重映射原语、回归测试和 `t39-tab-file-integration.md`。
- 影响范围：R2/R6 与 R13 交界；磁盘事实继续由 Rust 命令决定。
- 边界与异常：不存在的最近项不创建假文档；目录移动风险不虚构未打开引用；操作失败保持树与所有页签原状态。
- 验证方式：重复打开、同名文件、目录下多页签 rename/move/delete、图片链接、失败回滚、外部删除和 watch 回归。
- 完成标准：所有打开入口不再替换唯一文档；任意文件/目录操作都能在磁盘提交前准确得到受影响页签和提交后的路径变换，实际结算与磁盘接线由 T40 完成。
- 实际落地情况：待实施。

### 6.6 任务 T40：单页签/批量关闭与全页签结算

- 状态：待开始。
- 依赖：T37、T39。
- 涉及文件/模块：`TabSettlementDialog.tsx`、settlement coordinator、现有 Conflict/SaveCopy/Recovery 组件、P1、测试、DESIGN。
- 目标：为关闭当前/其他/右侧/全部、文件树变更以及窗口级意图提供同一内容安全结算。
- 操作：先按 4.5.1 新增 `prototypes/tab-settlement-dialog.html` 并完成页面流程/布局复核，未通过前不写生产 dialog；随后实现不可变目标快照、逐项状态、重试保存、另存、放弃、保持打开和最终一次性提交；复用安全写/冲突令牌；成功后再释放 recovery；把 T39 的受影响集合接入 rename/move/delete，磁盘成功后才批量提交路径、图片链接和页签移除。
- 产出：补充安全弹层原型、统一结算协调器、批量弹层、文件树多页签提交链路、动作菜单、测试和 `t40-tab-settlement.md`。
- 影响范围：页签集合、恢复快照生命周期和关闭 UX；不新增磁盘写通道。
- 边界与异常：取消不能部分关闭；保存成功后后续取消不回滚磁盘；令牌/修订变化必须回到可重试阻塞态；弹层动词写明结果。
- 验证方式：dirty/saving/save_failed/readonly/conflict 混合集合、保存中继续编辑、另存、取消、重复动作、焦点与故障注入。
- 完成标准：补充原型已覆盖 4.5.1 的混合状态、明确动词、滚动和焦点契约并通过页面流程复核；任意关闭或文件变更批次都不会静默丢内容；磁盘失败不改变页签集合，所有阻塞状态有真实下一步。
- 实际落地情况：待实施。

### 6.7 任务 T41：窗口替换、关闭/退出协调与打开偏好

- 状态：待开始。
- 依赖：T36、T40。
- 涉及文件/模块：`WorkspaceWorkbench`、`WorkspaceLauncher`、`WorkspaceOpenPreferenceDialog`、`preferences.rs`、`window.rs`、`menu.rs`、gateway/contracts、测试。
- 目标：完成 R14 的全页签替换保护和可回退打开偏好，并保持现有窗口事务纪律。
- 操作：扩展偏好字段/命令；激活 P2 设置入口和原生设置菜单；把 replace/close/quit settlement 从单 controller 改为 tab collection；持久化旧会话后才允许 Rust 提交；保持新窗口/同目录聚焦路径。
- 产出：设置闭环、窗口协调集成、菜单、测试和 `t41-window-lifecycle.md`。
- 影响范围：全局非正文偏好、窗口打开/关闭/退出流程；不实现位置/尺寸/布局。
- 边界与异常：偏好 current 不能绕过结算；偏好损坏回退 ask；退出任一窗口取消则全局退出取消；提交后错误不得虚报已回滚。
- 验证方式：三种偏好、设置重置、同目录、两窗口、替换失败、关闭取消、应用退出和 Rust 协调器注入测试。
- 完成标准：当前窗口替换由全部页签决定；偏好有定义/保存/读取/消费/校验/重置完整链路。
- 实际落地情况：待实施。

### 6.8 任务 T42：P1/P2 页签会话恢复与失败隔离

- 状态：待开始。
- 依赖：T36、T37、T41。
- 涉及文件/模块：P1、P2、launcher/workbench gateway、window session services、recovery 集成、组件测试。
- 目标：应用重启、工作区重开和窗口逐项恢复时恢复真实页签、活动项与视图元数据。
- 操作：P2 摘要显示 tab count；授权成功后读取 session；建立 lazy tab descriptors；逐项校验路径/权限；首次激活加载磁盘并比较恢复快照；写回成功恢复/失败状态。
- 产出：P1/P2 恢复链路、失败项 UI、测试和 `t42-tab-session-restore.md`。
- 影响范围：启动恢复和重新打开工作区；不自动写回任何 `.md`。
- 边界与异常：缺失/无权限/损坏单项不阻断其他项；活动项失败时选择下一个可用项；未知 schema 只读阻断会话恢复但仍允许手动打开目录。
- 验证方式：多窗口、多页签、active tab、模式/选择/锚点、missing、permission-denied、corrupt、recovery dirty 和跳过/重试测试。
- 完成标准：根恢复不再代替页签恢复，失败不会修改磁盘或阻塞安全窗口。
- 实际落地情况：待实施。

### 6.9 任务 T43：原生页签菜单、快捷键与焦点路由

- 状态：待开始。
- 依赖：T38、T40～T42。
- 涉及文件/模块：`src-tauri/src/menu.rs`、前端菜单服务、tab manager、P1/P2、parity/组件测试。
- 目标：让聚焦窗口的真实页签状态驱动原生命令，不建立第二套快捷键路径。
- 操作：增加关闭当前 `Cmd/Ctrl+W`、重新打开最近关闭 `Cmd/Ctrl+Shift+T`、下一/上一页签、关闭其他/右侧/全部和页签列表菜单；保留关闭窗口 `Cmd/Ctrl+Shift+W`；扩展每窗口 menu state。
- 产出：原生菜单/事件、状态 parity、焦点恢复测试和 `t43-tab-menu-keyboard.md`。
- 影响范围：原生菜单和 P1 命令；P2 无页签时相关项禁用。
- 边界与异常：菜单启用必须与当前窗口一致；无 consumer 时禁用；平台冲突时优先系统惯例；React 不绑定同一全局 accelerator。
- 验证方式：Rust 菜单策略、TS action parity、两窗口聚焦、纯键盘 tablist/menu/dialog 流程和 macOS/Windows E2E。
- 完成标准：不依赖鼠标可切换、关闭、重开页签并关闭窗口，结果与鼠标路径一致。
- 实际落地情况：待实施。

### 6.10 任务 T44：契约 parity、单元与服务集成门禁

- 状态：待开始。
- 依赖：T35～T43。
- 涉及文件/模块：Rust/TS contract tests、tab/repository/window/menu tests、`package.json` scripts、fixtures、CI 前置门禁。
- 目标：把所有页签状态、仓储 schema、命令 DTO、菜单动作和失败路径纳入可重复的非桌面门禁。
- 操作：补 union/tag/enum/字段 parity；构建临时 workspace/app data 集成测试；将 tab/window-session 测试加入 `pnpm test` 或明确必跑脚本；跑既有全量回归。
- 产出：统一测试命令、契约守卫、故障注入矩阵和 `t44-tab-contract-tests.md`。
- 影响范围：测试和脚本；不降低现有门禁。
- 边界与异常：不得仅比较顶层字段名而漏掉 tagged union 值；测试只用临时目录/fixture；并发测试不能共享状态根。
- 验证方式：Node、Vitest、Rust all-features/no-default-features、fmt、Clippy、typecheck、build、licenses。
- 完成标准：新 checkout 可一条统一命令复现所有非桌面状态与服务门禁，T37 当前 200 Rust/209 Vitest/30 Node 基线不回退。
- 实际落地情况：待实施。

### 6.11 任务 T45：真实桌面 E2E、双平台 CI 与页面验收

- 状态：待开始。
- 依赖：T44。
- 涉及文件/模块：`tests/e2e/`、fixtures、WDIO、`.github/workflows/ci.yml`、P1/P2、页面验收留痕。
- 目标：用真实 Tauri IPC 在 macOS/Windows 验证页签、结算、窗口替换和恢复，而不是只依赖 jsdom/mock。
- 操作：扩展隔离 E2E；验证 1100/1050/820/760/740 px；运行多窗口、重启恢复、外部修改、保存失败可控夹具；推送后核验两个平台最新 HEAD。
- 产出：桌面套件、截图/日志、CI run/artifact 证据和 `t45-tab-desktop-e2e.md`。
- 影响范围：测试 flavor 与 CI；生产构建继续结构性排除 E2E 命令/fixture。
- 边界与异常：确定性业务流程不靠重试；macOS 结果不外推 Windows；原生系统菜单/辅助技术无法自动覆盖的项目明确列人工未验证。
- 验证方式：至少覆盖三页签独立编辑/撤销、duplicate focus、拖动/溢出、关闭阻塞/取消、最近关闭、当前窗口替换阻断、两窗口独立恢复和偏好重置；双平台生产构建。
- 完成标准：最新实现提交取得 macOS/Windows 双绿且 artifact 可追溯，所有未验证项如实登记。
- 实际落地情况：待实施。

### 6.12 任务 T46：整体复核、架构文档与阶段验收

- 状态：待开始。
- 依赖：T45。
- 涉及文件/模块：需求、计划、`architecture/tab-window-lifecycle.md`、既有架构、README、DESIGN、AGENTS/CLAUDE、开发留痕、Git 状态。
- 目标：对代码、业务闭环、页面、复用、DESIGN、权限、配置、菜单和文档做一次整体复核，并只按真实证据更新状态。
- 操作：逐项核对 R1～R34 与 T35～T46；生成专项架构与阶段验收；同步 requirement §12、计划实际落地、README 文档入口、DESIGN 组件登记和 AGENTS 稳定事实；不把阶段流水账写入长期规则。
- 产出：`architecture/tab-window-lifecycle.md`、`t46-stage-acceptance.md`、必要文档更新和复核报告。
- 影响范围：文档和验收状态；发现代码问题必须先修复并重跑相关门禁。
- 边界与异常：不得用计划状态代替运行证据；未完成人工平台项继续保留；阶段 3 完成不等于 R14 窗口布局或完整产品完成。
- 验证方式：需求映射脚本/人工交叉审查、全量本机门禁、最新双平台 CI、工作区干净度与提交范围核对。
- 完成标准：实现、测试、需求、计划和架构状态一致，无未解释任务编号、悬空配置或虚假完成声明。
- 实际落地情况：待实施。

## 7. 数据库、SQL、配置、菜单、权限与初始化计划

### 7.1 数据库、SQL 与 seed

本阶段不涉及数据库、SQL 或 seed，不创建 SQL 文件。页签和窗口会话是本机应用元数据，使用版本化 JSON；Markdown 与恢复正文仍是既有文件事实源。不得因最近关闭或页签检索提前引入 SQLite/FTS5。

### 7.2 配置与本地数据路径

| 路径/配置 | 定义/保存/读取/消费 | 执行时机 | 影响范围 | 校验与失败 | 回滚方式 |
| --- | --- | --- | --- | --- | --- |
| `appDataDir()/plainroot-window-sessions-v1/manifest-v1.json` | Rust repository 定义/原子保存；P1/P2/窗口协调消费 | setup、页签结构变化、窗口关闭/恢复 | 工作区→会话引用和摘要 | schema、1 MiB/1000 项、CAS、损坏备份、未知版本不覆盖 | 退出应用后可备份/删除；只失去页签恢复，不改 `.md` |
| `appDataDir()/plainroot-window-sessions-v1/sessions/*.json` | Rust 保存单工作区页签元数据 | 顺序/活动/视图防抖、关闭、退出 | 路径/模式/锚点/最近关闭 | opaque ref、1 MiB、相对路径、原子写、无正文 | 可删除恢复为空页签；不删除 Markdown/recovery |
| `appDataDir()/plainroot-state-v1.json` | 现有 state 保存根会话，第三阶段真实写 `windowStateRef` | 窗口绑定/替换/关闭/启动恢复 | 最近工作区和根窗口 | 保持 schema v1；ref 必须指向合法会话或 `null` | 沿用现有备份/删除回退 |
| `appDataDir()/plainroot-preferences-v1.json` | 扩展可选全局 `workspaceOpenDisposition`；P1/P2/menu 消费 | setup、设置保存/重置、打开目录 | 非正文打开偏好 | `ask/current_window/new_window`，缺失/非法回退 ask | 设置重置或退出后删除文件；资源目录仍按既有默认恢复 |
| `appDataDir()/plainroot-recovery-v1/` | 既有 recovery 保存脏正文 | inactive dirty、关闭/恢复 | 内容安全副本 | 继续按活动页签独立注册，不迁入 session JSON | 沿用第二阶段，不随会话清理误删 |
| `PLAINROOT_E2E_DATA_DIR` | 现有 e2e feature 专用状态根 | 仅测试 | 临时数据 | 生产编译移除，每套件独立 | 沿用，不新增生产环境变量 |

本阶段无账号、远程服务、API key 或业务环境变量。若实现新增长期配置，必须先在本节补定义者、保存者、读取者、消费者、校验、执行时机、影响和回滚。

### 7.3 菜单与快捷键

- 菜单继续集中在 `src-tauri/src/menu.rs`，按聚焦窗口 `EditorMenuState + TabMenuState` 决定启用。
- 新增/启用：
  - 关闭当前页签 `Cmd/Ctrl+W`；
  - 重新打开最近关闭 `Cmd/Ctrl+Shift+T`；
  - 下一/上一页签采用平台兼容的 `Ctrl+Tab` / `Ctrl+Shift+Tab`；
  - 关闭其他、关闭右侧、关闭全部、页签列表；
  - 设置/偏好入口，macOS 使用应用菜单，Windows 使用可发现的设置菜单。
- 保留关闭窗口 `Cmd/Ctrl+Shift+W`、新建窗口 `Cmd/Ctrl+Shift+N`。
- 无活动页签、无右侧页签、无最近关闭或 busy 时相应命令禁用；不得发空成功事件。
- 回滚：移除菜单项与 action parity，并同步恢复禁用；不能留下悬空 accelerator。

### 7.4 权限与 capability

- 正式 capability 继续保持 `core:default` 与明确窗口标签；页签 UI 不需要通用 filesystem 权限。
- 所有 session 命令在 Rust 侧校验调用窗口与 `workspaceId` 绑定；前端相对路径不能扩大授权根。
- P2 未授权状态只能读取工作区级会话摘要（数量、时间、状态），不能读取正文或任意绝对路径。
- 最近记录/页签会话删除只删除应用元数据；任何删除 `.md` 仍走既有文件命令和确认。
- 预期无需修改 capability 文件；若实现发现必须变更，T36/T41 先更新本节并说明精确命令、窗口范围和回滚，禁止 `$HOME/**/*`。

### 7.5 初始化、升级与回退

- setup 顺序：初始化 persistent state → window session repository → preferences/recovery → window coordinator；repository 失败不阻断手动打开 Markdown。
- 从第二阶段升级：`windowStateRef=null` 或仓储不存在时按空页签会话处理，不虚构恢复错误；首次有效结构变化才创建记录。
- 旧 preference 无打开偏好字段时默认 `ask`；旧二进制回退可能忽略/丢弃该可选字段，结果安全回到 ask，不影响资源目录和 Markdown。
- 新版本读取未知 session schema 时保留原文件并提示手动打开；旧版本不会读取新目录。
- 显式关闭窗口保留最后页签会话供工作区重开，但移除根自动恢复记录；P2 “移除记录”同步移除会话元数据并明确“不删除本地文件”。

## 8. 测试与验证计划

### 8.1 单元测试

- tab reducer：唯一路径、活动项、顺序、拖动、最近关闭、同名消歧、陈旧 action。
- manager：lazy load、每页签 session/controller、切换提交、history/mode/anchor、inactive autosave、销毁。
- settlement：所有保存状态、批量两阶段提交、取消、保存成功后取消、恢复释放顺序。
- preference：默认、保存、读取、重置、非法/损坏/未知版本。

### 8.2 Rust 仓储与接口测试

- manifest/session 原子故障、CAS、容量、并发、损坏、未知版本、孤儿、移除和回退。
- workspace/window 授权、跨工作区拒绝、P2 摘要脱敏、`windowStateRef` 事务。
- Rust↔TS 所有 struct/tag/enum/error/menu action parity，不只检查顶层字段。

### 8.3 页面与组件测试

- P1：默认、loading、empty、error、missing、permission-denied、dirty、saving、save_failed、readonly、conflict、closing。
- 页签：活动/非活动、同名、长路径、50 项溢出、拖动取消、上下文动作、最近关闭、焦点恢复。
- P2：恢复摘要、逐项恢复、设置偏好、失效目录、移除记录。
- 视口：1100、1050、820、760、740 px 和低高度；无根横向/纵向溢出。

### 8.4 组件资产闭环测试

- 验证 `WorkspaceTabBar`、共享页签菜单基元、`TabSettlementDialog`、`WorkspaceOpenPreferenceDialog` 与 `WorkspaceTabManager` 均被 4.9 表中的真实页面消费，不存在只登记未接线的资产。
- 验证 `TabSettlementDialog` 真实复用 `AppDialog`、`AsyncStatePanel`、`ContentSafetySummary` 和既有冲突/另存能力，没有页面私有焦点圈定或第二套错误面板。
- 验证打开偏好从配置字段、P2/原生菜单入口、保存/读取到 P1/P2/第二实例消费和重置完整闭环。
- 完成实现后同步 DESIGN 运行时组件清单、消费者和稳定职责；生产 CSS 扫描只消费语义 token。

### 8.5 集成与内容安全测试

- 三个文档独立编辑/撤销/模式/保存；inactive dirty 仍安全保存。
- 关闭当前/其他/右侧/全部与窗口/退出/替换使用同一结算。
- 多个打开文档受目录 rename/move/delete 影响时，路径、图片链接、recovery 身份与文件树一致。
- 外部修改/删除、只读、写失败、另存令牌过期、恢复快照损坏均不丢内容。

### 8.6 权限与数据范围测试

- 任意 workspaceId/windowLabel/path 注入、跨窗口 session 读取/删除、根权限撤销和 symlink。
- session JSON 扫描确认没有 Markdown 正文、history patch、canonical root 或用户绝对路径。
- capability 扫描确认无通用文件权限；测试数据只使用临时目录/fixtures。

### 8.7 回归测试

- 完整运行第二阶段 Node/Vitest/Rust/许可证/构建门禁。
- 保持 9 条现有 P1/P2 桌面 E2E，并增加页签用例；不得通过删除断言或全局重试换绿。
- 回归一目录一窗口、文件树 CRUD/watch、安全写、恢复、冲突、图片、菜单和四档编辑 chrome。
- R11/R31 只验证页签、菜单、结算和恢复新增子集；阶段 4 的完整状态、布局、焦点、对比度、长文和系统辅助技术矩阵继续标为未覆盖，不得在 T46 由本节外推为完成。

### 8.8 异常与性能测试

- 0 字节、5 MiB/64 MiB source-only 文档、多文档含大内容、100 个轻量恢复页签。
- 启动只加载活动页签重资源；inactive 恢复项不得同时创建 Milkdown/CodeMirror。
- session store 磁盘满、只读、强制失败、陈旧写、未知 schema。
- 应用强制终止后恢复、窗口恢复一项失败、系统休眠/文件系统卸载作为长时人工项登记。

### 8.9 桌面 E2E 与跨平台

- 真 Tauri IPC 打开至少 3 个文档，验证独立编辑/撤销、重复聚焦、拖动、溢出、关闭保护、最近关闭和重启恢复。
- 当前窗口替换遇到 blocked tab 必须停止；解决后替换；新窗口路径保留原窗口。
- 两个窗口独立 tab state/menu state，关闭一个不影响另一个。
- macOS/Windows runner 均跑非桌面门禁、桌面 E2E、未签名生产构建和 artifact。
- Windows 原生菜单、WebView2 焦点和辅助技术若自动化无法覆盖，单独登记人工未验证，不用 macOS 结果替代。

### 8.10 建议执行命令

```bash
source "${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
nvm use
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
pnpm test:licenses
pnpm licenses:check
pnpm tauri build --no-bundle
```

## 9. 发布、回滚与迁移

- 本阶段不修改 Markdown 文件格式，不需要内容 migration。
- 代码回滚不得自动删除 `plainroot-window-sessions-v1/`；旧版本忽略该目录，用户文件不受影响。
- preference 新字段回滚后安全退化为“每次询问”；不能残留 UI 选中但后端未消费的假设置。
- 如果 session repository 初始化失败，产品降级为可手动打开工作区、无页签恢复；当前运行时页签仍可编辑/保存。
- 如果菜单/快捷键回滚，必须同步移除前端事件消费者和启用态。
- 发布前确认生产产物不含 fixture/E2E 命令；远端双平台绿灯只代表自动化范围，原生人工项继续登记。

## 10. 风险、假设与待确认项

### 10.1 风险与缓解

| 风险 | 影响 | 缓解与验证 |
| --- | --- | --- |
| 多个已加载大文档使内存增长 | 切换卡顿或系统内存压力 | T37 已用真实 Tauri/WebKit 三 session、36 次切换锁定单 adapter 与 RSS 增量 ≤128 MiB；WebKit 本机未暴露 JS heap，且短时样本不替代 T45 双平台长时回归，不得据此静默丢 history |
| 每页签 controller 并发自动保存/快照 | I/O 峰值与恢复竞争 | 独立单飞、现有 mutation lock、节流与跨页签集成测试 |
| 批量结算中部分保存后取消 | 用户误解“取消”会回滚磁盘 | 弹层明确已保存结果；页签集合不部分关闭；测试锁定 |
| 会话元数据陈旧写覆盖新顺序 | 重启后页签恢复错乱 | 前端串行队列 + Rust CAS revision + 故障注入 |
| 目录操作影响多个打开文档 | 路径/recovery/图片链接漂移 | 操作前收集集合，磁盘成功后原子批量重映射 |
| 原生菜单与 React 快捷键双触发 | 重复关闭/打开弹层 | accelerator 只在 Rust；组件只处理局部 tablist 键盘 |
| 恢复大量页签拖慢启动 | 窗口白屏或全部解析 | 轻量描述恢复，首次激活才读盘/建 editor |
| Windows WebView2/菜单行为差异 | 快捷键、拖动、焦点回归 | T45 真实 windows-latest E2E；人工项不外推 |

### 10.2 事实假设

- 第二阶段 `DocumentSession`、安全写、恢复/冲突/另存和图片链路继续作为稳定底座，不在第三阶段重写。
- `workspaceId` 在同一规范化根下稳定，可用于查找最后窗口页签会话；Rust 仍以 canonical root 做最终一目录一窗口校验。
- 关闭窗口保存的是页签元数据，未保存正文仍由 recovery 仓储保护；重启后不恢复完整撤销栈。
- 最近关闭最大 50 项是可调整技术默认值，不改变“可重新打开最近关闭文档”的需求含义。
- 本阶段不新增数据库、远程服务、账号或生产环境变量。

### 10.3 待确认与阻塞判断

- 当前没有阻塞计划启动的问题。R13/R14 已明确真实页签、全页签结算、会话恢复、一目录一窗口和打开偏好回退语义。
- 已识别的主动待补布局证据：P1 原型未覆盖安全关键的多页签混合结算。T40 必须先按 4.5.1 生成并复核补充原型，原型门禁只阻塞 T40 的生产弹层编码，不阻塞 T35～T39 的模型、仓储、内存 manager 和页签条任务；若补原型暴露新的业务动作或关闭结果选择，立即升级为用户确认项。
- 窗口位置、尺寸、三栏布局精确持久化属于阶段 4；第三阶段只保存页签会话，不把该缺口伪装为 R14 全量完成。
- T37 真实单 adapter 与本机 RSS 门禁已通过，未触发产品裁剪确认；WebKit JS heap 未暴露、Windows 和长时压力仍由 T45 复核，不得把本机短时结果写成双平台容量承诺。
- 如果新增设置入口需要改变 P2 导航结构或引入通用设置窗口，先补交互确认；当前计划只实现单一“工作区打开方式”设置弹层和原生入口。
- 如果跨平台拖动无法在 WebView2/WebKit 一致实现，必须保留键盘/菜单排序并提交替代方案确认，不能静默取消 R13 的鼠标拖动要求。
