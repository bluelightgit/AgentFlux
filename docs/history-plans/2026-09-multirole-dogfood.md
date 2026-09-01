# 历史规划：多角色与 production dogfood

状态：已完成并归档。

## 规划目标

让同一 Agent 可以按每次 Run 选择不同 role，正确继承 Main 模型/provider，绑定 Workflow 节点，并通过外部监督器在 production dist 和全新 Pi 中验证。

## 已完成结果

- Agent 创建支持 `roles[]`，Run、结果、telemetry 和 Run Registry 记录实际 role。
- role 级 capability snapshot 和 generation 隔离完成；`shared/fresh` 会话策略接入。
- Workflow 节点支持 role、agentId、sessionMode 和 invocation override，并拒绝未知角色或越权绑定。
- production build 后的 planner→reviewer 真实链路成功；两次角色 Run completed，Agent callCount=2、lastRole=reviewer。
- 外部 `npm run dogfood:restart` 已能重新 build、启动全新 Pi、加载两个 dist 入口并保存报告。

## 遗留转移

真实 Task continue/retry 谱系、Workflow 完整入口、空间互斥、消息单一路径和长期 soak 不属于已完成范围，已转入当前规划文件。
