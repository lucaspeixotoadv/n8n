import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { ChatGeneration, LLMResult } from '@langchain/core/outputs';

import { normalizeLlmResultUsage } from 'src/utils/llm-usage-normalizer';

function withMessage(
	message: AIMessage | AIMessageChunk,
	llmOutput?: LLMResult['llmOutput'],
): LLMResult {
	const generation: ChatGeneration = { text: 'Response', message };
	return { generations: [[generation]], llmOutput };
}

describe('normalizeLlmResultUsage', () => {
	it('reads OpenAI usage_metadata: cached input and reasoning output are subsets of the totals', () => {
		const usage = normalizeLlmResultUsage(
			withMessage(
				new AIMessage({
					content: 'Response',
					usage_metadata: {
						input_tokens: 1000,
						output_tokens: 300,
						total_tokens: 1300,
						input_token_details: { cache_read: 600 },
						output_token_details: { reasoning: 200 },
					},
				}),
				{ tokenUsage: { promptTokens: 1000, completionTokens: 300, totalTokens: 1300 } },
			),
		);

		expect(usage).toEqual({
			promptTokens: 1000,
			completionTokens: 300,
			totalTokens: 1300,
			cacheReadTokens: 600,
			reasoningTokens: 200,
		});
	});

	it('reads Anthropic usage_metadata: input already includes cache reads and writes', () => {
		const usage = normalizeLlmResultUsage(
			withMessage(
				new AIMessage({
					content: 'Response',
					usage_metadata: {
						input_tokens: 5000,
						output_tokens: 100,
						total_tokens: 5100,
						input_token_details: { cache_creation: 1000, cache_read: 3500 },
					},
				}),
			),
		);

		expect(usage).toEqual({
			promptTokens: 5000,
			completionTokens: 100,
			totalTokens: 5100,
			cacheReadTokens: 3500,
			cacheWriteTokens: 1000,
		});
	});

	it('reads the streamed usage chunk, which is the only usage a streamed call reports', () => {
		const usage = normalizeLlmResultUsage(
			withMessage(
				new AIMessageChunk({
					content: '',
					usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				}),
				{ estimatedTokenUsage: {} },
			),
		);

		expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
	});

	it('omits zero-valued breakdowns', () => {
		const usage = normalizeLlmResultUsage(
			withMessage(
				new AIMessage({
					content: 'Response',
					usage_metadata: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_token_details: { cache_creation: 0, cache_read: 0 },
						output_token_details: { reasoning: 0 },
					},
				}),
			),
		);

		expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
	});

	it('falls back to the OpenAI-format llmOutput.tokenUsage', () => {
		const usage = normalizeLlmResultUsage({
			generations: [[{ text: 'Response' }]],
			llmOutput: { tokenUsage: { promptTokens: 50, completionTokens: 30 } },
		});

		expect(usage).toEqual({ promptTokens: 50, completionTokens: 30, totalTokens: 80 });
	});

	it('falls back to a usage_metadata-shaped llmOutput.tokenUsage', () => {
		const usage = normalizeLlmResultUsage({
			generations: [[{ text: 'Response' }]],
			llmOutput: { tokenUsage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 } },
		});

		expect(usage).toEqual({ promptTokens: 50, completionTokens: 30, totalTokens: 80 });
	});

	it('falls back to the raw Anthropic usage block and folds the cache tiers into the prompt', () => {
		const usage = normalizeLlmResultUsage({
			generations: [[{ text: 'Response' }]],
			llmOutput: {
				usage: {
					input_tokens: 500,
					output_tokens: 100,
					cache_creation_input_tokens: 1000,
					cache_read_input_tokens: 3500,
				},
			},
		});

		expect(usage).toEqual({
			promptTokens: 5000,
			completionTokens: 100,
			totalTokens: 5100,
			cacheReadTokens: 3500,
			cacheWriteTokens: 1000,
		});
	});

	it('surfaces a provider-reported cost from llmOutput or the raw usage block', () => {
		expect(
			normalizeLlmResultUsage({
				generations: [[{ text: 'Response' }]],
				llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 10, totalCost: 0.456 } },
			}).providerCost,
		).toBe(0.456);

		expect(
			normalizeLlmResultUsage(
				withMessage(
					new AIMessage({
						content: 'Response',
						usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
						response_metadata: { usage: { prompt_tokens: 10, cost: 0.00042 } },
					}),
				),
			).providerCost,
		).toBe(0.00042);
	});

	it('returns zeroes when nothing was reported, so the tracing can estimate instead', () => {
		expect(normalizeLlmResultUsage({ generations: [] })).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});
	});
});
