# T18 编辑器依赖与 PoC 开发留痕

## 1. 功能的详细需求

T18 是第二阶段正式编辑器开发前的技术硬门禁，对应 R1、R3、R6、R10 的技术可行性子集，不直接交付产品功能。任务要求在当前 Tauri 2 + React + TypeScript + Vite 技术栈中验证 Milkdown/ProseMirror 与 CodeMirror 6，并满足以下条件：

- 精确锁定编辑器依赖，许可证策略不放宽；
- CommonMark、GFM、中文/英文、表格、图片、代码块和 raw HTML 能稳定语义往返；
- 未验证支持的 frontmatter、自定义 directive、wiki link 和 MDX 组件不被排版编辑器静默改写，必须保留原始源码并进入源码安全路径；
- 两个 editor 可以创建、聚焦、处理 composition/剪贴板并完整销毁；
- 记录 100 KiB、5 MiB、20 MiB、64 MiB 文档的序列化/hash 成本、编辑器依赖包体和首次加载数据；
- PoC 不得接入正式 P1，不得创建菜单、权限、配置、持久化或用户数据副作用；任一硬门禁失败时停止 T19。

事实源为 `requirement.md` 2.1、R3/R6/R10 验收条目以及本阶段 `plan.md` 6.1。

## 2. 功能开发的实际结果

T18 结论为通过，可以进入 T19，但不能据此宣称 R3、R6 或 R10 已完成。

- `package.json` 与 `pnpm-lock.yaml` 精确锁定 `@milkdown/kit@7.21.3`、`@milkdown/react@7.21.3`、`codemirror@6.0.2`、`@codemirror/lang-markdown@6.5.1`；四个直接依赖均为 MIT。
- `src/features/editor/poc/` 建立隔离的 Milkdown 直接 adapter、React adapter、CodeMirror adapter、浏览器 PoC、异常语法分类器和包体探针；这些模块未被 `src/App.tsx` 或正式 P1 导入。
- `tests/fixtures/markdown/` 建立 CommonMark/GFM、raw HTML 与 source-only 三类语料。
- 7 个专项测试验证 React 挂载/销毁、稳定语义往返、raw HTML 保留且不生成可执行 `script`、焦点、composition、剪贴板、CodeMirror 生命周期、异常语法原文保留与 fenced code 排除。
- 受支持 Markdown 的“无损”落实为语义和规范化输出稳定，不把列表符号、分隔线和表格空格等合法规范化误判为数据丢失；异常扩展语法不进入排版往返。
- 真实 Chromium 页面加载后，Milkdown 首次 ready 为 104.8 ms、CodeMirror 为 3.8 ms，两个 editor 均完成中文输入且控制台无错误。
- macOS Tauri WebKit 605.1.15 已真实启动并加载两个 editor；WebDriver 自动化中文按键未能写入 contenteditable，且本机 UI 当时处于锁定状态，未取得人工输入证据。该缺口不伪报为通过，完整 WebKit/Windows 输入由 T23/T31 在产品 adapter 与桌面 E2E 中继续验证。
- 正式生产入口未加载编辑器 PoC，生产 JS 保持 247.44 kB / gzip 75.91 kB；独立编辑器依赖 chunk（排除仓库既有 React）为 1,063,853 B / gzip 347,935 B，证明 T23 必须按文档首次打开懒加载，不能并入根启动包。
- 没有新增数据库、SQL、seed、产品环境变量、Tauri capability、菜单、用户偏好或初始化数据。

## 3. 功能开发的具体实施方案

### 3.1 解析、编辑器与安全降级

- `milkdownPoc.ts` 统一装配 CommonMark、GFM、clipboard、history 和 listener；`MilkdownReactPoc.tsx` 复用同一个工厂，避免直接/React 两套配置漂移。
- `codeMirrorPoc.ts` 只验证 CodeMirror 6 Markdown 创建、输入、焦点和销毁，不建立第二份文件或保存通道。
- `markdownCompatibility.ts` 使用保守 source-only 分类识别本阶段没有往返证据的语法，并忽略 fenced code 中的示例文本。该分类器是 T18 技术证据，T19/T23 仍须把它接入唯一 `DocumentSession`，当前不会改变 P1 行为。
- `browserPoc.tsx` 与 `poc.html` 仅用于开发验证，不在 Vite 正式入口图中；`editorBundleProbe.ts` 只为构建统计保留依赖引用。

### 3.2 性能和包体

`scripts/editor-poc-report.mjs` 可重复生成四个尺寸的 JSON 序列化、SHA-256 和编辑器依赖 chunk 报告。本次 Node 24.11.1 实测如下：

| 文档尺寸 | JSON 序列化 | SHA-256 |
| --- | ---: | ---: |
| 100 KiB | 0.23 ms | 0.31 ms |
| 5 MiB | 6.41 ms | 6.08 ms |
| 20 MiB | 21.70 ms | 25.27 ms |
| 64 MiB | 85.85 ms | 106.75 ms |

这些数字只证明前端传输前序列化与 hash 的数量级，不代表 64 MiB 文档已完成 Milkdown 排版、自动保存或恢复快照产品验收。800 ms/2 秒/5 秒防抖仍是候选值，须由 T26 结合真实写盘次数、编辑延迟和大文档策略校准。

### 3.3 复用判断

- 复用现有 Vitest/jsdom、Vite 构建、许可证扫描和 package script 体系，没有建立第二套测试运行器。
- Milkdown 直接 adapter 与 React adapter 共同消费 `createMilkdownPocEditor`，同一职责没有复制配置。
- T18 没有生产页面或第二个稳定运行时消费者，因此不把 PoC 抽成 `src/components` 公共组件，也不登记到 `DESIGN.md` 运行时组件表。
- 现有 `AppDialog`、`AsyncStatePanel`、`focusContainment`、`workspacePath` 与 P1/P2 状态均未改动，无需为了 PoC 制造无消费者的复用层。

## 4. 上线部署操作

T18 不产生可发布产品能力，不需要 SQL、seed、数据迁移、权限、菜单、配置、环境变量或服务部署操作。提交后普通开发者只需使用仓库固定工具链执行：

```bash
nvm use
pnpm install --frozen-lockfile
pnpm test:editor-poc
pnpm test:editor-poc:performance
```

正式构建仍执行 `pnpm build` 或 `pnpm tauri build --no-bundle`，不会包含隔离 PoC 页面和 bundle probe。回滚 T18 只需回滚本任务提交和锁文件；没有用户数据或持久化格式需要回滚。

## 5. 验证情况

### 5.1 已执行并通过

- Node 24.11.1 / pnpm 11.5.1 下 `pnpm install --frozen-lockfile`；
- `pnpm typecheck`；
- `pnpm test:editor-poc`：7/7；
- `pnpm test`：许可证 4/4、永久删除反馈 4/4、路径 3/3、树状态 18/18、fixture 1/1、Vitest 汇总 42/42（包含 7 个 PoC 测试）；
- `pnpm test:editor-poc:performance`；
- `pnpm test:licenses`；
- `pnpm licenses:check`：727 Node / 508 Rust / 0 阻断；
- `pnpm build`：正式 JS 247.44 kB / gzip 75.91 kB；
- `pnpm tauri build --no-bundle`；
- 生产 `dist` 与 release 二进制无 `editorBundleProbe`、PoC 输入文本或 PoC 工厂标记；
- `git diff --check`；
- 真实 Chromium 交互：两个 editor 中文输入、焦点和无控制台错误；
- 真实 macOS Tauri WebKit 605.1.15：应用与两个 editor 加载成功。

### 5.2 未通过或未执行

- macOS WebKit 自动化按键未写入 contenteditable；这次失败不表示 editor 解析/加载失败，但也不能作为中文输入通过证据。人工 UI 因本机处于锁定状态未执行。
- Windows 编译、WebView2 输入和远端 CI 未执行；T18 是本地任务，T31 承接双平台 CI。
- 64 MiB 文档的 Milkdown 全量排版、连续输入、自动保存和恢复快照未执行；本任务只测序列化/hash 边界，产品性能由 T23/T26/T31 承接。
- 未重跑既有 4/4 P1/P2 桌面 E2E，因为 T18 未进入正式 P1 入口；正式生产 Tauri 构建和全量前端回归已证明既有入口未被依赖图改变。

## 6. 关联文档同步结论

- `requirement.md`：只更新第二阶段/T18 实施状态和证据边界，R 编号、范围、建议项和产品验收标准不变。
- `plan.md`：T18 改为已完成，R1/R3/R6/R10 改为进行中并明确只是技术子集，T19 仍待开始。
- `README.md`、`AGENTS.md`：更新稳定依赖、命令、测试与许可证事实；不写临时代理配置或本机失败流水。
- `DESIGN.md`：不需要更新，原因是 T18 没有生产页面、token、组件或交互契约变化。
- `CLAUDE.md`：不需要更新，原因是其仍是稳定薄入口，没有新的长期协作规则。
- `architecture/desktop-foundation.md`：不需要更新，原因是正式 P1 和桌面底座架构未接入 editor；第二阶段生产架构由 T32 在真实模块落地后建立。
- SQL、seed、权限、菜单、Tauri capability、产品配置与环境变量文档：不需要更新，原因是本任务没有产生对应稳定事实。
