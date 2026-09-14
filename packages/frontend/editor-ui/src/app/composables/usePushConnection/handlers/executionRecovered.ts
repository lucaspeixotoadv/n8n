import type { ExecutionRecovered } from '@n8n/api-types/push/execution';
import { useUIStore } from '@/app/stores/ui.store';
import {
	fetchExecutionData,
	getRunExecutionData,
	handleExecutionFinishedWithSuccessOrOther,
	handleExecutionFinishedWithErrorOrCanceled,
	handleExecutionFinishedWithWaitTill,
	refreshWatchingDocuments,
	setRunExecutionData,
} from './executionFinished';
import { resolveExecutionDocuments } from './executionDocuments';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'executionRecovered' event: an execution that was cut short by a restart has
 * been settled from its logs.
 *
 * For a document that merely displays it, the recovery is the finish it never got: the
 * stored execution is read and shown. The document that started the run additionally gets
 * the outcome the way a finish would have reported it.
 */
export async function executionRecovered(
	{ data }: ExecutionRecovered,
	options: PushHandlerOptions,
) {
	const { documentId, suppressExecutionSuccessToasts, suppressExecutionErrorToasts } = options;
	const workflowExecutionStateStore = useWorkflowExecutionStateStore(documentId);
	const uiStore = useUIStore();

	const { watcherDocumentIds } = resolveExecutionDocuments(data.executionId, options);
	await refreshWatchingDocuments(data.executionId, watcherDocumentIds);

	// Only recover the execution this document is tracking. A mismatch (including
	// the no-active-execution case, where activeExecutionId is undefined) means
	// the event belongs to another execution and must be ignored.
	if (workflowExecutionStateStore.activeExecutionId !== data.executionId) {
		return;
	}

	uiStore.setProcessingExecutionResults(true);

	const execution = await fetchExecutionData(data.executionId, documentId);
	if (!execution) {
		uiStore.setProcessingExecutionResults(false);
		return;
	}

	const runExecutionData = getRunExecutionData(execution);
	uiStore.setProcessingExecutionResults(false);

	if (execution.data?.waitTill !== undefined) {
		handleExecutionFinishedWithWaitTill(execution.workflowId ?? '', options);
	} else if (execution.status === 'error' || execution.status === 'canceled') {
		handleExecutionFinishedWithErrorOrCanceled(
			execution,
			runExecutionData,
			documentId,
			suppressExecutionErrorToasts,
		);
	} else {
		handleExecutionFinishedWithSuccessOrOther(
			documentId,
			execution.status,
			false,
			suppressExecutionSuccessToasts,
		);
	}

	setRunExecutionData(execution, runExecutionData, documentId);
}
