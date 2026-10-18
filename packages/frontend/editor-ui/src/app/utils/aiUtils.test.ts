import type { LlmTokenUsageData } from '@/Interface';
import {
	addTokenUsageData,
	formatTokenUsageCost,
	formatTokenUsageCount,
	invocationToTokenUsageData,
	parseAiContent,
	toTokenUsageData,
} from '@/app/utils/aiUtils';
import { NodeConnectionTypes } from 'n8n-workflow';

describe(parseAiContent, () => {
	it('should parse inputOverride data', () => {
		const executionData = [
			{
				json: {
					messages: ['System: You are a helpful assistant\nHuman: test'],
					estimatedTokens: 11,
					options: {
						openai_api_key: {
							lc: 1,
							type: 'secret',
							id: ['OPENAI_API_KEY'],
						},
						model: 'gpt-4o-mini',
						timeout: 60000,
						max_retries: 2,
						configuration: {
							baseURL: 'https://api.openai.com/v1',
						},
						model_kwargs: {},
					},
				},
			},
		];

		expect(parseAiContent(executionData, NodeConnectionTypes.AiLanguageModel)).toEqual([
			{
				parsedContent: {
					data: 'System: You are a helpful assistant\nHuman: test',
					parsed: true,
					type: 'text',
				},
				raw: expect.any(Object),
			},
		]);
	});

	it('should parse response from AI model node', () => {
		const executionData = [
			{
				json: {
					response: {
						generations: [
							[
								{
									text: "It seems like you're testing the interface. How can I assist you today?",
									generationInfo: {
										prompt: 0,
										completion: 0,
										finish_reason: 'stop',
										system_fingerprint: 'fp_b376dfbbd5',
										model_name: 'gpt-4o-mini-2024-07-18',
									},
								},
							],
						],
					},
					tokenUsage: {
						completionTokens: 16,
						promptTokens: 17,
						totalTokens: 33,
					},
				},
			},
		];

		expect(parseAiContent(executionData, NodeConnectionTypes.AiLanguageModel)).toEqual([
			{
				parsedContent: {
					data: ["It seems like you're testing the interface. How can I assist you today?"],
					parsed: true,
					type: 'json',
				},
				raw: expect.any(Object),
			},
		]);
	});
});

describe(addTokenUsageData, () => {
	it('should return sum of consumed tokens', () => {
		expect(
			addTokenUsageData(
				{ completionTokens: 1, promptTokens: 100, totalTokens: 1000, isEstimate: false },
				{ completionTokens: 0, promptTokens: 1, totalTokens: 2, isEstimate: false },
			),
		).toEqual({ completionTokens: 1, promptTokens: 101, totalTokens: 1002, isEstimate: false });
	});

	it('should set isEstimate to true if either of the arguments is an estimation', () => {
		const usageData = { completionTokens: 0, promptTokens: 0, totalTokens: 0, isEstimate: false };

		expect(addTokenUsageData(usageData, usageData)).toEqual({
			...usageData,
			isEstimate: false,
		});
		expect(addTokenUsageData({ ...usageData, isEstimate: true }, usageData)).toEqual({
			...usageData,
			isEstimate: true,
		});
		expect(addTokenUsageData(usageData, { ...usageData, isEstimate: true })).toEqual({
			...usageData,
			isEstimate: true,
		});
		expect(
			addTokenUsageData({ ...usageData, isEstimate: true }, { ...usageData, isEstimate: true }),
		).toEqual({
			...usageData,
			isEstimate: true,
		});
	});
});

describe('addTokenUsageData breakdowns and cost', () => {
	const base = { completionTokens: 1, promptTokens: 1, totalTokens: 2, isEstimate: false };

	it('sums cache and reasoning breakdowns only when at least one side has them', () => {
		expect(addTokenUsageData(base, base)).not.toHaveProperty('cacheReadTokens');
		expect(
			addTokenUsageData(
				{ ...base, cacheReadTokens: 3, reasoningTokens: 1 },
				{ ...base, cacheReadTokens: 4 },
			),
		).toMatchObject({ cacheReadTokens: 7, reasoningTokens: 1 });
	});

	it('sums costs and keeps the sum complete only when every priced side is complete', () => {
		const priced = { ...base, cost: { amount: 0.5, currency: 'USD' as const, isComplete: true } };

		expect(addTokenUsageData(priced, priced).cost).toEqual({
			amount: 1,
			currency: 'USD',
			isComplete: true,
		});
	});

	it('marks the cost incomplete when usage without a cost is added', () => {
		const priced = { ...base, cost: { amount: 0.5, currency: 'USD' as const, isComplete: true } };

		expect(addTokenUsageData(priced, base).cost).toEqual({
			amount: 0.5,
			currency: 'USD',
			isComplete: false,
		});
	});

	it('does not let an empty usage make a cost incomplete', () => {
		const priced = { ...base, cost: { amount: 0.5, currency: 'USD' as const, isComplete: true } };
		const empty = { completionTokens: 0, promptTokens: 0, totalTokens: 0, isEstimate: false };

		expect(addTokenUsageData(empty, priced).cost).toEqual({
			amount: 0.5,
			currency: 'USD',
			isComplete: true,
		});
	});
});

describe(toTokenUsageData, () => {
	it('maps a published summary, dropping zero breakdowns and keeping cost completeness', () => {
		expect(
			toTokenUsageData({
				invocations: 2,
				tokens: {
					promptTokens: 100,
					completionTokens: 50,
					totalTokens: 150,
					cacheReadTokens: 40,
					cacheWriteTokens: 0,
					reasoningTokens: 10,
				},
				tokensEstimated: false,
				tokensComplete: true,
				cost: { amount: 0.25, currency: 'USD' },
				costComplete: false,
			}),
		).toEqual({
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			isEstimate: false,
			cacheReadTokens: 40,
			reasoningTokens: 10,
			cost: { amount: 0.25, currency: 'USD', isComplete: false },
		});
	});
});

describe(invocationToTokenUsageData, () => {
	it('maps one run item with its cost', () => {
		expect(
			invocationToTokenUsageData({
				tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 2 },
				isEstimate: false,
				cost: { amount: 0.01, currency: 'USD', source: 'catalog' },
			}),
		).toEqual({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			isEstimate: false,
			cacheReadTokens: 2,
			cost: { amount: 0.01, currency: 'USD', isComplete: true },
		});
	});
});

describe(formatTokenUsageCost, () => {
	it('formats US dollars with enough precision for small amounts', () => {
		expect(formatTokenUsageCost({ amount: 0.001234, currency: 'USD', isComplete: true })).toBe(
			'$0.001234',
		);
		expect(formatTokenUsageCost({ amount: 1.5, currency: 'USD', isComplete: true })).toBe('$1.50');
	});
});

describe(formatTokenUsageCount, () => {
	const usageData: LlmTokenUsageData = {
		completionTokens: 11,
		promptTokens: 22,
		totalTokens: 33,
		isEstimate: false,
	};

	it('should return the number of specified field', () => {
		expect(formatTokenUsageCount(usageData, 'completion')).toBe('11');
		expect(formatTokenUsageCount(usageData, 'prompt')).toBe('22');
		expect(formatTokenUsageCount(usageData, 'total')).toBe('33');
	});

	it('should prepend "~" if the usage data is an estimation', () => {
		expect(formatTokenUsageCount({ ...usageData, isEstimate: true }, 'total')).toBe('~33');
	});
});
