#!/usr/bin/env python3
"""
AgentFlux 实验 B 最终版: mask vs compact 成本对比 (价格层)
基准模型: deepseek-v4-flash (octopus-anthropic)

关键背景发现:
  - contextWindow 实际 1M (模型注册表), 但 pi stats 的 contextUsage.percent
    在 RPC new_session 后读取异常 (实验脚本读到 0.7079, 实际应 0.007)
  - mask 触发条件: contextPercent >= compaction_threshold - 0.10
  - 在 1M 窗口下, mask/compact 都极难自然触发 (需 ~800K token)
  - 真实 compaction 需 session > 20000 token (keepRecentTokens)

实验设计 (诚实版):
  用实验 A 的长 prompt 塞满 > 24000 token 触发真 compaction.
  两条路径:
    - compact 路径: 塞满后触发 compaction, 量化惩罚
    - mask 路径: 同样塞满, 但 compaction_threshold 设极低 (0.02) 让 mask
                 在低占用就触发, 观察 mask 能否推迟/避免 compaction
  关键: 不发 new_session (避免 stale ctx), 用 --session-id 独立进程
"""
import json, subprocess, sys, time, os, shutil

PI = "pi"
EXT = "src/entry.ts"
PROVIDER = "octopus-anthropic"
MODEL = "deepseek-v4-flash"
OUT_DIR = ".agentflux"
OUT_FILE = os.path.join(OUT_DIR, "expB-mask-vs-compact.json")

P_IN = 9e-8
P_OUT = 1.8e-7
P_READ = 2e-8
P_WRITE = 0

def cost(u):
    return (u.get("input",0)*P_IN + u.get("output",0)*P_OUT +
            u.get("cacheRead",0)*P_READ + u.get("cacheWrite",0)*P_WRITE)

SEG = ("AgentFlux is a work-mode routing and multi-agent orchestration layer "
       "for LLM coding agents. Its core thesis turns the accuracy-efficiency-cost "
       "trilemma into configurable, observable, routable runtime decisions. "
       "It formalizes four orthogonal dimensions: context topology, lifecycle, "
       "parallelism, and model strategy. Six work modes M1-M6 map to dimension "
       "combinations and trilemma triangle positions. ")
LONG = SEG * 70

# 8 轮塞满 (前7轮 ~20000+, 第8轮在 compact 后)
PROMPTS = [f"{LONG} (batch {i+1}) reply OK only." for i in range(7)]
PROMPTS.append("根据之前的上下文, AgentFlux 的核心命题是什么?一句话。")

def run_isolated(label, session, config_overrides, do_compact_at):
    """独立进程跑一条路径 (不发 new_session, 避免 stale ctx)"""
    cwd = os.getcwd()
    flux_dir = os.path.join(cwd, ".agentflux")
    os.makedirs(flux_dir, exist_ok=True)
    cfg_path = os.path.join(flux_dir, "agentflux.json")
    backup = cfg_path + ".bak" if os.path.exists(cfg_path) else None
    if backup: shutil.copy2(cfg_path, backup)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(config_overrides, f, ensure_ascii=False, indent=2)

    proc = subprocess.Popen(
        [PI, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
         "-e", EXT, "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
         "--session-id", session],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, text=False, shell=True,
    )
    buf = b""
    def read_ev():
        nonlocal buf
        while b"\n" not in buf:
            c = proc.stdout.read(4096)
            if not c: return None
            buf += c
        line, buf = buf.split(b"\n", 1)
        try: return json.loads(line.rstrip(b"\r").decode("utf-8"))
        except: return {}
    def send(cmd): proc.stdin.write((json.dumps(cmd)+"\n").encode()); proc.stdin.flush()
    def wait(pred, timeout=300):
        dl = time.time()+timeout
        while time.time()<dl:
            ev = read_ev()
            if ev is None: return None
            if pred(ev): return ev
        return None
    def get_last_usage():
        send({"type":"get_messages"})
        ev = wait(lambda e: e.get("type")=="response" and e.get("command")=="get_messages")
        if not ev or not ev.get("success"): return None
        for m in reversed(ev.get("data",{}).get("messages",[])):
            if m.get("role")=="assistant" and m.get("usage"):
                u = m["usage"]
                return {"input":u.get("input",0),"output":u.get("output",0),
                        "cacheRead":u.get("cacheRead",0),"cacheWrite":u.get("cacheWrite",0)}
        return None
    def stats():
        send({"type":"get_session_stats"})
        ev = wait(lambda e: e.get("type")=="response" and e.get("command")=="get_session_stats")
        return ev.get("data") if ev and ev.get("success") else None
    def prompt(msg):
        send({"type":"prompt","message":msg})
        wait(lambda e: e.get("type")=="response" and e.get("command")=="prompt")
        wait(lambda e: e.get("type")=="agent_end", timeout=300)

    print(f"\n{'='*60}\n路径: {label}\n{'='*60}", file=sys.stderr)
    turns = []; compact_info = None
    try:
        for i, p in enumerate(PROMPTS):
            if do_compact_at is not None and i == do_compact_at:
                print(f"  {label} 触发 compaction (第{i}轮后)...", file=sys.stderr)
                send({"type":"compact"})
                cev = wait(lambda e: e.get("type")=="response" and e.get("command")=="compact", timeout=300)
                if cev and cev.get("success"):
                    d = cev.get("data",{})
                    compact_info = {"tokensBefore":d.get("tokensBefore"),"after":d.get("estimatedTokensAfter")}
                    print(f"  {label} compact OK: {d.get('tokensBefore')}→{d.get('estimatedTokensAfter')}", file=sys.stderr)
                else:
                    compact_info = {"failed": cev.get("error") if cev else "no resp"}
                    print(f"  {label} compact FAILED", file=sys.stderr)
            prompt(p)
            u = get_last_usage()
            s = stats()
            ctx = (s or {}).get("contextUsage",{}).get("tokens","?")
            if u:
                c = cost(u)
                is_post = compact_info is not None and i >= do_compact_at
                turns.append({"turn":i+1,"usage":u,"cost":c,"ctx":ctx,"post_compact":bool(is_post)})
                print(f"  {label} 轮{i+1}: ctx={ctx} in={u['input']} read={u['cacheRead']} | ${c:.6f}{' (post-compact)' if is_post else ''}", file=sys.stderr)
    finally:
        if backup: shutil.copy2(backup, cfg_path); os.remove(backup)
        else: os.remove(cfg_path)
        proc.stdin.close(); proc.terminate()
    return {"label":label,"turns":turns,"compact":compact_info,"total_cost":sum(t["cost"] for t in turns)}

# ============ 实验 ============
print("=== 实验 B 最终版: mask vs compact ===", file=sys.stderr)

# 路径1: compact (mask 关闭, 第7轮后塞满~20000, 触发 compaction)
compact_result = run_isolated(
    "compact路径", "flux-expBF-compact",
    {"context":{"mask_strategy":"none","compaction_threshold":0.95}},
    do_compact_at=7,
)

# 路径2: mask (mask 开启, compaction_threshold 极低 0.02 让 mask 早触发, 不 compact)
# 注意: 0.02-0.10=-0.08 < 0, 所以 mask 会在所有非零占用触发 — 持续 mask
mask_result = run_isolated(
    "mask路径", "flux-expBF-mask",
    {"context":{"mask_strategy":"hide_tool_results","mask_keep_last_n":3,"compaction_threshold":0.15}},
    do_compact_at=None,
)

# ============ 汇总 ============
print("\n" + "="*70)
print("实验 B 汇总: mask vs compact (最终版)")
print("="*70)
print(f"模型: {MODEL} | 价格: in=${P_IN} out=${P_OUT} read=${P_READ}/tok")
print()

for r in [compact_result, mask_result]:
    print(f"【{r['label']}】")
    for t in r["turns"]:
        u = t["usage"]
        tag = " (post-compact)" if t.get("post_compact") else ""
        print(f"  轮{t['turn']}: in={u['input']:6d} read={u['cacheRead']:6d} out={u['output']:4d} | ${t['cost']:.6f}{tag}")
    print(f"  总成本: ${r['total_cost']:.6f} ({len(r['turns'])} 轮)")
    print(f"  compaction: {r['compact']}")
    print()

print("-"*70)
print("【关键对比】")
print(f"  compact 路径总成本: ${compact_result['total_cost']:.6f}")
print(f"  mask    路径总成本: ${mask_result['total_cost']:.6f}")
if compact_result['total_cost'] > 0 and mask_result['total_cost'] > 0:
    ratio = compact_result['total_cost'] / mask_result['total_cost']
    saving = (compact_result['total_cost'] - mask_result['total_cost']) / compact_result['total_cost'] * 100
    print(f"  compact / mask = {ratio:.2f}x")
    print(f"  {'mask 省' if saving>0 else 'mask 贵'} {abs(saving):.1f}%")

ct = [t for t in compact_result["turns"] if t.get("post_compact")]
if ct and len(compact_result["turns"]) > len(ct):
    pre = [t for t in compact_result["turns"] if not t.get("post_compact")]
    last_pre = pre[-1]; first_post = ct[0]
    print(f"\n  compaction 惩罚: 前最后轮 ${last_pre['cost']:.6f} (read={last_pre['usage']['cacheRead']}) → 后首轮 ${first_post['cost']:.6f} (read={first_post['usage']['cacheRead']})")
    print(f"  成本倍数: {first_post['cost']/max(last_pre['cost'],1e-9):.2f}x")

os.makedirs(OUT_DIR, exist_ok=True)
result = {"experiment":"B-mask-vs-compact-final","model":MODEL,
          "pricing":{"input":P_IN,"output":P_OUT,"cacheRead":P_READ,"cacheWrite":P_WRITE},
          "compact_path":compact_result,"mask_path":mask_result,
          "note":"contextWindow实际1M, mask用低threshold(0.15)模拟早触发场景"}
with open(OUT_FILE,"w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"\n结果已保存: {OUT_FILE}")
