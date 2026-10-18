import type {
	ModelCatalog,
	ModelIdentity,
	ModelPricingLookupFailure,
	ResolvedModelPricing,
} from './types';

/**
 * The ids a node may send for one catalog entry, most specific first. Each step is a fixed
 * rewrite, so the same input always resolves to the same entry:
 * 1. the id as given;
 * 2. without the `models/` prefix Google APIs accept;
 * 3. without a trailing `-latest` alias marker;
 * 4. without a trailing dated snapshot (`-20240620`, `-2024-06-20`), for providers that
 *    price the snapshot like the base model (OpenAI, Anthropic).
 */
export function candidateCatalogIds(modelId: string): string[] {
	const candidates: string[] = [];
	const push = (id: string) => {
		if (id.length > 0 && !candidates.includes(id)) candidates.push(id);
	};

	push(modelId);
	const withoutPrefix = modelId.replace(/^models\//, '');
	push(withoutPrefix);
	push(withoutPrefix.replace(/-latest$/, ''));
	push(withoutPrefix.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, ''));

	return candidates;
}

export function resolveModelPricing(
	catalog: ModelCatalog,
	identity: ModelIdentity,
): ResolvedModelPricing | ModelPricingLookupFailure {
	const provider = catalog.providers[identity.provider];
	if (!provider) return { reason: 'unknown-provider' };

	for (const catalogId of candidateCatalogIds(identity.id)) {
		const model = provider.models[catalogId];
		if (!model) continue;
		if (!model.pricing) return { reason: 'no-pricing' };
		return { model, pricing: model.pricing, catalogId, catalogVersion: catalog.generatedAt };
	}

	return { reason: 'unknown-model' };
}

export function isPricingLookupFailure(
	result: ResolvedModelPricing | ModelPricingLookupFailure,
): result is ModelPricingLookupFailure {
	return 'reason' in result;
}
