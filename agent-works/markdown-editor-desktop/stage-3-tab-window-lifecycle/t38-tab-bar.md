# T38 页签条、溢出菜单与无障碍开发留痕

## 1. 任务与范围

- 任务：T38 页签条、溢出菜单、上下文动作与无障碍。
- 需求承接：R11、R13、R30、R31 的第三阶段页签子集。
- 页面功能点：P1 7.1.3、7.1.6。
- 计划事实源：`plan.md` §4.2、§4.8、§4.9、§6.4。
- 本次完成：
  - P1 可见页签条与活动页签单一投影；
  - 单页签鼠标/键盘关闭、当前窗口拖动和键盘排序；
  - 全部页签溢出列表与共享上下文菜单；
  - tablist/menu 语义、roving tabindex、焦点返回和非颜色状态；
  - 真实 Tauri/WebKit 三文档页签及窄窗回归。
- 明确未完成：最近关闭入口与顺序持久化归 T39；关闭其他/右侧/全部的真实两阶段结算归 T40；持久会话恢复归 T42；R11/R31 的完整产品验收仍属于后续任务和阶段 4。

## 2. 实际实现

### 2.1 可见页签与单一状态来源

- 新增 `WorkspaceTabBar`，直接消费 `WorkspaceTabManagerSnapshot`，不建立页面私有页签数组：
  - 顺序、活动项、路径身份与 incarnation 继续以 T35 集合为事实源；
  - 每项状态调用 `projectWorkspaceTabStatus`，遵循公共 async state 优先级和 assertive/polite 契约；
  - 同名文档显示父目录提示，完整相对路径进入 tooltip；
  - 图形、文字和可访问名称共同表达 unloaded/loading/dirty/saving/readonly/conflict/missing/error 等状态，不只依赖颜色；
  - 页签激活后，中央 editor、文件树、状态栏、窗口标题和原生菜单仍共同消费 manager 的活动 runtime。

### 2.2 关闭、排序和焦点

- `WorkspaceTabManager` 新增纯集合 `move`，排序不重建 runtime、session、history 或 editor。
- `close` 在结算前提交活动 adapter 的 Markdown、选择和锚点；调用方未显式提供视图时，从当前 ready session 推导最近关闭元数据。
- P1 的关闭动作使用 ref 单飞：
  - 安全结算成功后才移除页签并同步下一个活动路径、标题和菜单；
  - 保存失败、只读、冲突等阻塞时保留原页签、激活阻塞目标并展示真实原因；
  - 不把关闭失败伪装成成功 toast。
- 页签键盘契约：
  - `←/→/Home/End` 移动并激活 roving tab；
  - `Delete` 关闭当前 tab；
  - `Alt+Shift+←/→` 提供拖动排序的纯键盘替代；
  - `Shift+F10` / ContextMenu 打开目标页签菜单。
- 关闭后焦点进入相邻或新活动页签；菜单 Esc/外部点击关闭后回到原触发器。

### 2.3 共享菜单与状态诚实

- 新增共享 `TabMenu`，溢出列表和上下文菜单共同消费：
  - 复用既有 `focusableElements`，统一方向键、Home/End、Esc、Tab 和外部点击关闭；
  - 溢出菜单展示所有打开文档、完整相对路径及当前状态；
  - 上下文菜单提供关闭、向左/向右移动。
- “关闭其他页签 / 关闭右侧页签 / 关闭全部页签”在 T40 前保持禁用并可见说明“等待全页签安全结算能力”。本任务不以假动作、固定结果或部分关闭绕过 R5。

### 2.4 布局与设计

- 工作台网格增加稳定 38 px 页签行，标题栏、页签、工具栏、正文和状态栏各自保持明确滚动归属。
- 页签 viewport 负责横向滚动，根页面不滚；820 px 以下保持紧凑页签宽度，菜单使用视口边界夹取。
- 样式全部消费现有语义 token，没有新增私有 hex、rgba、渐变或第二套按钮/菜单配色。
- 活动项使用 paper 层级与 accent 下划线；状态颜色只是文字/图形之外的辅助信号。
- `prefers-reduced-motion` 下不引入平滑滚动或额外动画。

## 3. 复用判断

- 已复用：
  - T35 `WorkspaceTabCollection`、状态投影和公共 async state；
  - T37 `WorkspaceTabManager`、每页签 runtime 与单 adapter 生命周期；
  - `focusContainment` 的可聚焦元素筛选；
  - `WorkspaceWorkbench` 既有页面错误、窗口标题、树选择和菜单投影；
  - `tokens.css` 与 DESIGN 的中性 chrome、paper、line、accent、状态色。
- 新增 `TabMenu` 的理由：溢出和上下文菜单是第二个同职责消费者，必须共享键盘、关闭和焦点契约，不能各写一套私有 menu。
- `TabOverflowMenu` 与 `TabContextMenu` 保持薄组合：前者负责全部页签定位，后者负责目标页签动作；二者业务项不同，不合并成条件分支密集的大组件。
- 未抽取新的关闭协调器：T38 单项关闭直接复用 manager/controller；批量原子决策是 T40 的新稳定职责。

## 4. 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| T38 定向 Vitest | 3 文件 42/42 |
| `pnpm test` 的 Node/Vitest 部分 | Node 30/30、Vitest 26 文件 219/219 |
| Rust 非桌面服务门禁 | 200 通过、1 项手动性能探针忽略 |
| `pnpm build` | 通过；既有源码 chunk >500 kB 警告保留 |
| `pnpm licenses:check` | 727 Node / 511 Rust / 0 阻断 |
| `pnpm test:e2e` | macOS Tauri/WebKit 10/10；三真实页签、页签点击、溢出菜单 Esc 焦点返回、1100/820/740 px 无根溢出、单 adapter 与 RSS 门禁通过 |

第一次执行统一 `pnpm test` 时 shell 未加载 Cargo 环境，Node 30/30 和 Vitest 219/219 已通过，但命令在 Rust 子命令启动前以 `cargo: command not found` 结束；随后加载 `~/.cargo/env` 独立重跑同一 Rust 门禁，200 项通过且 1 项手动探针忽略。该环境启动失败不是测试失败，也不写成一次完整 `pnpm test` 绿灯。

## 5. 文档与配置同步

- 已同步：第三阶段 `plan.md`、本留痕、总需求阶段状态、`DESIGN.md` 组件登记与 Known Gaps、Markdown 编辑架构、README、AGENTS 稳定事实。
- 不需要更新：
  - SQL/seed：没有数据库、schema 或初始化数据；
  - 权限/capability：没有新增 Rust 命令或文件授权；
  - 菜单：没有启用原生页签菜单命令，键盘行为局限于已聚焦 tablist；
  - 配置/环境变量：没有新增持久偏好或产品环境变量；
  - `CLAUDE.md`：仍是指向 AGENTS 的薄入口，没有新增长期规则；
  - HTML 原型：P1 已提供页签视觉意图，并明确拖动/上下文动作由 R13/R30 和 7.1.6 承接；T38 没有新增安全关键弹层。

## 6. 未验证与后续

- T38 尚未推送，未取得当前提交的 macOS/Windows 远端 CI；本地 macOS 结果不得外推 Windows。
- Windows WebView2 的 tablist/menu 键盘、拖动、焦点和窄窗行为未运行。
- 系统辅助技术、原生输入、长时大量页签和 JS heap 仍无完整双平台证据；T45/T46 继续承接。
- 当前拖动顺序只在本窗口内存生效，T39 才接入顺序持久化和最近关闭入口。
- 批量关闭项明确禁用；T40 完成补充原型和两阶段结算前，不得宣称关闭其他/右侧/全部可用。
- T42 尚未把 T36 仓储接入启动恢复；当前可见页签不等于重启后恢复完成。
