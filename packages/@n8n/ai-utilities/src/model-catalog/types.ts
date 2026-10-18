/** Rates in USD per million tokens. */
export interface ModelPricingRates {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	inputAudio?: number;
	outputAudio?: number;
}

/** Rates that replace the base rates once the prompt exceeds `contextSize` tokens. */
export interface ModelPricingTier extends ModelPricingRates {
	contextSize: number;
}

export interface ModelPricing extends ModelPricingRates {
	tiers?: ModelPricingTier[];
}

export interface CatalogModel {
	name: string;
	status?: 'alpha' | 'beta' | 'deprecated';
	contextLimit?: number;
	/** Absent when the catalog knows the model but not its price. */
	pricing?: ModelPricing;
}

export interface CatalogProvider {
	name: string;
	models: Record<string, CatalogModel>;
}

/** The pruned models.dev snapshot shipped with n8n. */
export interface ModelCatalog {
	source: 'models.dev';
	/** ISO timestamp of the upstream data the snapshot was built from; doubles as the catalog version. */
	generatedAt: string;
	providers: Record<string, CatalogProvider>;
}

export interface ModelIdentity {
	/** models.dev provider id, e.g. `openai`, `anthropic`, `google`. */
	provider: string;
	/** Model id as the node sent it to the provider, e.g. `gpt-4o-2024-11-20`. */
	id: string;
}

export interface ResolvedModelPricing {
	model: CatalogModel;
	pricing: ModelPricing;
	/** The id the model was found under in the catalog, after normalization. */
	catalogId: string;
	catalogVersion: string;
}

export type ModelPricingLookupFailure =
	| { reason: 'unknown-provider' }
	| { reason: 'unknown-model' }
	| { reason: 'no-pricing' };
