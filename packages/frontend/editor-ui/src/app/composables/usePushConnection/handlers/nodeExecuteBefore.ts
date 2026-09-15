import type { NodeExecuteBefore } from '@n8n/api-types/push/execution';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'nodeExecuteBefore' event, which happens before a node is executed.
 */
export async function nodeExecuteBefore(
	{ data }: NodeExecuteBefore,
	options: PushHandlerOptions,
) {
	// Ignore node events for an execution nothing on screen shows — otherwise a
	// concurrent execution's node would pollute a document's spinner queue and
	// execution data.
	const documentIds = allExecutionDocuments(resolveExecutionDocuments(data.executionId, options));
	if (documentIds.length === 0) {
		return;
	}

	for (const documentId of documentIds) {
		useWorkflowExecutionStateStore(documentId).executingNode.addExecutingNode(
			data.nodeName,
			data.sequenceNumber,
		);
	}

	useExecutionDataStore(createExecutionDataId(data.executionId)).addNodeExecutionStartedData(data);
}
