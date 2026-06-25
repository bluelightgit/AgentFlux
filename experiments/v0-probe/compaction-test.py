#!/usr/bin/env python3
"""
AgentFlux compaction 对照实验 (RPC 模式)

验证 docs/06 核心论点: compaction 会摧毁 prompt cache 前缀, 导致下一轮 cacheRead 暴跌。

流程:
  1. new_session
  2. prompt 轮1 (建立历史 + 写热 system prompt 前缀)
  3. get_session_stats -> cacheRead1
  4. prompt 轮2 (L2 历史应命中, cacheRead 增长)
  5. get_session_stats -> cacheRead2
  6. compact (前缀被摘要替换)
  7. get_session_stats -> contextUsage 暴跌
  8. prompt 轮3 (compaction 后, 前缀变了, cacheRead 应暴跌)
  9. get_session_stats -> cacheRead3

预期: cacheRead2 > cacheRead1 (L2 增长), cacheRead3 << cacheRead2 (compaction 摧毁缓存)
"""
import json
import subprocess
import sys
import time

PI = "pi"
EXT = "experiments/v0-probe/agentflux-probe.ts"
PROVIDER = "octopus-anthropic"
MODEL = "deepseek-v4-flash"

# 长历史 prompt: 让对话历史 >= 1024 token 阈值, 触发隐式缓存覆盖 L2
SEG = ("AgentFlux 是面向 LLM 编码智能体的工作模式路由与多智能体编排层。"
       "其核心命题是把精度/效率/成本的三角约束转化为可配置、可观测、可路由的运行时决策。 ")
LONG_A = (SEG + "这是第一批上下文。") * 18  # ~ 1500 token
LONG_B = (SEG + "这是第二批上下文, 用于累积更长历史。") * 18

proc = subprocess.Popen(
    [PI, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
     "-e", EXT, "-e", "experiments/v0-probe/dump-request.ts",
     "--provider", PROVIDER, "--model", MODEL, "--thinking", "off",
     "--session-id", "flux-compaction-test"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    bufsize=0, text=False, shell=True,
)

buf = b""

def read_event():
    """读一行 JSON 事件 (按 \\n 分割, 避免 U+2028/2029 问题)"""
    global buf
    while b"\n" not in buf:
        chunk = proc.stdout.read(4096)
        if not chunk:
            return None
        buf += chunk
    line, buf = buf.split(b"\n", 1)
    line = line.rstrip(b"\r")
    try:
        return json.loads(line.decode("utf-8"))
    except Exception as e:
        return {"__parse_error__": str(e), "__raw__": line.decode("utf-8", "replace")[:200]}

def send(cmd: dict):
    data = (json.dumps(cmd) + "\n").encode("utf-8")
    proc.stdin.write(data)
    proc.stdin.flush()

def wait_for(predicate, timeout=120):
    """读事件直到 predicate(ev) 为真, 返回该事件"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        ev = read_event()
        if ev is None:
            print("[!] stdout closed", file=sys.stderr); return None
        t = ev.get("type", "")
        # 打印关键事件
        if t in ("agent_start", "agent_end") or t == "response" or t.startswith("compaction"):
            tag = ev.get("command", t)
            print(f"  event: {tag}", file=sys.stderr)
        if predicate(ev):
            return ev
    print("[!] timeout", file=sys.stderr); return None

def stats():
    send({"type": "get_session_stats"})
    ev = wait_for(lambda e: e.get("type") == "response" and e.get("command") == "get_session_stats")
    if ev and ev.get("success"):
        return ev.get("data", {})
    return None

def prompt(msg):
    send({"type": "prompt", "message": msg})
    wait_for(lambda e: e.get("type") == "response" and e.get("command") == "prompt")
    # 等 agent 真正跑完
    wait_for(lambda e: e.get("type") == "agent_end", timeout=180)

def show(label, s):
    if not s:
        print(f"{label}: <none>"); return
    tk = s.get("tokens", {})
    cu = s.get("contextUsage", {}) or {}
    print(f"{label}")
    print(f"  tokens: input={tk.get('input')} output={tk.get('output')} "
          f"cacheRead={tk.get('cacheRead')} cacheWrite={tk.get('cacheWrite')} total={tk.get('total')}")
    print(f"  context: {cu.get('tokens')}/{cu.get('contextWindow')} = {cu.get('percent')}%")
    print(f"  msgs: user={s.get('userMessages')} assistant={s.get('assistantMessages')}")

print("=== AgentFlux compaction 对照实验 (RPC) ===", file=sys.stderr)

# 等初始化 (读到第一个 session 相关事件或直接开始)
print("[1/9] new_session", file=sys.stderr)
send({"type": "new_session"})
wait_for(lambda e: e.get("type") == "response" and e.get("command") == "new_session")

print("[2/9] prompt 轮1: 建立长历史 (>=1024 token)", file=sys.stderr)
prompt(LONG_A + " 只回复OK两个字。")
s1 = stats(); show("轮1 后 stats:", s1)

print("[4/9] prompt 轮2: L2 长历史应命中隐式缓存", file=sys.stderr)
prompt(LONG_B + " 我上一条消息的核心命题是什么?一句话。")
s2 = stats(); show("轮2 后 stats:", s2)

print("[6/9] compact: 摧毁前缀", file=sys.stderr)
send({"type": "compact"})
cev = wait_for(lambda e: e.get("type") == "response" and e.get("command") == "compact", timeout=180)
if cev and cev.get("success"):
    d = cev.get("data", {})
    print(f"  compact response: before={d.get('tokensBefore')} after~{d.get('estimatedTokensAfter')} firstKept={d.get('firstKeptEntryId')} summary_len={len(d.get('summary','') or '')}")
    print(f"  compact summary: {(d.get('summary','') or '')[:200]}")
else:
    print(f"  compact FAILED: {cev}")

print("[7/9] compact 后 stats", file=sys.stderr)
s3 = stats(); show("compact 后 stats:", s3)

print("[8/9] prompt 轮3: compaction 后 L2 应被摘要替换, cacheRead 暴跌", file=sys.stderr)
prompt("根据摘要, 我之前发的核心命题是什么?一句话。")
s4 = stats(); show("轮3 后 stats:", s4)

# 汇总
print("\n=== 汇总 ===")
def cr(s): return (s or {}).get("tokens", {}).get("cacheRead", "?")
def ci(s): return (s or {}).get("tokens", {}).get("input", "?")
def ctx(s): return (s or {}).get("contextUsage", {}).get("tokens", "?")
print(f"轮1 cacheRead={cr(s1)} input={ci(s1)} ctx={ctx(s1)}")
print(f"轮2 cacheRead={cr(s2)} input={ci(s2)} ctx={ctx(s2)}  (L2 增长?)")
print(f"compact后 ctx={ctx(s3)}  (应暴跌)")
print(f"轮3 cacheRead={cr(s4)} input={ci(s4)} ctx={ctx(s4)}  (cacheRead 应 << 轮2)")

proc.stdin.close()
proc.terminate()
