import { Service } from '@n8n/di';

/**
 * Which frontend sessions are watching which executions, on this instance.
 *
 * Execution events have always been addressed to the session that started the run, which
 * is why only a manual execution in its originating tab ever updates live. Watching is a
 * different relationship from starting: it is about an execution someone has open, whoever
 * started it and however it was triggered. This is the registry of that relationship, and
 * it is deliberately local — each instance delivers to its own sessions, and the pubsub
 * relay reaches the rest.
 */
@Service()
export class ExecutionSubscriptionRegistry {
	private readonly refsByExecution = new Map<string, Set<string>>();

	private readonly executionsByRef = new Map<string, Set<string>>();

	subscribe(executionId: string, pushRef: string): void {
		addTo(this.refsByExecution, executionId, pushRef);
		addTo(this.executionsByRef, pushRef, executionId);
	}

	unsubscribe(executionId: string, pushRef: string): void {
		removeFrom(this.refsByExecution, executionId, pushRef);
		removeFrom(this.executionsByRef, pushRef, executionId);
	}

	/** Drops every subscription of a session, for when its connection goes away. */
	unsubscribeAll(pushRef: string): void {
		const executionIds = this.executionsByRef.get(pushRef);
		if (!executionIds) return;

		for (const executionId of executionIds) {
			removeFrom(this.refsByExecution, executionId, pushRef);
		}
		this.executionsByRef.delete(pushRef);
	}

	/** Sessions on this instance watching the execution. */
	subscribersOf(executionId: string): string[] {
		return [...(this.refsByExecution.get(executionId) ?? [])];
	}

	hasSubscribers(executionId: string): boolean {
		return (this.refsByExecution.get(executionId)?.size ?? 0) > 0;
	}
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
	const existing = index.get(key);
	if (existing) {
		existing.add(value);
		return;
	}
	index.set(key, new Set([value]));
}

function removeFrom(index: Map<string, Set<string>>, key: string, value: string): void {
	const existing = index.get(key);
	if (!existing) return;

	existing.delete(value);
	if (existing.size === 0) index.delete(key);
}
