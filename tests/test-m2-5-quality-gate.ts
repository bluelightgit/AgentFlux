/**
 * Quality gate 三态语义的确定性回归测试。
 * 不调用真实模型，不读写项目 .agentflux；所有路径均位于系统临时目录。
 */

import {
	checkQualityGate,
	formatQualityGateResult,
	interpretQualityGateJudgeExecution,
	parseQualityGateJudgeOutput,
} from "../src/extension/quality-gate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function main() {
	const tempRoot = mkdtempSync(join(tmpdir(), "agentflux-quality-gate-test-"));
	const criteria = ["Output has a summary", "Output lists a concrete finding"];

	try {
		const skipped = await checkQualityGate("anything", [], { cwd: tempRoot });
		record("empty criteria is a safe pass",
			skipped.status === "passed" && skipped.passed && skipped.gateCost === 0,
			`status=${skipped.status}, passed=${skipped.passed}`);

		const emptyOutput = await checkQualityGate("", criteria, { cwd: tempRoot });
		record("empty agent output is indeterminate",
			emptyOutput.status === "indeterminate" && !emptyOutput.passed && emptyOutput.gateCost === 0,
			`status=${emptyOutput.status}, feedback=${emptyOutput.feedback}`);

		const parsedPass = parseQualityGateJudgeOutput(JSON.stringify({
			passed: true,
			criteriaResults: criteria.map(criterion => ({ criterion, met: true })),
			feedback: "all met",
		}), criteria);
		record("strict valid pass JSON",
			parsedPass.status === "passed" && parsedPass.passed && parsedPass.criteriaResults.length === 2,
			`status=${parsedPass.status}`);

		const parsedFail = parseQualityGateJudgeOutput(JSON.stringify({
			passed: false,
			criteriaResults: [
				{ criterion: criteria[0], met: true },
				{ criterion: criteria[1], met: false },
			],
			feedback: "second criterion missing",
		}), criteria);
		record("strict valid failed JSON",
			parsedFail.status === "failed" && !parsedFail.passed,
			`status=${parsedFail.status}`);

		const malformed = parseQualityGateJudgeOutput("not-json", criteria);
		record("parse failure is indeterminate",
			malformed.status === "indeterminate" && !malformed.passed,
			`status=${malformed.status}`);

		const missingCriterion = parseQualityGateJudgeOutput(JSON.stringify({
			passed: true,
			criteriaResults: [{ criterion: criteria[0], met: true }],
			feedback: "incomplete",
		}), criteria);
		record("criterion cardinality mismatch is indeterminate",
			missingCriterion.status === "indeterminate" && !missingCriterion.passed,
			`status=${missingCriterion.status}`);

		const inconsistent = parseQualityGateJudgeOutput(JSON.stringify({
			passed: true,
			criteriaResults: [
				{ criterion: criteria[0], met: true },
				{ criterion: criteria[1], met: false },
			],
			feedback: "contradictory",
		}), criteria);
		record("contradictory verdict is indeterminate",
			inconsistent.status === "indeterminate" && !inconsistent.passed,
			`status=${inconsistent.status}`);

		const timedOut = interpretQualityGateJudgeExecution({
			output: "", exitCode: 124, timedOut: true, gateCost: 0.001,
		}, criteria);
		record("judge timeout is indeterminate and preserves cost",
			timedOut.status === "indeterminate" && !timedOut.passed && timedOut.gateCost === 0.001,
			`status=${timedOut.status}, cost=${timedOut.gateCost}`);

		const modelError = interpretQualityGateJudgeExecution({
			output: "", exitCode: 0, errorMessage: "model not found",
		}, criteria);
		record("judge model error is indeterminate",
			modelError.status === "indeterminate" && !modelError.passed,
			`status=${modelError.status}`);

		const processError = interpretQualityGateJudgeExecution({
			output: "", exitCode: 1,
		}, criteria);
		record("judge process failure is indeterminate",
			processError.status === "indeterminate" && !processError.passed,
			`status=${processError.status}`);

		const formatted = formatQualityGateResult(modelError);
		record("formatter exposes indeterminate state",
			formatted.includes("INDETERMINATE"),
			formatted.split("\n")[0]);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}

	const failed = results.filter(r => !r.passed);
	console.log(`\nQuality gate tests: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
