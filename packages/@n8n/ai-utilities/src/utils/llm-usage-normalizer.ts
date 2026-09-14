import { isAIMessage } from '@langchain/core/messages';
import type { UsageMetadata } from '@langchain/core/messages';
import type { ChatGeneration, Generation, LLMResult } from '@langchain/core/outputs';
import type { LlmTokenCounts } from 'n8n-workflow';

/**
 * Token usage of one LLM invocation as the tracing persists it, plus the cost the provider
 * or gateway reported itself, when it did.
 */
export type NormalizedLlmUsage = LlmTokenCounts & { providerCost?: number };

function isChatGeneration(generation: Generation): generation is ChatGeneration {
	return 'message' in generation;
}

function toNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function positive(value: number | undefined): number | undefined {
	return value !== undefined && value > 0 ? value : undefined;
}

function withDetails(
	base: { promptTokens: number; completionTokens: number; totalTokens: number },
	details: { cacheRead?: number; cacheWrite?: number; reasoning?: number },
): LlmTokenCounts {
	return {
		...base,
		...(positive(details.cacheRead) !== undefined && { cacheReadTokens: details.cacheRead }),
		...(positive(details.cacheWrite) !== undefined && { cacheWriteTokens: details.cacheWrite }),
		...(positive(details.reasoning) !== undefined && { reasoningTokens: details.reasoning }),
	};
}

/**
 * Maps LangChain's standard `usage_metadata`. Every provider adapter fills it with the
 * same semantics: `input_tokens` already contains the cached tokens and `output_tokens`
 * already contains the reasoning tokens; the details are breakdowns of those totals.
 */
export function fromUsageMetadata(usage: UsageMetadata): LlmTokenCounts {
	const promptTokens = usage.input_tokens ?? 0;
	const completionTokens = usage.output_tokens ?? 0;
	return withDetails(
		{
			promptTokens,
			completionTokens,
			totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
		},
		{
			cacheRead: toNumber(usage.input_token_details?.cache_read),
			cacheWrite: toNumber(usage.input_token_details?.cache_creation),
			reasoning: toNumber(usage.output_token_details?.reasoning),
		},
	);
}

function fromLangchainTokenUsage(tokenUsage: Record<string, unknown>): LlmTokenCounts | undefined {
	// The OpenAI-style shape most adapters put on `llmOutput.tokenUsage`
	const promptTokens = toNumber(tokenUsage.promptTokens);
	const completionTokens = toNumber(tokenUsage.completionTokens);
	if (promptTokens !== undefined || completionTokens !== undefined) {
		const prompt = promptTokens ?? 0;
		const completion = completionTokens ?? 0;
		return {
			promptTokens: prompt,
			completionTokens: completion,
			totalTokens: toNumber(tokenUsage.totalTokens) ?? prompt + completion,
		};
	}
	// Some adapters put a `usage_metadata`-shaped object there instead
	if (
		toNumber(tokenUsage.input_tokens) !== undefined ||
		toNumber(tokenUsage.output_tokens) !== undefined
	) {
		return fromUsageMetadata(tokenUsage as UsageMetadata);
	}
	return undefined;
}

/** Anthropic's raw `usage` block, which the adapter leaves on `llmOutput` for non-streamed calls. */
function fromAnthropicUsage(usage: Record<string, unknown>): LlmTokenCounts | undefined {
	const input = toNumber(usage.input_tokens);
	const output = toNumber(usage.output_tokens);
	if (input === undefined || output === undefined) return undefined;
	const cacheWrite = toNumber(usage.cache_creation_input_tokens) ?? 0;
	const cacheRead = toNumber(usage.cache_read_input_tokens) ?? 0;
	const promptTokens = input + cacheWrite + cacheRead;
	return withDetails(
		{ promptTokens, completionTokens: output, totalTokens: promptTokens + output },
		{ cacheRead, cacheWrite },
	);
}

function findProviderCost(
	result: LLMResult,
	tokenUsage: Record<string, unknown> | undefined,
): number | undefined {
	const fromLlmOutput = toNumber(tokenUsage?.cost) ?? toNumber(tokenUsage?.totalCost);
	if (fromLlmOutput !== undefined) return fromLlmOutput;

	// Gateways such as OpenRouter report the billed cost inside the raw usage block
	for (const generations of result.generations) {
		for (const generation of generations) {
			if (!isChatGeneration(generation)) continue;
			const responseMetadata: unknown = generation.message.response_metadata;
			const usage = isRecord(responseMetadata) ? responseMetadata.usage : undefined;
			const cost = isRecord(usage) ? toNumber(usage.cost) : undefined;
			if (cost !== undefined) return cost;
		}
	}
	return undefined;
}

const EMPTY: LlmTokenCounts = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Normalizes the usage of an LLM result into one shape, whatever the provider adapter:
 * the standard `usage_metadata` on the generated message first (it is the only place
 * that carries cache and reasoning breakdowns, and the only place streamed calls report
 * usage at all), then the adapter's `llmOutput` shapes. Zeroes mean the provider reported
 * nothing, and the tracing then falls back to an estimate.
 */
export function normalizeLlmResultUsage(result: LLMResult): NormalizedLlmUsage {
	const tokenUsage = isRecord(result.llmOutput?.tokenUsage)
		? result.llmOutput.tokenUsage
		: undefined;
	const providerCost = findProviderCost(result, tokenUsage);

	let counts: LlmTokenCounts | undefined;
	for (const generations of result.generations) {
		for (const generation of generations) {
			if (!isChatGeneration(generation)) continue;
			const { message } = generation;
			if (isAIMessage(message) && message.usage_metadata) {
				counts = fromUsageMetadata(message.usage_metadata);
			}
		}
	}

	if (!counts && tokenUsage) counts = fromLangchainTokenUsage(tokenUsage);
	if (!counts && isRecord(result.llmOutput?.usage)) {
		counts = fromAnthropicUsage(result.llmOutput.usage);
	}

	return { ...(counts ?? EMPTY), ...(providerCost !== undefined && { providerCost }) };
}
