import { createPinia, setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { createTestWorkflowExecutionResponse } from '@/__tests__/mocks';

import { executionRecovered } from './executionRecovered';
import type { PushHandlerOptions } from './types';

vi.mock('./executionFinished', () => ({
	refreshWatchingDocuments: vi.fn(),
	fetchExecutionData: vi.fn(),
	getRunExecutionData: vi.fn(),
	handleExecutionFinishedWithSuccessOrOther: vi.fn(),
	handleExecutionFinishedWithErrorOrCanceled: vi.fn(),
	handleExecutionFinishedWithWaitTill: vi.fn(),
	setRunExecutionData: vi.fn(),
}));
vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution: vi.fn(async () => {}),
	unwatchExecution: vi.fn(async () => {}),
}));

import { fetchExecutionData, refreshWatchingDocuments } from './executionFinished';

describe('executionRecovered', () => {
	const editorDocumentId = createWorkflowDocumentId('wf-1');
	const previewDocumentId = createWorkflowDocumentId('preview');
	let options: PushHandlerOptions;

	beforeEach(() => {
		vi.clearAllMocks();
		setActivePinia(createPinia());
		options = { router: mock<Router>(), documentId: editorDocumentId };
	});

	it('brings a document that merely displays the execution to its stored state', async () => {
		useExecutionDataStore(createExecutionDataId('exec-1')).setExecution(
			createTestWorkflowExecutionResponse({ id: 'exec-1', status: 'running', finished: false }),
		);
		useWorkflowExecutionStateStore(previewDocumentId).setDisplayedExecutionId('exec-1');

		await executionRecovered(
			{ type: 'executionRecovered', data: { executionId: 'exec-1' } },
			options,
		);

		expect(refreshWatchingDocuments).toHaveBeenCalledWith('exec-1', [previewDocumentId]);
		// A viewer did not start the run: the outcome is not reported to it as its own.
		expect(fetchExecutionData).not.toHaveBeenCalled();
	});

	it('reports the outcome to the document that started the run', async () => {
		useWorkflowExecutionStateStore(editorDocumentId).setActiveExecutionId('exec-1');

		await executionRecovered(
			{ type: 'executionRecovered', data: { executionId: 'exec-1' } },
			options,
		);

		expect(fetchExecutionData).toHaveBeenCalledWith('exec-1', editorDocumentId);
	});

	it('ignores an execution no document shows', async () => {
		await executionRecovered(
			{ type: 'executionRecovered', data: { executionId: 'exec-1' } },
			options,
		);

		expect(refreshWatchingDocuments).toHaveBeenCalledWith('exec-1', []);
		expect(fetchExecutionData).not.toHaveBeenCalled();
	});
});
