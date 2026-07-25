# Plainroot Markdown 文档编辑架构

## 1. 文档定位

本文描述 Plainroot 当前已经落地的单文档编辑模块，包括统一内容模型、排版/源码投影、保存与恢复、外部冲突、另存副本、图片资源、窗口结算和菜单状态；同时登记第三阶段 T35 已落地但尚未接入生产页面的纯页签集合模型。产品范围与验收口径以 `../requirement.md` 为准，第二阶段任务状态与证据以 `../stage-2-markdown-editing/plan.md` 和 `../stage-2-markdown-editing/t32-stage-acceptance.md` 为准，第三阶段当前进度见 `../stage-3-tab-window-lifecycle/plan.md`；代码、清单、配置和自动化测试是实现事实源。

`desktop-foundation.md` 负责工作区授权、文件系统、窗口和应用状态等跨模块底座概览；本文是 Markdown 文档编辑子系统的专项事实源。T35 只建立可测试的页签状态契约，不代表多页签容器已经可见或可持久化；大纲、工作区搜索、分页阅读、主题工作室和完整布局持久化也不属于本文所述的已完成能力。

## 2. 模块边界

```mermaid
flowchart LR
    P1["WorkspaceWorkbench"] --> ES["DocumentEditorShell"]
    ES --> DS["DocumentSession"]
    ES --> VA["MilkdownVisualAdapter"]
    ES --> SA["CodeMirrorSourceAdapter"]
    DS --> HC["DocumentHistory"]
    P1 --> SC["DocumentSaveController"]
    SC --> SG["EditorSaveGateway"]
    SC --> RG["EditorRecoveryGateway"]
    P1 --> RC["恢复 / 冲突 / 另存弹层"]
    P1 --> AC["图片与资源目录"]
    SG --> IPC["Tauri IPC"]
    RG --> IPC
    RC --> IPC
    AC --> IPC
    IPC --> SW["safe_write"]
    IPC --> RR["RecoveryRepository"]
    IPC --> EC["EditorSaveService"]
    IPC --> AR["AssetImportService"]
    IPC --> PR["PreferencesRepository"]
    SW --> MD["授权根内 Markdown"]
    EC --> COPY["原生选择的单个另存目标"]
    AR --> IMG["授权根内图片资源"]
```

- `WorkspaceWorkbench` 负责活动文件、文件树、watch、页面弹层、窗口结算意图和编辑器模块的组合，不持有第二份 Markdown。
- `DocumentSession` 是当前窗口活动文档的唯一前端内容、历史、选择、锚点、保存和内容安全状态。
- Milkdown 与 CodeMirror 只是 `DocumentSession` 的可替换投影，不直接写磁盘，也不各自维护跨模式权威历史。
- `DocumentSaveController` 是自动保存、手动保存、恢复快照和关闭结算的唯一前端调度器。
- Rust 命令与服务负责授权、路径、revision、原子写、恢复仓储、一次性令牌和图片签名等安全边界；前端只提交用户意图和受控标识。

## 3. 统一文档模型

### 3.1 会话状态

`src/features/editor/documentSession.ts` 定义以下稳定状态：

- 生命周期：`empty`、`loading`、`ready`、`unavailable`。
- 保存：`clean`、`dirty`、`saving`、`saved`、`save_failed`、`readonly`、`conflict`。
- 内容安全：磁盘、仅内存、恢复快照、明确风险。
- 恢复：无、可用、持久化中、失败。
- 投影：`visual` 或 `source`，并独立保存选择与语义/源码锚点。

`ReadyDocumentSession` 同时保存 `generation`、`editVersion`、Markdown、磁盘 `FileRevision`、已持久内容摘要、UTF-8 编码/换行基线、统一历史、兼容性证据和冲突证据。异步结果必须同时匹配文档身份、`generation` 和适用的 `editVersion`；陈旧读取、解析、保存、恢复或图片结果不能改写新会话。

### 3.2 单一内容源与历史

- 所有编辑事务先进入 `DocumentSession`，再由 React 投影回当前 adapter。
- 模式切换先同步当前 adapter 的 Markdown、选择与锚点，再销毁旧投影并创建新投影。
- Milkdown 与 CodeMirror 的撤销/重做均桥接 `documentHistory.ts`；adapter 内部历史不作为权威来源。
- 历史以可逆文本 patch 保存，默认预算 8 MiB、最多 500 项；预算只约束历史内存，不表示大文档编辑是常数时间。
- 当前 patch 生成、内容摘要和安全写仍包含 O(全文长度)工作。64 MiB 是文件服务边界，不是排版编辑性能承诺。

### 3.3 Markdown 兼容性

- Remark + GFM 负责生产兼容性证据，未知或不安全往返语法转为源码模式，不由排版序列化静默吞掉。
- mixed 换行文档默认进入源码模式；CodeMirror 的 LF 内部视图通过 raw projection 映射回原始 CRLF、CR 或 mixed 文本。
- 排版编辑在创建 Milkdown 前执行双门槛：Markdown 不超过 2 MiB，且非空内容行不超过 2000。超出门槛安全降级到源码，不改变文件服务 64 MiB 上限。
- 排版与源码 adapter 都必须单调推进本地 `editVersion`，拒绝同一 generation 的较低版本投影覆盖新输入。

### 3.4 页签集合模型

`src/features/tabs/` 已建立第三阶段的纯页签状态边界：

- `WorkspaceTabDescriptor` 只保存窗口内 `tabId`、不可复用的 incarnation、Rust 规范化工作区相对路径及不透明平台路径身份、派生显示信息、加载状态、视图恢复元数据和最后活动时间，不保存 Markdown、history 或保存控制器。前端不得自行 lower-case 或把反斜杠转换成索引身份。
- `DocumentSession` 与 `DocumentSaveController` 位于独立 runtime map；runtime 必须带与 descriptor 相同的 incarnation，集合只暴露一个匹配当前 incarnation 的活动页签投影，editor adapter 不进入页签 DTO 或恢复描述。
- reducer 使用有序 ID、平台路径身份索引、活动项、最近关闭、单调 incarnation 和 revision 表达唯一打开、聚焦、排序、关闭/恢复、陈旧 load generation/incarnation 拒绝和待持久化状态，并双向校验 map key、descriptor、顺序、路径索引、活动项和最近关闭集合。
- 页签主状态与 `AsyncStatePanel` 共同消费 `src/components/asyncState.ts`，遵循 DESIGN 的统一优先级与 assertive/polite 契约；尚未读取的惰性页签投影为 unloaded，不能误报为 empty。
- T35 的可失败门禁只证明轻量 descriptor/runtime 引用、恢复 DTO 容量和纯 reducer 延迟；真实 Milkdown/CodeMirror 单挂载、切换生命周期与进程 heap/RSS 门禁属于 T37，且必须在 T38 可见页签开发前通过。
- 当前 P1 仍消费单个 `DocumentSession`；页签 runtime manager、磁盘会话仓储、页签栏和全页签结算尚未接入，分别由 T36 以后任务承接。

## 4. 保存、恢复和冲突

### 4.1 自动与手动保存

`DocumentSaveController` 根据 UTF-8 字节数使用 800 ms、2 秒或 5 秒自动保存防抖；恢复快照通常为 2 秒，大正文为 10 秒。保存与快照分别单飞，保存中的后续编辑必须在当前写入结束后追赶到最新 `editVersion`。

保存统一调用 Rust `safe_write`：

1. 校验当前工作区授权、相对路径、文件类型和基线 revision。
2. 在同目录创建私有随机临时文件，写入并同步。
3. 替换前再次读取并比较 revision，防止 TOCTOU 覆盖。
4. 使用平台原子替换提交，并返回新的 `FileRevision`。
5. 前端只有收到成功 revision 后才把 session 标为安全。

UTF-8 BOM 与单一 LF/CRLF/CR 优先沿用原文件；mixed 或不支持编码的另存必须由用户明确选择 UTF-8 输出格式。

### 4.2 恢复快照

恢复数据位于 `appDataDir()/plainroot-recovery-v1/`：

- manifest：`manifest-v1.json`，schema v1，上限 1 MiB。
- 正文：`snapshots/snapshot-v1-*.md`，opaque 文件名。
- 策略：每个工作区/文档保留最新一份，默认 7 天、最多 32 项、正文总量 128 MiB。
- 活动脏会话受保护；大正文文件 I/O 不持有全局 manifest 锁，并发读取使用租约避免删除竞态。
- 损坏项隔离；未知 schema 不覆盖；写入不可用时明确降级为仅内存安全，后续成功写可恢复持久化状态。

恢复只把快照载入 dirty session，不直接覆盖 `.md`。读取和删除都必须同时匹配已授权 `workspaceId`、快照 id 与相对路径。

### 4.3 外部修改与删除

- watch 事件只触发重新核对；磁盘 revision/hash 是最终权威。
- 外部修改进入 `conflict`，展示路径、磁盘修订、当前内容安全性和重载/覆盖/另存/保持选项。
- 覆盖必须先取得绑定 workspace、相对路径、最新 revision 和当前内容 hash 的一次性令牌，再显式二次确认。
- 外部删除不清空内存 Markdown。只有恢复快照或同一 generation/editVersion 的另存结果足以保护内容时，关闭才可继续。

### 4.4 另存副本

工作区外目标只来自 Rust 原生保存对话框。前端确认命令不提交绝对路径，只提交一次性令牌、内容和明确的覆盖决定。已有目标在确认前后均复核 revision；新目标使用 no-replace，已有目标使用同目录临时文件与平台原子替换。单目标授权不转化为目录或工作区权限。

## 5. 图片和资源目录

### 5.1 偏好

资源目录偏好位于 `appDataDir()/plainroot-preferences-v1.json`：

- schema v1，文件上限 1 MiB，最多 1000 个工作区。
- 每个 `workspaceId` 只保存根内 `assetDirectory`，默认 `assets/`。
- 配置写入使用私有临时文件与原子替换；损坏文件备份后回默认，未知 schema 不覆盖。
- 重置只删除偏好记录，不删除已经导入的资源文件。

### 5.2 导入与引用

- 支持 PNG、JPEG、GIF、WebP，单项上限 20 MiB；以 Rust 二进制签名为准，SVG 明确拒绝。
- 系统选择、粘贴和拖放都进入受控导入服务。资源先原子写入不覆盖的唯一文件名，再签发最多 32 项、5 分钟、单次消费的 import token。
- Markdown 插入成功后 confirm 保留资源；失败或取消只在文件身份、长度和 SHA-256 未变化时清理本次副本。
- Rust 返回工作区相对 `assetPath`；写入 Markdown 前必须按当前文档目录换算为文档相对链接。
- 图片预览由 Rust 重新校验授权根、普通文件、大小和签名后返回原始字节；WebView 只创建可撤销 Blob URL，不获得通用文件协议权限。
- 当前打开文档或其包含目录移动时，先提交磁盘移动，再按 Markdown AST 位置重写当前 `DocumentSession` 中受影响的内联图片 URL；引用式图片定义当前不在自动改写范围。
- 移动已配置资源目录或递归包含 PNG/JPEG/GIF/WebP 的目录前，Rust 以当前授权根和资源偏好为依据执行最多 10,000 个目录项的有界检查。命中配置目录、图片扩展名或检查无法完整完成时，P1 必须提示“未打开 Markdown 文档中的相对图片链接可能失效”；取消不调用移动命令，继续按钮明确“链接可能失效”。
- 目录风险检查只表达潜在影响，不解析 Markdown、不声称已经找到具体引用，也不批量改写其他文档。真正的跨文档引用索引和批量链接维护仍未实现。

## 6. 页面、菜单与窗口结算

- P1 的 `DocumentEditorShell`、工具栏、持续状态栏和恢复类弹层全部消费当前 `DocumentSession`。
- 工具栏和原生菜单经同一命令总线执行保存、另存、撤销/重做、当前文档查找、排版/源码切换；菜单启用状态来自聚焦窗口的 `hasDocument/readOnly/busy/canUndo/canRedo/mode`。
- P2 没有文档时重置编辑菜单；工作区搜索、页签、阅读、主题等没有真实消费者的入口继续禁用或隐藏。
- 系统关闭、菜单关闭、当前窗口根替换和应用退出先创建一次性结算 intent。前端等待 `DocumentSaveController.settle()`，只有内容已安全才允许 Rust 继续窗口事务。
- 当前门禁只处理每窗口一个活动文档。阶段 3 必须把它提升为页签集合结算，不能把现状写成 R13 或完整 R14 已完成。

## 7. 权限和配置边界

| 对象 | 权威位置 | 安全边界 |
| --- | --- | --- |
| Markdown | 用户授权工作区 | Rust 根内相对路径校验；单次读取/写入上限 64 MiB |
| 恢复正文 | 应用数据目录 | 独立版本化仓储；不替代源文件、不上传 |
| 资源目录偏好 | 应用数据目录 | 只保存根内相对目录；读取和写入时重新校验工作区 |
| 图片资源 | 授权根内资源目录 | 签名白名单、20 MiB、no-replace、一次性导入令牌 |
| 另存目标 | 用户本次原生选择的单个文件 | 一次性目标令牌；不授予父目录长期权限 |
| 前端 capability | `src-tauri/capabilities/default.json` | 仅 `core:default`；无通用 filesystem/dialog capability |

当前没有 SQL、数据库 schema、seed、业务账号、密钥或生产环境变量。`PLAINROOT_E2E_DATA_DIR` 只存在于编译期隔离的 E2E 构建，不是产品配置。

## 8. 验证与可观测性

- `pnpm test` 统一执行 Node 独立回归、全部 Vitest 和 Rust 非桌面服务门禁。
- `pnpm test:editor` 覆盖 session、history、两种 adapter、保存控制器、恢复/冲突/资源组件和页面集成。
- `pnpm test:tabs` 覆盖纯页签状态机、状态投影、恢复边界与活动 runtime 唯一性；`pnpm test:tabs:performance` 输出 100 个轻量描述的打开、索引和切换基线。
- `pnpm test:roundtrip` 使用生产 adapter 验证 CommonMark/GFM、图片、受支持 HTML 与 source-only 语料。
- Rust 契约测试登记所有 TypeScript 导出 interface 和字符串枚举/tag，防止 Rust↔TypeScript 字段漂移。
- `pnpm test:e2e` 使用独立 identifier、临时状态目录和每套件复制的临时工作区，当前本地 9 条真桌面用例覆盖 P1/P2、两种模式、图片、保存重开、外部修改、恢复和目录图片移动风险确认/取消。
- 远端 GitHub Actions run `30082725332` 已在提交 `914ad8413b30569ab1c704dc1a55f15d3ed78c59` 上完成 macOS/Windows 双绿；该矩阵覆盖 23 个 Vitest 文件/176 项、9/9 桌面 E2E、Rust 门禁、未签名生产构建和 artifact 上传。T35 本地整改后为 24 个 Vitest 文件/198 项，尚未推送，不能沿用该远端运行宣称第三阶段双平台通过。

## 9. 已知边界

- 系统 IME 候选窗、系统剪贴板、Finder/Explorer 原生拖入、原生保存/图片选择器、系统关闭/退出和 Windows 原生辅助技术仍缺完整人工证据；WebView 自动化不替代这些证据。
- 大文档 patch/hash/save 仍是 O(全文长度)，源码 chunk 仍超过 500 kB 告警；现有阈值与分级防抖是安全运行值，不是最终性能定稿。
- 图片节点按项异步读取，当前没有全局并发或 Blob 总量预算；多图文档峰值内存未形成双平台证据。
- 目录图片移动风险检查按配置目录、受支持扩展名和有界遍历判断，不能证明图片确被某个 Markdown 引用；它以可能多提示一次换取不静默断链。其他文档不会自动批量改写，跨文档引用索引仍属于后续能力。
- 当前文档移动后的自动改写只覆盖内联图片语法；引用式图片定义不在改写范围。
- JPEG/WebP 签名校验采用保守完整信封，少数带尾随数据的合法文件可能被拒绝；前后端 WebP 预检严格度仍应继续保持一致。
- 强制终止发生在“资源已落盘、Markdown 尚未确认插入”之间时可能留下孤立资源；缺少持久证据时不猜测删除用户文件。
- T35 页签集合模型尚无 P1、持久化或桌面 E2E 消费者；多页签产品能力仍未完成。大纲、工作区搜索、分页阅读、主题预设和完整响应式布局仍属于后续阶段。
