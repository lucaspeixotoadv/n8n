import type { z } from 'zod';

import { MODEL_CATALOG_PROVIDERS } from './node-providers';
import {
	modelCatalogSchema,
	modelsDevCatalogSchema,
	modelsDevModelSchema,
	modelsDevProviderSchema,
} from './schema';
import type {
	CatalogModel,
	CatalogProvider,
	ModelCatalog,
	ModelPricing,
	ModelPricingRates,
} from './types';

type ModelsDevCost = NonNullable<z.infer<typeof modelsDevModelSchema>['cost']>;

/** The rate fields of a models.dev cost block or of one of its tiers. */
interface ModelsDevRates {
	input: number;
	output: number;
	reasoning?: number;
	cache_read?: number;
	cache_write?: number;
	input_audio?: number;
	output_audio?: number;
}

function toRates(cost: ModelsDevRates): ModelPricingRates {
	return {
		input: cost.input,
		output: cost.output,
		...(cost.cache_read !== undefined && { cacheRead: cost.cache_read }),
		...(cost.cache_write !== undefined && { cacheWrite: cost.cache_write }),
		...(cost.reasoning !== undefined && { reasoning: cost.reasoning }),
		...(cost.input_audio !== undefined && { inputAudio: cost.input_audio }),
		...(cost.output_audio !== undefined && { outputAudio: cost.output_audio }),
	};
}

function toPricing(cost: ModelsDevCost): ModelPricing {
	const { tiers, ...base } = cost;
	const pricing: ModelPricing = toRates(base as ModelsDevRates);
	if (tiers && tiers.length > 0) {
		pricing.tiers = tiers
			.map(({ tier, ...rates }) => ({ contextSize: tier.size, ...toRates(rates) }))
			.sort((a, b) => a.contextSize - b.contextSize);
	}
	return pricing;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export interface BuildSnapshotResult {
	catalog: ModelCatalog;
	/** Models that failed validation and were left out, as `provider/model: reason`. */
	skipped: string[];
}

/**
 * Builds the shipped snapshot from a models.dev `api.json` document: keeps the providers
 * n8n can attribute usage to, and for each model only identity, status, context limit and
 * pricing. Keys are sorted so that two builds of the same input produce the same file.
 */
export function buildModelCatalogSnapshot(
	document: unknown,
	options: { generatedAt: Date; providers?: readonly string[] },
): BuildSnapshotResult {
	const raw = modelsDevCatalogSchema.parse(document);
	const keep = new Set(options.providers ?? MODEL_CATALOG_PROVIDERS);
	const providers: Record<string, CatalogProvider> = {};
	const skipped: string[] = [];

	for (const [providerId, rawProvider] of Object.entries(raw)) {
		if (!keep.has(providerId)) continue;
		const provider = modelsDevProviderSchema.safeParse(rawProvider);
		if (!provider.success) {
			skipped.push(`${providerId}: ${provider.error.issues[0]?.message ?? 'invalid provider'}`);
			continue;
		}

		const models: Record<string, CatalogModel> = {};
		for (const [modelId, rawModel] of Object.entries(provider.data.models)) {
			const model = modelsDevModelSchema.safeParse(rawModel);
			if (!model.success) {
				skipped.push(
					`${providerId}/${modelId}: ${model.error.issues[0]?.message ?? 'invalid model'}`,
				);
				continue;
			}
			models[modelId] = {
				name: model.data.name,
				...(model.data.status && { status: model.data.status }),
				...(model.data.limit?.context !== undefined && {
					contextLimit: Math.floor(model.data.limit.context),
				}),
				...(model.data.cost && { pricing: toPricing(model.data.cost) }),
			};
		}
		providers[providerId] = { name: provider.data.name, models: sortedRecord(models) };
	}

	const catalog = modelCatalogSchema.parse({
		source: 'models.dev',
		generatedAt: options.generatedAt.toISOString(),
		providers: sortedRecord(providers),
	});
	return { catalog, skipped };
}

export interface ModelCatalogDiff {
	addedProviders: string[];
	removedProviders: string[];
	addedModels: string[];
	removedModels: string[];
	/** Models whose pricing, status or context limit changed, as `provider/model`. */
	changedModels: string[];
	previousModelCount: number;
	nextModelCount: number;
}

function modelKeys(catalog: ModelCatalog): Map<string, CatalogModel> {
	const keys = new Map<string, CatalogModel>();
	for (const [providerId, provider] of Object.entries(catalog.providers)) {
		for (const [modelId, model] of Object.entries(provider.models)) {
			keys.set(`${providerId}/${modelId}`, model);
		}
	}
	return keys;
}

export function diffModelCatalogs(previous: ModelCatalog, next: ModelCatalog): ModelCatalogDiff {
	const previousProviders = Object.keys(previous.providers);
	const nextProviders = Object.keys(next.providers);
	const previousModels = modelKeys(previous);
	const nextModels = modelKeys(next);

	const changedModels: string[] = [];
	for (const [key, model] of nextModels) {
		const before = previousModels.get(key);
		if (before && JSON.stringify(before) !== JSON.stringify(model)) changedModels.push(key);
	}

	return {
		addedProviders: nextProviders.filter((id) => !previous.providers[id]),
		removedProviders: previousProviders.filter((id) => !next.providers[id]),
		addedModels: [...nextModels.keys()].filter((key) => !previousModels.has(key)),
		removedModels: [...previousModels.keys()].filter((key) => !nextModels.has(key)),
		changedModels,
		previousModelCount: previousModels.size,
		nextModelCount: nextModels.size,
	};
}
