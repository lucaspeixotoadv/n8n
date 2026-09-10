import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { OperationalError } from 'n8n-workflow';
import type { MockInstance } from 'vitest';

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
});
