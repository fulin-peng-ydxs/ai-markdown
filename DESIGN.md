---
version: alpha
name: Plainroot
description: 面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器，采用安静、克制、适合长时间写作与阅读的中性工作台视觉。
colors:
  stage: "#d7d7d8"
  chrome: "#ececed"
  chrome-strong: "#e4e4e6"
  paper: "#f3f3f2"
  paper-deep: "#eeeeed"
  heading: "#222226"
  text: "#28282c"
  muted: "#66666d"
  quiet: "#85858c"
  line: "#ceced2"
  line-strong: "#b9b9bf"
  accent: "#70677f"
  accent-soft: "#dedbe3"
  on-accent: "#ffffff"
  success: "#52735e"
  warning: "#8a6d3f"
  danger: "#9b5050"
typography:
  ui-sm:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
  ui-md:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  document-body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.76
  document-h1:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 35px
    fontWeight: 720
    lineHeight: 1.22
  code:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: 4px
  md: 6px
  lg: 9px
  window: 11px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
  input-default:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line}"
    focusColor: "{colors.accent}"
    rounded: "{rounded.sm}"
  dialog-default:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.lg}"
  document-canvas:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    maxWidth: 800px
---

# Plainroot Design System

> 本文是 Plainroot 前端视觉、布局和交互的长期入口。当前正式工程尚未建立，因此 alpha token 来自三份已确认原型的共同实现；工程落地后，运行时代码与自动化测试应成为数值事实源，并同步更新本文。

当前证据：

- 工作台：`agent-works/markdown-editor-desktop/prototypes/markdown-workbench.html`
- 启动页：`agent-works/markdown-editor-desktop/prototypes/workspace-launcher.html`
- 主题工作室：`agent-works/markdown-editor-desktop/prototypes/theme-preset-studio.html`
- 产品状态、范围与交互：`agent-works/markdown-editor-desktop/requirement.md`
- 页面开发流程：`agent-works/markdown-editor-desktop/page-development-workflow.md`

## 1. Visual Theme & Atmosphere

Plainroot 是本地写作与阅读工具，不是通用后台、营销页面或知识图谱产品。界面应安静、稳定、克制，让窗口 chrome 退居背景，让文档、路径和保存状态成为主角。

Key Characteristics：

- 使用暖度极低的中性灰纸面，不使用纯白大面积背景，也不使用纯黑正文。
- 紫灰 `accent` 只承担选中、焦点、主操作和少量结构提示，不做大面积装饰渐变。
- 通过纸面、chrome、边框和轻阴影表达层级；避免卡片套卡片和悬浮面板堆叠。
- 桌面控件紧凑，正文排版舒展。应用壳和阅读区不能共用同一字号密度。
- 真实文件状态优先于装饰：保存、只读、冲突、失效和错误必须有文字或结构表达，不能只靠颜色。
- 平台窗口控制尊重 Windows/macOS 原生惯例，不把 macOS 红黄绿按钮机械复制到 Windows。

## 2. Color Palette & Roles

| 角色 | Token | 用法 |
|---|---|---|
| 原型舞台 | `stage` | 仅用于独立原型外部背景；正式原生窗口内不应出现 |
| 应用 chrome | `chrome` / `chrome-strong` | 侧栏、工具栏、状态栏与标题栏；`strong` 用于更稳定的边界层 |
| 文档纸面 | `paper` / `paper-deep` | 编辑器、输入面和普通对话框；`deep` 用于代码块、说明块和轻量选中 |
| 主文字 | `heading` / `text` | 标题与正文，确保长期阅读清晰 |
| 弱文字 | `muted` / `quiet` | 路径、时间、快捷键和辅助说明；关键错误或操作不可只用 `quiet` |
| 边界 | `line` / `line-strong` | 常规分隔与强调边界，不用阴影替代所有分隔 |
| 交互强调 | `accent` / `accent-soft` | 主按钮、活动页签、焦点、当前大纲与轻选中 |
| 状态 | `success` / `warning` / `danger` | 成功、警告、失败或破坏性动作；必须搭配文字、图标或结构语义 |

规则：

- 页面和组件只消费语义 token，不在局部复制相同 hex。
- 主按钮可用 `accent` 实底；次按钮使用 `paper + line-strong`；危险按钮默认保持浅背景与危险文字，只有明确不可逆且需要强提醒时才考虑实底。
- Hover 优先由当前表面与 `text`/`accent` 混合得到，不另建随机灰色。
- 自定义主题保存至少要满足普通文字 `4.5:1`、大字号文字 `3:1` 的对比目标；明暗两套是否必须联合通过见 Known Gaps。
- 颜色预设不得改变 Markdown 文件内容，也不得把状态色当作正文任意着色工具。

## 3. Typography Rules

字体族：

- UI 与正文使用系统无衬线栈，保证 Windows/macOS 离线可用；不依赖联网字体。
- Markdown 源码、路径、色值和代码使用系统等宽栈。

层级：

| 场景 | 建议层级 | 规则 |
|---|---|---|
| 工具栏、树、页签、状态栏 | `ui-sm` | 主要在 `10.5–12.5px` 原型区间内校准，保持可读，不用小字制造“专业感” |
| 对话框正文与普通表单 | `ui-md` | 使用清楚的行高，说明文字可降一级但不得发灰到不可读 |
| 长文正文 | `document-body` | alpha 基线 `17px / 1.76`，窄窗口可轻微收敛但不能与 UI 字号混用 |
| 文档 H1/H2/H3 | 35/23/18px 基线 | 主要靠字号、字重、留白和分隔线分层，不靠彩色标题 |
| Markdown 源码与代码块 | `code` | 保留滚动与原始文本，不因美化静默改写 |

排版原则：

- 正文宽度以约 `760–820px` 为 alpha 校准范围，宽屏不无限拉长；当前画布 token 上限为 `800px`。
- 段落、列表、引用、代码块和标题使用稳定垂直节奏，优先消费 spacing token。
- 文件名和路径默认单行省略并提供完整值；正文长文本按 Markdown 语义正常换行。
- 数值、快捷键和路径不使用装饰性字重；粗体只表达结构或业务强调。

## 4. Component Stylings

### 应用窗口与 chrome

- 窗口由标题栏、可选页签层、文档工具层、主工作区和状态栏组成；稳定 chrome 不随正文滚动。
- 原型外框 `11px` 圆角和大阴影只用于非原生演示窗口；正式 Tauri 窗口是否保留外框取决于平台装饰方式。
- 标题栏、菜单和窗口控制必须具有平台适配，不用网页按钮伪造系统能力。

### 按钮、图标与输入

- 同一操作组最多一个主按钮。次要、取消和危险操作保持明确层级。
- 纯图标按钮使用约 `29–30px` 点击面、`16px` 图标、透明默认背景；必须提供可访问名称和 tooltip。
- 输入框使用 `paper` 表面、`line` 边框；聚焦时使用 `accent` 边框和轻量 focus ring，不能只移除 outline。
- Disabled 除降低透明度外还要保留不可用语义；Loading 防止重复提交但不隐藏当前目标和安全状态。

### 页签、文件树与大纲

- 活动页签用纸面、主文字和底部 `accent` 线表示；未保存状态使用点标记并配合可访问文本。
- 页签文件名、路径、树节点和大纲长文本单行省略；完整内容通过 tooltip、状态栏或详情承接。
- 文件树与大纲各自只在明确侧区内滚动，中央正文拥有主滚动；避免窗口、页面、正文三层同时滚动。
- 文件树的选中、磁盘处理中、只读、失效和错误状态必须区分，不能把 hover 当作选中。

### 对话框、状态与反馈

- 普通确认和少字段输入使用居中 dialog；目录决策、冲突和关闭保护必须写明对象、后果与安全边界。
- 破坏性按钮使用具体动词，如“放弃并关闭”“移除记录”，不使用含糊“确定”。
- 对话框支持 Esc、焦点圈定和关闭后焦点恢复；存在未保存草稿或破坏性结果时，Esc 行为必须与取消契约一致。
- Toast 只报告已完成的轻量结果，不承载需要选择、重试或长期查看的错误。
- 页面至少覆盖 ready、loading、empty、error；文件场景再按需覆盖 readonly、dirty、saving、conflict、missing 和 permission-denied，状态之间必须有明确优先级。

### 文档画布与主题工作室

- 编辑画布以 `paper` 为连续纸面，不把每个 Markdown 块做成卡片。
- 源码模式保留等宽文本、原始字符和滚动位置；排版模式与源码模式共享内容状态。
- 主题工作室保持“预设库 → token 编辑 → 实时预览 → 固定提交区”的关系。内置预设只读，草稿与已保存值视觉上可辨。
- 颜色错误紧邻字段显示具体 token、调色板和比值，不能只显示全局红色提示。

## 5. Layout Principles

页面原型：

| 页面 | 原型类型 | 主任务 | 核心结构 |
|---|---|---|---|
| Markdown 工作台 P1 | workbench | 编辑与阅读当前文档 | 窗口 chrome + 页签 + 工具栏 + 文件树/文档/大纲 + 状态栏 |
| 工作区启动 P2 | launcher | 打开本地目录或文件 | 欢迎与主入口 + 最近工作区列表 |
| 颜色主题工作室 P3 | settings studio | 编辑、验证、预览并保存主题 | 设置导航 + 预设库 + token 编辑 + 实时预览 + 固定提交区 |

布局规则：

- 主内容区必须获得剩余空间；使用 `minmax(0, 1fr)`、`min-width: 0` 和 `min-height: 0` 处理真实溢出，不靠随意硬编码视口高度。
- 工作台中央文档优先保留宽度。alpha 侧栏基线为左 `252px`、右 `220px`，正式实现需支持拖动、边界夹取、键盘调整和工作区记忆。
- 标题栏、页签、工具栏和状态栏保持稳定；文件树、大纲、编辑画布各自管理明确滚动，不让整页滚动吞掉窗口 chrome。
- 启动页只有“打开本地内容”一个主任务；最近列表是辅助入口，不加入营销导航、统计卡或空洞欢迎区。
- 主题工作室预览是验证编辑结果的必要区域，不得缩成无反馈的色块；低宽度先减少设置导航和次要预览 chrome。
- 弹窗覆盖当前任务但不改变背后工作区状态；复杂长流程若未来出现，优先独立设置页或明确分区，不塞进小对话框。

## 6. Depth & Elevation

- 常规层级优先用背景明度和 `line` 边界；卡片与列表行默认不加阴影。
- 原型窗口可使用双层轻阴影表达演示舞台；正式原生窗口使用系统阴影，不叠加网页大阴影。
- Dialog 使用 `line-strong`、`rounded.lg` 和单一高层阴影；Popover 比 dialog 更轻，Toast 使用深色实底。
- 圆角遵循 `4 / 6 / 9 / 11px` 层级：微控件、普通控件、浮层、原型窗口。不得在页面内随机新增相近圆角。
- 遮罩保持中性半透明，确保上下文仍可识别；z-index 建立少量语义层级，不使用不断增大的局部数字竞争。

## 7. Do's and Don'ts

Do：

- 让文档、文件名、路径和真实状态主导界面层级。
- 优先复用同类组件和状态模型；第二处相同行为形成复用单元。
- 使用语义 token、稳定间距和平台原生能力。
- 为 loading、empty、error、只读、冲突和权限撤销提供真实承接。
- 用清晰动词描述保存、覆盖、另存、移除和放弃的结果。

Don't：

- 不做大 hero、渐变光晕、玻璃拟态、统计卡片墙或通用后台侧栏。
- 不把 Markdown 区块卡片化，不用纯白/纯黑制造强对比疲劳。
- 不新增无真实实现的可点击控件，不用固定数据或 toast 伪装系统能力。
- 不让页面、侧栏、弹窗和编辑器同时形成无边界的多层滚动。
- 不把长路径、文件名或页签强制换行撑高 chrome。
- 不用颜色作为保存、冲突、选中或危险状态的唯一表达。
- 不把主题颜色写进 Markdown，不把排版设置混入颜色预设身份。

## 8. Responsive Behavior

Plainroot 首发是桌面应用，响应式目标是窄桌面窗口可用，不是手机端重排。

- `≥1180px`：工作台三栏完整；主题工作室保留设置导航、预设库、编辑和预览。
- `940–1179px`：主题工作室先隐藏低频设置导航；工作台仍优先保证中央编辑器。
- `821–1050px`：工作台右侧大纲退化为按需抽屉，右侧理想宽度仍保存在工作区偏好中。
- `≤820px`：工作台左侧文件树也退化为抽屉，页签允许横向滚动，中央文档保留最小安全留白。
- 启动页约 `760px` 以下由双栏变单栏；打开入口仍在最近列表之前，窗口 chrome 不丢失。
- 主题工作室当前原型最小宽度为 `760px`，不承诺手机布局；更窄窗口应阻止继续压缩或采用后续确认的分步编辑方案。
- 窄窗口退化不能覆盖已保存的理想侧栏宽度；恢复到宽窗口时回到用户设置。
- 所有模式支持键盘操作、可见焦点和 `prefers-reduced-motion`；隐藏区域必须有可发现的恢复入口。

## 9. Agent Prompt Guide

Quick Color Reference：

- 应用 chrome：`{colors.chrome}` / `{colors.chrome-strong}`
- 文档纸面：`{colors.paper}` / `{colors.paper-deep}`
- 正文：`{colors.heading}` / `{colors.text}` / `{colors.muted}`
- 交互：`{colors.accent}` / `{colors.accent-soft}`
- 边界：`{colors.line}` / `{colors.line-strong}`

Example Component Prompts：

- “按 Plainroot launcher 原型实现最近工作区空态：保留打开本地内容主入口，使用 paper/chrome 层级，不新增统计卡，并覆盖路径失效与重新授权。”
- “按 Plainroot workbench 规则实现文件树：侧区内滚、长路径省略、磁盘成功后更新、选中与处理中状态分离，并在 820px 以下退化为抽屉。”
- “实现 Plainroot 冲突对话框：显示目标路径、内容是否安全和明确结果动词，支持键盘焦点圈定与取消后焦点恢复。”

Iteration Guide：

1. 先核对页面职责、需求编号、当前阶段和原型，不先画通用页面。
2. 复用已存在的窗口壳、按钮、对话框、状态面板和 token；没有代码事实时按本文角色命名，脚手架建立后再登记真实组件。
3. 先完成真实 ready/loading/empty/error 与本地文件异常，再微调装饰。
4. 在宽窗口、1050px、820px 和页面专属临界宽度验证滚动、焦点、文本溢出和主任务可见性。
5. 视觉或交互决策改变时，同步本文与页面开发流程，不只修单页 CSS。

## 10. Known Gaps

- 正式 React/Tauri 工程、运行时 token 文件和复用组件尚未建立；当前 token 仍以原型共同值为 alpha 事实，不能声称已有代码级设计系统。
- 启动页原型危险色为 `#955252`，工作台和主题工作室为 `#9b5050`；本文已收敛为 `#9b5050`，正式实现时应统一消费 token。
- 暗色主题尚无完整原型和 token；不得简单反转当前亮色值。R7/R15 阶段需补全明暗语义、派生状态和跨窗口预览测试。
- `17px / 1.76`、约 `760–820px` 正文宽度及 `252/220px` 侧栏是 alpha 校准基线，仍需在不同 DPI、中英文长文和 Windows 字体渲染下验证。
- 自定义主题“明暗两套调色板必须同时通过才允许保存”仍是待主题阶段确认的非阻塞决策；确认前不要写成用户已最终决定。
- HTML 原型主要表现 macOS 窗口外观；Windows 原生标题栏、菜单、快捷键、回收站和窗口行为需在正式工程与 Windows CI/人工验收中补证。
