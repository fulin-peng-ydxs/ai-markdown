# T45 真实桌面 E2E 与双平台门禁留痕

## 1. 任务边界

- 对应任务：第三阶段 `T45`。
- 对应需求：R1、R2、R3、R5、R6、R10、R11、R13、R14、R30、R31 的真实桌面验证子集。
- 本次完成桌面测试编排、macOS 原生页签组合键、真实窗口替换拒绝和跨进程会话恢复；不进入 T46 阶段验收。
- 已完成十六轮第三阶段双平台运行。第十五轮 run `30322298422` 已在代码提交 `9ba28d1` 上让 macOS/Windows 同时通过非桌面门禁、四段 15/15 真实桌面链、未签名生产构建和 artifact 上传；第十六轮 run `30323620642` 又在其上的首轮收口文档提交 `a0268eb` 重复取得双绿与成对 artifact。Windows 聚焦 WebView 平台适配已以真实系统 `Ctrl+PageDown/PageUp` 证明双向切换。T45 状态为“已完成”，不进入 T46。

## 2. 实际实现

### 2.1 四段隔离桌面链

`scripts/run-desktop-e2e.mjs` 将单次 WDIO 执行改为顺序启动四个相互隔离的桌面进程：

1. `desktop-shell.e2e.mjs`：12 条 P1/P2 主链；
2. `native-tab-shortcuts.e2e.mjs`：平台原生下一/上一页签；
3. `restart-seed.e2e.mjs`：在真实 Rust 仓储写入三个页签及活动项；
4. `restart-restore.e2e.mjs`：复用同一测试 app-data 重新启动，恢复可用页签并隔离缺失项。

主链、快捷键链和重启链使用不同临时状态目录与 fixture。重启链的两个进程之间由 Node 编排删除 `restart-missing.md`，因此恢复失败来自真实磁盘变化，而不是前端 mock。任一阶段退出非零即停止后续阶段；确定性业务用例不启用重试。

`tests/e2e/wdio.conf.mjs` 只通过 `PLAINROOT_E2E_SPEC` 选择本次隔离 spec。该变量、测试状态目录和 fixture 只属于 E2E 进程，不是产品环境变量或生产配置。

### 2.2 窗口替换结算

P1 主链新增真实替换事务：

- 在当前文档制造内存 dirty；
- 从测试进程直接修改同一文件，形成外部修订差异；
- 调用生产 `coordinate_workspace_open(current_window)`，确认 Rust 返回 `settlement_required`；
- 等待生产“安全替换当前窗口”弹层可见；
- 通过真实 `resolve_window_settlement(allow=false)` 拒绝 intent；
- 再从生产快照确认窗口仍绑定原工作区，并确认内存 dirty 文本仍在。

该用例验证 Rust intent、前端弹层到达、真实拒绝 IPC 和状态保留。弹层取消按钮到 handler 的 React 接线继续由既有组件测试覆盖；本用例没有把直接 IPC 拒绝写成“点击取消按钮”的虚假证据。

### 2.3 平台原生页签组合键

原生快捷键用独立桌面进程和三个真实页签验证。测试先有界等待唯一 fixture 窗口进入系统可发现状态，再等待目标进程成为前台且对应原生菜单项已启用，最后执行系统级输入；每个方向只发送一次：

- macOS：System Events `AXRaise` 后发送 `Cmd+Option+Right/Left`；
- Windows：全部 E2E 隔离进程通过编译期隔离分支把原生标题固定为“工作区 — Plainroot”，避免 WDIO 随文档标题变化丢失 renderer；快捷键测试仍由 `e2e_tab_shortcuts_ready` 读取真实 `EditorMenuStateRegistry` 与 Tauri `MenuItem::is_enabled`，系统脚本确认前台窗口后只发送一次 `Ctrl+PageDown/PageUp`，最后由真实页签选中态断言结果。多轮 runner 已证明系统输入完整投递但 Tauri 原生菜单没有路由动作，因此 Windows 改由聚焦 WebView 平台适配消费组合键，并委托唯一 `workbenchMenuHandlerRef`；Windows 菜单不再注册同组合键 accelerator。生产构建不读取测试标志，也不注册探针。
- run `30295225359` 继续证明策略与菜单启用态均可达，Windows Forms `SendKeys` 发送替代键后仍未切换页签。当前改用 Win32 `SendInput` 向已核验的前台窗口提交 Ctrl 与扩展 Page 键的四个按下/抬起事件，并检查系统实际接收数量；该路径仍是一次真实系统输入，不调用 WebView keydown、不直接触发业务命令、不增加重试。
- run `30296713912` 证明 Win32 `SendInput` 已完整提交四个输入事件；macOS 再次完整通过，Windows 非桌面门禁、主桌面链 12/12、页签策略与原生菜单启用态均通过。Windows 失败 artifact（SHA-256 `c0da994f7cea3b05348920f5e80cc80ce7aa439937601453ecf162536d75f613`）显示专项用例从开始即持续出现 WDIO 按动态原生标题重定位 renderer 的告警，失败截图则是会话清理时出现的结算弹层，并不是按键后的三页签状态。根因收敛为结果断言复用了会触发原生窗口重定位的旧元素句柄，无法据此证明产品快捷键无效；当前改为在同一 renderer 内执行只读 DOM 查询，不改变真实菜单、系统输入或期望页签结果。

macOS 在最新重建的 Tauri E2E release 二进制上发现 `Cmd+Shift+]` 可触发，但 `Cmd+Shift+[` 不会到达菜单动作；因此没有保留不可用的对称外观，而是收敛为双向均实际通过的 `Cmd+Option+Right/Left`。Windows 已在 run `30322298422` 以真实系统输入通过 `Ctrl+PageDown/PageUp` 双向切换；其固定标题测试缝仅稳定 WDIO 与真实 renderer 的连接，不进入默认生产构建。

Windows 新增唯一 document 级 `keydown` 平台适配，但只识别无 Alt/Meta/Shift 的 `Ctrl+PageDown/PageUp`，先消费现有菜单 policy 再委托同一个 `workbenchMenuHandlerRef` 与 `WorkspaceTabManager`；Windows Rust 菜单把这两个 accelerator 置空，避免双分发。macOS 原生菜单仍通过唯一 `WORKBENCH_MENU_EVENT` 路由。T45 的 Windows 硬化还包含 CRLF 契约解析、平台条件编译、固定 E2E 标题、就绪探针与 renderer 观察修复；并非只抽取平台识别工具。

### 2.4 重启恢复与页面矩阵

重启种子进程等待真实 `get_workspace_tab_session` 返回 revision 大于 0、三个页签和预期活动项后才退出。恢复进程确认：

- P2 展示真实窗口恢复入口；
- 两个仍可读页签进入 P1；
- 被删除页签以“有 1 个页签未恢复”面板单独展示；
- 缺失活动项不会成为当前页签；
- 点击未加载的可读页签后才读取其 Markdown。

既有主链页面矩阵扩为 1100/1050/820/760/740 px，验证根级无横向溢出、主操作与保存可见、格式区和页签 viewport 自己承担滚动、状态栏路径与单一保存状态保持可见。

## 3. 验证证据

### 3.1 macOS 桌面

最新 E2E release 二进制上的完整隔离链通过：

- P1/P2 主链：12/12；
- 原生页签组合键：1/1；
- 重启前会话写入：1/1；
- 重启后恢复与缺失项隔离：1/1；
- 合计：15/15。

执行期间曾发现两类真实失败并在最终证据前修正：

- 旧 E2E 二进制曾造成快捷键结果失真；重新执行 `pnpm test:e2e:build` 后只采信最新产物；
- 恢复用例错误地查询 `h3`，而公共 `AsyncStatePanel` 的标题契约是 `h2`；修正语义选择器后完整四段链从头通过。
- 加入 760 px 档位后的首次完整复跑中，主链 12/12 通过，但原生下一页签未触发，整套真实返回非零；原因是固定 500 ms 延时不能证明目标进程和菜单已就绪。测试改为等待前台进程与菜单启用这两个可观察前置条件后仍只发送一次按键，随后四段链再次从头通过。
- 同一前置条件也已应用到 Windows 分支：不再使用固定 500 ms 延时。第三次远端运行证明 Tauri/Windows 菜单不应假设为传统窗口 HMENU，Win32 `GetMenu` 因此不能作为菜单就绪事实源；当前实现改由编译期隔离的 Rust 探针读取 Tauri 自身菜单项状态，Win32 只负责窗口前台与真实按键。该修正尚未取得 Windows runner 结果，不能由 macOS 通过结果推断其可用。
- Windows 前置门禁整改后的首次 macOS 回归又真实暴露 System Events 单次枚举尚未发现新进程窗口的失败；窗口发现因此也改为有界等待。该等待只建立系统输入前置条件，不重复发送快捷键或重试业务断言；整改后完整四段链再次以 15/15 通过。

WDIO Tauri service 在 macOS 会输出无法按动态文档标题切换原生窗口的告警，但 WebDriver 会话、断言与 spec 均完成；这些告警不被当成通过证据，也未通过关闭断言或业务重试掩盖。

### 3.2 非桌面门禁

`pnpm verify:non-desktop` 从头通过：

- Node 独立回归：30/30；
- Vitest：33 个文件、269/269；
- Rust no-default-features：207 项通过，另 1 项手动性能探针忽略；
- Rust all-features：207 项通过，另 1 项手动性能探针忽略；
- Rust fmt：通过；
- Rust all-targets/all-features Clippy `-D warnings`：通过；
- TypeScript：通过；
- Vite 生产构建：通过；
- 许可证：727 个 Node 包、511 个 Rust 包、0 个阻断项。

构建仍有既有编辑器懒加载 chunk 超过 500 kB 的警告；T45 没有改变编辑器包体，不将该警告写成已解决。

### 3.3 首次远端运行与跨平台契约修复

GitHub Actions run `30272399213` 对提交 `ad04b5ffce04117add606795b38def5d8069f0c5` 给出了可追溯的首次第三阶段远端证据：

- macOS 作业通过非桌面门禁、205 项 Rust 测试、15 条桌面 E2E、未签名生产构建和 artifact 上传；
- Windows 作业在 `Type and frontend gates` 失败，后续 Rust、桌面 E2E 和生产构建因此未执行；
- 失败用例为 `contract_test::tagged_variant_parity_rejects_a_field_on_the_wrong_variant`。逐变体 TypeScript 契约解析器用 `;\n\n` 识别类型别名结尾，在 Windows CRLF checkout 上提前报出 `TypeScript type alias should end with a semicolon`，没有到达测试期望的字段错置断言。

修复将输入行尾先归一为 LF，再执行原有严格格式解析；新增 Windows CRLF 回归用例，同时保留字段放错变体时 fail-loud 的反向断言。该修复不修改生产 IPC、数据格式或业务状态，只修正跨平台测试守卫。修复后的远端双平台结果仍待重新推送核验。

修复后本地 `pnpm verify:non-desktop` 已从头通过：30/30 Node、267/267 Vitest、206 项 no-default Rust 与 206 项 all-features Rust（均另 1 项手动探针忽略）、fmt、Clippy、typecheck、生产构建和许可证 727/511/0。

第二次远端 run `30274596446` 对修复提交 `8f2a922050f14cee1629b5d0bd3eb253e6be92f9` 的结果进一步确认：

- macOS 作业再次通过完整门禁、15 条桌面 E2E、生产构建与 artifact；
- Windows 已通过首次失败的 TypeScript/Rust 契约门禁，证明 CRLF 修复生效；
- Windows 随后在 `Rust format and lint gates` 被 `-D warnings` 阻断：`WindowSessionStore.root` 只在 `#[cfg(unix)]` 权限收紧分支读取，但此前仍作为 Windows 结构体字段编译，因此触发 `dead_code`。

整改不添加 lint 豁免，而是让 `root` 字段只在 Unix 目标存在；Windows 继续保留由 `root` 派生的 manifest/session 路径，不改变仓储格式或行为。该分支必须由下一次 Windows runner 的 Clippy、测试、E2E 与生产构建共同验证。

第三次远端 run `30275676382` 对提交 `2c4fede` 给出新的有效证据：

- macOS 作业继续通过完整门禁、15 条桌面 E2E、生产构建与 artifact；
- Windows 已通过 TypeScript/前端门禁、Rust fmt/Clippy 和 Rust 测试，证明前两轮 CRLF 与平台字段整改均真实生效；
- Windows 首次进入本阶段真实桌面 E2E，在原生页签快捷键用例发送按键前失败。日志显示 Win32 `GetMenu` 无法从 Tauri 窗口取得传统 HMENU，导致“菜单项未就绪”探针误判；当次没有发送 `Ctrl+Tab`，不能据此判断产品快捷键成功或失败。

整改没有删除真实系统输入或放宽结果断言。E2E flavor 新增只读 `e2e_tab_shortcuts_ready`：同时检查聚焦窗口登记的页签状态与 Tauri 菜单项的实际 enabled 状态；Windows 系统脚本只建立前台窗口条件并发送一次按键。探针受 `e2e` feature 编译期隔离，默认生产 handler 不存在。修正后本机重新构建 E2E release 并完整通过 macOS 四段 15/15，其中原生下一/上一页签仍以真实系统事件首次触发成功；Windows 结果等待下一次远端运行。

第四次远端 run `30278252178` 对提交 `4887198` 给出新的失败证据：

- macOS 已通过非桌面门禁并进入桌面主链，在“编辑、导入图片、保存并刷新重开”用例的刷新后阶段失败；
- 远端首先表现为刷新后排版编辑区未出现。本机随后完整复现时，WDIO Tauri service 在动态窗口标题变化后刷新 WebView 会持续寻找旧标题，首个等待失败后级联破坏后续用例。`browser.refresh()` 既不关闭原生窗口，也不等价于真实应用重启，因此不是有效的跨进程恢复证据；
- Windows 已通过非桌面门禁和 12/12 主链，在原生页签快捷键专项中等待 Tauri 菜单状态超时。当时探针在 Windows 脚本建立前台窗口条件之前运行，而生产菜单状态只在对应窗口聚焦后应用；该轮没有发送 `Ctrl+Tab`，不能据此判断真实快捷键失败；
- 两个平台诊断 artifact 均已上传：`plainroot-macos-30278252178` 的 SHA-256 为 `e9758037104c586f904074326f186e6abceaa61ee84f53a74a74858f626ab70c`，`plainroot-windows-30278252178` 为 `26cff25d996b95ad52afcbeb6774f1dc61f0ef0aa0fc20028e4aeb82dff45f93`。本轮因此仍不能作为双平台通过证据。

整改移除该业务用例中的 WebView 刷新：保存完成后通过真实页签关闭按钮关闭 `note.md`，再从文件树重新打开，切回源码并继续核对编辑内容、图片链接和真实磁盘字节。真实跨进程恢复仍由独立 restart seed/restore 进程覆盖，不用 WebView 刷新冒充应用重启。原生快捷键专项则先按工作区窗口标题将目标进程置于前台，再等待 registry 与 Tauri 菜单状态同时就绪，最后仍只发送一次系统按键；macOS System Events 不再依赖进程名大小写，而是从可见应用窗口中匹配目标标题。整改后本机 macOS 已重新从头运行四个隔离桌面进程并通过 15/15（主链 12/12、原生快捷键 1/1、重启种子 1/1、跨进程恢复 1/1）。修复不增加业务重试、固定等待或弱化内容断言，需要下一轮 macOS/Windows 远端运行共同验证。

### 3.4 第五次远端运行与 WebView2 渲染器定位整改

GitHub Actions run `30280357578` 对提交 `a471a43` 给出新的有效证据：

- macOS 再次通过非桌面门禁、205 项 Rust 测试、15 条桌面 E2E、未签名生产构建和 artifact 上传；`plainroot-macos-30280357578` 的 SHA-256 为 `ab4772d4a174194c1c9f450af93b292af3eae5f685c19e6fdf6935f1d943f0f6`；
- Windows 已通过类型/前端、Rust fmt/Clippy、Rust 测试和主桌面链前 10 条，在“真实改名/移动/删除”和随后目录移动风险取消用例失败；由于主链非零，原生快捷键、重启恢复和生产构建没有继续执行；
- Windows 诊断 artifact `plainroot-windows-30280357578` 的 SHA-256 为 `15c6bfd89a5c263128a75e6adb80dde3fa553beb38701baedf3257e755350ebc`。截图显示删除步骤实际停留在上一文件的移动弹层，且后续可见残留结算弹层；结合反复出现的动态标题查找告警，根因是 WDIO Tauri service 在 WebView2 下按已变化的原生标题选择错误渲染器，而非 Rust 改名、移动、回收站或风险分析返回失败。

整改没有把磁盘链替换成测试命令或 mock。`desktop-shell.e2e.mjs` 在当前 WebView 文档内等待并点击真实文件树按钮、按 `aria-labelledby` 精确限定生产弹层、派发真实 `input`/`change` 事件，然后继续等待真实页签、Tauri IPC 和磁盘字节结果；每个失败仍立即终止，不增加业务重试。失败清理也只通过现有取消按钮关闭残留生产弹层。修复后本机主桌面 spec 已连续两次通过 12/12；第五轮已经远端通过的 macOS 原生快捷键、重启种子和恢复实现没有修改。本轮因本机无 bundle WebDriver 的辅助功能窗口身份不可激活，未把新的本机原生快捷键试验计入证据，最终仍以最新远端两平台完整执行为完成门禁。

### 3.5 第六次远端运行与 Windows 原生菜单就绪整改

GitHub Actions run `30285162108` 对提交 `bdc4c215d80c85bd95adcfb709ff2205a051a4ce` 给出新的有效证据：

- macOS 再次通过完整门禁、15 条桌面 E2E、未签名生产构建和 artifact 上传；`plainroot-macos-30285162108` 的 SHA-256 为 `48029701e808050719577f75b90d5350ecc48363a2453a2dee19449e5fccf521`；
- Windows 已通过非桌面门禁、Rust fmt/Clippy、Rust 测试和主桌面链 12/12，证明第五轮 WebView2 当前渲染器整改真实闭合；
- Windows 随后在原生页签快捷键专项发送按键之前失败。日志持续报告 WDIO Tauri service 无法按动态文档标题切换活动 renderer，`e2e_tab_shortcuts_ready` 因此无法取得菜单状态；当次没有发送 `Ctrl+Tab`，不能据此判定产品快捷键失败；
- Windows 诊断 artifact `plainroot-windows-30285162108` 的 SHA-256 为 `3ae0cc1a117e93f369cee25c0df528af81215ab49767f966dc5773c87db35aba`。

当前整改仅调整 Windows 原生快捷键测试的可观察前置条件：目标进程成为前台后，从 UI Automation 原生可访问性树等待对应页签菜单项启用；随后仍只发送一次系统按键，并通过原生窗口标题确认切换结果。macOS 保持第六轮已通过的 System Events + Rust/Tauri 菜单探针路径不变。该修复不修改产品菜单、命令路由、IPC、权限或快捷键映射，必须由下一轮 Windows runner 验证。

### 3.6 第七次远端运行与折叠菜单可访问性整改

GitHub Actions run `30287098572` 对提交 `30b44ad5a7b24accc2aa729535265cc087566ff2` 给出新的有效证据：

- macOS 再次完整通过并上传 `plainroot-macos-30287098572`，SHA-256 为 `5682950a5080c55c570dcbab9e7b29224fedd7d1880b7a92fd92177a99324e66`；
- Windows 再次通过非桌面门禁、Rust 门禁和主桌面链 12/12，随后在原生快捷键专项等待 UI Automation 菜单项启用时超时；当次仍未发送按键；
- Windows 诊断 artifact `plainroot-windows-30287098572` 的 SHA-256 为 `31dee948ffb2f9095fedddacbabd463ec570c5b724a40f9d3741bc5817f2f56c`；
- PowerShell 已取得窗口 AutomationElement，但折叠状态下只查询窗口后代无法看到子菜单项。当前修复先通过 `ExpandCollapsePattern` 展开顶层“页签”菜单，再从同一进程的桌面可访问性树读取目标子项，最终在 `finally` 收起菜单；前台与标题结果门禁保持不变。

### 3.7 第八次远端运行与快捷键测试标题隔离

GitHub Actions run `30288530855` 对提交 `89fb7bd8c8dbd582a2d41afd283bc9b868c7a651` 给出新的有效证据：

- macOS 再次完整通过并上传 `plainroot-macos-30288530855`，SHA-256 为 `e90c0819f7a91a482af0591389c9f642acda533c19f78d054bdb5d6f030d01b9`；
- Windows 再次通过非桌面门禁、Rust 门禁和主桌面链 12/12；主动展开顶层菜单后，UI Automation 仍未暴露目标子菜单项，快捷键专项在发送按键前安全失败；
- Windows 诊断 artifact `plainroot-windows-30288530855` 的 SHA-256 为 `9d8f0d69242fbf7544ef94fa23d99032df2d6cf06f20de18d8a721d6a79ffbf9`。

当前整改不再把测试正确性建立在 Tauri/Windows 未暴露的 HMENU 或 UI Automation 子树上。`PLAINROOT_E2E_FIXED_WINDOW_TITLE` 由 Windows E2E 隔离进程注入，且只在 `e2e` feature 编译分支读取；它把与业务断言无关的文档标题变化固定为工作区标题，使 WDIO 能持续读取同一真实 renderer、调用既有只读菜单探针并读取真实页签选中态。产品菜单状态、快捷键、命令路由和页签标题逻辑在默认构建中不变。

### 3.8 第九次远端运行与全 Windows E2E 标题隔离

GitHub Actions run `30290219296` 对提交 `a280f978f38e8eed1ddb82fa69f86eae358097e9` 给出新的有效证据：

- macOS 再次完整通过并上传 `plainroot-macos-30290219296`，SHA-256 为 `c530f11bc23ed3748eba7e635dafec009ec80ee8ded58acf02163eea64307eec`；
- Windows 通过非桌面门禁、Rust 门禁并在主桌面链完成 10/12；手动保存和恢复副本两项在动态标题变化后由 WDIO 路由到失效 renderer，真实磁盘保存已经发生，但后续可见状态/源码断言无法读取；
- 原生快捷键专项尚未运行；Windows 诊断 artifact `plainroot-windows-30290219296` 的 SHA-256 为 `b1a5d2518672b8659efba8fc7e18a2963d04c8ff10098d4a2d0817facdbb0f99`。

因此固定标题测试缝现由 `runDesktopSpec` 为每个 Windows E2E 隔离进程统一注入，而非仅覆盖快捷键进程。该变更不替换 React handler、Tauri IPC、Rust 磁盘操作、恢复仓储、菜单状态或系统输入，只稳定 WebDriver 与实际 WebView2 renderer 的连接。

### 3.9 第十次远端运行与单窗口菜单同步

GitHub Actions run `30291901180` 对提交 `a25af90f271cfe92347de7040b1b0a2effe317b6` 给出新的有效证据：

- macOS 再次完整通过并上传 `plainroot-macos-30291901180`，SHA-256 为 `228473f8411c6e7d64b394e17579cff079a46640751fdf693aede8f341046bee`；
- Windows 通过非桌面门禁、Rust 门禁和主桌面链 12/12，证明全 Windows E2E 固定标题已消除主链 renderer 漂移；
- 原生快捷键专项能持续调用 `e2e_tab_shortcuts_ready`，但真实下一/上一菜单项未启用，因此在发送系统按键前安全失败；Windows 诊断 artifact `plainroot-windows-30291901180` 的 SHA-256 为 `dede64c0ccccd205f9a66fe70269e45e254c321964fe66be0e07f1516640e2a9`。

第十轮直接证据只能证明探针最终未同时观察到 policy 与原生菜单就绪，旧实现又只在 `window.is_focused()` 为真时把 registry 状态应用到菜单；它没有输出足够信息区分 registry 尚忙与原生菜单陈旧。当前按最窄可复验假设处理：单窗口无论暂时是否聚焦都持续应用自身状态，只有同时存在多个窗口时才继续严格按聚焦窗口路由。纯函数门禁覆盖单窗口后台、多窗口聚焦和多窗口后台三种情况；E2E 探针同时新增脱敏的 registry/menu 诊断，若下一轮仍失败即可直接区分两类状态，不再靠推测。

### 3.10 第十五次远端运行与双平台完成证据

GitHub Actions run `30322298422` 对提交 `9ba28d1bd077b950059b6b474e7da77cf173ea63` 给出 T45 完成证据：

- macOS 与 Windows 两个作业均正式 `success`，完整执行统一非桌面门禁、四段 15/15 真实桌面链和未签名生产构建；
- Windows 首次以真实系统 `Ctrl+PageDown/PageUp` 通过下一/上一页签切换，同时保留 12/12 主链、跨进程会话种子和恢复/缺失项隔离；
- `plainroot-macos-30322298422` artifact SHA-256 为 `15541ac7491602e740d5d93518ab1d58c258ee3c0da442c7ee0d82a346a9bb95`；
- `plainroot-windows-30322298422` artifact SHA-256 为 `4da211e9404884e3119b0854034ebf094bd42f4218adf62b10bcd7a500e5e23e`。

### 3.11 第十六次远端运行与收口文档证据

GitHub Actions run `30323620642` 对纯文档提交 `a0268eb2482face230bb6458f085a68afcfaeaed` 再次给出 macOS/Windows 双绿、四段 15/15 桌面链与成对 artifact：

- `plainroot-macos-30323620642` artifact SHA-256 为 `d16334981a0f6a6c7be01734b80a67da1acaf21f72a237d4be5a44d28aeaba07`；
- `plainroot-windows-30323620642` artifact SHA-256 为 `482ca21af722bf0b66980c59844a87408921a2a798d2d2de9bf923d468315ced`。

第十五次 run 是覆盖全部 T45 代码的完成证据；第十六次 run 是证明首轮收口文档提交仍双绿的补充证据。二者不可互换提交归属。

## 4. 未验证项

- Windows 原生选择器、回收站、Explorer、菜单和辅助技术仍是人工项。
- Windows E2E 为避免 WDIO/WebView2 renderer 漂移而固定原生窗口标题，因此没有覆盖生产“标题随活动文档变化”的 Windows 路径；macOS 主链与前端标题契约仍覆盖该行为。
- 真实多窗口整组退出、系统 IME、JS heap、长时峰值内存、休眠、网络卷和文件系统卸载仍无完整产品级证据。
- macOS 本轮验证了替换 intent 的拒绝分支；多窗口整组退出与允许替换的完整系统级人工链仍留待 T46 汇总或后续平台验收。

## 5. 文档与约束同步

- `plan.md`：T45 标记为已完成，并记录本地与远端双平台验证、artifact 和剩余人工边界。
- `../requirement.md`：只更新阶段 3 的真实开发/验证状态；R 编号、范围、建议项处理和验收标准未改变。
- `README.md`：更新四段 E2E 入口、当前 macOS 证据和 T45 留痕入口。
- `../architecture/desktop-foundation.md`、`../architecture/markdown-document-editing.md`：同步测试拓扑、平台快捷键和真实恢复边界；没有创建新的产品架构模块。
- `AGENTS.md`：只沉淀最新稳定命令、平台映射、证据边界和计数，不记录试错流水。
- `DESIGN.md`：同步页签切换的平台交互契约；`CLAUDE.md` 与页面开发流程无需更新，没有新增协作入口、页面、组件、token 或布局契约。
- SQL、seed、数据库、产品权限/capability、菜单动作集合、产品配置、生产环境变量和初始化数据无需更新：本次只调整既有页签菜单的平台加速键，并扩展编译期隔离测试链。

## 6. 当前结论

T45 已完成。十六轮第三阶段远端运行依次暴露并验证了 Windows CRLF 契约解析、平台 lint、测试前置、WebView/renderer 定位和原生菜单组合键路由等真实跨平台边界；整改没有跳过真实输入、降低业务断言或加入业务重试。代码 run `30322298422` 覆盖提交 `9ba28d1` 的全部 T45 实现，收口文档 run `30323620642` 覆盖其上的纯文档提交 `a0268eb`；两次均取得 macOS/Windows 双绿、四段 15/15 桌面链与可追溯成对 artifact。Windows 原生标题更新、系统 UI 人工项、长时性能边界和真实多窗口整组退出继续如实保留；T46 未开始。
