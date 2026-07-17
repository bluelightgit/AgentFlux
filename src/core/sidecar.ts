/**
 * AgentFlux F3-5 — Python sidecar 通信协议
 * 文档依据: docs/09-tech-stack, docs/05-routing 层2/3
 *
 * 设计:
 *   - stdio JSON 通信协议 (line-delimited JSON)
 *   - 请求/响应模式: TS 发送 {method, params}, Python 返回 {result, error}
 *   - 如果 Python 不可用, 回退到 TS 启发式 (budget-router.ts + experience-store.ts)
 *
 * 协议:
 *   请求: {"id":"req-1","method":"optimize_budget","params":{...}}
 *   响应: {"id":"req-1","result":{...}} 或 {"id":"req-1","error":"..."}
 *
 * 当前状态: 通信层已实现, Python sidecar 未部署时自动回退到 TS 启发式
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { optimizeBudget, buildAgentModelOptions, type AgentModelOption, type BudgetOptimizerOptions, type BudgetPlan } from "./budget-router";
import { ExperienceStore, type ModeRecommendation } from "./experience-store";

// ─── 协议类型 ───

export interface SidecarRequest {
	id: string;
	method: "optimize_budget" | "suggest_mode" | "rl_update" | "ping";
	params: any;
}

export interface SidecarResponse {
	id: string;
	result?: any;
	error?: string;
}

export type SidecarMethod = SidecarRequest["method"];

// ─── Sidecar 客户端 ───

export class SidecarClient {
	private process: ChildProcess | null = null;
	private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();
	private buffer = "";
	private available = false;
	private pythonPath: string;

	constructor(
		private readonly fluxDir: string,
		pythonPath?: string,
	) {
		this.pythonPath = pythonPath ?? this.findPython();
	}

	/**
	 * 检查 Python sidecar 是否可用.
	 */
	async checkAvailability(): Promise<boolean> {
		// 检查 sidecar 脚本是否存在
		const sidecarScript = join(this.fluxDir, "sidecar", "agentflux_sidecar.py");
		if (!existsSync(sidecarScript)) {
			this.available = false;
			return false;
		}

		try {
			this.startProcess(sidecarScript);
			const resp = await this.send("ping", {});
			this.available = resp === "pong";
			return this.available;
		} catch {
			this.available = false;
			return false;
		}
	}

	/**
	 * 预算优化 (F3-6).
	 * 如果 Python sidecar 可用, 使用 ILP; 否则回退到 TS 启发式.
	 */
	async optimizeBudget(
		agents: AgentModelOption[],
		opts: BudgetOptimizerOptions,
	): Promise<BudgetPlan> {
		if (this.available) {
			try {
				const resp = await this.send("optimize_budget", { agents, ...opts });
				if (resp) return resp as BudgetPlan;
			} catch (e) {
				console.error(`[flux sidecar] ILP failed, falling back to TS heuristic: ${e}`);
			}
		}
		// TS 启发式回退
		return optimizeBudget(agents, opts);
	}

	/**
	 * 模式推荐 (F3-7).
	 * 如果 Python sidecar 可用, 使用 RL; 否则回退到 ExperienceStore 统计.
	 */
	async suggestMode(
		experienceStore: ExperienceStore,
		taskType: string,
		complexityTier: number,
		fileCount: number,
	): Promise<ModeRecommendation | null> {
		if (this.available) {
			try {
				const resp = await this.send("suggest_mode", { taskType, complexityTier, fileCount });
				if (resp) return resp as ModeRecommendation;
			} catch (e) {
				console.error(`[flux sidecar] RL suggest failed, falling back to TS statistics: ${e}`);
			}
		}
		// TS 统计回退
		return experienceStore.suggest(taskType, complexityTier, fileCount);
	}

	/**
	 * RL 更新 (F3-7).
	 * 如果 Python sidecar 可用, 更新 RL 策略; 否则记录到 ExperienceStore.
	 */
	async rlUpdate(
		experienceStore: ExperienceStore,
		params: {
			taskType: string; complexityTier: number; fileCount: number;
			mode: string; success: boolean; cost: number; latencyMs: number;
		},
	): Promise<void> {
		if (this.available) {
			try {
				await this.send("rl_update", params);
				return;
			} catch (e) {
				console.error(`[flux sidecar] RL update failed, recording to ExperienceStore: ${e}`);
			}
		}
		// TS 回退: 记录到 ExperienceStore
		experienceStore.record({
			taskType: params.taskType,
			complexityTier: params.complexityTier,
			fileCount: params.fileCount,
			diffLines: 0,
			routedMode: params.mode as any,
			actualMode: params.mode as any,
			outcome: {
				success: params.success,
				cost: params.cost,
				latencyMs: params.latencyMs,
				turns: 1,
				cacheHitRate: 0,
			},
		});
	}

	get isAvailable(): boolean { return this.available; }

	// ─── 内部: 进程管理 ───

	private findPython(): string {
		try {
			const { execSync } = require("node:child_process");
			execSync("python --version", { stdio: "ignore", timeout: 3000 });
			return "python";
		} catch {
			try {
				const { execSync } = require("node:child_process");
				execSync("python3 --version", { stdio: "ignore", timeout: 3000 });
				return "python3";
			} catch { return "python3"; }
		}
	}

	private startProcess(scriptPath: string): void {
		this.process = spawn(this.pythonPath, [scriptPath], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.fluxDir,
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const resp = JSON.parse(line) as SidecarResponse;
					const pending = this.pendingRequests.get(resp.id);
					if (pending) {
						clearTimeout(pending.timeout);
						this.pendingRequests.delete(resp.id);
						if (resp.error) pending.reject(new Error(resp.error));
						else pending.resolve(resp.result);
					}
				} catch (e) {
					console.error(`[flux sidecar] parse error: ${e}`);
				}
			}
		});

		this.process.on("error", (e) => {
			console.error(`[flux sidecar] process error: ${e}`);
			this.available = false;
		});

		this.process.on("exit", () => {
			this.available = false;
			this.process = null;
		});
	}

	private send(method: SidecarMethod, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.process || !this.process.stdin) {
				reject(new Error("sidecar process not started"));
				return;
			}

			const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const req: SidecarRequest = { id, method, params };

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`sidecar request timeout: ${method}`));
			}, 30000);

			this.pendingRequests.set(id, { resolve, reject, timeout });
			this.process.stdin.write(JSON.stringify(req) + "\n");
		});
	}

	dispose(): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("sidecar disposed"));
		}
		this.pendingRequests.clear();
		this.process?.kill();
		this.process = null;
	}
}

// ─── 便捷函数: 构建并优化 ───

export async function optimizeWithBudget(
	roles: Array<{ name: string; role: string; critical: boolean; estimatedTokens: { input: number; output: number } }>,
	models: Record<string, any>,
	maxTotalCost: number,
	sidecar?: SidecarClient,
): Promise<BudgetPlan> {
	const agents = buildAgentModelOptions(roles, models);
	const opts: BudgetOptimizerOptions = { maxTotalCost };

	if (sidecar && sidecar.isAvailable) {
		return sidecar.optimizeBudget(agents, opts);
	}
	return optimizeBudget(agents, opts);
}
