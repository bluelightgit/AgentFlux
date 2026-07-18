# 12 - 用户界面方向：TUI、Web、Electron

> 历史 UI 讨论。当前 Desktop 产品与开发规划见 [29](29-desktop-workbench-plan.md)。

## 设计总原则

AgentFlux 的 UI 不是“聊天窗口的包装”,而是**路由控制台**。

### 目标

1. 让用户一眼看懂当前在什么模式、为什么这么路由、成本如何。
2. 让用户能在不同工作形态之间切换:单 agent / 主+subagent / 对话树 fork / handoff / 持久多 agent。
3. 让 pi TUI、Web、Electron 三种外壳共享同一套信息结构。
4. 先在 pi 里验证“是否真的提升效率”,再决定 Web/Electron 的投入。

### 核心审美方向

**控制室 / 路由中枢 / 工业级仪表盘**。

不是传统 SaaS 玻璃拟态,也不是花哨 AI 炫光风。应该像:
- 铁路调度中心
- 航运雷达屏
- 金融风控大屏
- 数据中心运维台

关键词:
- 高信息密度
- 低噪音
- 强层级
- 清晰状态
- 明确动作
- 可回溯

---

## 一、视觉语言

### 1. 色彩

#### TUI / 终端主题

推荐方向:**深石墨底 + 琥珀/青蓝高亮 + 状态绿/警示红**。

建议色系:
- 背景:深灰、炭黑、石墨蓝
- 主强调:电光青 / 冷蓝
- 次强调:琥珀黄 / 橙金
- 成功:信号绿
- 风险:警报红
- 次要文本:冷灰

避免:
- 紫粉渐变
- 漂亮但无功能的霓虹风
- 过度玻璃拟态
- 低对比度浅色卡片

#### Web / Electron 主题

建议不要直接复制 TUI 的粗暴感,而是做成**“精密仪表 + 航图地图”**的混合。

- 主色:深夜蓝 / 石墨黑
- 点亮色:青蓝、琥珀、信号绿、警示红
- 背景层次:深色平面 + 细网格 + 微弱噪点
- 卡片:少量圆角,边框比阴影更重要
- 图表:使用单色或双强调色,避免彩虹色堆满

### 2. 字体

#### TUI

受终端限制,重点在对齐和层级:
- 标题:全大写或小型大写风格
- 数字和路径:等宽高对齐
- 状态标签:短词 + 色块/边框

#### Web / Electron

建议组合:
- 标题/品牌: **IBM Plex Sans Condensed** 或 **Space Mono?** 不,避免泛滥
- 正文/UI: **IBM Plex Sans** 或 **Inter Tight** 的替代风格
- 数字/日志/代码: **Iosevka** / **IBM Plex Mono** / **JetBrains Mono**

如果要更有辨识度,可考虑:
- 标题用 **Fraunces** 或 **Newsreader** 的轻量衬线感,但仅用于品牌区
- 主体仍保持工业感,不要走文艺路线

### 3. 形态语言

- 直线、网格、轨道、分段条
- 少量圆角,不做“软糖卡片”
- 状态以标签/轨道/条形图/路径图表达
- 用“连接线”而不是大块阴影表达层级
- 允许轻微动画,但以“状态变化”而非“装饰”为主

---

## 二、统一的信息架构

无论 TUI/Web/Electron,都应该围绕这 8 个信息面板:

1. **当前模式**:M1–M6,以及 override 状态
2. **路由理由**:为什么选这个模式,被什么信号触发
3. **成本账本**:tokens/cacheRead/cacheWrite/cost
4. **上下文状态**:context fill, compaction 风险, branch 状态
5. **执行链路**:主 agent、subagent、fork、handoff 的进度
6. **决策历史**:上一次为什么选错/选对,后续如何调整
7. **路由偏好**:五维倾向 + 场景覆盖(见 [13](13-routing-preference.md))
8. **项目成熟度**:stage + role + 信号逼近阈值(见 [14](14-project-evolution.md))

这 6 项要贯穿所有 UI 外壳,不能每个壳都自己发明一套。

---

## 三、pi TUI 方向

pi TUI 是第一验证场,它的任务不是“做成漂亮桌面”,而是**让用户在 terminal 里看懂 AgentFlux 的策略**。

### 1. TUI 的角色

- 路由控制台
- 成本监视器
- 分支查看器
- subagent 运行台
- 决策调试器

### 2. TUI 布局建议

#### 默认主界面

```
┌──────────────────────────────────────────────────────────────┐
│ AgentFlux · M2主+subagent · cache 87% · ctx 43% · $0.18     │
├──────────────────────────────────────────────────────────────┤
│ Current Mode                                                  │
│  M2  |  reason: verification-needed + diff-medium            │
│                                                               │
│ Route Reason                                                  │
│  - code change touches 3 files                                │
│  - needs review + tests                                       │
│  - cache is still healthy                                     │
│                                                               │
│ Execution Lane                                                │
│  main  → worker  → reviewer  → main                           │
│                                                               │
│ Cache Ledger                                                  │
│  input 9k  read 42k  write 6k  hit 82%                        │
└──────────────────────────────────────────────────────────────┘
> prompt...
```

#### 关键视觉点

- 顶部固定状态条:模式 + cache + context + cost
- 中间信息区:理由、路线、执行进度
- 底部输入区:保持 pi 原有交互体验
- 需要时弹出 overlay

### 3. pi TUI 的核心组件

- `setFooter`: 缓存/成本/上下文摘要 + 路由提示 (非侵入式 hint)
- ~~`setStatus`~~: 已弃用 — 会创建无法消除的持久状态栏, 改用 setFooter
- `ctx.ui.custom(...)`: 路由选择、设置面板 (flat SelectList 模式, 非 SettingsList submenu)
- `SelectList`: 模式切换、主菜单、team 子菜单 (参考 pi preset.ts)
- ~~`SettingsList submenu`~~: 不使用 — Container 类无 handleInput 方法, submenu 委托失效
- `BorderedLoader`: 长操作等待

### 4. TUI 必须具备的交互

- `/flux`：打开路由中心
- `/flux mode`：切换模式
- `/flux why`：解释当前决策
- `/flux budget`：查看成本与缓存
- `/flux branch`：查看 fork 树
- `/flux settings`：调整阈值

### 5. TUI 风格标准

- 不要堆太多颜色
- 不要让状态信息散落在各处
- 一屏只回答一个问题
- 所有数字都应该“可对比”而不是“只展示”
- 用短句、标签、路径、箭头表达流程

---

## 四、Web UI 方向

Web 不是为了替代终端,而是为了把 AgentFlux 变成**可视化的系统**。

### 1. Web 的定位

Web 主要解决三类问题:
- **全局态势**:跨 session、跨项目、跨时间看趋势
- **结构化分析**:拓扑、成本、路由命中率、错误模式
- **协作查看**:非终端用户也能理解 AgentFlux 在做什么

### 2. Web 首页建议:Command Center

首页不要是传统 dashboard 零件堆砌,而是一个“路由中枢”视图:

左侧:
- Sessions
- Branches
- Agents
- Presets

中间主区:
- 当前 session 路径图
- M1–M6 迁移动画
- 任务轨迹

右侧:
- 成本统计
- cache hit rate
- context 风险
- 最近决策理由

底部:
- 日志时间线
- 失败/回退事件

### 3. Web 的核心页面

#### A. Route Map
展示:
- 单个任务如何从 M1 变成 M2/M3/M5
- fork 与 handoff 的路径
- 哪些节点被 compact/mask/prune

#### B. Cache Ledger
展示:
- 每次 turn 的 input/cacheRead/cacheWrite
- cache 命中率趋势
- compaction 前后成本波动

#### C. Context Studio
展示:
- L1/L2/L3 的上下文组成
- 哪些内容被 mask
- 哪些内容进入新 session/handoff
- prefix layout 是否稳定

#### D. Agent Board
展示:
- 主 agent + subagents + reviewer + tester
- 状态灯
- 任务队列
- 各 agent 的 budget/速度/成功率

通信视图必须区分“目录/成员关系”和“已发生的通信”：默认使用无交叉、可排序的 Sender → Recipient Communication Lanes，而不是高数量时不可读的全局 node-link canvas。`All Agents` 仅是目录，普通群组仅是 scope；二者都不能生成通信边。方向、消息量和状态必须同时用文字/ARIA 表达。默认 Top 12，scope-first 后渐进展开；群组投递只有在逐接收者 Delivery 数据可用时才能作为可选 traffic 图层，不能由 membership 推断。

#### E. Decision Replay
展示:
- 某次为什么选了 M3 而不是 M2
- 哪个规则/预算/历史经验起作用
- 若换策略,结果会怎样

### 4. Web 设计风格

建议走**深色信息台 + 结构化图形**:
- 页面背景:深色纯底,叠加细网格纹理
- 图表:少而准,不做彩虹饼图
- 卡片:轻边框、低阴影、密集信息
- 节点图:清晰路径和流向,突出“选择”而非“装饰”

### 5. Web 技术建议

如果后续实现:
- React + TypeScript
- Vite
- Zustand / Jotai 做轻状态
- TanStack Query 处理 telemetry 拉取
- xterm.js 嵌入只读/可控终端预览(后期)
- React Flow 适合 route map / branch graph
- ECharts/Visx 适合 cache/cost 时间序列

但注意:技术只是后端。关键是页面要围绕“解释决策”来做,不是围绕“展示漂亮统计图”来做。

---

## 五、Electron 方向

### 1. 什么时候做 Electron

只有当以下条件成立时再做:
- Web UI 已经验证有价值
- 需要原生托盘、通知、开机启动、后台常驻
- 需要内嵌终端或深度系统集成
- 需要把 Web UI 打包成桌面应用发给非技术用户

### 2. Electron 的定位

Electron 应该是 **Web UI 的壳**，不是重新设计一套产品。

最佳路径:
- 先做 Web 版 AgentFlux
- 再用 Electron 包一层
- 用同一套 React 页面
- 增加本地 daemon、系统菜单、通知、自动启动

### 3. 为什么不 Electron-first

因为初期我们最需要的是:
- 快速验证
- 最少打包成本
- 最少跨平台问题
- 最多复用 pi 的现成能力

Electron 会放大:
- 打包体积
- 维护成本
- 内存占用
- 进程协调复杂度

所以它是产品化阶段的工具,不是验证阶段的起点。

---

## 六、三端一致性策略

### 1. 同一概念,同一名字

无论 pi TUI、Web、Electron,都用同样术语:
- mode
- reason
- budget
- cache
- context
- branch
- handoff
- review
- fallback

### 2. 同一数据源

所有 UI 都读同一 telemetry model,不要各自造状态。

### 3. 同一优先级

永远先展示:
1. 当前模式
2. 为什么这么选
3. 会花多少钱
4. 有没有风险

### 4. 渐进揭示

- 默认只显示概要
- 需要时再展开详情
- 不要把所有 debug 信息一次性铺开

---

## 七、推荐的产品路线

### Phase A: pi TUI 验证

目标:
- 让用户在 terminal 里感到“这个系统真的更聪明了”

交付:
- 状态 footer
- 路由解释 overlay
- cache ledger
- subagent 进度 lane

### Phase B: Web read-only 控制台

目标:
- 让用户能理解长期趋势

交付:
- route map
- cache ledger
- decision replay
- branch tree

### Phase C: Web control plane

目标:
- 用户可从 Web 下发策略

交付:
- mode override
- budget control
- agent pause/resume
- preset 管理

### Phase D: Electron 桌面壳

目标:
- 打包成完整桌面产品

交付:
- tray
- native notifications
- auto-start
- local daemon

---

## 八、最重要的产品判断

AgentFlux 的 UI 不应该被做成“只有一个聊天窗口”，但直接和 agent 对话是工作台不可缺少的控制面。

它应该被做成:
- **路由解释器**
- **成本仪表盘**
- **上下文剖面图**
- **分支工作台**
- **多 agent 调度台**
- **可同时对话、纠偏和分发任务的 runtime 工作台**

如果用户看到的是“只是更漂亮的聊天框”,那就失败了。
如果用户能在同一处向多个 agent 分发任务、继续对话和取消执行，同时知道 agent 为什么这样做、花了多少、下一步会怎样，那才是成功。

---

## 九、下一步落地建议

1. 先做 pi TUI 的最小验证版
2. 同步定义 telemetry event schema
3. 再画 Web 版首页和 Route Map 草图
4. 确认 Web 页面原型后再决定 Electron 是否值得

**一句话总结**:先在 pi 里证明“策略有效”,再用 Web 把“策略可视化”,最后再用 Electron 把“产品包装完成”。
