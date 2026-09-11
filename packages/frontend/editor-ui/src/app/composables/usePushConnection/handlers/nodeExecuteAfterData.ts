import type { NodeExecuteAfterData } from '@n8n/api-types/push/execution';
import { useSchemaPreviewStore } from '@/features/ndv/runData/schemaPreview.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'nodeExecuteAfterData' event, which is sent after a node has executed and contains the resulting data.
 */
export async function nodeExecuteAfterData(
	{ data: pushData }: NodeExecuteAfterData,
	options: PushHandlerOptions,
) {
	const schemaPreviewStore = useSchemaPreviewStore();

	// Ignore node events for an execution nothing on screen shows — a concurrent
	// execution's data must not land on a document.
	const documents = resolveExecutionDocuments(pushData.executionId, options);
	if (allExecutionDocuments(documents).length === 0) {
		return;
	}

	// The data store is keyed by execution id, so one write serves every document
	// showing the run.
	useExecutionDataStore(createExecutionDataId(pushData.executionId)).updateNodeExecutionRunData(
		pushData,
	);

	if (documents.ownerDocumentId === null) {
		return;
	}

	// Schema-preview tracking reports on a workflow the user is building, so it
	// belongs to the document that started the run.
	const workflowDocumentStore = useWorkflowDocumentStore(documents.ownerDocumentId);
	const node = workflowDocumentStore.getNodeByName(pushData.nodeName);

	if (!node) {
		return;
	}

	void schemaPreviewStore.trackSchemaPreviewExecution(
		workflowDocumentStore.workflowId,
		node,
		pushData,
	);
}
