import type { INodeExecutionData, IRunData, ITaskData } from './interfaces';
import { NodeConnectionTypes } from './interfaces';

/**
 * Token counts of one LLM invocation, in the provider's billing semantics:
 * `promptTokens` covers every input token the provider billed (cache tiers included),
 * `completionTokens` covers every output token (reasoning included). The optional
 * breakdowns are subsets of those two numbers and must never be added on top of them.
 */
export interface LlmTokenCounts {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Prompt tokens served from the provider's prompt cache. Subset of `promptTokens`. */
	cacheReadTokens?: number;
	/** Prompt tokens written to the provider's prompt cache. Subset of `promptTokens`. */
	cacheWriteTokens?: number;
	/** Output tokens spent on reasoning/thinking. Subset of `completionTokens`. */
	reasoningTokens?: number;
}

/** The rates (USD per million tokens) that priced one invocation, frozen at execution time. */
export interface LlmAppliedPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	/** Set when a context-size pricing tier applied instead of the base rates. */
	tier?: { contextSize: number };
}

/** Monetary cost of one LLM invocation, persisted on the LLM run next to its token usage. */
export interface LlmInvocationCost {
	amount: number;
	currency: 'USD';
	/** `provider` when the provider or gateway reported the cost itself, `catalog` when computed from the model catalog. */
	source: 'provider' | 'catalog';
	model?: { provider: string; id: string };
	pricing?: LlmAppliedPricing;
	/** Version of the catalog snapshot the pricing came from. */
	catalogVersion?: string;
}

/** Usage read back from one LLM run item. */
export interface LlmInvocationUsage {
	tokens: LlmTokenCounts;
	isEstimate: boolean;
	cost?: LlmInvocationCost;
}

/** Sum of the usage of a set of LLM invocations. */
export interface LlmUsageSummary {
	/** Number of LLM invocations counted. */
	invocations: number;
	tokens: Required<LlmTokenCounts>;
	/** True when at least one invocation reported estimated token counts. */
	tokensEstimated: boolean;
	/** False when at least one invocation reported no token counts at all. */
	tokensComplete: boolean;
	cost: { amount: number; currency: 'USD' };
	/** False when at least one invocation has no computed cost. Independent of `tokensComplete`. */
	costComplete: boolean;
}

/**
 * Usage of an agent-like node run: `own` is what the node's own LLM invocations used,
 * `subagents` is what every descendant sub-agent used (at any depth), and
 * `total = own + subagents`.
 */
export interface LlmUsageAggregate {
	own: LlmUsageSummary;
	subagents: LlmUsageSummary;
	total: LlmUsageSummary;
}

export function emptyLlmUsageSummary(): LlmUsageSummary {
	return {
		invocations: 0,
		tokens: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		},
		tokensEstimated: false,
		tokensComplete: true,
		cost: { amount: 0, currency: 'USD' },
		costComplete: true,
	};
}

export function addLlmUsageSummaries(a: LlmUsageSummary, b: LlmUsageSummary): LlmUsageSummary {
	return {
		invocations: a.invocations + b.invocations,
		tokens: {
			promptTokens: a.tokens.promptTokens + b.tokens.promptTokens,
			completionTokens: a.tokens.completionTokens + b.tokens.completionTokens,
			totalTokens: a.tokens.totalTokens + b.tokens.totalTokens,
			cacheReadTokens: a.tokens.cacheReadTokens + b.tokens.cacheReadTokens,
			cacheWriteTokens: a.tokens.cacheWriteTokens + b.tokens.cacheWriteTokens,
			reasoningTokens: a.tokens.reasoningTokens + b.tokens.reasoningTokens,
		},
		tokensEstimated: a.tokensEstimated || b.tokensEstimated,
		tokensComplete: a.tokensComplete && b.tokensComplete,
		cost: { amount: a.cost.amount + b.cost.amount, currency: 'USD' },
		costComplete: a.costComplete && b.costComplete,
	};
}

function toNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTokenCounts(value: unknown): LlmTokenCounts | undefined {
	if (!isRecord(value)) return undefined;
	const promptTokens = toNumber(value.promptTokens);
	const completionTokens = toNumber(value.completionTokens);
	if (promptTokens === undefined || completionTokens === undefined) return undefined;

	const counts: LlmTokenCounts = {
		promptTokens,
		completionTokens,
		totalTokens: toNumber(value.totalTokens) ?? promptTokens + completionTokens,
	};
	// `cacheReadInputTokens` is the name earlier Gemini runs persisted.
	const cacheReadTokens = toNumber(value.cacheReadTokens) ?? toNumber(value.cacheReadInputTokens);
	if (cacheReadTokens !== undefined) counts.cacheReadTokens = cacheReadTokens;
	const cacheWriteTokens = toNumber(value.cacheWriteTokens);
	if (cacheWriteTokens !== undefined) counts.cacheWriteTokens = cacheWriteTokens;
	const reasoningTokens = toNumber(value.reasoningTokens);
	if (reasoningTokens !== undefined) counts.reasoningTokens = reasoningTokens;
	return counts;
}

function readCost(json: Record<string, unknown>): LlmInvocationCost | undefined {
	const cost = json.cost;
	if (isRecord(cost)) {
		const amount = toNumber(cost.amount);
		if (amount === undefined) return undefined;
		return cost as unknown as LlmInvocationCost;
	}
	// Runs written before cost became an object carried a bare provider-reported number.
	const legacy = isRecord(json.tokenUsage) ? toNumber(json.tokenUsage.cost) : undefined;
	if (legacy !== undefined) return { amount: legacy, currency: 'USD', source: 'provider' };
	return undefined;
}

/**
 * Reads the usage one LLM run item persisted (`json.tokenUsage` for provider-reported
 * counts, `json.tokenUsageEstimate` for estimates, `json.cost` for the priced cost).
 */
export function readLlmInvocationUsage(
	item: INodeExecutionData | null | undefined,
): LlmInvocationUsage | undefined {
	const json = item?.json;
	if (!isRecord(json)) return undefined;

	const actual = readTokenCounts(json.tokenUsage);
	if (actual) return { tokens: actual, isEstimate: false, cost: readCost(json) };

	const estimate = readTokenCounts(json.tokenUsageEstimate);
	if (estimate) return { tokens: estimate, isEstimate: true };

	return undefined;
}

function summarizeInvocation(usage: LlmInvocationUsage | undefined): LlmUsageSummary {
	const summary = emptyLlmUsageSummary();
	summary.invocations = 1;
	if (!usage) {
		summary.tokensComplete = false;
		summary.costComplete = false;
		return summary;
	}
	summary.tokens = {
		promptTokens: usage.tokens.promptTokens,
		completionTokens: usage.tokens.completionTokens,
		totalTokens: usage.tokens.totalTokens,
		cacheReadTokens: usage.tokens.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.tokens.cacheWriteTokens ?? 0,
		reasoningTokens: usage.tokens.reasoningTokens ?? 0,
	};
	summary.tokensEstimated = usage.isEstimate;
	if (usage.cost) {
		summary.cost = { amount: usage.cost.amount, currency: 'USD' };
	} else {
		summary.costComplete = false;
	}
	return summary;
}

/** Sums the usage of every LLM invocation an LLM sub-node run carries. */
export function summarizeLlmRun(task: ITaskData): LlmUsageSummary {
	const branches = task.data?.[NodeConnectionTypes.AiLanguageModel] ?? [];
	let summary = emptyLlmUsageSummary();
	for (const branch of branches) {
		for (const item of branch ?? []) {
			summary = addLlmUsageSummaries(summary, summarizeInvocation(readLlmInvocationUsage(item)));
		}
	}
	return summary;
}

/**
 * Whether the run belongs to a sub-node (a model, a tool, a sub-agent) rather than to a node
 * of the main flow. Sub-node runs store their output under their connection type; only a
 * main-flow run has a `main` output. A main-flow successor also points to the run that
 * produced its input through `source`, so this is what keeps it out of that run's subtree.
 */
function isSubNodeRun(task: ITaskData): boolean {
	return task.data !== undefined && task.data[NodeConnectionTypes.Main] === undefined;
}

function isChildRunOf(task: ITaskData, nodeName: string, runIndex: number): boolean {
	const source = task.source?.[0];
	return (
		source?.previousNode === nodeName &&
		(source.previousNodeRun ?? 0) === runIndex &&
		// Every LLM run is stored with output data; an errored run has none to count.
		isSubNodeRun(task)
	);
}

/**
 * Computes `own`, `subagents` and `total` for one run of a node from the runs that hang
 * below it in `runData`. Bottom-up by construction: an LLM run counts once toward the `own`
 * of the single run it points to through `source`; a descendant that already published its
 * own aggregate (a sub-agent) contributes only its `total`, so its subtree is never walked
 * again and no invocation is counted twice, whatever the depth of the tree.
 *
 * A child reached through the model connection (an LLM run, or a model selector that
 * published an aggregate) is the node's own model usage; any other child that published an
 * aggregate is a sub-agent.
 */
export function aggregateLlmUsage(
	runData: IRunData,
	nodeName: string,
	runIndex: number,
): LlmUsageAggregate {
	let own = emptyLlmUsageSummary();
	let subagents = emptyLlmUsageSummary();

	for (const childName of Object.keys(runData)) {
		for (const task of runData[childName] ?? []) {
			if (!task || !isChildRunOf(task, nodeName, runIndex)) continue;

			const published = task.metadata?.llmUsage;
			if (task.data?.[NodeConnectionTypes.AiLanguageModel] !== undefined) {
				own = addLlmUsageSummaries(own, published ? published.total : summarizeLlmRun(task));
			} else if (published) {
				subagents = addLlmUsageSummaries(subagents, published.total);
			}
		}
	}

	return { own, subagents, total: addLlmUsageSummaries(own, subagents) };
}

/**
 * LLM usage of a whole execution, from the aggregates the engine published on its runs.
 * A run whose parent run (through `source`) published an aggregate is already inside that
 * aggregate, so only the top-most aggregated runs are summed and nothing is counted twice.
 * A parent execution uses this to fold a sub-workflow's usage into the run that started it.
 */
export function summarizeExecutionLlmUsage(runData: IRunData): LlmUsageSummary {
	let summary = emptyLlmUsageSummary();

	for (const nodeName of Object.keys(runData)) {
		for (const task of runData[nodeName] ?? []) {
			const published = task?.metadata?.llmUsage;
			if (!published) continue;

			const source = task.source?.[0];
			const parentRun = source
				? runData[source.previousNode]?.[source.previousNodeRun ?? 0]
				: undefined;
			if (isSubNodeRun(task) && parentRun?.metadata?.llmUsage) continue;

			summary = addLlmUsageSummaries(summary, published.total);
		}
	}

	return summary;
}

/** The aggregate a run publishes for usage that happened entirely below it (a sub-workflow). */
export function llmUsageAggregateFromSubtree(subtree: LlmUsageSummary): LlmUsageAggregate {
	return { own: emptyLlmUsageSummary(), subagents: subtree, total: subtree };
}
