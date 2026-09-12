import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import type { WorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';
import type { PushHandlerOptions } from './types';

export interface ExecutionDocuments {
	/**
	 * The document that started this run, if it is the one currently open. It owns the
	 * side effects of having launched the run: toasts, telemetry, form popups, reruns.
	 */
	ownerDocumentId: WorkflowDocumentId | null;
	/**
	 * Documents that merely display this execution. They show what the run produces and
	 * nothing else — a viewer did not start the run and must not be told it "finished
	 * successfully" or have their workflow re-triggered.
	 */
	watcherDocumentIds: WorkflowDocumentId[];
}

/**
 * The documents an execution event belongs to.
 *
 * Returns an empty result when the event concerns an execution nothing on screen shows,
 * which is the common case for a session that has a workflow open while other executions
 * run.
 */
export function resolveExecutionDocuments(
	executionId: string,
	{ documentId }: PushHandlerOptions,
): ExecutionDocuments {
	const isOwner = useWorkflowExecutionStateStore(documentId).activeExecutionId === executionId;

	return {
		ownerDocumentId: isOwner ? documentId : null,
		watcherDocumentIds: [
			...(useExecutionWatchStore().documentsByExecution.get(executionId) ?? []),
		].filter((watcherId) => watcherId !== documentId || !isOwner),
	};
}

/** Every document to update, owner first. */
export function allExecutionDocuments({
	ownerDocumentId,
	watcherDocumentIds,
}: ExecutionDocuments): WorkflowDocumentId[] {
	return ownerDocumentId === null ? watcherDocumentIds : [ownerDocumentId, ...watcherDocumentIds];
}
