import type { ExecutionSnapshot } from '@n8n/api-types/push/execution';
import { parse } from 'flatted';
import { isTerminalExecutionStatus } from 'n8n-workflow';
import type { IRunData } from 'n8n-workflow';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { refreshWatchingDocuments } from './executionFinished';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'executionSnapshot' event: what an execution has done so far, sent when a
 * session subscribes to it.
 *
 * The session already holds the execution as it read it over HTTP, and may already have
 * applied events that reached it after the subscription was registered but before the
 * snapshot was built. So the snapshot is merged, run by run, over what is displayed: a run
 * it brings is added or refreshed, and a run it does not know is kept. Applied the same
 * way after a lost connection, this is how the session catches up without losing what it
 * saw or showing anything twice.
 */
export async function executionSnapshot({ data }: ExecutionSnapshot, options: PushHandlerOptions) {
	const documents = resolveExecutionDocuments(data.executionId, options);
	const documentIds = allExecutionDocuments(documents);
	if (documentIds.length === 0) {
		return;
	}

	const executionDataStore = useExecutionDataStore(createExecutionDataId(data.executionId));
	const displayed = executionDataStore.getExecutionSnapshot();
	// Nothing displayed yet to complete: the read that follows carries the same state.
	if (displayed === null) {
		return;
	}

	// The execution ended while the session was not listening, so no finish event will
	// come: treat the snapshot as the finish, which reads the stored execution in full.
	if (isTerminalExecutionStatus(data.status)) {
		await refreshWatchingDocuments(data.executionId, documents.watcherDocumentIds);
		return;
	}

	if (data.flattedRunData !== undefined) {
		executionDataStore.mergeExecutionRunData(parse(data.flattedRunData) as IRunData);
	}

	if (displayed.status !== data.status) {
		executionDataStore.setExecution(
			{ ...executionDataStore.getExecutionSnapshot(), status: data.status } as never,
			{ stripWaitingTaskData: false },
		);
	}

	// A parked execution produces no node events, so nothing can be shown as executing.
	if (data.status === 'waiting') {
		for (const documentId of documentIds) {
			useWorkflowExecutionStateStore(documentId).executingNode.clearNodeExecutionQueue();
		}
	}
}
