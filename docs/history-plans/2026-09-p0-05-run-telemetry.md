# 历史规划：P0-05 Run Registry 在线遥测与模型错误

状态：已完成并归档。

## 规划目标

让 Core Run Registry 在真实子进程运行期间持续保存 phase、attempt、PID、turns、tokens、cost、heartbeat、最近活动、model/provider 和分类错误；heartbeat 写失败不得误杀健康 child，普通业务/文件错误不得触发模型降级，终态必须与在线绝对快照单调收敛。

## 已完成结果

- Run Registry 增加旧记录内存归一化、原子绝对快照、非负/单调校验、terminal 拒写和在线错误字段。
- runner 在 process start、assistant `message_end`、tool start、heartbeat、backoff、retry、model switch、stop、process exit 和 terminal 持续写入同一 Run；跨 attempt usage 使用绝对累计，避免重试双计。
- heartbeat 写失败改为有界诊断和后续重试，不再污染业务错误或终止健康进程。
- model/provider 错误采用明确分类；`file not found` 等普通错误不再被宽泛 `not found` 规则误判，只有明确 model/provider/API 故障可触发降级。
- `flux_agent list` 与 TUI Agent Details 从 Core active Run 显示阶段、elapsed/freshness、turns、tokens、实时/累计成本、model/provider、活动和错误；AgentStore 历史聚合不再伪装成在线事实。
- 新增 `npm run test:live:run-telemetry`，由外部监督进程启动全新 Pi，并加载本轮 `dist/extension/entry.js` 和 `dist/extension/subagent-entry.js`。

## 验证证据

- `npm run verify`：623/623 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过；production dist 两个入口存在并包含在线 Run 路径。
- `git diff --check`：通过。
- production 报告：`.agentflux/test-results/run-telemetry-latest.json`，`passed=true`。
- 真实配置：`octopus-completions/deepseek-v4-flash`、`thinking=off`、全新 fixture Pi，Main PID 34640。
- 在线事实：active Run 在 child PID 31532 存活时达到 turns=1、input=1463、output=157、cacheRead=512、cost=$0.00017017、phase=tool、heartbeat 更新 8 次；在线计数全程单调。
- 终态事实：completed、turns=3、input=1618、output=315、cacheRead=4864、cost=$0.00029960，Task/Execution/Run 关联完整。
- 显式故障恢复：`agentflux-live-model-not-found` 首次得到真实 404/model error，同一不可变 Run attempt=2 降级到 `deepseek-v4-flash` 并 completed，保留 `modelError`。
- 一次失败的真实尝试因全局 Pi 模型发现扩大候选并遇到 provider overload，最终超时；失败证据保存在 `.agentflux/test-results/run-telemetry-recovery-failure-2026-09-01.json`，后续通过隔离候选修复验证，未删除失败事实。

## 遗留转移

inspect/steer/stop、busy Agent 队列、Message V2 单一路径和父 Task 聚合预算属于 P0-06/P0-07；真实 provider overload 下的部分成功、停止和新谱系恢复继续由 P2-03 跟踪，不属于本项已完成范围。
