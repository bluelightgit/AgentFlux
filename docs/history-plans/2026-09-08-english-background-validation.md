# 英文文案与 Windows 后台启动：阶段验证摘要

日期：2026-09-08。分支 `fix/project-review-2026-09-07`，基线 `35f4edb`，未提交。本页归并已完成的实现与验证；人工 TUI/桌面复验仍在当前规划，不代表全部功能关闭。

## 实现

- 自带菜单、状态、通知、工具结果/错误、Core 日志、Workflow 格式化及 runtime prompt 改为英文，状态图标改为英文/ASCII。自带角色与项目本地覆盖同步处理；备份在 `.agentflux/test-results/english-background/config-before/`。模型仍为 Luna/max，预算没有提高。
- AST 门禁检查 `src` 的 TS/JS 字符串及模板（包括 Unicode 转义），排除开发注释和识别正则；无需产品文案白名单。另检查角色资产、formatter 和用户原文保留，不过滤用户/历史/外部原始输出。
- Windows 子 Pi 在 CLI 之前加载 package-owned `background-preload.mjs`，为 Node 七类子进程 API 补缺省 `windowsHide=true`，覆盖 ESM 绑定与 custom promisify；保留显式 false、回调、Promise.child、参数校验、stdio/env、取消/超时与原始结果。
- 不修改安装的 Pi、Main 或全局 NODE_OPTIONS。保留 runner 的 detached 和定向 `/T`：本地 Node/libuv 调查与受控探测表明，改为非 detached 会在父进程退出时通过 Job Object 回收子进程。
- 完整包包含两个扩展入口和 preload。默认启动解析前移至 Run/lease 登记前；缺资产返回零 usage 的可见失败，不留无 PID 的 starting Run。相关 live 夹具的复制、存在性及指纹检查已同步；这些夹具不等于全部重新实跑。

## 确定性验证

`.agentflux/test-results/english-background/` 中保留：

- `background-4.log`：签名/回调/Promise/ESM、Windows/POSIX、真实 Node 错误/超时/取消，以及打包缺资产零 Run。
- `smoke-evidence-1.log`：缺失或不一致 preload 不得通过 production 包判定。
- `verify-final-3.log`、`typecheck-final-4.log`、`build-final.log`、`dist-import-final.log`、`background-dist-final.log`、`diff-final.log`：完整门禁通过。
- `package-1.json`：dry-run 包含第三个资产；这不是无源码安装认证。

## 同构建真实验证

外部监督器 `live-1788847638392-14280` 使用 `openai-codex/gpt-5.6-luna`、max，没有停止当前 Pi：

1. dogfood：两个 role 的持久会话均真实调用 find、grep 并收到成功结果，thinking 记录为 max，Task/Run 成功且无默认 deadline。
2. 默认 smoke：direct、agents、Workflow 三节点及质量门、Community submit→review pass→resolve 四场景全部通过。
3. controls：steer 消费/ACK、停止、父取消及 stop 后旧 steer 拒绝通过。

`english-background/summary.json` 独立核对两轮六组 fixture 的 18 个资产、最新三个文件与当前构建同 hash、31 个已记录 PID 均退出，当前 continue 谱系与 `$2 / 8 iterations / 4 parallel / no deadline` 未变。它不证明未观测孙进程或所有入口。

最终构建 SHA256：

- `entry.js`：`ce19827fbb34f5c9906b951c72ef5aaa1f893b54ccd38c09816d3bad304d6c8e`
- `subagent-entry.js`：`6c15ffc955a36391cdfc52a5ab3798270825c368c0c520667282a4a23a2475b3`
- `background-preload.mjs`：`a7efe6d0e326ea052abac3d7e8347f7badd8593048f40abfc294060a38a1b85e`

## 用户再次重启后的专项复验

后台启动与文案门禁、`dogfood:restart` 再次通过。独立报告 `english-background/post-restart/summary.json` 核对 fresh Pi 两种 role 真实 find/grep、Task/Run completed、会话 max、三资产与上述构建一致，记录 Main PID 9704 已退出；真实阶段约 59 秒，未提高预算、未停止当前 Pi。此轮没有重跑所有场景，也未人工观察桌面。

原因区分：Pi 内部 fd/rg/版本探测等路径遗漏 windowsHide，最外层隐藏选项不会自动传递；这是确认并补齐的启动缺口，不是用户当次闪窗唯一来源的直接证据。首轮 smoke 失败则是夹具漏 preload，加上原启动校验晚于 Run 登记留下无 PID 记录，最终触发夹具 watchdog，与模型执行默认时限无关。

## 窗口观测与限制

`preload-window-audit/windows-node-probe-1788846662394-20004-c40bd7bd-9562-4e74-8878-ad8d007944a6.json` 记录 Win32 EnumWindows/GetWindowThreadProcessId 对照：默认未隐藏 spawn 采到可见 PseudoConsoleWindow；preload 后默认 spawn 未采到窗口；detached 子进程仍在父退出后存活；显式交互 false 保留。

这是 API 采样，不是人工桌面目测，也不能确认用户原闪窗的唯一来源。兼容层不能阻止 native/任意孙进程自行创建 GUI；依赖 Pi 升级后仍需复核，上游统一处理优先。

## 保留的失败

- 首轮 `live-1788846561896-21280`：dogfood/controls 成功，但 smoke 只复制两入口。两个真实调用报 preload 缺失，原路径留下无 PID Run；fixture Main 随后自行复制 preload、诊断并请求 stop，最终触发夹具 watchdog，Workflow/Community 未执行。`missing-preload-failure.json`、完整流、工作区和旧状态均保留，后来文件存在不能否认启动时缺失。
- 第一版证据汇总误以为失败工作区始终缺文件，因此拒绝；核对原 stdout 中真实 cp 调用后修正证据逻辑。`evidence-verification-1.log` 与后续通过日志均保留，没有删除失败或修改旧终态。

未完成项：人工菜单/键盘/桌面复验、跨平台实际启动及安装、GC 共同 fence、旧数据迁移、崩溃重投、hard-kill 恢复及权威账务等仍按当前规划推进。
