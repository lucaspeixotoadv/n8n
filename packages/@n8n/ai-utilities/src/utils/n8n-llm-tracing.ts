import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { SerializedFields } from '@langchain/core/dist/load/map_keys';
import { getModelNameForTiktoken } from '@langchain/core/language_models/base';
import type {
	Serialized,
	SerializedNotImplemented,
	SerializedSecret,
} from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import pick from 'lodash/pick';
import type {
	IDataObject,
	ISupplyDataFunctions,
	JsonObject,
	LlmInvocationCost,
	LlmTokenCounts,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeError, NodeOperationError } from 'n8n-workflow';

import { normalizeLlmResultUsage } from './llm-usage-normalizer';
import { logAiEvent } from './log-ai-event';
import { redactHeaderValues } from './redact-headers';
import { loadModelCatalog } from '../model-catalog/catalog';
import { computeLlmInvocationCost, type CostUnavailableReason } from '../model-catalog/cost';
import { MODEL_CATALOG_PROVIDER_BY_NODE_TYPE } from '../model-catalog/node-providers';
import { isPricingLookupFailure, resolveModelPricing } from '../model-catalog/pricing';
import type { ModelIdentity } from '../model-catalog/types';
import { estimateTokensFromStringList } from './tokenizer/token-estimator';

/**
 * Normalized token usage returned by a TokensUsageParser: the shared invocation contract,
 * plus the cost the provider reported itself when it did (`cost`, or `totalCost` for
 * providers that name it so).
 */
export type TokenUsageResult = LlmTokenCounts & {
	cost?: number;
	totalCost?: number;
	/** Name earlier Gemini parsers used for `cacheReadTokens`. */
	cacheReadInputTokens?: number;
};

export type TokensUsageParser = (result: LLMResult) => TokenUsageResult;

type RunDetail = {
	index: number;
	messages: BaseMessage[] | string[] | string;
	options: SerializedSecret | SerializedNotImplemented | SerializedFields;
};

const TIKTOKEN_ESTIMATE_MODEL = 'gpt-4o';

type TracingWriter = {
	setMetadata: (metadata: { tracing: LlmTokenTracingMetadata }) => void;
};

/** Keys written by `applyTracingTokenMetadata` into execution tracing metadata. */
type LlmTokenTracingMetadata = {
	'llm.tokens.in': number;
	'llm.tokens.out': number;
	'llm.tokens.total': number;
	'llm.tokens.estimated': boolean;
	'llm.tokens.cache_read'?: number;
	'llm.tokens.cache_write'?: number;
	'llm.tokens.reasoning'?: number;
	'llm.model.provider'?: string;
	'llm.model.id'?: string;
	'llm.cost.total'?: number;
	'llm.cost.source'?: LlmInvocationCost['source'];
	'llm.cost.unavailable_reason'?: CostUnavailableReason;
};

/** The output item the tracing persists for one invocation. */
type LlmRunOutput = {
	response: { generations: LLMResult['generations'] };
	tokenUsage?: LlmTokenCounts;
	tokenUsageEstimate?: LlmTokenCounts;
	cost?: LlmInvocationCost;
};

function toCounts(usage: TokenUsageResult): LlmTokenCounts {
	const cacheReadTokens = usage.cacheReadTokens ?? usage.cacheReadInputTokens;
	return {
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.totalTokens,
		...(cacheReadTokens !== undefined && { cacheReadTokens }),
		...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
		...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
	};
}

function readModelId(kwargs: unknown): string | undefined {
	if (typeof kwargs !== 'object' || kwargs === null) return undefined;
	for (const key of ['model', 'model_name', 'modelName']) {
		const value = (kwargs as Record<string, unknown>)[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}

function canWriteTracingMetadata(context: unknown): context is TracingWriter {
	return (
		typeof context === 'object' &&
		context !== null &&
		'setMetadata' in context &&
		typeof context.setMetadata === 'function'
	);
}

export class N8nLlmTracing extends BaseCallbackHandler {
	name = 'N8nLlmTracing';

	// This flag makes sure that LangChain will wait for the handlers to finish before continuing
	// This is crucial for the handleLLMError handler to work correctly (it should be called before the error is propagated to the root node)
	awaitHandlers = true;

	connectionType = NodeConnectionTypes.AiLanguageModel;

	promptTokensEstimate = 0;

	completionTokensEstimate = 0;

	#parentRunIndex?: number;

	/**
	 * A map to associate LLM run IDs to run details.
	 * Key: Unique identifier for each LLM run (run ID)
	 * Value: RunDetails object
	 *
	 */
	runsMap: Record<string, RunDetail> = {};

	options: {
		tokensUsageParser: TokensUsageParser;
		errorDescriptionMapper: (error: NodeError) => string | null | undefined;
		redactedHeaders?: string[];
		/**
		 * Which catalog model prices the invocations. Defaults to the provider of the node type
		 * (see `MODEL_CATALOG_PROVIDER_BY_NODE_TYPE`) and the model id the node handed to
		 * LangChain; a node whose identity differs from that (e.g. a gateway) passes it here.
		 */
		model?: ModelIdentity;
	} = {
		// Default parser: LangChain's standard usage_metadata, then the adapter's llmOutput shapes
		tokensUsageParser: (result: LLMResult) => {
			const { providerCost, ...counts } = normalizeLlmResultUsage(result);
			return { ...counts, ...(providerCost !== undefined && { cost: providerCost }) };
		},
		errorDescriptionMapper: (error: NodeError) => error.description,
	};

	constructor(
		private executionFunctions: ISupplyDataFunctions,
		options?: {
			tokensUsageParser?: TokensUsageParser;
			errorDescriptionMapper?: (error: NodeError) => string;
			redactedHeaders?: string[];
			model?: ModelIdentity;
		},
	) {
		super();
		this.options = { ...this.options, ...options };
	}

	async estimateTokensFromGeneration(generations: LLMResult['generations']) {
		const messages = generations.flatMap((gen) => gen.map((g) => g.text));
		return await this.estimateTokensFromStringList(messages);
	}

	async estimateTokensFromStringList(list: string[]) {
		const embeddingModel = getModelNameForTiktoken(TIKTOKEN_ESTIMATE_MODEL);
		return await estimateTokensFromStringList(list, embeddingModel);
	}

	async handleLLMEnd(output: LLMResult, runId: string) {
		// The fallback should never happen since handleLLMStart should always set the run details
		// but just in case, we set the index to the length of the runsMap
		const runDetails = this.runsMap[runId] ?? { index: Object.keys(this.runsMap).length };

		// Parse usage before stripping the generations down to text/generationInfo:
		// some providers (e.g. Google Gemini) report token usage only on the
		// generation message's usage_metadata, which the stripping removes.
		const tokenUsage = this.options.tokensUsageParser(output);

		output.generations = output.generations.map((gen) =>
			gen.map((g) => pick(g, ['text', 'generationInfo'])),
		);

		const tokenUsageEstimate = {
			completionTokens: 0,
			promptTokens: 0,
			totalTokens: 0,
		};

		if (output.generations.length > 0) {
			tokenUsageEstimate.completionTokens = await this.estimateTokensFromGeneration(
				output.generations,
			);

			tokenUsageEstimate.promptTokens = this.promptTokensEstimate;
			tokenUsageEstimate.totalTokens =
				tokenUsageEstimate.completionTokens + this.promptTokensEstimate;
		}
		const response: LlmRunOutput = {
			response: { generations: output.generations },
		};

		const model = this.resolveModelIdentity(runDetails.options);

		// If the LLM response contains actual tokens usage, otherwise fallback to the estimate
		if (tokenUsage.promptTokens > 0 || tokenUsage.completionTokens > 0) {
			const counts = toCounts(tokenUsage);
			const priced = await this.priceInvocation(
				counts,
				tokenUsage.cost ?? tokenUsage.totalCost,
				model,
			);
			response.tokenUsage = counts;
			if (priced.cost) response.cost = priced.cost;
			this.applyTracingTokenMetadata({
				counts,
				isEstimated: false,
				model,
				cost: priced.cost,
				costUnavailableReason: priced.reason,
			});
		} else {
			response.tokenUsageEstimate = tokenUsageEstimate;
			this.applyTracingTokenMetadata({
				counts: tokenUsageEstimate,
				isEstimated: true,
				model,
				// An estimate is never priced: a wrong number is worse than none
				costUnavailableReason: 'estimated-usage',
			});
		}

		const parsedMessages =
			typeof runDetails.messages === 'string'
				? runDetails.messages
				: runDetails.messages.map((message) => {
						if (typeof message === 'string') return message;
						if (typeof message?.toJSON === 'function') return message.toJSON();

						return message;
					});

		const sourceNodeRunIndex =
			this.#parentRunIndex !== undefined ? this.#parentRunIndex + runDetails.index : undefined;

		this.executionFunctions.addOutputData(
			this.connectionType,
			runDetails.index,
			[[{ json: { ...response } }]],
			undefined,
			sourceNodeRunIndex,
		);

		logAiEvent(this.executionFunctions, 'ai-llm-generated-output', {
			messages: parsedMessages,
			options: runDetails.options,
			response,
		});
	}

	async handleLLMStart(llm: Serialized, prompts: string[], runId: string) {
		const estimatedTokens = await this.estimateTokensFromStringList(prompts);
		const sourceNodeRunIndex =
			this.#parentRunIndex !== undefined
				? this.#parentRunIndex + this.executionFunctions.getNextRunIndex()
				: undefined;

		const options = redactHeaderValues(
			llm.type === 'constructor' ? llm.kwargs : llm,
			this.options.redactedHeaders ?? [],
		);
		const { index } = this.executionFunctions.addInputData(
			this.connectionType,
			[
				[
					{
						json: {
							messages: prompts,
							estimatedTokens,
							options,
						},
					},
				],
			],
			sourceNodeRunIndex,
		);

		// Save the run details for later use when processing `handleLLMEnd` event
		this.runsMap[runId] = {
			index,
			options,
			messages: prompts,
		};
		this.promptTokensEstimate = estimatedTokens;
	}

	async handleLLMError(error: IDataObject | Error, runId: string, parentRunId?: string) {
		const runDetails = this.runsMap[runId] ?? { index: Object.keys(this.runsMap).length };

		// Filter out non-x- headers to avoid leaking sensitive information in logs
		// eslint-disable-next-line no-prototype-builtins
		if (typeof error === 'object' && error?.hasOwnProperty('headers')) {
			const errorWithHeaders = error as { headers: Record<string, unknown> };

			Object.keys(errorWithHeaders.headers).forEach((key) => {
				if (!key.startsWith('x-')) {
					delete errorWithHeaders.headers[key];
				}
			});
		}

		if (error instanceof NodeError) {
			if (this.options.errorDescriptionMapper) {
				error.description = this.options.errorDescriptionMapper(error);
			}

			this.executionFunctions.addOutputData(this.connectionType, runDetails.index, error);
		} else {
			// If the error is not a NodeError, we wrap it in a NodeOperationError
			this.executionFunctions.addOutputData(
				this.connectionType,
				runDetails.index,
				new NodeOperationError(this.executionFunctions.getNode(), error as JsonObject, {
					functionality: 'configuration-node',
				}),
			);
		}

		logAiEvent(this.executionFunctions, 'ai-llm-errored', {
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			error: Object.keys(error).length === 0 ? error.toString() : error,
			runId,
			parentRunId,
		});
	}

	// Used to associate subsequent runs with the correct parent run in subnodes of subnodes
	setParentRunIndex(runIndex: number) {
		this.#parentRunIndex = runIndex;
	}

	/** The model that priced this run: the explicit option, else the node type's provider and the id LangChain was given. */
	private resolveModelIdentity(kwargs: unknown): Partial<ModelIdentity> {
		if (this.options.model) return this.options.model;
		const provider = MODEL_CATALOG_PROVIDER_BY_NODE_TYPE[this.executionFunctions.getNode().type];
		const id = readModelId(kwargs);
		return { ...(provider && { provider }), ...(id && { id }) };
	}

	/**
	 * Prices one invocation. A cost the provider reported itself wins over the catalog; the
	 * catalog only prices a model it knows, with every rate the usage needs. Anything else
	 * leaves the cost unavailable, with the reason on the tracing metadata.
	 */
	private async priceInvocation(
		counts: LlmTokenCounts,
		providerCost: number | undefined,
		model: Partial<ModelIdentity>,
	): Promise<{ cost?: LlmInvocationCost; reason?: CostUnavailableReason }> {
		if (typeof providerCost === 'number' && Number.isFinite(providerCost)) {
			return {
				cost: {
					amount: providerCost,
					currency: 'USD',
					source: 'provider',
					...(model.provider && model.id && { model: { provider: model.provider, id: model.id } }),
				},
			};
		}
		if (!model.provider) return { reason: 'unknown-provider' };
		if (!model.id) return { reason: 'unknown-model' };

		let catalog;
		try {
			catalog = await loadModelCatalog();
		} catch (error) {
			this.executionFunctions.logger?.warn?.(
				`Model catalog unavailable, cost not computed: ${(error as Error).message}`,
			);
			return { reason: 'no-pricing' };
		}
		const resolved = resolveModelPricing(catalog, { provider: model.provider, id: model.id });
		if (isPricingLookupFailure(resolved)) return { reason: resolved.reason };

		return computeLlmInvocationCost(counts, resolved.pricing, {
			model: { provider: model.provider, id: model.id },
			catalogVersion: resolved.catalogVersion,
		});
	}

	private applyTracingTokenMetadata(params: {
		counts: LlmTokenCounts;
		isEstimated: boolean;
		model: Partial<ModelIdentity>;
		cost?: LlmInvocationCost;
		costUnavailableReason?: CostUnavailableReason;
	}) {
		if (!canWriteTracingMetadata(this.executionFunctions)) return;

		const { counts, model, cost } = params;
		const tracing: LlmTokenTracingMetadata = {
			'llm.tokens.in': counts.promptTokens,
			'llm.tokens.out': counts.completionTokens,
			'llm.tokens.total': counts.totalTokens,
			'llm.tokens.estimated': params.isEstimated,
		};
		if (counts.cacheReadTokens !== undefined) {
			tracing['llm.tokens.cache_read'] = counts.cacheReadTokens;
		}
		if (counts.cacheWriteTokens !== undefined) {
			tracing['llm.tokens.cache_write'] = counts.cacheWriteTokens;
		}
		if (counts.reasoningTokens !== undefined) {
			tracing['llm.tokens.reasoning'] = counts.reasoningTokens;
		}
		if (model.provider) tracing['llm.model.provider'] = model.provider;
		if (model.id) tracing['llm.model.id'] = model.id;
		if (cost) {
			tracing['llm.cost.total'] = cost.amount;
			tracing['llm.cost.source'] = cost.source;
		} else if (params.costUnavailableReason) {
			tracing['llm.cost.unavailable_reason'] = params.costUnavailableReason;
		}

		this.executionFunctions.setMetadata({ tracing });
	}
}
