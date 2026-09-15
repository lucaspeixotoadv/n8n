import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { SerializedFields } from '@langchain/core/dist/load/map_keys';
import type {
	Serialized,
	SerializedNotImplemented,
	SerializedSecret,
} from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { logAiEvent, redactHeaderValues, type ParentRunIndexAware } from '@n8n/ai-utilities';
import pick from 'lodash/pick';
import type { IDataObject, ISupplyDataFunctions, JsonObject } from 'n8n-workflow';
import { NodeConnectionTypes, NodeError, NodeOperationError } from 'n8n-workflow';

type RunDetail = {
	index: number;
	messages: BaseMessage[] | string[] | string;
	options: SerializedSecret | SerializedNotImplemented | SerializedFields;
	/** Run of the parent sub-node this invocation belongs to, when the parent pinned one. */
	sourceNodeRunIndex?: number;
};

export class N8nNonEstimatingTracing extends BaseCallbackHandler implements ParentRunIndexAware {
	name = 'N8nNonEstimatingTracing';

	// This flag makes sure that LangChain will wait for the handlers to finish before continuing
	// This is crucial for the handleLLMError handler to work correctly (it should be called before the error is propagated to the root node)
	awaitHandlers = true;

	connectionType = NodeConnectionTypes.AiLanguageModel;

	#parentRunIndex?: number;

	/** Parent run pinned per LangChain run id by the parent sub-node's own tracer. */
	readonly #parentRunIndexByRun = new Map<string, number>();

	/**
	 * A map to associate LLM run IDs to run details.
	 * Key: Unique identifier for each LLM run (run ID)
	 * Value: RunDetails object
	 *
	 */
	runsMap: Record<string, RunDetail> = {};

	options: {
		errorDescriptionMapper: (error: NodeError) => string | null | undefined;
		redactedHeaders?: string[];
		/**
		 * Called as soon as this tracer opened its run for an invocation, with the LangChain
		 * run id and the run index. A node that sits between an agent and a model uses it to
		 * pin that run on the model's tracer, so the model's run points to the exact run of
		 * this node.
		 */
		onRunStarted?: (runId: string, runIndex: number) => void;
	} = {
		// Default(OpenAI format) parser
		errorDescriptionMapper: (error: NodeError) => error.description,
	};

	constructor(
		private executionFunctions: ISupplyDataFunctions,
		options?: {
			errorDescriptionMapper?: (error: NodeError) => string;
			redactedHeaders?: string[];
			onRunStarted?: (runId: string, runIndex: number) => void;
		},
	) {
		super();
		this.options = { ...this.options, ...options };
	}

	async handleLLMEnd(output: LLMResult, runId: string) {
		// The fallback should never happen since handleLLMStart should always set the run details
		// but just in case, we set the index to the length of the runsMap
		const runDetails = this.runsMap[runId] ?? { index: Object.keys(this.runsMap).length };

		output.generations = output.generations.map((gen) =>
			gen.map((g) => pick(g, ['text', 'generationInfo'])),
		);

		const tokenUsageEstimate = {
			completionTokens: 0,
			promptTokens: 0,
			totalTokens: 0,
		};
		const response: {
			response: { generations: LLMResult['generations'] };
			tokenUsageEstimate?: typeof tokenUsageEstimate;
		} = {
			response: { generations: output.generations },
		};

		response.tokenUsageEstimate = tokenUsageEstimate;

		const parsedMessages =
			typeof runDetails.messages === 'string'
				? runDetails.messages
				: runDetails.messages.map((message) => {
						if (typeof message === 'string') return message;
						if (typeof message?.toJSON === 'function') return message.toJSON();

						return message;
					});

		this.executionFunctions.addOutputData(
			this.connectionType,
			runDetails.index,
			[[{ json: { ...response } }]],
			undefined,
			runDetails.sourceNodeRunIndex,
		);

		logAiEvent(this.executionFunctions, 'ai-llm-generated-output', {
			messages: parsedMessages,
			options: runDetails.options,
			response,
		});
	}

	async handleLLMStart(llm: Serialized, prompts: string[], runId: string) {
		const estimatedTokens = 0;
		const sourceNodeRunIndex = this.resolveSourceNodeRunIndex(runId);

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
			sourceNodeRunIndex,
		};
		this.options.onRunStarted?.(runId, index);
	}

	async handleLLMError(error: IDataObject | Error, runId: string, parentRunId?: string) {
		const runDetails = this.runsMap[runId] ?? { index: Object.keys(this.runsMap).length };

		// Filter out non-x- headers to avoid leaking sensitive information in logs
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

			this.executionFunctions.addOutputData(
				this.connectionType,
				runDetails.index,
				error,
				undefined,
				runDetails.sourceNodeRunIndex,
			);
		} else {
			// If the error is not a NodeError, we wrap it in a NodeOperationError
			this.executionFunctions.addOutputData(
				this.connectionType,
				runDetails.index,
				new NodeOperationError(this.executionFunctions.getNode(), error as JsonObject, {
					functionality: 'configuration-node',
				}),
				undefined,
				runDetails.sourceNodeRunIndex,
			);
		}

		logAiEvent(this.executionFunctions, 'ai-llm-errored', {
			error: Object.keys(error).length === 0 ? error.toString() : error,
			runId,
			parentRunId,
		});
	}

	/**
	 * Base run index of the parent sub-node, for callers that cannot pin a run per
	 * invocation. Superseded by {@link setParentRunIndexForRun} whenever a pin exists.
	 * @deprecated Pin the parent run per invocation with `setParentRunIndexForRun`.
	 */
	setParentRunIndex(runIndex: number) {
		this.#parentRunIndex = runIndex;
	}

	/** Pins the run of the parent sub-node that the invocation `runId` belongs to. */
	setParentRunIndexForRun(runId: string, runIndex: number) {
		this.#parentRunIndexByRun.set(runId, runIndex);
	}

	private resolveSourceNodeRunIndex(runId: string): number | undefined {
		const pinned = this.#parentRunIndexByRun.get(runId);
		if (pinned !== undefined) {
			this.#parentRunIndexByRun.delete(runId);
			return pinned;
		}
		return this.#parentRunIndex !== undefined
			? this.#parentRunIndex + this.executionFunctions.getNextRunIndex()
			: undefined;
	}
}
