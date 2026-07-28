# Plainroot 页签与窗口生命周期架构

## 1. 文档职责

本文描述 Plainroot 已落地的多文档页签、窗口页签会话、全页签结算、文件路径联动、窗口生命周期保护和平台页签命令。产品范围与验收口径以 `../requirement.md` 为准，第三阶段任务与证据以 `../stage-3-tab-window-lifecycle/plan.md` 和 `../stage-3-tab-window-lifecycle/t46-stage-acceptance.md` 为准；代码、清单、配置与自动化测试是实现事实源。

本模块不保存 Markdown 正文副本，不建立私有内容数据库，也不负责窗口尺寸、三栏布局、搜索、阅读分页或主题预设。

## 2. 核心不变量

- 一个窗口只绑定一个工作区，同一 Rust 平台路径身份的工作区只允许一个可写窗口。
- 同一窗口内，同一 Rust 不透明文件身份只允许一个打开页签；前端不通过自行小写路径或拼接绝对路径建立身份。
- 每次页签创建使用不可复用的 `incarnation`；异步读取同时校验 `incarnation` 与 `generation`，保存与重映射再校验 `editVersion`，旧结果不能命中新页签。
- 每个已加载页签独立持有 `DocumentSession`、history 与 `DocumentSaveController`；任意时刻只挂载活动页签的 Milkdown 或 CodeMirror adapter。
- 文件新建、重命名、移动、删除和保存均以 Rust 磁盘结果为提交边界。磁盘成功前不改正式页签路径、文件树或文档链接。
- 批量关闭、工作区替换、窗口关闭和应用退出共用两阶段结算；取消时不部分关闭页签。
- 窗口会话只保存轻量元数据，不保存 Markdown 正文、完整撤销栈或恢复正文。
- 单个恢复项失败不阻断其他页签和窗口；损坏项可隔离，新的安全会话可继续持久化。

## 3. 模块边界

| 模块 | 事实源 | 职责 |
| --- | --- | --- |
| 页签描述与纯状态机 | `src/features/tabs/tabTypes.ts`、`tabReducer.ts` | 顺序、活动项、路径身份、不可复用 incarnation、加载 generation、最近关闭和集合不变量 |
| 页签运行时 | `src/features/tabs/WorkspaceTabManager.ts` | 每页签 session/history/save controller、惰性加载、活动 adapter 投影、关闭和路径重映射提交 |
| 可见页签与菜单 | `WorkspaceTabBar.tsx`、`TabMenu.tsx`、`TabOverflowMenu.tsx`、`TabContextMenu.tsx` | tablist、排序、溢出、最近关闭、键盘/焦点和动作入口；不复制保存或结算逻辑 |
| 全页签结算 | `TabSettlementDialog.tsx`、`tabSettlement.ts` | 固定目标快照、逐项内容安全状态、保存/冲突/另存/放弃决策和最终提交门禁 |
| 路径影响分析 | `tabPathImpact.ts`、`workspacePath.ts`、`workspaceAssetPath.ts` | 文件/目录变更对页签和内联图片链接的纯分析；不执行磁盘写入 |
| 会话投影与调度 | `tabSessionProjection.ts`、`tabSessionPersistence.ts` | 从运行时生成无正文快照、防抖写入、revision/CAS、已有会话恢复前冻结和恢复后接管 |
| Rust 会话仓储 | `src-tauri/src/window_session.rs`、`commands/window_session.rs` | 版本化 manifest/session 文件、原子提交、崩溃前滚、容量校验、窗口绑定和平台路径身份解析 |
| 窗口协调 | `src-tauri/src/window.rs`、`window_settlement.rs`、前端工作区打开模块 | 一目录一窗口、当前/新窗口决策、替换/关闭/退出 intent 与 allow/deny 握手 |
| 平台命令 | `src-tauri/src/menu.rs`、`src/features/platform/`、P1 菜单处理器 | 聚焦窗口菜单状态、macOS 原生页签加速键、Windows 聚焦 WebView 页签组合键；统一委托页签 manager |

## 4. 页签身份与状态

页签描述只保存工作区相对路径、Rust 返回的不透明 `pathIdentity`、展示信息、`incarnation`、加载 generation 和轻量视图元数据。`tabsById`、顺序、路径索引和最近关闭列表必须双向一致；恢复输入进入正式集合前执行同一组不变量校验。

页签主状态消费 DESIGN 公共优先级：

`permission-denied > missing > conflict > error > unsupported > saving > loading > dirty > readonly > empty > unloaded > ready`

`unloaded` 表示已恢复但尚未读取磁盘的页签，不得显示为“空文件”。权限、位置、冲突和错误以 assertive alert 呈现，进度与稳定状态使用 polite status；颜色之外始终保留文字。

## 5. 运行时与编辑器单挂载

`WorkspaceTabManager` 是 P1 的唯一多文档运行时。打开文件先向 Rust 解析受授权约束的路径身份；身份已存在时聚焦原页签，不创建第二个 session。新页签按 `incarnation` 建立独立运行时，读取完成只有在身份、incarnation 和 generation 仍匹配时才能提交。

切换页签时先同步采集活动 adapter 的 Markdown、选择和语义锚点，再卸载旧 adapter、投影目标 session 并挂载目标 adapter。未活动页签保留内存 session/history/save controller，不保留重型 editor DOM。启动恢复只建立轻量页签；首次激活时才读取磁盘，活动候选失败则逐项隔离并尝试下一可读页签。

## 6. 全页签结算与文件操作

关闭当前、关闭其他、关闭右侧、关闭全部、文件/目录重命名、移动、删除、工作区替换、窗口关闭和应用退出都先固定目标集合及其 `incarnation/generation/editVersion`。结算弹层逐项处理：

- dirty/saving/save-failed：等待、重试保存或明确放弃；
- conflict：保留本地、重载磁盘、覆盖确认或另存；
- readonly/missing/permission-denied：说明内容是否仍安全，并只提供真实可执行动作；
- recovery：恢复快照与当前内存内容继续沿用文档保存链，不由页签层复制正文。

所有目标完成决策后才提交页签移除或窗口动作。文件操作在结算后调用 Rust；磁盘成功后才一次性重映射全部受影响 runtime、树状态和已加载文档的内联图片链接。提交前页签又发生编辑时，操作拒绝陈旧快照并要求重新处理；磁盘已成功而内存提交失败时保留内容并明确提示刷新/重开，不伪装事务回滚。

## 7. 窗口页签会话仓储

应用数据目录中的版本化页签会话由 manifest 指向按 revision 命名的 session 文件。快照包含顺序、活动项、模式、选择/锚点、最近关闭和相对路径，不含正文/history/绝对根路径。写入使用 CAS revision、同目录临时文件、同步与平台原子替换；manifest 提交前旧 session 保持有效，启动时可识别 session 已提交而 manifest 未提交的中间态并前滚。

仓储设有单文件、条目数、总量和字段长度上限。未知 schema 不覆盖；损坏文件备份隔离；单项路径失效或重复平台身份形成 issue，不使整个窗口会话不可用。P1 消费已有会话前，前端持久化调度保持冻结；恢复成功或降级完成后显式接管新 revision，避免覆盖尚未读取的会话。

## 8. 窗口与平台命令

工作区打开偏好为 `ask/current_window/new_window`，默认 `ask`，P1、P2 与原生设置菜单消费同一偏好仓储和弹层。同一工作区已打开时始终聚焦既有窗口，偏好不能绕过目录去重、授权或全页签替换保护。

原生菜单只按当前聚焦窗口的编辑与页签状态启用。macOS 使用原生菜单 `Cmd+Option+Right/Left` 切换页签；Windows 使用聚焦 WebView 的 `Ctrl+PageDown/PageUp` 平台适配，并委托同一页签命令处理器，原生菜单不重复注册对应 accelerator。`Cmd/Ctrl+W` 关闭当前页签，最后一个页签关闭后保留已绑定工作区的空窗口；`Cmd/Ctrl+Shift+W` 关闭窗口。

## 9. 数据、权限与配置边界

- 无数据库、SQL 或 seed；页签元数据使用应用数据目录中的版本化 JSON。
- 无新增生产环境变量；E2E 数据目录和固定标题只存在于隔离测试构建。
- 前端只发送工作区 ID、窗口标签、相对路径和用户意图；Rust 重新校验窗口绑定、授权根和平台路径身份。
- capability 不开放任意绝对路径、shell 或工作区外文件访问；所有磁盘副作用继续由受控 Rust 命令承担。
- 产品回退不得修改用户 Markdown。旧版本无法理解新会话 schema 时只忽略或隔离元数据，不覆盖未知版本。

## 10. 验证与已知边界

非桌面门禁覆盖页签不变量、身份别名、ABA、惰性恢复、CAS/崩溃前滚、结算证据、磁盘成功后提交、菜单路由、Rust↔TypeScript 逐变体契约、类型、构建、lint 和许可证。桌面 E2E 覆盖真实 IPC、三个文档单 adapter、批量结算后真实改名/移动/删除、窗口替换拒绝、平台组合键和跨进程恢复/单项失败隔离。

当前已知边界：

- 窗口位置、尺寸和三栏布局持久化属于后续布局阶段。
- 真实多窗口整组退出/恢复仍缺独立自动化用例；现有自动化覆盖单窗口 intent、替换拒绝与跨进程会话恢复。
- Windows 原生选择器、回收站、Explorer、菜单可见性和辅助技术仍缺人工实机矩阵；WebView2 自动化不替代这些证据。
- 系统 IME、JS heap、长时峰值内存、休眠、网络卷和文件系统卸载仍无产品级证据。
- 跨窗口拖拽、固定页签和预览页签不在当前实现范围。

