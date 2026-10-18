import { normalizeLlmResultUsage } from '@n8n/ai-utilities';
import type { LLMResult } from '@langchain/core/outputs';
import type { LlmTokenCounts } from 'n8n-workflow';

/**
 * Token usage parser for Gemini models, on top of the shared normalizer.
 *
 * Gemini's `promptTokenCount` already includes `cachedContentTokenCount`, which the
 * adapter reports as `input_token_details.cache_read`, so cache reads are a subset of the
 * prompt tokens as everywhere else. Its `candidatesTokenCount` however excludes the
 * `thoughtsTokenCount` of thinking models while `totalTokenCount` includes it, and the
 * adapter maps `output_tokens` to the candidates only. Gemini bills thoughts as output,
 * so the difference `total - prompt - candidates` is folded into `completionTokens` and
 * exposed as `reasoningTokens`, keeping `total = prompt + completion` and reasoning a
 * subset of the output.
 */
export function geminiTokensUsageParser(result: LLMResult): LlmTokenCounts {
	const { providerCost: _providerCost, ...usage } = normalizeLlmResultUsage(result);

	const thoughtTokens = usage.totalTokens - usage.promptTokens - usage.completionTokens;
	if (thoughtTokens <= 0 || usage.reasoningTokens !== undefined) return usage;

	return {
		...usage,
		completionTokens: usage.completionTokens + thoughtTokens,
		reasoningTokens: thoughtTokens,
	};
}
