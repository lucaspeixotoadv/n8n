import type { AgentNodeProgress } from '@n8n/api-types';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'agentNodeProgress' event: what an agent node is doing inside its run.
 *
 * Progress is part of watching the execution, not of having started it, so every document
 * displaying the execution shows it.
 */
export async function agentNodeProgress(event: AgentNodeProgress, options: PushHandlerOptions) {
	for (const documentId of allExecutionDocuments(
		resolveExecutionDocuments(event.data.executionId, options),
	)) {
		useWorkflowExecutionStateStore(documentId).handleAgentNodeProgress(event);
	}
}
