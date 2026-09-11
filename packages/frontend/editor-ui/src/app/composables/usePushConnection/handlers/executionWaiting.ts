import type { ExecutionWaiting } from '@n8n/api-types/push/execution';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'executionWaiting' event, which happens when an execution parks — on a Wait
 * node, a form, or a tool call waiting for a callback.
 *
 * The run stops producing node events at that point, so without this the last node stays
 * spinning for anyone watching until the execution resumes.
 */
export async function executionWaiting({ data }: ExecutionWaiting, options: PushHandlerOptions) {
	const documentIds = allExecutionDocuments(resolveExecutionDocuments(data.executionId, options));
	if (documentIds.length === 0) {
		return;
	}

	const executionDataStore = useExecutionDataStore(createExecutionDataId(data.executionId));
	const execution = executionDataStore.getExecutionSnapshot();

	if (execution !== null) {
		executionDataStore.setExecution({ ...execution, status: 'waiting' });
	}

	for (const documentId of documentIds) {
		useWorkflowExecutionStateStore(documentId).executingNode.clearNodeExecutionQueue();
	}
}
