import { createPinia, setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';
import type { AgentNodeProgress } from '@n8n/api-types';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';
import { createTestWorkflowExecutionResponse } from '@/__tests__/mocks';

import { agentNodeProgress } from './agentNodeProgress';
import type { PushHandlerOptions } from './types';

vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution: vi.fn(async () => {}),
	unwatchExecution: vi.fn(async () => {}),
}));

describe('agentNodeProgress', () => {
	const editorDocumentId = createWorkflowDocumentId('wf-1');
	const previewDocumentId = createWorkflowDocumentId('preview');
	let options: PushHandlerOptions;

	const event = (executionId = 'exec-1'): AgentNodeProgress => ({
		type: 'agentNodeProgress',
		data: {
			executionId,
			nodeId: 'node-1',
			nodeName: 'Agent',
			runIndex: 0,
			itemIndex: 0,
			sequenceNumber: 0,
			toolCallId: 'call-1',
			capability: { kind: 'tool', name: 'lookup' },
			status: 'running',
		},
	});

	beforeEach(() => {
		setActivePinia(createPinia());
		options = { router: mock<Router>(), documentId: editorDocumentId };
	});

	it('shows the progress in a document that merely displays the execution', async () => {
		useExecutionDataStore(createExecutionDataId('exec-1')).setExecution(
			createTestWorkflowExecutionResponse({ id: 'exec-1', status: 'running', finished: false }),
		);
		const previewStateStore = useWorkflowExecutionStateStore(previewDocumentId);
		previewStateStore.setDisplayedExecutionId('exec-1');
		expect(useExecutionWatchStore().documentsWatching('exec-1')).toEqual([previewDocumentId]);

		await agentNodeProgress(event(), options);

		expect(previewStateStore.activeAgentCapabilityKeysByNodeId.has('node-1')).toBe(true);
	});

	it('shows the progress in the document that started the run', async () => {
		const editorStateStore = useWorkflowExecutionStateStore(editorDocumentId);
		editorStateStore.setActiveExecutionId('exec-1');

		await agentNodeProgress(event(), options);

		expect(editorStateStore.activeAgentCapabilityKeysByNodeId.has('node-1')).toBe(true);
	});

	it('ignores progress of an execution no document shows', async () => {
		const editorStateStore = useWorkflowExecutionStateStore(editorDocumentId);
		editorStateStore.setActiveExecutionId('exec-1');

		await agentNodeProgress(event('exec-other'), options);

		expect(editorStateStore.activeAgentCapabilityKeysByNodeId.size).toBe(0);
	});
});
