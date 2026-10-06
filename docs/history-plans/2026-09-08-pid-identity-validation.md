# PID 出生记录与异常退出：局部验证阶段

日期：2026-09-08。分支 `fix/project-review-2026-09-07`，基线 `35f4edb`，未提交。**这是已完成实现/验证的阶段摘要，不是全部 PID/恢复风险关闭。** 当前余项只看 [运行规划](../development-plan/02-runtime-and-storage.md)。

## 已实现

- Core ProcessIdentity v1：Windows 创建时间、Linux boot ID/starttime；坏数据、权限/查询错误及不支持平台为 unknown。Task owner、Run attempt、lease 和新锁保存出生信息，旧事实不猜测补写。
- 外部 Run 异步采集避免阻塞 stdout/deadline；迟到绑定检查 active Run、attempt、PID，已有身份不可改。引用判断的短时 positive-only 缓存只能推迟清理，强停重新查询。
- 未发布 PID 或未知 owner 不视为已退出。启动登记失败进入统一监听/费用/退出流程，exit 72 不重试、不被产物证明洗成成功；无 PID spawn 错误正确收敛。
- 拒绝终止或仅宽限期到期不伪造退出，保留活 Run/文件锁；实际退出后收敛。检查 taskkill 状态/信号错误，隔离终止 Promise 异常和已结算后的输出。

## 确定性与生产证据

目录：`.agentflux/test-results/pid-identity-closure/`。

- `verify-8.log`、独立 `typecheck-final-3.log` / `build-3.log` 通过；14 项 leaf、13 项集成、4 组 Windows 启动/清理故障及原生命周期/空间/93 项 GC 竞争均通过。
- 启动故障测试使用真实 Node 和显式 Registry hook，unknown 使用隔离 PATH，宽限期测试使用模拟 signal 成功回执。它们不是 Provider 故障或 Linux 实跑。
- 第一构建五项 live 全通过并独立核对 5 fixture/44 PID，见 `summary-attempt1.json`；此后发现并修复提前终态的异常路径，旧构建通过没有代替追加回归。
- 第二构建 dogfood、controls、GC references、消息两类故障重投、默认四场景全通过；`summary-attempt2.json` 独立核对 5 fixture/44 PID，Execution 费用合计 $0.0470908（SDK/回执，不是账单）。`dist-same-candidate.log` 确认最终重建三资产未变。
- dogfood 在线重读 Main owner 和两个 role 的系统出生值，与持久字段一致；两个实际 find/grep 会话成功。模型均为 `openai-codex/gpt-5.6-luna`、max，无默认执行 deadline；当前 Main 未热加载。
- 消息夹具追加新鲜出生、二次 Run/attempt 与实际信号回执检查，未知不杀。第三轮 `live-1788876356209-15472` 再通过 crash/ACK-loss 两场景：目标 PID 15416 的出生匹配、二次 Core 检查和 taskkill exit 0 均记录。
- 最终 `summary.json` 独立核对第二/第三轮同三资产候选的五类脚本最新结果全通过、6 fixture、59 个记录 PID 在核验时均不存在，Execution 费用合计 $0.05649964。三资产分别为 entry `de03f591…`、subagent `e8a3cce4…`、preload `a7efe6d0…`；完整哈希、每项出处与限制均在 summary。它不是所有脚本/进程树或供应商账单认证。

## 保留的失败与审查

- 同步 Windows 探测曾遮蔽在线 usage、延迟 deadline；改异步后保留原断言通过。旧夹具仅改 PID 却保留当前出生值属于矛盾 metadata，先验证拒绝后再显式模拟 legacy。
- 空间 holder 改为显式 release barrier 保证真实重叠；100ms deadline 和仅释放自身断言不变，30s 仅是 fixture 泄漏 watchdog。
- Linux UUID 正则编辑错误、首个新增测试误用 runAgent 签名、早期完整测试失败/300 秒基础设施中断日志均保留；未当作产品通过。最终完整命令单独通过。
- Luna 限定复审原文和处置在 `reviewer-final-facts.json` / `review-disposition.md`，**不是无 must-fix 的独立批准**。

## 保证边界

首次出生捕获没有原子启动握手，查询到信号存在 OS 竞态；未知/终止失败可能长期 pending，不保证可用性。没有完成重启后父控制器强停、锁 generation-CAS、Linux/跨 PID namespace 实跑或未观测孙进程证明；本轮未复现 Core 实际误杀，也不声称全部 PID 风险已解决。
