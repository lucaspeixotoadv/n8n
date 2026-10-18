import { computeLlmInvocationCost, selectPricingRates } from '../cost';
import { candidateCatalogIds, isPricingLookupFailure, resolveModelPricing } from '../pricing';
import type { ModelCatalog } from '../types';

const catalog: ModelCatalog = {
	source: 'models.dev',
	generatedAt: '2026-09-14T00:00:00.000Z',
	providers: {
		openai: {
			name: 'OpenAI',
			models: {
				'gpt-4o': { name: 'GPT-4o', pricing: { input: 2.5, output: 10, cacheRead: 1.25 } },
				'gpt-4o-2024-11-20': {
					name: 'GPT-4o (2024-11-20)',
					pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
				},
				'o3-deep-research': { name: 'o3 deep research' },
			},
		},
		anthropic: {
			name: 'Anthropic',
			models: {
				'claude-sonnet-4-5': {
					name: 'Claude Sonnet 4.5',
					pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				},
			},
		},
		google: {
			name: 'Google',
			models: {
				'gemini-2.5-pro': {
					name: 'Gemini 2.5 Pro',
					pricing: {
						input: 1.25,
						output: 10,
						cacheRead: 0.125,
						tiers: [{ contextSize: 200_000, input: 2.5, output: 15, cacheRead: 0.25 }],
					},
				},
			},
		},
	},
};

const context = { model: { provider: 'x', id: 'y' }, catalogVersion: catalog.generatedAt };

describe('candidateCatalogIds', () => {
	it('tries the id as given, then without the Google prefix, alias marker and date suffix', () => {
		expect(candidateCatalogIds('models/gemini-2.5-pro-latest')).toEqual([
			'models/gemini-2.5-pro-latest',
			'gemini-2.5-pro-latest',
			'gemini-2.5-pro',
		]);
		expect(candidateCatalogIds('claude-sonnet-4-5-20250929')).toEqual([
			'claude-sonnet-4-5-20250929',
			'claude-sonnet-4-5',
		]);
		expect(candidateCatalogIds('gpt-4o-2024-11-20')).toEqual(['gpt-4o-2024-11-20', 'gpt-4o']);
	});
});

describe('resolveModelPricing', () => {
	it('resolves an exact id', () => {
		const result = resolveModelPricing(catalog, { provider: 'openai', id: 'gpt-4o-2024-11-20' });

		expect(isPricingLookupFailure(result)).toBe(false);
		if (isPricingLookupFailure(result)) return;
		expect(result.catalogId).toBe('gpt-4o-2024-11-20');
		expect(result.catalogVersion).toBe(catalog.generatedAt);
	});

	it('falls back to the base model for a dated snapshot the catalog does not list', () => {
		const result = resolveModelPricing(catalog, {
			provider: 'anthropic',
			id: 'claude-sonnet-4-5-20250929',
		});

		expect(result).toMatchObject({ catalogId: 'claude-sonnet-4-5' });
	});

	it('strips the Google models/ prefix', () => {
		const result = resolveModelPricing(catalog, {
			provider: 'google',
			id: 'models/gemini-2.5-pro',
		});

		expect(result).toMatchObject({ catalogId: 'gemini-2.5-pro' });
	});

	it('reports why a lookup failed', () => {
		expect(resolveModelPricing(catalog, { provider: 'nope', id: 'gpt-4o' })).toEqual({
			reason: 'unknown-provider',
		});
		expect(resolveModelPricing(catalog, { provider: 'openai', id: 'gpt-99' })).toEqual({
			reason: 'unknown-model',
		});
		expect(resolveModelPricing(catalog, { provider: 'openai', id: 'o3-deep-research' })).toEqual({
			reason: 'no-pricing',
		});
	});
});

describe('selectPricingRates', () => {
	const pricing = catalog.providers.google.models['gemini-2.5-pro'].pricing!;

	it('uses the base rates up to the tier threshold', () => {
		expect(selectPricingRates(pricing, 200_000)).toEqual({
			rates: { input: 1.25, output: 10, cacheRead: 0.125 },
		});
	});

	it('switches to the tier rates once the prompt exceeds the threshold', () => {
		expect(selectPricingRates(pricing, 200_001)).toEqual({
			rates: { input: 2.5, output: 15, cacheRead: 0.25 },
			tier: { contextSize: 200_000 },
		});
	});
});

describe('computeLlmInvocationCost', () => {
	it('prices input and output tokens', () => {
		const result = computeLlmInvocationCost(
			{ promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000 },
			{ input: 2.5, output: 10 },
			context,
		);

		expect(result.cost).toMatchObject({
			amount: 2.5 + 1,
			currency: 'USD',
			source: 'catalog',
			model: context.model,
			pricing: { input: 2.5, output: 10 },
			catalogVersion: catalog.generatedAt,
		});
	});

	it('bills cache reads at the cache rate and never on top of the prompt tokens', () => {
		const result = computeLlmInvocationCost(
			{
				promptTokens: 1_000_000,
				completionTokens: 0,
				totalTokens: 1_000_000,
				cacheReadTokens: 400_000,
			},
			{ input: 2.5, output: 10, cacheRead: 1.25 },
			context,
		);

		expect(result.cost?.amount).toBeCloseTo(0.6 * 2.5 + 0.4 * 1.25);
	});

	it('bills cache writes at the cache write rate (Anthropic semantics)', () => {
		const result = computeLlmInvocationCost(
			{
				promptTokens: 1_000_000,
				completionTokens: 0,
				totalTokens: 1_000_000,
				cacheReadTokens: 200_000,
				cacheWriteTokens: 300_000,
			},
			{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			context,
		);

		expect(result.cost?.amount).toBeCloseTo(0.5 * 3 + 0.2 * 0.3 + 0.3 * 3.75);
	});

	it('bills reasoning tokens as output when the model has no reasoning rate', () => {
		const withoutRate = computeLlmInvocationCost(
			{
				promptTokens: 0,
				completionTokens: 1_000_000,
				totalTokens: 1_000_000,
				reasoningTokens: 400_000,
			},
			{ input: 2, output: 8 },
			context,
		);
		const withRate = computeLlmInvocationCost(
			{
				promptTokens: 0,
				completionTokens: 1_000_000,
				totalTokens: 1_000_000,
				reasoningTokens: 400_000,
			},
			{ input: 2, output: 8, reasoning: 4 },
			context,
		);

		expect(withoutRate.cost?.amount).toBeCloseTo(8);
		expect(withRate.cost?.amount).toBeCloseTo(0.6 * 8 + 0.4 * 4);
	});

	it('applies the context tier to the whole invocation and records it', () => {
		const result = computeLlmInvocationCost(
			{ promptTokens: 300_000, completionTokens: 1_000, totalTokens: 301_000 },
			catalog.providers.google.models['gemini-2.5-pro'].pricing!,
			context,
		);

		expect(result.cost?.amount).toBeCloseTo(0.3 * 2.5 + 0.001 * 15);
		expect(result.cost?.pricing).toEqual({
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			tier: { contextSize: 200_000 },
		});
	});

	it('refuses to price a cache category the pricing has no rate for', () => {
		expect(
			computeLlmInvocationCost(
				{ promptTokens: 10, completionTokens: 1, totalTokens: 11, cacheReadTokens: 5 },
				{ input: 1, output: 1 },
				context,
			),
		).toEqual({ reason: 'missing-rate:cacheRead' });
		expect(
			computeLlmInvocationCost(
				{ promptTokens: 10, completionTokens: 1, totalTokens: 11, cacheWriteTokens: 5 },
				{ input: 1, output: 1, cacheRead: 1 },
				context,
			),
		).toEqual({ reason: 'missing-rate:cacheWrite' });
	});
});
