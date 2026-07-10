import { AIMessage } from '@langchain/core/messages';
import type { ChatGeneration, LLMResult } from '@langchain/core/outputs';

import { geminiTokensUsageParser } from '../tokens-usage-parser';

function resultWithMessage(usageMetadata?: AIMessage['usage_metadata']): LLMResult {
	const generation: ChatGeneration = {
		text: 'Response text',
		message: new AIMessage({ content: 'Response text', usage_metadata: usageMetadata }),
	};
	return { generations: [[generation]] };
}

describe('geminiTokensUsageParser', () => {
	it('reads token usage from the generation message usage_metadata', () => {
		const usage = geminiTokensUsageParser(
			resultWithMessage({ input_tokens: 100, output_tokens: 40, total_tokens: 140 }),
		);

		expect(usage).toEqual({
			completionTokens: 40,
			promptTokens: 100,
			totalTokens: 140,
		});
	});

	it('reports cached tokens without adjusting the prompt total', () => {
		const usage = geminiTokensUsageParser(
			resultWithMessage({
				input_tokens: 5000,
				output_tokens: 40,
				total_tokens: 5040,
				input_token_details: { cache_read: 4096 },
			}),
		);

		expect(usage).toEqual({
			completionTokens: 40,
			promptTokens: 5000,
			totalTokens: 5040,
			cacheReadInputTokens: 4096,
		});
	});

	it('omits the cache field when the response has no cached tokens', () => {
		const usage = geminiTokensUsageParser(
			resultWithMessage({
				input_tokens: 100,
				output_tokens: 40,
				total_tokens: 140,
				input_token_details: {},
			}),
		);

		expect(usage).not.toHaveProperty('cacheReadInputTokens');
	});

	it('falls back to llmOutput.tokenUsage when the message carries no usage_metadata', () => {
		const result: LLMResult = {
			...resultWithMessage(undefined),
			llmOutput: { tokenUsage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } },
		};

		expect(geminiTokensUsageParser(result)).toEqual({
			completionTokens: 40,
			promptTokens: 100,
			totalTokens: 140,
		});
	});

	it('returns zeroes for an empty result', () => {
		expect(geminiTokensUsageParser({ generations: [] })).toEqual({
			completionTokens: 0,
			promptTokens: 0,
			totalTokens: 0,
		});
	});

	it('handles text-only generations without a message', () => {
		const result: LLMResult = {
			generations: [[{ text: 'Response text' }]],
			llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
		};

		expect(geminiTokensUsageParser(result)).toEqual({
			completionTokens: 5,
			promptTokens: 10,
			totalTokens: 15,
		});
	});
});
