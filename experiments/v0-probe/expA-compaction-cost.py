#!/usr/bin/env python3
"""
AgentFlux 实验 A: compaction 成本惩罚量化 (价格层)
基准模型: deepseek-v4-flash (octopus-anthropic)

目标: 量化 compaction 摧毁 L2 缓存前缀的真实美元代价.
方法: RPC 模式塞满 session > 24000 token 触发 compaction,
      每轮采集单条 assistant 消息 usage (单轮真实值, 非累积),
      用价格层算每轮成本, 对比 compaction 前后单轮成本.

成本公式: cost = input*p_in + output*p_out + cacheRead*p_read + cacheWrite*p_write
"""
import json, subprocess, sys, time, os

PI = "pi"
EXT = "src/entry.ts"
PROVIDER = "octopus-anthropic"
MODEL = "deepseek-v4-flash"
SESSION = "flux-expA-v2"
OUT_DIR = ".agentflux"
OUT_FILE = os.path.join(OUT_DIR, "expA-compaction-cost.json")

# 英文长 prompt, 每轮 ~2900 token, 8 轮 > 23000 触发 compaction
SEG = ("AgentFlux is a work-mode routing and multi-agent orchestration layer "
       "for LLM coding agents. Its core thesis turns the accuracy-efficiency-cost "
       "trilemma into configurable, observable, routable runtime decisions. "
       "It formalizes four orthogonal dimensions: context topology, lifecycle, "
       "parallelism, and model strategy. Six work modes M1-M6 map to dimension "
       "combinations and trilemma triangle positions. ")
LONG = SEG * 70

# 价格 (deepseek-v4-flash, $/token, 从 OpenRouter)
P_IN = 9e-8
P_OUT = 1.8e-7
P_READ = 2e-8
P_WRITE = 0

def cost(u):
    return (u.get("input",0)*P_IN + u.get("output",0)*P_OUT +
            u.get("cacheRead",0)*P_READ + u.get("cacheWrite",0)*P_WRITE)

proc = subprocess.Popen(
    [PI, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
     "-e", EXT, "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
     "--session-id", SESSION],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, text=False, shell=True,
)
buf = b""

def read_event():
    global buf
    while b"\n" not in buf:
        c = proc.stdout.read(4096)
        if not c: return None
        buf += c
    line, buf = buf.split(b"\n", 1)
    try: return json.loads(line.rstrip(b"\r").decode("utf-8"))
    except: return {}

def send(cmd): proc.stdin.write((json.dumps(cmd)+"\n").encode()); proc.stdin.flush()

def wait(pred, timeout=240):
    dl = time.time()+timeout
    while time.time()<dl:
        ev = read_event()
        if ev is None: print("[!] closed",file=sys.stderr); return None
        if pred(ev): return ev
    print("[!] timeout",file=sys.stderr); return None

def get_last_assistant_usage():
    """取当前 branch 最后一条 assistant 消息的单轮 usage (非累积)"""
    send({"type":"get_messages"})
    ev = wait(lambda e: e.get("type")=="response" and e.get("command")=="get_messages")
    if not ev or not ev.get("success"): return None
    msgs = ev.get("data",{}).get("messages",[])
    for m in reversed(msgs):
        if m.get("role")=="assistant" and m.get("usage"):
            u = m["usage"]
            return {"input":u.get("input",0),"output":u.get("output",0),
                    "cacheRead":u.get("cacheRead",0),"cacheWrite":u.get("cacheWrite",0),
                    "totalTokens":u.get("totalTokens",0),"model":m.get("model")}
    return None

def stats():
    send({"type":"get_session_stats"})
    ev = wait(lambda e: e.get("type")=="response" and e.get("command")=="get_session_stats")
    return ev.get("data") if ev and ev.get("success") else None

def prompt(msg):
    send({"type":"prompt","message":msg})
    wait(lambda e: e.get("type")=="response" and e.get("command")=="prompt")
    wait(lambda e: e.get("type")=="agent_end", timeout=240)

# ============ 实验 ============
print("=== 实验 A: compaction 成本惩罚 ===", file=sys.stderr)
print(f"模型: {MODEL} | 价格: in=${P_IN}/tok out=${P_OUT}/tok read=${P_READ}/tok", file=sys.stderr)

send({"type":"new_session"})
wait(lambda e: e.get("type")=="response" and e.get("command")=="new_session")

pre_compact_turns = []
print("\n--- 阶段1: 塞满 session 到 > 24000 token ---", file=sys.stderr)
for i in range(12):
    prompt(f"{LONG} (batch {i+1}) reply OK only.")
    u = get_last_assistant_usage()
    s = stats()
    ctx = (s or {}).get("contextUsage",{}).get("tokens","?")
    if u:
        c = cost(u)
        pre_compact_turns.append({"turn": i+1, "usage": u, "cost": c})
        print(f"  轮{i+1}: ctx={ctx} | in={u['input']} read={u['cacheRead']} out={u['output']} | ${c:.6f}", file=sys.stderr)
    if isinstance(ctx,(int,float)) and ctx > 24000:
        print(f"  ctx={ctx} > 24000, 停止", file=sys.stderr)
        break

baseline_turn = pre_compact_turns[-1] if pre_compact_turns else None
print(f"\n--- compaction 前基线 ---", file=sys.stderr)
if baseline_turn:
    bu = baseline_turn["usage"]
    print(f"  in={bu['input']} read={bu['cacheRead']} → ${baseline_turn['cost']:.6f}", file=sys.stderr)

print("\n--- 阶段2: 触发 compaction ---", file=sys.stderr)
send({"type":"compact"})
cev = wait(lambda e: e.get("type")=="response" and e.get("command")=="compact", timeout=240)
compact_info = {}
if cev and cev.get("success"):
    d = cev.get("data",{})
    compact_info = {"tokensBefore": d.get("tokensBefore"), "estimatedTokensAfter": d.get("estimatedTokensAfter"),
                    "summary_len": len(d.get("summary","") or "")}
    print(f"  compact OK: before={d.get('tokensBefore')} after~{d.get('estimatedTokensAfter')}", file=sys.stderr)
else:
    print(f"  compact FAILED: {cev.get('error') if cev else 'no response'}", file=sys.stderr)

print("\n--- 阶段3: compaction 后发轮, 量化成本惩罚 ---", file=sys.stderr)
post_compact_turns = []
for i in range(3):
    prompt("根据之前的上下文, AgentFlux 的核心命题是什么?一句话。" if i==0 else "再简述一次。")
    u = get_last_assistant_usage()
    s = stats()
    ctx = (s or {}).get("contextUsage",{}).get("tokens","?")
    if u:
        c = cost(u)
        post_compact_turns.append({"turn": len(pre_compact_turns)+i+1, "usage": u, "cost": c})
        print(f"  compact后轮{i+1}: ctx={ctx} | in={u['input']} read={u['cacheRead']} out={u['output']} | ${c:.6f}", file=sys.stderr)

# ============ 汇总 ============
print("\n" + "="*70)
print("实验 A 汇总: compaction 成本惩罚")
print("="*70)
print(f"模型: {MODEL}")
print(f"价格: input=${P_IN}/tok  output=${P_OUT}/tok  cacheRead=${P_READ}/tok  cacheWrite=${P_WRITE}/tok")
print(f"      (缓存读 = input 的 {P_READ/P_IN*100:.1f}%, 命中比全价便宜 {(1-P_READ/P_IN)*100:.1f}%)")
print()

print("【compaction 前】逐轮成本:")
for t in pre_compact_turns:
    u = t["usage"]
    print(f"  轮{t['turn']:2d}: in={u['input']:6d} read={u['cacheRead']:6d} out={u['output']:4d} | 本轮${t['cost']:.6f}")

print(f"\n【compaction】: {compact_info}")

print("\n【compaction 后】逐轮成本:")
for t in post_compact_turns:
    u = t["usage"]
    print(f"  轮{t['turn']:2d}: in={u['input']:6d} read={u['cacheRead']:6d} out={u['output']:4d} | 本轮${t['cost']:.6f}")

if baseline_turn and post_compact_turns:
    post = post_compact_turns[0]
    bu = baseline_turn["usage"]; pu = post["usage"]
    print("\n" + "-"*70)
    print("【关键对比】compaction 前后单轮成本:")
    print(f"  compaction 前最后轮: in={bu['input']} read={bu['cacheRead']} → ${baseline_turn['cost']:.6f}")
    print(f"  compaction 后第1轮 : in={pu['input']} read={pu['cacheRead']} → ${post['cost']:.6f}")
    cost_ratio = post['cost']/baseline_turn['cost'] if baseline_turn['cost']>0 else 0
    print(f"  成本倍数: {cost_ratio:.2f}x")
    print(f"  cacheRead 变化: {bu['cacheRead']} → {pu['cacheRead']} ({(pu['cacheRead']-bu['cacheRead'])/max(bu['cacheRead'],1)*100:+.1f}%)")
    print(f"  input 变化: {bu['input']} → {pu['input']} ({(pu['input']-bu['input'])/max(bu['input'],1)*100:+.1f}%)")
    # 缓存丧失的美元代价
    lost_read = bu['cacheRead'] - pu['cacheRead']
    if lost_read > 0:
        # 这些 token 从缓存价($P_READ)变成全价($P_IN)重新传输
        extra_cost = lost_read * (P_IN - P_READ)
        print(f"  缓存丧失代价: {lost_read} token 从缓存价→全价, 每轮多付${extra_cost:.6f}")

os.makedirs(OUT_DIR, exist_ok=True)
result = {
    "experiment": "A-compaction-cost-penalty",
    "model": MODEL, "pricing": {"input":P_IN,"output":P_OUT,"cacheRead":P_READ,"cacheWrite":P_WRITE},
    "pre_compact_turns": pre_compact_turns, "compact": compact_info, "post_compact_turns": post_compact_turns,
}
with open(OUT_FILE,"w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"\n结果已保存: {OUT_FILE}")

proc.stdin.close(); proc.terminate()
