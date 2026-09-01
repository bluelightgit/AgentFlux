# 当前开发规划

更新日期：2026-09-01。

本文只负责规划入口、状态规则和执行顺序；具体任务按主题拆分，避免把所有工作塞进一个文档。

## 当前规划文件

| 文件 | 主题 | 范围 |
|---|---|---|
| [01-entry-and-safety.md](01-entry-and-safety.md) | 入口与安全边界 | Workflow 入口、空间互斥、Community、质量门、heartbeat、Message V2 |
| [02-runtime-and-storage.md](02-runtime-and-storage.md) | 执行语义与数据可靠性 | Main 节点、Agent 队列、任务谱系、checkpoint、资源边界、session 隔离 |
| [03-real-validation.md](03-real-validation.md) | 真实链路与长期验证 | production Pi、恢复、continue/retry、soak 和发布包 |

## 状态规则

- **待开发**：没有完整实现。
- **部分完成**：已有代码或入口，但契约未闭合。
- **待真实验证**：确定性测试已通过，真实 Pi/Provider 尚未覆盖。
- **完成**：实现、测试、必要的真实验证和文档证据全部完成。

## 规划门禁

1. 开始任务前先核对 [产品目标](../00-product.md) 和 [架构规范](../01-architecture.md)。
2. 选择对应主题文件中的任务；没有匹配项时，先新增或修订规划，再改代码。
3. 实现期间不得为了通过测试改变产品目标、事实源、权限上界或历史谱系规则。
4. 完成任务时同步填写状态、提交、测试命令、真实报告和剩余限制。
5. 新规划建立或主题重排时，先把已经完成的规划文件移到 `docs/history-plans/`，再创建新的当前文件；当前目录只保留未完成或待验证内容。
6. 不允许在 `AGENTS.md`、README、续接记录或聊天记录中维护第二份详细任务清单。

## 当前顺序

先完成 `01-entry-and-safety.md` 的 P0，再处理 `02-runtime-and-storage.md` 的 P1，最后按 `03-real-validation.md` 执行真实链路和长期验证。任务依赖未满足时不得跳过前置工作。

## 统一完成标准

- Core、TUI、持久化和生产入口行为一致；
- 直接相关测试通过；
- `npm run verify`、`npm run typecheck`、`npm run build` 通过；
- 涉及模型、进程、消息或恢复时由全新 Pi 加载本轮 dist 验证；
- 从 Task、Execution、Agent、Run、delivery、checkpoint 和成本核对事实；
- 已完成规划按规则归档，当前状态和续接文档同步。
