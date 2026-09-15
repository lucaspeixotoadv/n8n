import { createPinia, setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';

import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution: vi.fn(async () => {}),
	unwatchExecution: vi.fn(async () => {}),
}));

describe('resolveExecutionDocuments', () => {
	const documentId = createWorkflowDocumentId('test-wf');
	const previewDocumentId = createWorkflowDocumentId('preview-wf');
	let options: PushHandlerOptions;

	beforeEach(() => {
		setActivePinia(createPinia());
		options = { router: mock<Router>(), documentId };
	});

	it('returns nothing for an execution no document shows', () => {
		const documents = resolveExecutionDocuments('exec-1', options);

		expect(documents).toEqual({ ownerDocumentId: null, watcherDocumentIds: [] });
		expect(allExecutionDocuments(documents)).toEqual([]);
	});

	it('names the document that started the run as its owner', () => {
		useWorkflowExecutionStateStore(documentId).setActiveExecutionId('exec-1');

		const documents = resolveExecutionDocuments('exec-1', options);

		expect(documents).toEqual({ ownerDocumentId: documentId, watcherDocumentIds: [] });
	});

	it('names a document that only displays the execution as a watcher', () => {
		useExecutionWatchStore().observe(previewDocumentId, 'exec-1');

		const documents = resolveExecutionDocuments('exec-1', options);

		expect(documents).toEqual({
			ownerDocumentId: null,
			watcherDocumentIds: [previewDocumentId],
		});
		expect(allExecutionDocuments(documents)).toEqual([previewDocumentId]);
	});

	it('does not list the owning document twice when it also watches', () => {
		useWorkflowExecutionStateStore(documentId).setActiveExecutionId('exec-1');
		useExecutionWatchStore().observe(documentId, 'exec-1');

		const documents = resolveExecutionDocuments('exec-1', options);

		expect(documents).toEqual({ ownerDocumentId: documentId, watcherDocumentIds: [] });
		expect(allExecutionDocuments(documents)).toEqual([documentId]);
	});

	it('ignores an execution other than the one the open document started', () => {
		useWorkflowExecutionStateStore(documentId).setActiveExecutionId('exec-2');

		expect(resolveExecutionDocuments('exec-1', options)).toEqual({
			ownerDocumentId: null,
			watcherDocumentIds: [],
		});
	});

	it('puts the owner first when both an owner and watchers exist', () => {
		useWorkflowExecutionStateStore(documentId).setActiveExecutionId('exec-1');
		useExecutionWatchStore().observe(previewDocumentId, 'exec-1');

		expect(allExecutionDocuments(resolveExecutionDocuments('exec-1', options))).toEqual([
			documentId,
			previewDocumentId,
		]);
	});
});
