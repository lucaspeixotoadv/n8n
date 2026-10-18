import { loadModelCatalog } from '../catalog';
import { MODEL_CATALOG_PROVIDER_BY_NODE_TYPE } from '../node-providers';
import { isPricingLookupFailure, resolveModelPricing } from '../pricing';
import { buildModelCatalogSnapshot, diffModelCatalogs } from '../snapshot';

const generatedAt = new Date('2026-09-14T00:00:00.000Z');

const modelsDevDocument = {
	openai: {
		id: 'openai',
		name: 'OpenAI',
		models: {
			'gpt-4o': {
				id: 'gpt-4o',
				name: 'GPT-4o',
				cost: { input: 2.5, output: 10, cache_read: 1.25 },
				limit: { context: 128000, output: 16384 },
				tool_call: true,
			},
			'broken-model': { id: 'broken-model', name: 'Broken', cost: { input: -1, output: 1 } },
			'no-price': { id: 'no-price', name: 'No price' },
		},
	},
	google: {
		id: 'google',
		name: 'Google',
		models: {
			'gemini-2.5-pro': {
				id: 'gemini-2.5-pro',
				name: 'Gemini 2.5 Pro',
				status: 'beta',
				cost: {
					input: 1.25,
					output: 10,
					cache_read: 0.125,
					tiers: [{ tier: { type: 'context', size: 200000 }, input: 2.5, output: 15 }],
					context_over_200k: { input: 2.5, output: 15 },
				},
				limit: { context: 1048576, output: 65536 },
			},
		},
	},
	'some-gateway': { id: 'some-gateway', name: 'Gateway', models: {} },
};

describe('buildModelCatalogSnapshot', () => {
	it('keeps only the allowed providers and the pricing-relevant fields', () => {
		const { catalog, skipped } = buildModelCatalogSnapshot(modelsDevDocument, {
			generatedAt,
			providers: ['openai', 'google'],
		});

		expect(Object.keys(catalog.providers)).toEqual(['google', 'openai']);
		expect(catalog.generatedAt).toBe('2026-09-14T00:00:00.000Z');
		expect(catalog.providers.openai.models['gpt-4o']).toEqual({
			name: 'GPT-4o',
			contextLimit: 128000,
			pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
		});
		expect(catalog.providers.openai.models['no-price']).toEqual({ name: 'No price' });
		expect(catalog.providers.google.models['gemini-2.5-pro']).toEqual({
			name: 'Gemini 2.5 Pro',
			status: 'beta',
			contextLimit: 1048576,
			pricing: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				tiers: [{ contextSize: 200000, input: 2.5, output: 15 }],
			},
		});
		expect(skipped).toEqual(['openai/broken-model: Number must be greater than or equal to 0']);
	});

	it('produces the same document for the same input', () => {
		const a = buildModelCatalogSnapshot(modelsDevDocument, { generatedAt });
		const b = buildModelCatalogSnapshot(modelsDevDocument, { generatedAt });

		expect(JSON.stringify(a.catalog)).toBe(JSON.stringify(b.catalog));
	});
});

describe('diffModelCatalogs', () => {
	it('lists added, removed and changed models', () => {
		const previous = buildModelCatalogSnapshot(modelsDevDocument, { generatedAt }).catalog;
		const nextDocument: Record<string, { models: Record<string, unknown> }> =
			structuredClone(modelsDevDocument);
		nextDocument.openai.models['gpt-4o'] = {
			...(nextDocument.openai.models['gpt-4o'] as object),
			cost: { input: 2, output: 8 },
		};
		delete nextDocument.openai.models['no-price'];
		nextDocument.openai.models['gpt-5'] = {
			id: 'gpt-5',
			name: 'GPT-5',
			cost: { input: 1, output: 2 },
		};
		const next = buildModelCatalogSnapshot(nextDocument, { generatedAt }).catalog;

		expect(diffModelCatalogs(previous, next)).toEqual({
			addedProviders: [],
			removedProviders: [],
			addedModels: ['openai/gpt-5'],
			removedModels: ['openai/no-price'],
			changedModels: ['openai/gpt-4o'],
			previousModelCount: 3,
			nextModelCount: 3,
		});
	});
});

describe('shipped snapshot', () => {
	it('loads, validates and covers every provider a node can be attributed to', async () => {
		const catalog = await loadModelCatalog();

		expect(catalog.source).toBe('models.dev');
		for (const provider of new Set(Object.values(MODEL_CATALOG_PROVIDER_BY_NODE_TYPE))) {
			expect(catalog.providers[provider]).toBeDefined();
		}
	});

	it('prices the models the main nodes default to', async () => {
		const catalog = await loadModelCatalog();

		for (const identity of [
			{ provider: 'openai', id: 'gpt-4o-mini' },
			{ provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
			{ provider: 'google', id: 'models/gemini-2.5-flash' },
		]) {
			const result = resolveModelPricing(catalog, identity);
			expect(isPricingLookupFailure(result)).toBe(false);
		}
	});
});
