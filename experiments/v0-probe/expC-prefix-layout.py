#!/usr/bin/env python3
"""
AgentFlux 实验 C: prefix layout 长历史 cache 对比 (价格层)
基准模型: deepseek-v4-flash (octopus-anthropic)

目标: 控制变量对比有/无前缀布局 (prefix_layout) 在多轮 tool call 长历史下的
      cache 命中率与成本差异.

设计: 两条独立 RPC 进程, 相同的 5 轮读文件 task (工作量一致):
  - naive 路径: prefix_layout=none (不注入 cache_control)
  - flux  路径: prefix_layout=static_first (注入 cache_control 到倒数第二条消息)
对比累积 cacheRead / input / 成本.

关键: 用主进程 (非 subagent) 避免 LLM 行为差异, 5 轮固定读相同文件.
"""
import json, subprocess, sys, time, os, shutil

PI = "pi"
EXT = "src/entry.ts"
PROVIDER = "octopus-anthropic"
MODEL = "deepseek-v4-flash"
OUT_DIR = ".agentflux"
OUT_FILE = os.path.join(OUT_DIR, "expC-prefix-layout.json")

P_IN = 9e-8
P_OUT = 1.8e-7
P_READ = 2e-8
P_WRITE = 0

def cost(u):
    return (u.get("input",0)*P_IN + u.get("output",0)*P_OUT +
            u.get("cacheRead",0)*P_READ + u.get("cacheWrite",0)*P_WRITE)

FILES = ["README.md", "docs/00-overview.md", "docs/06-cache-strategy.md", "docs/16-pricing-layer.md", "src/core/pricing.ts"]

def run_isolated(label, session, prefix_layout):
    cwd = os.getcwd()
    flux_dir = os.path.join(cwd, ".agentflux")
    os.makedirs(flux_dir, exist_ok=True)
    cfg_path = os.path.join(flux_dir, "agentflux.json")
    backup = cfg_path + ".bak" if os.path.exists(cfg_path) else None
    if backup: shutil.copy2(cfg_path, backup)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"cache":{"prefix_layout":prefix_layout}}, f, ensure_ascii=False, indent=2)

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
    def prompt(msg):
        send({"type":"prompt","message":msg})
        wait(lambda e: e.get("type")=="response" and e.get("command")=="prompt")
        wait(lambda e: e.get("type")=="agent_end", timeout=300)

    print(f"\n{'='*60}\n路径: {label} (prefix_layout={prefix_layout})\n{'='*60}", file=sys.stderr)
    turns = []
    try:
        for i, f in enumerate(FILES):
            prompt(f"读 {f} 文件, 然后用一句话告诉我它的内容。只回复那一句总结。")
            u = get_last_usage()
            if u:
                c = cost(u)
                turns.append({"turn":i+1,"usage":u,"cost":c})
                print(f"  {label} 轮{i+1}: in={u['input']} read={u['cacheRead']} out={u['output']} | ${c:.6f}", file=sys.stderr)
    finally:
        if backup: shutil.copy2(backup, cfg_path); os.remove(backup)
        else: os.remove(cfg_path)
        proc.stdin.close(); proc.terminate()
    total = {"input":sum(t["usage"]["input"] for t in turns),
             "output":sum(t["usage"]["output"] for t in turns),
             "cacheRead":sum(t["usage"]["cacheRead"] for t in turns),
             "cacheWrite":sum(t["usage"]["cacheWrite"] for t in turns)}
    total["cost"] = cost(total)
    return {"label":label,"prefix_layout":prefix_layout,"turns":turns,"total":total}

# ============ 实验 ============
print("=== 实验 C: prefix layout 长历史对比 ===", file=sys.stderr)

naive = run_isolated("naive(none)", "flux-expC-naive", "none")
flux = run_isolated("flux(static_first)", "flux-expC-flux", "static_first")

# ============ 汇总 ============
print("\n" + "="*70)
print("实验 C 汇总: prefix layout 长历史 cache 对比")
print("="*70)
print(f"模型: {MODEL} | 价格: in=${P_IN} out=${P_OUT} read=${P_READ}/tok")
print(f"task: 5 轮读文件 (相同工作量)")
print()

for r in [naive, flux]:
    print(f"【{r['label']}】")
    for t in r["turns"]:
        u = t["usage"]
        print(f"  轮{t['turn']}: in={u['input']:6d} read={u['cacheRead']:6d} out={u['output']:4d} | ${t['cost']:.6f}")
    tt = r["total"]
    hit = tt["cacheRead"]/(tt["cacheRead"]+tt["input"]+1e-9)*100
    print(f"  累积: in={tt['input']} read={tt['cacheRead']} out={tt['output']} | hit={hit:.1f}% | 总成本${tt['cost']:.6f}")
    print()

print("-"*70)
print("【关键对比】")
nt, ft = naive["total"], flux["total"]
print(f"  naive    累积: in={nt['input']} read={nt['cacheRead']} | ${nt['cost']:.6f}")
print(f"  flux     累积: in={ft['input']} read={ft['cacheRead']} | ${ft['cost']:.6f}")
ratio = ft["cost"]/nt["cost"] if nt["cost"]>0 else 0
saving = (nt["cost"]-ft["cost"])/nt["cost"]*100 if nt["cost"]>0 else 0
print(f"  cost ratio (flux/naive): {ratio:.2f}x | {'flux 省' if saving>0 else 'flux 贵'} {abs(saving):.1f}%")
read_diff = ft["cacheRead"] - nt["cacheRead"]
print(f"  cacheRead diff: {'+' if read_diff>0 else ''}{read_diff} ({'flux 多命中' if read_diff>0 else 'flux 少命中'})")

os.makedirs(OUT_DIR, exist_ok=True)
result = {"experiment":"C-prefix-layout-long-history","model":MODEL,
          "pricing":{"input":P_IN,"output":P_OUT,"cacheRead":P_READ,"cacheWrite":P_WRITE},
          "naive":naive,"flux":flux}
with open(OUT_FILE,"w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"\n结果已保存: {OUT_FILE}")
