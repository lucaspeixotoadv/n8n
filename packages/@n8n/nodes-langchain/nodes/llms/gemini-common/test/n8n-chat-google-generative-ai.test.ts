import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { OperationalError } from 'n8n-workflow';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import {
	MAX_MALFORMED_FUNCTION_CALL_ATTEMPTS,
	N8nChatGoogleGenerativeAI,
} from '../n8n-chat-google-generative-ai';

function makeChatResult(finishReason: string, text = ''): ChatResult {
	return {
		generations: [
			{
				text,
				message: new AIMessage(text),
				generationInfo: { finishReason },
			},
		],
	};
}

describe('N8nChatGoogleGenerativeAI', () => {
	let superGenerateSpy: MockInstance;
	let model: N8nChatGoogleGenerativeAI;
	const messages = [new HumanMessage('hello')];

	beforeEach(() => {
		superGenerateSpy = vi.spyOn(ChatGoogleGenerativeAI.prototype, '_generate');
		model = new N8nChatGoogleGenerativeAI({
			apiKey: 'test-api-key',
			model: 'gemini-2.5-flash',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should return the result unchanged when the finish reason is not MALFORMED_FUNCTION_CALL', async () => {
		const result = makeChatResult('STOP', 'Hello there');
		superGenerateSpy.mockResolvedValue(result);

		const response = await model._generate(messages, {} as never);

		expect(response).toBe(result);
		expect(superGenerateSpy).toHaveBeenCalledTimes(1);
	});

	it('should retry when the model returns MALFORMED_FUNCTION_CALL and return the first valid result', async () => {
		const malformed = makeChatResult('MALFORMED_FUNCTION_CALL', 'Calling FAQ with input: {}');
		const valid = makeChatResult('STOP', 'All good');
		superGenerateSpy.mockResolvedValueOnce(malformed).mockResolvedValueOnce(valid);

		const response = await model._generate(messages, {} as never);

		expect(response).toBe(valid);
		expect(superGenerateSpy).toHaveBeenCalledTimes(2);
	});

	it('should throw a clear error when all attempts return MALFORMED_FUNCTION_CALL', async () => {
		superGenerateSpy.mockResolvedValue(
			makeChatResult('MALFORMED_FUNCTION_CALL', 'Calling FAQ with input: {}'),
		);

		await expect(model._generate(messages, {} as never)).rejects.toThrow(OperationalError);
		expect(superGenerateSpy).toHaveBeenCalledTimes(MAX_MALFORMED_FUNCTION_CALL_ATTEMPTS);
	});

	it('should include the finish message from the provider in the error description', async () => {
		superGenerateSpy.mockResolvedValue({
			generations: [
				{
					text: '',
					message: new AIMessage(''),
					generationInfo: {
						finishReason: 'MALFORMED_FUNCTION_CALL',
						finishMessage: 'Malformed function call: Function call is empty - no input to parse.',
					},
				},
			],
		});

		await expect(model._generate(messages, {} as never)).rejects.toMatchObject({
			description: expect.stringContaining('Function call is empty'),
		});
	});

	it('should propagate errors thrown by the underlying model', async () => {
		superGenerateSpy.mockRejectedValue(new Error('API error'));

		await expect(model._generate(messages, {} as never)).rejects.toThrow('API error');
		expect(superGenerateSpy).toHaveBeenCalledTimes(1);
	});

	describe('turn order', () => {
		// A history cut mid tool-use cycle, as context-window truncation produces it
		const cutHistory = [
			new AIMessage({
				content: '',
				tool_calls: [{ id: 'call_1', name: 'someTool', args: {}, type: 'tool_call' }],
			}),
			new ToolMessage({ content: 'result', tool_call_id: 'call_1', name: 'someTool' }),
			new AIMessage('a1'),
			new HumanMessage('q2'),
		];

		it('should drop an orphaned leading tool cycle before generating', async () => {
			superGenerateSpy.mockResolvedValue(makeChatResult('STOP', 'Hello there'));

			await model._generate(cutHistory, {} as never);

			expect(superGenerateSpy).toHaveBeenCalledWith(
				[cutHistory[2], cutHistory[3]],
				expect.anything(),
				undefined,
			);
		});

		it('should drop an orphaned leading tool cycle before streaming', async () => {
			const superStreamSpy = vi
				.spyOn(ChatGoogleGenerativeAI.prototype, '_streamResponseChunks')
				.mockImplementation(async function* () {});

			for await (const _chunk of model._streamResponseChunks(cutHistory, {} as never)) {
				// drain the stream
			}

			expect(superStreamSpy).toHaveBeenCalledWith(
				[cutHistory[2], cutHistory[3]],
				expect.anything(),
				undefined,
			);
		});

		it('should pass a valid history through untouched', async () => {
			superGenerateSpy.mockResolvedValue(makeChatResult('STOP', 'Hello there'));

			await model._generate(messages, {} as never);

			expect(superGenerateSpy).toHaveBeenCalledWith(messages, expect.anything(), undefined);
		});
	});

	describe('history from another provider', () => {
		// The turn of an Anthropic fallback model, as the agent replays it
		const anthropicTurn = new AIMessage({
			content: [
				{ type: 'thinking', thinking: 'I need the case.', signature: 'anthropic-signature' },
				{ type: 'text', text: 'Looking up the case.' },
				{ type: 'tool_use', id: 'toolu_1', name: 'getCase', input: { caseId: '1' } },
			],
			response_metadata: { model_provider: 'anthropic' },
		});
		const history = [
			new HumanMessage('Open case 1'),
			anthropicTurn,
			new ToolMessage({ content: 'case 1', tool_call_id: 'toolu_1', name: 'getCase' }),
		];

		async function sendHistory(modelName: string) {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							candidates: [
								{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' },
							],
						}),
					),
			);
			const geminiModel = new N8nChatGoogleGenerativeAI({
				apiKey: 'test-api-key',
				model: modelName,
				fetch: fetchMock,
			});

			await geminiModel.invoke(history);

			const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			const body = JSON.parse(init.body as string) as {
				contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
			};
			return body.contents;
		}

		it('should send the text and the tool call of the turn, without the reasoning', async () => {
			const contents = await sendHistory('gemini-2.5-flash');

			expect(contents[1]).toEqual({
				role: 'model',
				parts: [
					{ text: 'Looking up the case.' },
					{ functionCall: { name: 'getCase', args: { caseId: '1' } } },
				],
			});
			expect(contents[2].parts[0]).toMatchObject({ functionResponse: { name: 'getCase' } });
		});

		it('should give the tool call a thought signature for a model that requires one', async () => {
			const contents = await sendHistory('gemini-3-flash-preview');

			expect(contents[1].parts[1]).toEqual({
				functionCall: { name: 'getCase', args: { caseId: '1' } },
				thoughtSignature: expect.any(String),
			});
		});
	});

	describe('function declarations', () => {
		it('should give an items schema to each array of a tool schema', async () => {
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							candidates: [
								{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' },
							],
						}),
					),
			);
			const geminiModel = new N8nChatGoogleGenerativeAI({
				apiKey: 'test-api-key',
				model: 'gemini-2.5-flash',
				fetch: fetchMock,
			});
			// An object or a list of any values, as the MCP client gets it for a $fromAI json argument
			const tool = new DynamicStructuredTool({
				name: 'search',
				description: 'Search cases',
				schema: z.object({ types: z.union([z.record(z.any()), z.array(z.any())]) }),
				func: async () => '',
			});

			await geminiModel.bindTools([tool]).invoke('Search');

			const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			const body = JSON.parse(init.body as string) as {
				tools: Array<{ functionDeclarations: Array<{ parameters: unknown }> }>;
			};
			expect(body.tools[0].functionDeclarations[0].parameters).toMatchObject({
				properties: { types: { anyOf: [{ type: 'object' }, { type: 'array', items: {} }] } },
			});
		});
	});
});
