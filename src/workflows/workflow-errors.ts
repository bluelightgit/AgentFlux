/**
 * Trusted Workflow terminal signals.
 *
 * Workflow/Task terminal classification must never be inferred from arbitrary
 * error text: user task descriptions, active-context holder descriptions and
 * provider messages are untrusted data.  A deadline error is therefore an
 * explicit runtime type emitted only by a boundary that observed an actual
 * deadline/timeout fact.
 */
export const WORKFLOW_DEADLINE_EXCEEDED = "WORKFLOW_DEADLINE_EXCEEDED" as const;

export class WorkflowDeadlineExceededError extends Error {
	readonly code = WORKFLOW_DEADLINE_EXCEEDED;
	readonly deadlineAt?: number;

	constructor(message: string, deadlineAt?: number) {
		super(message);
		this.name = "WorkflowDeadlineExceededError";
		this.deadlineAt = deadlineAt;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function isWorkflowDeadlineExceededError(error: unknown): error is WorkflowDeadlineExceededError {
	return error instanceof WorkflowDeadlineExceededError;
}
