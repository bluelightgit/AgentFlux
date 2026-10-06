# 当前 Host 同版核验与跨平台可用性

日期：2026-10-01 UTC。本次仅做实际重启短调用、源码调查与规划修订，未修改业务源码、依赖或production dist。

## 当前重启已通过

真实调用 `pi0992-current-host-check` 一次read后返回PI0992_CURRENT_HOST_OK。Core Run completed/terminal，金额与归属完整，费用估计$0.00091352、原child PID退出。OS查询确认当前Main命令入口与Run记录相符：Main和child均为**同一个全局安装的dist/bundle/cli.js，Pi0.99.2**，SDK版本0.99.2，selectionSource=validated-cli-entry。父Task真实continue新谱系，快照时仍running，不冒称已settled。

磁盘entry仍为a44099e5e9172f6f1ebfc1f6dffaaaa6cb4648892aea898914a9461329eeae16，无需再次重启。证据 `.agentflux/test-results/host-binding-platform-2026-10-01/current-host-summary.json` 与current-host-check-attempt1.log；本次不是完整套件重跑。

## 同一 Pi 不等于 SDK 已统一

[src/core/pi-runtime.ts](../../src/core/pi-runtime.ts)已按实际Main manifest/bin/realpath启动同一安装的child，不从PATH找另一份Pi。但SDK仍可能由production ESM native import从项目node_modules解析，当前guard严格要求其VERSION等于Main，四开发包也仍固定0.99.2。故CLI漂移已解决，SDK宿主绑定尚未根治，不能声称今后升级一定自动兼容。

最简单的现有部署方式是开发项目中用 `npx --no-install pi` 启动Main：Main、child与项目SDK使用同一安装树，避免全局Pi与本地SDK分别升级。真正的产品方向是运行期SDK由宿主提供、开发依赖只用于类型/测试，并验证loader与模块身份；不是删除guard或每个patch改业务代码。相关方案与验收仅在[04规划](../development-plan/04-pi-compatibility.md)维护。

兼容patch不应要求AgentFlux反复修代码；但Pi的破坏性API、协议、权限或计价变化仍须适配，同一版本的Main/child不能替代扩展API兼容性验证。更新后重启加载新的进程代码是正常需要，不等于每次更新都需修改AgentFlux。

## 平台结论

| 平台 | 当前证据与边界 |
|---|---|
| Windows | 当前production真实链路已验证；本次短调用与上轮八类fresh成功属于各自明确范围。 |
| Linux | [process-identity.ts](../../src/core/process-identity.ts)实现/proc boot_id + starttime；runner有POSIX进程组停止分支。可作为待验收试用目标，但当前候选不能声明完成原生Linux全链路认证。 |
| macOS | ProcessPlatform与isSupportedPlatform只接受win32/linux；darwin返回unknown。runner停止在无出生身份时保守拒绝，锁/GC/orphan恢复亦受影响。基本会话可能运行，正式多Agent生命周期不能算完整支持。 |

本机只读WSL探测发现Ubuntu22.04/WSL2、/proc可读，但未找到Linux原生node；输出的npm版本不能当Linux Node运行证据。没有安装系统Node、共享Windows node_modules或把Windows节点当Linux认证。

现有CI仅配置Ubuntu，ci.yml仍有Node20，live/publish也仍Node20，与项目/Pi最低Node22.19要求冲突；工作流存在不证明本候选已在Linux通过。macOS无CI矩阵。必须补齐实际OS/Node/进程停止/锁/PID重用/恢复及production链路；详细范围见[03规划](../development-plan/03-real-validation.md)。

`git diff --check`通过；没有新增业务构建或声称新的Linux/macOS测试通过。
