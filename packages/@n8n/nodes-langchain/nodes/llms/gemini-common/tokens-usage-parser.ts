import { isAIMessage } from '@langchain/core/messages';
import type { UsageMetadata } from '@langchain/core/messages';
import type { ChatGeneration, Generation, LLMResult } from '@langchain/core/outputs';

function isChatGeneration(generation: Generation): generation is ChatGeneration {
	return 'message' in generation;
}

/**
 * Token usage parser for Gemini models. The full usage report — including
 * cachedContentTokenCount, which is how Gemini implicit context caching hits
 * surface — only lives on the generation message's usage_metadata
 * (as input_token_details.cache_read); llmOutput.tokenUsage carries the plain
 * totals and is kept as a fallback.
 *
 * Unlike Anthropic, Gemini's input token count already includes the cached
 * tokens, so cacheReadInputTokens is reported as-is without adjusting totals.
 */
export function geminiTokensUsageParser(result: LLMResult) {
	let usage: UsageMetadata | undefined;
	for (const generations of result.generations) {
		for (const generation of generations) {
			if (!isChatGeneration(generation)) continue;
			const { message } = generation;
			if (isAIMessage(message) && message.usage_metadata) {
				usage = message.usage_metadata;
			}
		}
	}

	if (!usage) {
		const tokenUsage = result?.llmOutput?.tokenUsage as
			| { promptTokens?: number; completionTokens?: number; totalTokens?: number }
			| undefined;
		const completionTokens = tokenUsage?.completionTokens ?? 0;
		const promptTokens = tokenUsage?.promptTokens ?? 0;
		return {
			completionTokens,
			promptTokens,
			totalTokens: tokenUsage?.totalTokens ?? completionTokens + promptTokens,
		};
	}

	const completionTokens = usage.output_tokens ?? 0;
	const promptTokens = usage.input_tokens ?? 0;
	const cacheReadInputTokens = usage.input_token_details?.cache_read;

	return {
		completionTokens,
		promptTokens,
		totalTokens: usage.total_tokens ?? completionTokens + promptTokens,
		...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
	};
}
