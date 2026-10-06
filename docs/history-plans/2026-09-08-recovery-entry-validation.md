# 恢复入口与 Task history 验证阶段

状态：本阶段已完成，2026-09-08。当前剩余任务仍见 [规划索引](../development-plan/00-index.md)，不代表 R01–R17 全部关闭。

## 实现与验证事实

- Task tool/slash 共用正文判定：continue/reuse/retry 省略正文取源 Task；resume 不允许改写源正文。Workflow resume 取保存的 invocationTask，核对显式正文/action/selector/version/name 后才绑定资源和创建产物目录。
- 恢复 handler 本地验证等值/省略输入、错误版本/动作/名称、损坏输入、零额外 Run、独立谱系及原历史不变。12 组 review 回归通过。
- runner 修复 Pi 自动重试后的旧 assistant 错误残留；不清除 Host 终止/预算/存储错误。29 项 safety（含 4 项新增真实 Node 消息流场景）、19 项 Task execution 检查通过。
- DAG 返回值不再按展示精度舍入，保留与 checkpoint/父回执相同的原始数值；小数精度回归通过。只修改未来执行，不回写历史。
- 完整 `npm run verify`、独立 typecheck/build、两个 dist 语法/动态导入、diff 检查通过，日志在 `.agentflux/test-results/recovery-closure/`，最新确定性门禁后缀为 `-4`。

## 同一构建的真实结果

`.agentflux/test-results/recovery-closure/summary.json` 对应 `live-current.json` 指向的最终监督器：dogfood、workflow-resume、Task history 均通过，使用 Luna/max，无默认执行 deadline，原预算未提高。

- Workflow：真实首节点成功、第二节点业务条件不满足；冲突输入的新 resume 被拒且零 child；改变业务条件后，再新 Pi 实际 resume，只执行剩余节点。源 Task/Execution/DAG/checkpoint/产物 hash 不变，新 Task/Execution completed。继承成本 `0.002484`，本次 attempt 与父 invocation 都为 `0.0009621999999999999`。
- Task history：九个 fresh Main 场景覆盖 new/continue/reuse、失败源 retry、completed retry 拒绝、活动 continue/reuse/resume/retry 拒绝、resume 正文冲突和无 checkpoint 拒绝。准备谱系的验证不冒充失败 Agent 自动重跑。
- 汇总校验八组保留 fixture/dist；独立复查 64 个已记录自有 PID 均不存在。首次独立 PID 检查未全通过且当时未输出具体 PID，保留该失败日志，不推断原因；后续复查通过。不覆盖未观测孙进程。

## 保留的失败及限制

- 第一轮恢复夹具不同逻辑会话导致找不到源，后续误跑新 Workflow；严格零 child 断言失败。改用相同逻辑会话但独立 Pi，并断言准备成功，不放宽断言。
- 第二轮真正恢复已执行，但 `attempt=0.0009326` 被 DAG 返回值舍入成 `0.000933` 后写入回执；严格 `1e-9` 对账失败。修复并按原容差重验，旧金额不回写。
- history 子代理虽交付，旧 runner 仍因此前 WebSocket error 将 Run 记为 failed；完整交付/错误/会话 hash 在 `delegation-facts.json`，历史 Run 与父回执未改。修复有合成 Node 流覆盖，未强制制造新的真实 Provider 自动重试来验收。
- 这是可控业务失败恢复，不是 hard-kill/断电恢复，也不是供应商账单认证。GC 调查已交付但共同 writer fence 尚未实现。
