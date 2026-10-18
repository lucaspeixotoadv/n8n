import type { LlmAppliedPricing, LlmInvocationCost, LlmTokenCounts } from 'n8n-workflow';

import type { ModelPricing, ModelPricingRates } from './types';

const PER_MILLION = 1_000_000;

export type CostUnavailableReason =
	| 'unknown-provider'
	| 'unknown-model'
	| 'no-pricing'
	| 'estimated-usage'
	| 'missing-rate:cacheRead'
	| 'missing-rate:cacheWrite';

export type LlmCostResult =
	| { cost: LlmInvocationCost; reason?: undefined }
	| { cost?: undefined; reason: CostUnavailableReason };

/**
 * Picks the rates that apply to a prompt of `promptTokens`: the largest tier whose context
 * size the prompt exceeds, otherwise the base rates.
 */
export function selectPricingRates(
	pricing: ModelPricing,
	promptTokens: number,
): { rates: ModelPricingRates; tier?: { contextSize: number } } {
	const tiers = [...(pricing.tiers ?? [])].sort((a, b) => b.contextSize - a.contextSize);
	for (const tier of tiers) {
		if (promptTokens > tier.contextSize) {
			const { contextSize, ...rates } = tier;
			return { rates, tier: { contextSize } };
		}
	}
	const { tiers: _tiers, ...rates } = pricing;
	return { rates };
}

/**
 * Prices one invocation from its normalized token counts. Cache and reasoning tokens are
 * subsets of the prompt and completion counts, so they are carved out of those counts and
 * billed at their own rate, never added on top. A category the usage reports but the
 * pricing has no rate for makes the cost unavailable rather than approximated.
 */
export function computeLlmInvocationCost(
	tokens: LlmTokenCounts,
	pricing: ModelPricing,
	context: { model: { provider: string; id: string }; catalogVersion: string },
): LlmCostResult {
	const { rates, tier } = selectPricingRates(pricing, tokens.promptTokens);

	const cacheRead = tokens.cacheReadTokens ?? 0;
	const cacheWrite = tokens.cacheWriteTokens ?? 0;
	const reasoning = tokens.reasoningTokens ?? 0;

	if (cacheRead > 0 && rates.cacheRead === undefined) return { reason: 'missing-rate:cacheRead' };
	if (cacheWrite > 0 && rates.cacheWrite === undefined) {
		return { reason: 'missing-rate:cacheWrite' };
	}

	const uncachedInput = Math.max(tokens.promptTokens - cacheRead - cacheWrite, 0);
	// Reasoning tokens are billed as output unless the model prices them separately
	const reasoningRate = rates.reasoning ?? rates.output;
	const plainOutput = Math.max(tokens.completionTokens - reasoning, 0);

	const amount =
		(uncachedInput * rates.input +
			cacheRead * (rates.cacheRead ?? 0) +
			cacheWrite * (rates.cacheWrite ?? 0) +
			plainOutput * rates.output +
			reasoning * reasoningRate) /
		PER_MILLION;

	const applied: LlmAppliedPricing = {
		input: rates.input,
		output: rates.output,
		...(rates.cacheRead !== undefined && { cacheRead: rates.cacheRead }),
		...(rates.cacheWrite !== undefined && { cacheWrite: rates.cacheWrite }),
		...(rates.reasoning !== undefined && { reasoning: rates.reasoning }),
		...(tier && { tier }),
	};

	return {
		cost: {
			amount,
			currency: 'USD',
			source: 'catalog',
			model: context.model,
			pricing: applied,
			catalogVersion: context.catalogVersion,
		},
	};
}
