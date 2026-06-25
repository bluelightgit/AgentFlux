#!/usr/bin/env python3
"""
AgentFlux compaction 真实实验: 塞满 > 20000 token, 触发真正的 compaction, 观察 cacheRead 变化

keepRecentTokens 默认 20000, session 必须 > 20000 token 才能 compact。
"""
import json, subprocess, sys, time

PI = "pi"
EXT = "experiments/v0-probe/agentflux-probe.ts"
DUMP = "experiments/v0-probe/dump-request.ts"
PROVIDER = "octopus-anthropic"
MODEL = "deepseek-v4-flash"
SEG = ("AgentFlux is a work-mode routing and multi-agent orchestration layer "
       "for LLM coding agents. Its core thesis turns the accuracy-efficiency-cost "
       "trilemma into configurable, observable, routable runtime decisions. ")
# 英文, 每轮 ~2900 token, 发到 > 24000, 让 compact 能在 turn 边界切 (保留最近 20000)
LONG = SEG * 70

proc = subprocess.Popen(
    [PI, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
     "-e", EXT, "-e", DUMP, "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
     "--session-id", "flux-compact-large"],
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

def wait(pred, timeout=200):
    dl = time.time()+timeout
    while time.time()<dl:
        ev = read_event()
        if ev is None: print("[!] closed",file=sys.stderr); return None
        t = ev.get("type","")
        if t in ("agent_start","agent_end") or t=="response" or t.startswith("compaction"):
            print(f"  ev: {ev.get('command',t)}",file=sys.stderr)
        if pred(ev): return ev
    print("[!] timeout",file=sys.stderr); return None

def stats():
    send({"type":"get_session_stats"})
    ev = wait(lambda e: e.get("type")=="response" and e.get("command")=="get_session_stats")
    return ev.get("data") if ev and ev.get("success") else None

def prompt(msg):
    send({"type":"prompt","message":msg})
    wait(lambda e: e.get("type")=="response" and e.get("command")=="prompt")
    wait(lambda e: e.get("type")=="agent_end", timeout=240)

def cr(s): return (s or {}).get("tokens",{}).get("cacheRead","?")
def ci(s): return (s or {}).get("tokens",{}).get("input","?")
def ctx(s): return (s or {}).get("contextUsage",{}).get("tokens","?")

print("=== 塞满 session 到 > 20000 token ===",file=sys.stderr)
send({"type":"new_session"})
wait(lambda e: e.get("type")=="response" and e.get("command")=="new_session")

rounds = []
for i in range(15):
    prompt(f"{LONG} (batch {i+1}) reply OK only.")
    s = stats()
    c = ctx(s)
    print(f"  轮{i+1}: ctx={c} cacheRead={cr(s)} input={ci(s)}",file=sys.stderr)
    rounds.append(s)
    if isinstance(c,(int,float)) and c > 24000:
        print(f"  已超 28000, 停止",file=sys.stderr)
        break

print("\n=== compact ===",file=sys.stderr)
send({"type":"compact"})
cev = wait(lambda e: e.get("type")=="response" and e.get("command")=="compact", timeout=240)
if cev and cev.get("success"):
    d = cev.get("data",{})
    print(f"  compact OK: before={d.get('tokensBefore')} after~{d.get('estimatedTokensAfter')} summary_len={len(d.get('summary','') or '')}",file=sys.stderr)
else:
    print(f"  compact FAILED: {cev.get('error') if cev else 'no response'}",file=sys.stderr)

sc = stats()
print(f"\n=== compact 后 stats ===")
print(f"  ctx={ctx(sc)} cacheRead={cr(sc)} input={ci(sc)}")

print("\n=== compact 后再发1轮, 看 cacheRead ===",file=sys.stderr)
prompt("根据之前的上下文, AgentFlux 的核心命题是什么?一句话。")
sa = stats()
print(f"  compact后轮: ctx={ctx(sa)} cacheRead={cr(sa)} input={ci(sa)}")

print("\n========== 汇总 ==========")
prev_cr = 0
for i,s in enumerate(rounds):
    cur = cr(s)
    delta = cur - prev_cr if isinstance(cur,(int,float)) and isinstance(prev_cr,(int,float)) else "?"
    print(f"轮{i+1}: cacheRead累计={cur} 增量={delta} ctx={ctx(s)}")
    if isinstance(cur,(int,float)): prev_cr = cur
print(f"compact后: cacheRead累计={cr(sa)} 增量(vs轮末)={cr(sa)-prev_cr if isinstance(cr(sa),(int,float)) else '?'} ctx={ctx(sa)}")
print(f"\n关键: compact 后那一轮的 cacheRead 增量是否 << 压缩前的每轮增量?")

proc.stdin.close(); proc.terminate()
