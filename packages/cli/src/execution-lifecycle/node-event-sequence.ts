/**
 * The order of an execution's node events, for a consumer that may receive them late.
 *
 * The engine numbers every task of an execution with an `executionIndex` in the order it
 * starts them, and keeps counting across a resume. A node event is therefore ordered by the
 * task it belongs to, with the start of a task before its end. Deriving the number from the
 * task rather than counting events means every producer of the same event — the live push
 * and the snapshot built from the journal — arrives at the same number without sharing any
 * state, so a session can compare the two.
 */
export function nodeEventSequence(executionIndex: number, phase: 'started' | 'finished'): number {
	return executionIndex * 2 + (phase === 'finished' ? 1 : 0);
}
