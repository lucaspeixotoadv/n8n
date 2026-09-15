import type { Serialized } from '@langchain/core/load/serializable';
import type { ISupplyDataFunctions } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { N8nNonEstimatingTracing } from '../N8nNonEstimatingTracing';

describe('N8nNonEstimatingTracing', () => {
	const executionFunctions = mock<ISupplyDataFunctions>({
		addInputData: vi.fn().mockReturnValue({ index: 0 }),
		addOutputData: vi.fn(),
		getNode: vi.fn().mockReturnValue({ name: 'TestNode' }),
		getNextRunIndex: vi.fn().mockReturnValue(0),
	});

	beforeEach(() => {
		vi.clearAllMocks();
		executionFunctions.addInputData.mockReturnValue({ index: 0 });
	});

	describe('handleLLMStart', () => {
		const serializedModel: Serialized = {
			lc: 1,
			type: 'constructor',
			id: ['langchain', 'chat_models', 'openai'],
			kwargs: {
				model: 'gpt-4',
				configuration: {
					baseURL: 'https://api.openai.com/v1',
					defaultHeaders: {
						'User-Agent': 'n8n',
						authorization: 'Bearer My_secret_API_key123456789',
						'x-secret-header': 'My_secret_API_key123456789',
					},
				},
			},
		};

		const getPersistedHeaders = () => {
			const inputArg = executionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { configuration: { defaultHeaders: Record<string, string> } } } }>
			>;
			return inputArg[0][0].json.options.configuration.defaultHeaders;
		};

		it('should mask declared header values in persisted input data', async () => {
			const tracer = new N8nNonEstimatingTracing(executionFunctions, {
				redactedHeaders: ['x-secret-header'],
			});

			await tracer.handleLLMStart(serializedModel, ['hello'], 'run-123');

			const persistedHeaders = getPersistedHeaders();
			expect(persistedHeaders['x-secret-header']).toBe('**********');
			// non-declared header is untouched
			expect(persistedHeaders['User-Agent']).toBe('n8n');

			// stored run details are masked the same way
			const storedOptions = tracer.runsMap['run-123'].options as {
				configuration: { defaultHeaders: Record<string, string> };
			};
			expect(storedOptions.configuration.defaultHeaders['x-secret-header']).toBe('**********');

			// the original serialized object is not mutated
			expect(
				(serializedModel.kwargs.configuration as { defaultHeaders: Record<string, string> })
					.defaultHeaders['x-secret-header'],
			).toBe('My_secret_API_key123456789');
		});

		it('should mask the always-redacted header names without being asked to', async () => {
			const tracer = new N8nNonEstimatingTracing(executionFunctions);

			await tracer.handleLLMStart(serializedModel, ['hello'], 'run-123');

			// the floor every model gets: ALWAYS_REDACTED_HEADERS in redact-headers.ts, which
			// covers the nodes that declare no header names of their own
			expect(getPersistedHeaders().authorization).toBe('**********');
		});

		it('should keep header values that are neither declared nor always-redacted', async () => {
			const tracer = new N8nNonEstimatingTracing(executionFunctions);

			await tracer.handleLLMStart(serializedModel, ['hello'], 'run-123');

			// masking is opt-in per header name, so a name the model never declared is kept
			expect(getPersistedHeaders()['x-secret-header']).toBe('My_secret_API_key123456789');
		});
	});
});

describe('N8nNonEstimatingTracing parent run pinning', () => {
	const serialized: Serialized = { lc: 1, type: 'constructor', id: ['test'], kwargs: {} };

	it('reports the run it opened so a parent can pin it on the child tracers', async () => {
		const onRunStarted = vi.fn();
		const executionFunctions = mock<ISupplyDataFunctions>({
			addInputData: vi.fn().mockReturnValue({ index: 4 }),
			getNextRunIndex: vi.fn().mockReturnValue(4),
		});
		const tracer = new N8nNonEstimatingTracing(executionFunctions, { onRunStarted });

		await tracer.handleLLMStart(serialized, ['hello'], 'run-9');

		expect(onRunStarted).toHaveBeenCalledWith('run-9', 4);
	});

	it('points its own run to the parent run pinned for the invocation', async () => {
		const executionFunctions = mock<ISupplyDataFunctions>({
			addInputData: vi.fn().mockReturnValue({ index: 1 }),
			addOutputData: vi.fn(),
			getNextRunIndex: vi.fn().mockReturnValue(1),
		});
		const tracer = new N8nNonEstimatingTracing(executionFunctions);
		tracer.setParentRunIndexForRun('run-9', 7);

		await tracer.handleLLMStart(serialized, ['hello'], 'run-9');
		await tracer.handleLLMEnd({ generations: [[{ text: 'ok' }]] }, 'run-9');

		expect(executionFunctions.addInputData).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			7,
		);
		expect(executionFunctions.addOutputData).toHaveBeenCalledWith(
			expect.anything(),
			1,
			expect.any(Array),
			undefined,
			7,
		);
	});
});
