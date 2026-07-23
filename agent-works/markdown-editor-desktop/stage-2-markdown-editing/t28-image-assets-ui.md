# T28 图片输入、资源目录与相对链接

## 功能的详细需求

T28 对应 R2、R3、R6、R11、R30、R31，并承接 P1 7.1.2 的图片与资源管理子集。目标是把 T22 已建立的资源目录偏好、受控图片导入和两阶段确认契约接入当前唯一 `DocumentSession`，形成系统选择、剪贴板、拖放、资源目录、文档相对链接、缺失占位、重新定位和移动链接调整的真实闭环。

图片必须先在 Rust 授权根内完成格式、大小、路径和唯一命名校验并落盘，编辑器再把返回的工作区相对资源路径转换为以当前 Markdown 文档目录为基准的相对链接。插入成功后才确认保留资源；插入失败、文档版本变化或取消时只清理身份、长度和 hash 仍与本次导入一致的副本。多图导入允许部分成功，但失败项不能形成 Markdown 链接。

排版图片不能直接使用前端拼接的本地文件 URL。缺失、越界、不支持或已变化的资源必须显示原路径和可执行的重新定位入口；重新定位只在新资源通过同一导入链并成功更新当前节点后确认。当前文档或包含资源的目录移动时，先完成磁盘移动，再按用户确认调整受影响图片链接，并让改写结果进入原自动保存/恢复链。

## 功能开发的实际结果

- 新增 `src/features/editor/assets/`，以纯路径代数完成工作区资源路径与当前文档相对 Markdown 图片链接之间的转换，并用 Remark/GFM AST 的图片节点位置重写移动后受影响的 URL。根文档、两级子目录、空格、外部 URL、越界、目录同移和文档单独移动均有自动化覆盖。
- `DocumentEditorShell` 接入系统选择器、剪贴板和拖放。三种入口都在开始时固定当前 generation、editVersion 与选择位置，并共用单飞门禁；异步期间文档变化会取消未使用资源，避免晚到导入插入到另一版本。确认失败只在 session 仍是刚插入图片的版本时回滚该次插入，已有后续变化时不误撤用户内容。多图按项处理并反馈成功/失败数量，失败项不插链。
- 新增 `AssetDirectoryDialog`，复用 `AppDialog`、`AsyncStatePanel`、`plainroot-button` 与语义 token，承接当前工作区资源目录读取、保存、恢复默认、非法目录错误、processing 关闭门禁和焦点返回。只读文档禁用资源写入入口。
- Milkdown 与 CodeMirror adapter 都支持在当前选择或拖放坐标插入图片 Markdown；排版 adapter 新增受控图片 node view。可用资源投影为 Blob URL，缺失/不支持资源显示原路径和“重新定位”；节点更新或销毁时撤销 Blob URL，不持有第二份 Markdown。
- Rust 新增 `read_workspace_image` 原始字节命令。每次读取都重新校验当前 workspace 授权、工作区相对路径、符号链接、普通文件、20 MiB 上限和 PNG/JPEG/GIF/WebP 签名；SVG 与签名不匹配被拒绝。CSP 仅为图片增加 `blob:`，正式 capability 仍只有既有最小权限。
- P1 移动当前 Markdown 或其包含目录时，对含本地图片的文档显示默认勾选的链接调整项。只有磁盘移动成功后才根据旧/新文档目录和同移资源路径改写图片 URL；URL 按 Markdown 图片目标语法定位，不会把相同内容的替代文本或标题误改。结果提交为当前 session 的 dirty 编辑，由既有自动保存/恢复链负责持久化。

当前未完成且不得外推：

- T29 的菜单、完整状态栏和页面集成收口尚未完成。
- 本任务没有取得真实 Tauri 系统图片选择器、原生剪贴板/拖放、WebView raw IPC、桌面 E2E、macOS WebKit 产品链路或 Windows WebView2 证据。
- 系统输入法候选窗、系统辅助技术、峰值内存、强制进程终止、磁盘满、休眠、网络卷和文件系统卸载仍未验证。
- 当前仍是每窗口单文档；多页签间的图片状态与批量关闭门禁属于后续阶段。

## 功能开发的具体实施方案

1. 系统选择入口调用 Rust 原生图片选择器；剪贴板/拖放先在前端按字节签名和 20 MiB 上限筛选，再通过 T22 的 opaque upload id 上传原始字节。Rust 始终重新验证，不信任浏览器 MIME、文件名或相对路径。
2. 每个导入 proposal 都绑定当前 workspace。编辑器把 `assetPath` 转换为当前文档相对 URL，并通过统一 adapter 命令插入；命令成功才 confirm，失败、版本漂移或回滚则 cancel。
3. 排版/源码两个 adapter 共同实现坐标选区与 `insert_image`，不在页面维护第二套插入逻辑。拖放先把屏幕坐标映射为 adapter 选择，再走同一图片命令。
4. 图片节点解析先将 Markdown URL 还原为工作区相对路径，再通过受控 raw IPC 读取字节并创建 Blob URL。读取失败只影响当前节点，展示缺失占位，不能阻断其他正文。
5. 重新定位继续走相同导入 proposal；节点 URL 更新成功后确认新资源，失败则恢复旧 URL 并取消 proposal。只读时不显示可执行的重定位动作。
6. 移动链接改写只处理 Markdown image 节点，不修改普通链接或代码文本；磁盘移动成功是改写前置条件，改写后的正文复用 `applyDocumentEdit`、自动保存和恢复快照。
7. 临时浏览器验证发现 `[hidden]` 被组件 display 样式覆盖，导致坏图与缺失占位同时出现；同时资源弹层私有宽度在 740 px 验证容器内产生内部横向滚动。最终分别补显式 hidden 规则并让业务弹层消费共享可用宽度，验证后删除临时入口。

## 复用判断

- 已复用 T22 的 `EditorAssetGateway`、两阶段 import token、资源偏好仓储、Rust mutation lock、`AppDialog`、`AsyncStatePanel`、`focusContainment`、`plainroot-button`、统一 `EditorAdapter`、`DocumentSession` 和保存/恢复控制器。
- `workspaceAssetPath` 同时被编辑器导入和 P1 移动流程消费，且路径规则必须同定义变化，已抽取为纯复用单元；它与通用 `workspacePath` 的职责不同，前者理解“当前文档相对 URL”，后者只处理工作区树路径，因此没有强行合并。
- `workspaceImageNodeView` 承担 Blob URL 生命周期、缺失占位和重新定位回滚，是稳定独立安全边界，保持为 Milkdown adapter 的专用复用单元。
- 资源目录弹层继续组合共享对话框和状态面板，没有复制焦点、遮罩、按钮或错误面板。选择、剪贴板和拖放只在输入来源上不同，落盘/插入/确认编排共用同一控制器。

## 上线部署操作

本次无额外上线部署操作：

- 无数据库、SQL、seed、迁移或初始化数据。
- 无新增依赖、lockfile、产品环境变量、密钥、账号、远端服务、菜单或业务权限。
- 无新增 Tauri capability；新增 `read_workspace_image` Rust 命令继续通过 workspace 授权和相对路径边界执行。`tauri.conf.json` 的 CSP 仅为 `img-src` 增加 `blob:`，不开放 `file:`、通用文件系统或目录权限。
- 资源目录继续使用 `appDataDir()/plainroot-preferences-v1.json`，schema、路径、默认值和回滚方式均未变化；图片仍写入用户当前授权工作区的资源目录。
- 回滚 T28 时需同时回退 P1/编辑器消费者、路径转换、受控读取命令和 CSP `blob:`。已经确认导入的图片与已保存 Markdown 属于用户文件，不随代码回滚自动删除或改写。
- 未确认的 import token 仅存在当前进程；强制终止可能留下已落盘但未插链的孤立资源，缺少持久证据时后续版本仍不得猜测删除。

## 验证情况

已执行并通过：

- 锁定 `node_modules` 下直接运行 TypeScript 编译器、Vitest 与 Vite：166/166 个 Vitest 通过，生产构建通过。
- 新增图片路径、签名、资源目录、编辑器壳、Milkdown node view 和 P1 移动交互测试，覆盖根/两级子目录、选择插入确认、图片操作单飞、确认失败精确回滚、剪贴板部分失败、失败不插链、缺失占位、重新定位、目录保存/重置和移动确认。
- Rust 全量 172 项通过，1 项手动性能探针按设计忽略；新增用例覆盖授权根内图片读取、SVG 拒绝和 20 MiB 有界读取。`cargo fmt --check` 与 all-targets/all-features Clippy `-D warnings` 通过。
- Node 独立门禁：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、树状态 18/18、fixture 1/1。
- 许可证清单：727 个 Node 包、508 个 Rust 包、0 个阻断项。第一次组合执行因当前 shell 未加载 Cargo 路径而在清单步骤中止，加载 `/Users/pengshuaifeng/.cargo/env` 后同一命令通过；没有把环境初始化失败记作产品测试通过。
- 使用临时浏览器验证入口在真实 Chromium 中检查 1280 px，并用独立 iframe viewport 检查 820/740 px：页面、工具栏和弹层均无横向溢出；资源目录输入、保存关闭与焦点返回真实生效；缺失图片只显示占位和原路径。验证入口与 Vite 服务均已删除/停止。

未取得通过证据：

- 本任务未运行真实 Tauri IPC、系统图片选择器、原生剪贴板/拖放、桌面 E2E、macOS WebKit 人工链路、Windows CI 或系统辅助技术。
- 未执行强制进程终止、磁盘满、系统休眠、网络卷和文件系统卸载长时测试。

## 关联文档同步

- 已更新第二阶段 `plan.md` 的 T28 状态、R2/R3/R6/R11/R30/R31 映射、页面功能点、实际落地、验证计划、配置消费和风险边界。
- 已更新 `requirement.md` 的当前阶段和第 12 章实施状态。需求范围、R 编号、建议实现处理状态、验收标准和遗留确认项未因 T28 改变，不需要修改。
- 已更新 `architecture/desktop-foundation.md` 的 P1 图片消费者、受控读取、文档相对链接、两阶段确认、移动后改写和 CSP/capability 边界；已有架构文档能够承接本次稳定事实，不需要新建第二份技术架构文档。
- 已更新 `DESIGN.md` 的运行时组件登记和 Known Gaps；本任务没有新增颜色、间距、圆角、阴影或断点 token。
- 已更新 `README.md`、`AGENTS.md` 的当前稳定能力、验证数量和未验证边界。
- `CLAUDE.md` 继续作为指向 `AGENTS.md`、需求和阶段计划的薄入口，没有新增稳定规则，不需要更新。
- `page-development-workflow.md` 的通用页面流程未变化，不需要更新。
- SQL、seed、数据库、菜单、产品权限、环境变量、依赖、lockfile 和脚本没有稳定事实变化，不需要更新。
