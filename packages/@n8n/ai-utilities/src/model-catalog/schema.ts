import { z } from 'zod';

const rate = z.number().min(0);

export const modelPricingRatesSchema = z.object({
	input: rate,
	output: rate,
	cacheRead: rate.optional(),
	cacheWrite: rate.optional(),
	reasoning: rate.optional(),
	inputAudio: rate.optional(),
	outputAudio: rate.optional(),
});

export const modelPricingTierSchema = modelPricingRatesSchema.extend({
	contextSize: z.number().int().min(0),
});

export const modelPricingSchema = modelPricingRatesSchema.extend({
	tiers: z.array(modelPricingTierSchema).optional(),
});

export const catalogModelSchema = z.object({
	name: z.string().min(1),
	status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
	contextLimit: z.number().int().min(0).optional(),
	pricing: modelPricingSchema.optional(),
});

export const catalogProviderSchema = z.object({
	name: z.string().min(1),
	models: z.record(z.string().min(1), catalogModelSchema),
});

export const modelCatalogSchema = z.object({
	source: z.literal('models.dev'),
	generatedAt: z.string().datetime(),
	providers: z.record(z.string().min(1), catalogProviderSchema),
});

/**
 * The subset of the models.dev `api.json` document the snapshot is built from. Fields
 * the snapshot does not carry are ignored; a model that fails this schema is skipped.
 */
export const modelsDevCostSchema = z
	.object({
		input: rate,
		output: rate,
		reasoning: rate.optional(),
		cache_read: rate.optional(),
		cache_write: rate.optional(),
		input_audio: rate.optional(),
		output_audio: rate.optional(),
		tiers: z
			.array(
				z.object({
					tier: z.object({ type: z.literal('context').optional(), size: z.number().int().min(0) }),
					input: rate,
					output: rate,
					reasoning: rate.optional(),
					cache_read: rate.optional(),
					cache_write: rate.optional(),
					input_audio: rate.optional(),
					output_audio: rate.optional(),
				}),
			)
			.optional(),
	})
	.passthrough();

export const modelsDevModelSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
		cost: modelsDevCostSchema.optional(),
		limit: z
			.object({ context: z.number().min(0) })
			.passthrough()
			.optional(),
	})
	.passthrough();

export const modelsDevProviderSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		models: z.record(z.string(), z.unknown()),
	})
	.passthrough();

export const modelsDevCatalogSchema = z.record(z.string(), z.unknown());
