import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { INode, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { Mock, Mocked } from 'vitest';

import * as logAiEventModule from 'src/utils/log-ai-event';
import { N8nLlmTracing } from 'src/utils/n8n-llm-tracing';
import * as tokenEstimatorModule from 'src/utils/tokenizer/token-estimator';

// Mock the dependencies
vi.mock('src/utils/log-ai-event', () => ({
	logAiEvent: vi.fn(),
}));

vi.mock('src/utils/tokenizer/token-estimator', () => ({
	estimateTokensFromStringList: vi.fn().mockResolvedValue(100),
}));

const logAiEvent = vi.mocked(logAiEventModule.logAiEvent);
const estimateTokensFromStringList = vi.mocked(tokenEstimatorModule.estimateTokensFromStringList);

describe('N8nLlmTracing', () => {
	let mockExecutionFunctions: Mocked<ISupplyDataFunctions>;
	let mockNode: INode;

	beforeEach(() => {
		mockNode = {
			id: 'test-node',
			name: 'Test Node',
			type: 'n8n-nodes-base.testNode',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		};

		mockExecutionFunctions = {
			getNode: vi.fn().mockReturnValue(mockNode),
			addOutputData: vi.fn(),
			addInputData: vi.fn().mockReturnValue({ index: 0 }),
			getNextRunIndex: vi.fn().mockReturnValue(0),
			setMetadata: vi.fn(),
		} as unknown as Mocked<ISupplyDataFunctions>;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('should create instance with default options', () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			expect(tracer).toBeInstanceOf(N8nLlmTracing);
			expect(tracer.name).toBe('N8nLlmTracing');
			expect(tracer.awaitHandlers).toBe(true);
			expect(tracer.connectionType).toBe(NodeConnectionTypes.AiLanguageModel);
		});

		it('should create instance with custom tokensUsageParser', () => {
			const customParser = vi.fn().mockReturnValue({
				completionTokens: 50,
				promptTokens: 30,
				totalTokens: 80,
			});

			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				tokensUsageParser: customParser,
			});

			expect(tracer).toBeInstanceOf(N8nLlmTracing);
		});

		it('should create instance with custom errorDescriptionMapper', () => {
			const customMapper = vi.fn().mockReturnValue('Custom error description');

			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				errorDescriptionMapper: customMapper,
			});

			expect(tracer).toBeInstanceOf(N8nLlmTracing);
		});
	});

	describe('handleLLMStart', () => {
		it('should handle LLM start event with prompts', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'llms', 'openai'],
				kwargs: { modelName: 'gpt-4', temperature: 0.7 },
			};

			const prompts = ['What is the capital of France?'];
			const runId = 'run-123';

			await tracer.handleLLMStart(llm, prompts, runId);

			expect(mockExecutionFunctions.addInputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({
							json: expect.objectContaining({
								messages: prompts,
								estimatedTokens: expect.any(Number),
								options: llm.kwargs,
							}),
						}),
					]),
				]),
				undefined,
			);

			expect(estimateTokensFromStringList).toHaveBeenCalledWith(prompts, 'gpt-4o');
		});

		it('should store run details for later use', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'not_implemented',
				id: ['langchain', 'llms', 'test'],
			};

			const prompts = ['Test prompt'];
			const runId = 'run-123';

			await tracer.handleLLMStart(llm, prompts, runId);

			expect(tracer.runsMap[runId]).toBeDefined();
			expect(tracer.runsMap[runId].messages).toEqual(prompts);
			expect(tracer.runsMap[runId].index).toBe(0);
		});

		it('should handle multiple prompts', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'llms', 'openai'],
				kwargs: {},
			};

			const prompts = ['Prompt 1', 'Prompt 2', 'Prompt 3'];
			const runId = 'run-123';

			await tracer.handleLLMStart(llm, prompts, runId);

			expect(tracer.runsMap[runId].messages).toEqual(prompts);
			expect(estimateTokensFromStringList).toHaveBeenCalledWith(prompts, 'gpt-4o');
		});

		it('should mask declared header values in persisted input data', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				redactedHeaders: ['x-secret-header'],
			});

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					model: 'gpt-4',
					configuration: {
						baseURL: 'https://api.openai.com/v1',
						defaultHeaders: {
							'User-Agent': 'n8n',
							'x-secret-header': 'My_secret_API_key123456789',
						},
					},
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { configuration: { defaultHeaders: Record<string, string> } } } }>
			>;
			const persistedHeaders = inputArg[0][0].json.options.configuration.defaultHeaders;

			// declared header name stays, value is masked
			expect(persistedHeaders['x-secret-header']).toBe('**********');
			expect(persistedHeaders['x-secret-header']).not.toBe('My_secret_API_key123456789');
			// non-declared header is untouched
			expect(persistedHeaders['User-Agent']).toBe('n8n');

			// stored run details are masked the same way
			const storedOptions = tracer.runsMap['run-123'].options as {
				configuration: { defaultHeaders: Record<string, string> };
			};
			expect(storedOptions.configuration.defaultHeaders['x-secret-header']).toBe('**********');

			// The original serialized object is not mutated
			expect(
				(llm.kwargs.configuration as { defaultHeaders: Record<string, string> }).defaultHeaders[
					'x-secret-header'
				],
			).toBe('My_secret_API_key123456789');
		});

		it('should mask declared header values inside clientOptions', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				redactedHeaders: ['x-secret-header'],
			});

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'anthropic'],
				kwargs: {
					model: 'claude',
					clientOptions: {
						defaultHeaders: {
							'User-Agent': 'n8n',
							'x-secret-header': 'My_secret_API_key123456789',
						},
					},
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { clientOptions: { defaultHeaders: Record<string, string> } } } }>
			>;
			const persistedHeaders = inputArg[0][0].json.options.clientOptions.defaultHeaders;

			expect(persistedHeaders['x-secret-header']).toBe('**********');
			expect(persistedHeaders['User-Agent']).toBe('n8n');
		});

		it('should always mask the Authorization header value', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					model: 'llama3',
					// top-level header map and nested wrapper
					headers: { authorization: 'Bearer top-secret', Cookie: 'session=abc' },
					configuration: {
						defaultHeaders: { Authorization: 'Bearer nested-secret', 'x-api-key': 'sk-123' },
					},
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{
					json: {
						options: {
							headers: Record<string, string>;
							configuration: { defaultHeaders: Record<string, string> };
						};
					};
				}>
			>;
			const persisted = inputArg[0][0].json.options;
			// Matched case-insensitively, in both container shapes
			expect(persisted.headers.authorization).toBe('**********');
			expect(persisted.headers.Cookie).toBe('**********');
			expect(persisted.configuration.defaultHeaders.Authorization).toBe('**********');
			expect(persisted.configuration.defaultHeaders['x-api-key']).toBe('**********');
		});

		it('should mask the Authorization header value at any nesting depth', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					configuration: { httpAgent: { headers: { Authorization: 'Bearer deep-secret' } } },
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{
					json: { options: { configuration: { httpAgent: { headers: Record<string, string> } } } };
				}>
			>;
			expect(inputArg[0][0].json.options.configuration.httpAgent.headers.Authorization).toBe(
				'**********',
			);
		});

		it('should redact header values inside an array element', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					transports: [{ headers: { Authorization: 'Bearer array-secret' } }],
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { transports: Array<{ headers: Record<string, string> }> } } }>
			>;
			expect(inputArg[0][0].json.options.transports[0].headers.Authorization).toBe('**********');
		});

		it('should match a declared header name case-insensitively', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				redactedHeaders: ['X-Secret-Header'],
			});

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					configuration: { defaultHeaders: { 'x-secret-header': 'My_secret_API_key123456789' } },
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { configuration: { defaultHeaders: Record<string, string> } } } }>
			>;
			expect(inputArg[0][0].json.options.configuration.defaultHeaders['x-secret-header']).toBe(
				'**********',
			);
		});

		it('should not mask a non-header field that shares a declared name', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				redactedHeaders: ['model'],
			});

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					model: 'gpt-4',
					configuration: { defaultHeaders: { model: 'header-value' } },
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{
					json: {
						options: { model: string; configuration: { defaultHeaders: Record<string, string> } };
					};
				}>
			>;
			const persisted = inputArg[0][0].json.options;
			// Top-level model field stays; only the header-container occurrence is masked
			expect(persisted.model).toBe('gpt-4');
			expect(persisted.configuration.defaultHeaders.model).toBe('**********');
		});

		it('should leave headers unchanged when nothing is declared', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['langchain', 'chat_models', 'openai'],
				kwargs: {
					configuration: {
						defaultHeaders: { 'x-secret-header': 'My_secret_API_key123456789' },
					},
				},
			};

			await tracer.handleLLMStart(llm, ['hello'], 'run-123');

			const inputArg = mockExecutionFunctions.addInputData.mock.calls[0][1] as Array<
				Array<{ json: { options: { configuration: { defaultHeaders: Record<string, string> } } } }>
			>;
			expect(inputArg[0][0].json.options.configuration.defaultHeaders['x-secret-header']).toBe(
				'My_secret_API_key123456789',
			);
		});

		it('should use parent run index when set', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.setParentRunIndex(5);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['test'],
				kwargs: {},
			};

			mockExecutionFunctions.getNextRunIndex.mockReturnValue(2);

			await tracer.handleLLMStart(llm, ['test'], 'run-123');

			expect(mockExecutionFunctions.addInputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				expect.any(Array),
				7, // 5 (parent) + 2 (next)
			);
		});
	});

	describe('handleLLMEnd', () => {
		it('should handle LLM end event with token usage', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			// Setup run
			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test prompt'],
				options: {},
			};
			tracer.promptTokensEstimate = 50;

			const output: LLMResult = {
				generations: [[{ text: 'Response text', generationInfo: {} }]],
				llmOutput: {
					tokenUsage: {
						completionTokens: 30,
						promptTokens: 50,
						totalTokens: 80,
					},
				},
			};

			await tracer.handleLLMEnd(output, runId);

			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				0,
				expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({
							json: expect.objectContaining({
								response: expect.objectContaining({
									generations: expect.any(Array),
								}),
								tokenUsage: expect.objectContaining({
									completionTokens: 30,
									promptTokens: 50,
									totalTokens: 80,
								}),
							}),
						}),
					]),
				]),
				undefined,
				undefined,
			);

			expect(logAiEvent).toHaveBeenCalledWith(
				mockExecutionFunctions,
				'ai-llm-generated-output',
				expect.any(Object),
			);

			expect(
				(mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata,
			).toHaveBeenCalledWith({
				tracing: {
					'llm.tokens.in': 50,
					'llm.tokens.out': 30,
					'llm.tokens.total': 80,
					'llm.tokens.estimated': false,
					'llm.cost.unavailable_reason': 'unknown-provider',
				},
			});
		});

		it('should use token estimates when actual tokens not available', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test prompt'],
				options: {},
			};
			tracer.promptTokensEstimate = 50;

			estimateTokensFromStringList.mockResolvedValue(25);

			const output: LLMResult = {
				generations: [[{ text: 'Response text' }]],
				llmOutput: {},
			};

			await tracer.handleLLMEnd(output, runId);

			const callArgs = mockExecutionFunctions.addOutputData.mock.calls[0] as any;
			const outputData = callArgs?.[2]?.[0]?.[0]?.json;

			expect(outputData.tokenUsageEstimate).toBeDefined();
			expect(outputData.tokenUsageEstimate.completionTokens).toBe(25);
			expect(outputData.tokenUsageEstimate.promptTokens).toBe(50);
			expect(outputData.tokenUsageEstimate.totalTokens).toBe(75);
			expect(
				(mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata,
			).toHaveBeenCalledWith({
				tracing: {
					'llm.tokens.in': 50,
					'llm.tokens.out': 25,
					'llm.tokens.total': 75,
					'llm.tokens.estimated': true,
					'llm.cost.unavailable_reason': 'estimated-usage',
				},
			});
			expect(outputData.cost).toBeUndefined();
		});

		it('should handle string messages', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: 'Simple string message',
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {},
			};

			await tracer.handleLLMEnd(output, runId);

			expect(logAiEvent).toHaveBeenCalledWith(
				mockExecutionFunctions,
				'ai-llm-generated-output',
				expect.objectContaining({
					messages: 'Simple string message',
				}),
			);
		});

		it('should handle BaseMessage objects with toJSON', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const mockMessage: Partial<BaseMessage> = {
				toJSON: vi.fn().mockReturnValue({ content: 'test', role: 'user' }),
			};

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: [mockMessage as BaseMessage],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {},
			};

			await tracer.handleLLMEnd(output, runId);

			expect(mockMessage.toJSON).toHaveBeenCalled();
		});

		it('should handle missing run details gracefully', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {},
			};

			// Set up minimal run details with index but no messages
			tracer.runsMap['non-existent-run'] = {
				index: 0,
				messages: [],
				options: {},
			};

			// Run without full setup
			await tracer.handleLLMEnd(output, 'non-existent-run');

			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalled();
		});

		it('should strip unnecessary fields from generation info', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [
					[
						{
							text: 'Response',
							generationInfo: { model: 'gpt-4' },
							extraField: 'should be removed',
						} as any,
					],
				],
				llmOutput: {},
			};

			await tracer.handleLLMEnd(output, runId);

			const callArgs = mockExecutionFunctions.addOutputData.mock.calls[0] as any;
			const generations = callArgs[2][0][0].json.response.generations[0][0];

			expect(generations).toHaveProperty('text');
			expect(generations).toHaveProperty('generationInfo');
			expect(generations).not.toHaveProperty('extraField');
		});
	});

	describe('handleLLMError', () => {
		it('should handle NodeError', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const error = new NodeOperationError(mockNode, 'Test error', {
				description: 'Test description',
			});

			await tracer.handleLLMError(error, runId);

			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				0,
				error,
				undefined,
				undefined,
			);

			expect(logAiEvent).toHaveBeenCalledWith(
				mockExecutionFunctions,
				'ai-llm-errored',
				expect.objectContaining({
					error: expect.any(Object),
					runId,
				}),
			);
		});

		it('should wrap non-NodeError errors', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const error = new Error('Generic error');

			await tracer.handleLLMError(error, runId);

			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				0,
				expect.any(NodeOperationError),
				undefined,
				undefined,
			);
		});

		it('should filter out non-x- headers from error', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const error = {
				headers: {
					'x-request-id': '123',
					authorization: 'Bearer token',
					'content-type': 'application/json',
					'x-custom-header': 'value',
				},
			};

			await tracer.handleLLMError(error, runId);

			expect(error.headers).toHaveProperty('x-request-id');
			expect(error.headers).toHaveProperty('x-custom-header');
			expect(error.headers).not.toHaveProperty('authorization');
			expect(error.headers).not.toHaveProperty('content-type');
		});

		it('should use custom error description mapper', async () => {
			const customMapper = vi.fn().mockReturnValue('Custom description');
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				errorDescriptionMapper: customMapper,
			});

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const error = new NodeOperationError(mockNode, 'Test error');

			await tracer.handleLLMError(error, runId);

			expect(customMapper).toHaveBeenCalledWith(error);
			expect(error.description).toBe('Custom description');
		});

		it('should handle error with empty object', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const error = {};

			await tracer.handleLLMError(error, runId);

			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalled();
			expect(logAiEvent).toHaveBeenCalledWith(
				mockExecutionFunctions,
				'ai-llm-errored',
				expect.objectContaining({
					error: expect.any(String), // Should call toString()
				}),
			);
		});
	});

	describe('token estimation', () => {
		it('should estimate tokens from generation', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const generations: LLMResult['generations'] = [
				[{ text: 'Response 1' }, { text: 'Response 2' }],
			];

			estimateTokensFromStringList.mockResolvedValue(42);

			const result = await tracer.estimateTokensFromGeneration(generations);

			expect(result).toBe(42);
			expect(estimateTokensFromStringList).toHaveBeenCalledWith(
				['Response 1', 'Response 2'],
				'gpt-4o',
			);
		});

		it('should estimate tokens from string list', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const list = ['String 1', 'String 2', 'String 3'];

			estimateTokensFromStringList.mockResolvedValue(75);

			const result = await tracer.estimateTokensFromStringList(list);

			expect(result).toBe(75);
			expect(estimateTokensFromStringList).toHaveBeenCalledWith(list, 'gpt-4o');
		});
	});

	describe('setParentRunIndexForRun', () => {
		const llm: Serialized = { lc: 1, type: 'constructor', id: ['test'], kwargs: {} };

		it('points the run to the parent run pinned for that invocation, whatever ran before', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			// The model already ran twice under another parent run
			mockExecutionFunctions.getNextRunIndex.mockReturnValue(2);
			mockExecutionFunctions.addInputData.mockReturnValue({ index: 2 });
			tracer.setParentRunIndexForRun('run-abc', 5);

			await tracer.handleLLMStart(llm, ['prompt'], 'run-abc');
			await tracer.handleLLMEnd(
				{
					generations: [[{ text: 'ok' }]],
					llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1 } },
				},
				'run-abc',
			);

			expect(mockExecutionFunctions.addInputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				expect.any(Array),
				5,
			);
			expect(mockExecutionFunctions.addOutputData).toHaveBeenCalledWith(
				NodeConnectionTypes.AiLanguageModel,
				2,
				expect.any(Array),
				undefined,
				5,
			);
		});

		it('consumes the pin, so a later unpinned invocation is not attributed to it', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.setParentRunIndexForRun('run-1', 5);

			await tracer.handleLLMStart(llm, ['a'], 'run-1');
			await tracer.handleLLMStart(llm, ['b'], 'run-2');

			expect(mockExecutionFunctions.addInputData).toHaveBeenNthCalledWith(
				2,
				NodeConnectionTypes.AiLanguageModel,
				expect.any(Array),
				undefined,
			);
		});
	});

	describe('setParentRunIndex', () => {
		it('should set parent run index', () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			tracer.setParentRunIndex(10);

			// The private field can't be accessed directly, but we can verify behavior
			// in handleLLMStart
			expect(tracer).toBeDefined();
		});
	});

	describe('custom token usage parser', () => {
		it('should use custom token usage parser', async () => {
			const customParser = vi.fn().mockReturnValue({
				completionTokens: 100,
				promptTokens: 50,
				totalTokens: 150,
				cost: 0.0042,
			});

			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				tokensUsageParser: customParser,
			});

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: { customTokenData: 'test' },
			};

			await tracer.handleLLMEnd(output, runId);

			expect(customParser).toHaveBeenCalledWith(output);

			const callArgs = mockExecutionFunctions.addOutputData.mock.calls[0] as any;
			const outputData = callArgs[2][0][0].json;

			expect(outputData.tokenUsage).toEqual({
				completionTokens: 100,
				promptTokens: 50,
				totalTokens: 150,
			});
			expect(outputData.cost).toEqual({ amount: 0.0042, currency: 'USD', source: 'provider' });
			expect(
				(mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata,
			).toHaveBeenCalledWith({
				tracing: {
					'llm.tokens.in': 50,
					'llm.tokens.out': 100,
					'llm.tokens.total': 150,
					'llm.tokens.estimated': false,
					'llm.cost.total': 0.0042,
					'llm.cost.source': 'provider',
				},
			});
		});

		it('should call the parser before generations are stripped down to text/generationInfo', async () => {
			// Providers like Google Gemini only report usage (incl. cached tokens)
			// on the generation message, which handleLLMEnd strips from the output
			// payload — the parser must run first to still see it.
			let messageSeenByParser: unknown;
			const customParser = vi.fn().mockImplementation((result: LLMResult) => {
				messageSeenByParser = (result.generations[0][0] as { message?: unknown }).message;
				return { completionTokens: 1, promptTokens: 1, totalTokens: 2 };
			});

			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				tokensUsageParser: customParser,
			});

			const runId = 'run-123';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const message = { usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
			const output: LLMResult = {
				generations: [[{ text: 'Response', message } as unknown as LLMResult['generations'][0][0]]],
			};

			await tracer.handleLLMEnd(output, runId);

			expect(messageSeenByParser).toBe(message);
			// The stripped payload sent downstream must not contain the message
			const callArgs = mockExecutionFunctions.addOutputData.mock.calls[0] as any;
			expect(callArgs[2][0][0].json.response.generations[0][0]).not.toHaveProperty('message');
		});
	});

	describe('tracing metadata', () => {
		it('default parser surfaces cost from llmOutput.tokenUsage.cost', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-cost';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {
					tokenUsage: {
						completionTokens: 10,
						promptTokens: 5,
						totalTokens: 15,
						cost: 0.123,
					},
				},
			};

			await tracer.handleLLMEnd(output, runId);

			expect(
				(mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata,
			).toHaveBeenCalledWith({
				tracing: {
					'llm.tokens.in': 5,
					'llm.tokens.out': 10,
					'llm.tokens.total': 15,
					'llm.tokens.estimated': false,
					'llm.cost.total': 0.123,
					'llm.cost.source': 'provider',
				},
			});
			const outputData = (mockExecutionFunctions.addOutputData.mock.calls[0] as any)[2][0][0].json;
			expect(outputData.cost).toEqual({ amount: 0.123, currency: 'USD', source: 'provider' });
			// The provider-reported number is not repeated inside the token counts
			expect(outputData.tokenUsage).toEqual({
				promptTokens: 5,
				completionTokens: 10,
				totalTokens: 15,
			});
		});

		it('default parser falls back to totalCost when cost is absent', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const runId = 'run-totalcost';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {
					tokenUsage: {
						completionTokens: 10,
						promptTokens: 5,
						totalTokens: 15,
						totalCost: 0.456,
					},
				},
			};

			await tracer.handleLLMEnd(output, runId);

			expect(
				(mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					tracing: expect.objectContaining({
						'llm.cost.total': 0.456,
					}),
				}),
			);
		});

		it('does not throw when the execution context has no setMetadata', async () => {
			const ctxWithoutSetMetadata = {
				getNode: vi.fn().mockReturnValue(mockNode),
				addOutputData: vi.fn(),
				addInputData: vi.fn().mockReturnValue({ index: 0 }),
				getNextRunIndex: vi.fn().mockReturnValue(0),
			} as unknown as Mocked<ISupplyDataFunctions>;

			const tracer = new N8nLlmTracing(ctxWithoutSetMetadata);

			const runId = 'run-no-setmetadata';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {
					tokenUsage: {
						completionTokens: 10,
						promptTokens: 5,
						totalTokens: 15,
					},
				},
			};

			await expect(tracer.handleLLMEnd(output, runId)).resolves.not.toThrow();
			expect(ctxWithoutSetMetadata.addOutputData).toHaveBeenCalled();
		});

		it('omits llm.cost.total when the parsed cost is not finite', async () => {
			const customParser = vi.fn().mockReturnValue({
				completionTokens: 10,
				promptTokens: 5,
				totalTokens: 15,
				cost: Number.NaN,
			});

			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				tokensUsageParser: customParser,
			});

			const runId = 'run-nan-cost';
			tracer.runsMap[runId] = {
				index: 0,
				messages: ['Test'],
				options: {},
			};

			const output: LLMResult = {
				generations: [[{ text: 'Response' }]],
				llmOutput: {},
			};

			await tracer.handleLLMEnd(output, runId);

			const setMetadataMock = (mockExecutionFunctions as unknown as { setMetadata: Mock })
				.setMetadata;
			const tracingArg = setMetadataMock.mock.calls[0][0].tracing as Record<string, unknown>;
			expect(tracingArg).not.toHaveProperty('llm.cost.total');
		});
	});

	describe('runsMap management', () => {
		it('should track multiple runs', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions);

			const llm: Serialized = {
				lc: 1,
				type: 'constructor',
				id: ['test'],
				kwargs: {},
			};

			await tracer.handleLLMStart(llm, ['Prompt 1'], 'run-1');
			await tracer.handleLLMStart(llm, ['Prompt 2'], 'run-2');
			await tracer.handleLLMStart(llm, ['Prompt 3'], 'run-3');

			expect(Object.keys(tracer.runsMap)).toHaveLength(3);
			expect(tracer.runsMap['run-1']).toBeDefined();
			expect(tracer.runsMap['run-2']).toBeDefined();
			expect(tracer.runsMap['run-3']).toBeDefined();
		});
	});

	describe('cost from the model catalog', () => {
		const openAiNode = (): INode => ({
			...mockNode,
			type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
		});

		function usageResult(usage: Record<string, unknown>): LLMResult {
			return {
				generations: [[{ text: 'Response', generationInfo: {} }]],
				llmOutput: { tokenUsage: usage },
			};
		}

		function runOutput() {
			return (mockExecutionFunctions.addOutputData.mock.calls[0] as any)[2][0][0].json;
		}

		function tracingMetadata() {
			return (mockExecutionFunctions as unknown as { setMetadata: Mock }).setMetadata.mock
				.calls[0][0].tracing;
		}

		it('prices a known model of the node provider with the shipped catalog', async () => {
			mockExecutionFunctions.getNode.mockReturnValue(openAiNode());
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.runsMap['run-1'] = { index: 0, messages: ['Test'], options: { model: 'gpt-4o' } };

			await tracer.handleLLMEnd(
				usageResult({
					input_tokens: 1_000_000,
					output_tokens: 100_000,
					total_tokens: 1_100_000,
					input_token_details: { cache_read: 400_000 },
				}),
				'run-1',
			);

			const output = runOutput();
			expect(output.tokenUsage).toEqual({
				promptTokens: 1_000_000,
				completionTokens: 100_000,
				totalTokens: 1_100_000,
				cacheReadTokens: 400_000,
			});
			expect(output.cost).toMatchObject({
				currency: 'USD',
				source: 'catalog',
				model: { provider: 'openai', id: 'gpt-4o' },
				pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
			});
			expect(output.cost.amount).toBeCloseTo(0.6 * 2.5 + 0.4 * 1.25 + 0.1 * 10);
			expect(typeof output.cost.catalogVersion).toBe('string');
			expect(tracingMetadata()).toMatchObject({
				'llm.tokens.cache_read': 400_000,
				'llm.model.provider': 'openai',
				'llm.model.id': 'gpt-4o',
				'llm.cost.source': 'catalog',
			});
		});

		it('leaves the cost unavailable for a model the catalog does not know', async () => {
			mockExecutionFunctions.getNode.mockReturnValue(openAiNode());
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.runsMap['run-1'] = {
				index: 0,
				messages: ['Test'],
				options: { model: 'gpt-unreleased' },
			};

			await tracer.handleLLMEnd(
				usageResult({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
				'run-1',
			);

			expect(runOutput().cost).toBeUndefined();
			expect(runOutput().tokenUsage).toEqual({
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
			});
			expect(tracingMetadata()['llm.cost.unavailable_reason']).toBe('unknown-model');
		});

		it('uses an explicit model identity over the node type inference', async () => {
			const tracer = new N8nLlmTracing(mockExecutionFunctions, {
				model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
			});
			tracer.runsMap['run-1'] = { index: 0, messages: ['Test'], options: {} };

			await tracer.handleLLMEnd(
				usageResult({
					input_tokens: 1_000_000,
					output_tokens: 0,
					total_tokens: 1_000_000,
					input_token_details: { cache_creation: 200_000, cache_read: 300_000 },
				}),
				'run-1',
			);

			const output = runOutput();
			expect(output.tokenUsage).toMatchObject({
				cacheReadTokens: 300_000,
				cacheWriteTokens: 200_000,
			});
			expect(output.cost.model).toEqual({
				provider: 'anthropic',
				id: 'claude-sonnet-4-5-20250929',
			});
			expect(output.cost.amount).toBeCloseTo(0.5 * 3 + 0.3 * 0.3 + 0.2 * 3.75);
		});

		it('prefers the cost the provider reported over the catalog', async () => {
			mockExecutionFunctions.getNode.mockReturnValue(openAiNode());
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.runsMap['run-1'] = { index: 0, messages: ['Test'], options: { model: 'gpt-4o' } };

			await tracer.handleLLMEnd(
				usageResult({
					promptTokens: 1_000_000,
					completionTokens: 0,
					totalTokens: 1_000_000,
					cost: 0.5,
				}),
				'run-1',
			);

			expect(runOutput().cost).toEqual({
				amount: 0.5,
				currency: 'USD',
				source: 'provider',
				model: { provider: 'openai', id: 'gpt-4o' },
			});
		});

		it('prices the model the provider reports having served, not the requested deployment name', async () => {
			mockExecutionFunctions.getNode.mockReturnValue({
				...mockNode,
				type: '@n8n/n8n-nodes-langchain.lmChatAzureOpenAi',
			});
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.runsMap['run-1'] = {
				index: 0,
				messages: ['Test'],
				options: { model: 'my-prod-deployment' },
			};
			const { AIMessage } = await import('@langchain/core/messages');

			await tracer.handleLLMEnd(
				{
					generations: [
						[
							{
								text: 'Response',
								message: new AIMessage({
									content: 'Response',
									response_metadata: { model_name: 'gpt-4o-2024-08-06' },
									usage_metadata: {
										input_tokens: 1_000_000,
										output_tokens: 0,
										total_tokens: 1_000_000,
									},
								}),
							},
						],
					],
				},
				'run-1',
			);

			expect(runOutput().cost).toMatchObject({
				source: 'catalog',
				model: { provider: 'azure', id: 'gpt-4o-2024-08-06' },
			});
			expect(runOutput().cost.amount).toBeCloseTo(2.5);
		});

		it('never prices an estimate', async () => {
			mockExecutionFunctions.getNode.mockReturnValue(openAiNode());
			const tracer = new N8nLlmTracing(mockExecutionFunctions);
			tracer.runsMap['run-1'] = { index: 0, messages: ['Test'], options: { model: 'gpt-4o' } };
			estimateTokensFromStringList.mockResolvedValue(25);

			await tracer.handleLLMEnd({ generations: [[{ text: 'Response' }]], llmOutput: {} }, 'run-1');

			expect(runOutput().tokenUsageEstimate).toBeDefined();
			expect(runOutput().cost).toBeUndefined();
			expect(tracingMetadata()['llm.cost.unavailable_reason']).toBe('estimated-usage');
		});
	});
});
