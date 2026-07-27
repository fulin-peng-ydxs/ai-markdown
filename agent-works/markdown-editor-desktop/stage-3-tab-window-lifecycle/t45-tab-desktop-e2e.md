# T45 真实桌面 E2E 与双平台门禁留痕

## 1. 任务边界

- 对应任务：第三阶段 `T45`。
- 对应需求：R1、R2、R3、R5、R6、R10、R11、R13、R14、R30、R31 的真实桌面验证子集。
- 本次完成桌面测试编排、macOS 原生页签组合键、真实窗口替换拒绝和跨进程会话恢复；不进入 T46 阶段验收。
- 最新实现已推送并触发首次第三阶段双平台运行；macOS 作业通过，Windows 在非桌面契约守卫阶段失败。失败已定位为契约测试解析器只识别 LF、未兼容 Windows checkout 的 CRLF，而不是产品链路通过。T45 状态保持“进行中”，修复提交必须重新取得双平台结果后才能完成。

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
- Windows：轮询 Win32 `GetForegroundWindow` 与原生菜单 `GetMenuState`，确认目标窗口前台且对应菜单项启用后发送 `Ctrl+Tab` / `Ctrl+Shift+Tab`。

macOS 在最新重建的 Tauri E2E release 二进制上发现 `Cmd+Shift+]` 可触发，但 `Cmd+Shift+[` 不会到达菜单动作；因此没有保留不可用的对称外观，而是收敛为双向均实际通过的 `Cmd+Option+Right/Left`。Windows 映射保持平台常用组合，但尚未在 Windows runner 运行，不能记为通过。

React 没有新增全局 keydown；原生菜单仍通过唯一 `WORKBENCH_MENU_EVENT` 路由到现有 `WorkspaceTabManager`。

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
- 同一前置条件也已应用到 Windows 分支：不再使用固定 500 ms 延时，而是通过 Win32 窗口与原生菜单状态等待就绪。该代码尚未在 Windows 执行，不能由 macOS 通过结果推断其可用。
- Windows 前置门禁整改后的首次 macOS 回归又真实暴露 System Events 单次枚举尚未发现新进程窗口的失败；窗口发现因此也改为有界等待。该等待只建立系统输入前置条件，不重复发送快捷键或重试业务断言；整改后完整四段链再次以 15/15 通过。

WDIO Tauri service 在 macOS 会输出无法按动态文档标题切换原生窗口的告警，但 WebDriver 会话、断言与 spec 均完成；这些告警不被当成通过证据，也未通过关闭断言或业务重试掩盖。

### 3.2 非桌面门禁

`pnpm verify:non-desktop` 从头通过：

- Node 独立回归：30/30；
- Vitest：32 个文件、267/267；
- Rust no-default-features：206 项通过，另 1 项手动性能探针忽略；
- Rust all-features：206 项通过，另 1 项手动性能探针忽略；
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

## 4. 未验证项

- 修复后的最新提交尚未取得 GitHub Actions macOS/Windows 双绿与成对生产 artifact；首次 run `30272399213` 不能作为 T45 通过证据。
- Windows 首次 run 在非桌面契约守卫阶段停止，因此 Rust 全门禁、WebView2 15 条桌面链、`Ctrl+Tab` / `Ctrl+Shift+Tab` 真实系统输入和生产构建仍未验证。
- Windows 原生选择器、回收站、Explorer、菜单和辅助技术仍是人工项。
- 真实多窗口整组退出、系统 IME、JS heap、长时峰值内存、休眠、网络卷和文件系统卸载仍无完整产品级证据。
- macOS 本轮验证了替换 intent 的拒绝分支；多窗口整组退出与允许替换的完整系统级人工链仍留待 T46 汇总或后续平台验收。

## 5. 文档与约束同步

- `plan.md`：T45 标记为进行中，并分别记录本地实现/macOS 验证已完成与远端双平台待验证，同步需求映射、验证基线和实际落地。
- `../requirement.md`：只更新阶段 3 的真实开发/验证状态；R 编号、范围、建议项处理和验收标准未改变。
- `README.md`：更新四段 E2E 入口、当前 macOS 证据和 T45 留痕入口。
- `../architecture/desktop-foundation.md`、`../architecture/markdown-document-editing.md`：同步测试拓扑、平台快捷键和真实恢复边界；没有创建新的产品架构模块。
- `AGENTS.md`：只沉淀最新稳定命令、平台映射、证据边界和计数，不记录试错流水。
- `DESIGN.md`、`CLAUDE.md`、页面开发流程无需更新：没有新增生产页面、组件、token、布局契约或协作入口。
- SQL、seed、数据库、产品权限/capability、菜单动作集合、产品配置、生产环境变量和初始化数据无需更新：本次只调整既有页签菜单的平台加速键，并扩展编译期隔离测试链。

## 6. 当前结论

T45 的本地实现、macOS 桌面证据和非桌面回归已闭合。首次第三阶段远端运行真实发现 Windows CRLF 下契约守卫提前失败，现已完成本地修复与针对性回归，但完成标准仍要求修复提交在 macOS/Windows 远端双绿并可追溯 artifact。T45 继续保持“进行中”；T46 未开始。
