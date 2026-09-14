import type { IRunData, ITaskData } from '../src/interfaces';
import { NodeConnectionTypes } from '../src/interfaces';
import {
	aggregateLlmUsage,
	emptyLlmUsageSummary,
	readLlmInvocationUsage,
	type LlmInvocationCost,
	type LlmTokenCounts,
	type LlmUsageAggregate,
} from '../src/llm-usage';

const baseTask = (): Omit<ITaskData, 'source'> => ({
	startTime: 0,
	executionTime: 0,
	executionIndex: 0,
	executionStatus: 'success',
});

function llmRun(
	parent: string,
	parentRun: number,
	usage: Partial<LlmTokenCounts> & { estimate?: boolean; cost?: number | LlmInvocationCost },
): ITaskData {
	const tokens: LlmTokenCounts = {
		promptTokens: usage.promptTokens ?? 0,
		completionTokens: usage.completionTokens ?? 0,
		totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
		...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
		...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
		...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
	};
	const cost: LlmInvocationCost | undefined =
		typeof usage.cost === 'number'
			? { amount: usage.cost, currency: 'USD', source: 'catalog' }
			: usage.cost;
	return {
		...baseTask(),
		source: [{ previousNode: parent, previousNodeRun: parentRun }],
		data: {
			[NodeConnectionTypes.AiLanguageModel]: [
				[
					{
						json: {
							response: {},
							...(usage.estimate ? { tokenUsageEstimate: tokens } : { tokenUsage: tokens }),
							...(cost && { cost }),
						},
					},
				],
			],
		},
	};
}

function toolRun(parent: string, parentRun: number, llmUsage?: LlmUsageAggregate): ITaskData {
	return {
		...baseTask(),
		source: [{ previousNode: parent, previousNodeRun: parentRun }],
		data: { [NodeConnectionTypes.AiTool]: [[{ json: { response: 'ok' } }]] },
		...(llmUsage && { metadata: { llmUsage } }),
	};
}

function agentRun(): ITaskData {
	return { ...baseTask(), source: [{ previousNode: 'Trigger' }], data: { main: [[]] } };
}

describe('readLlmInvocationUsage', () => {
	it('reads provider-reported usage with its breakdowns and cost', () => {
		const usage = readLlmInvocationUsage({
			json: {
				tokenUsage: {
					promptTokens: 100,
					completionTokens: 50,
					totalTokens: 150,
					cacheReadTokens: 40,
					cacheWriteTokens: 10,
					reasoningTokens: 20,
				},
				cost: { amount: 0.5, currency: 'USD', source: 'catalog' },
			},
		});

		expect(usage).toEqual({
			tokens: {
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
				cacheReadTokens: 40,
				cacheWriteTokens: 10,
				reasoningTokens: 20,
			},
			isEstimate: false,
			cost: { amount: 0.5, currency: 'USD', source: 'catalog' },
		});
	});

	it('reads an estimate and never attaches a cost to it', () => {
		const usage = readLlmInvocationUsage({
			json: { tokenUsageEstimate: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
		});

		expect(usage).toEqual({
			tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			isEstimate: true,
		});
	});

	it('maps the legacy Gemini cache field and the legacy bare cost number', () => {
		const usage = readLlmInvocationUsage({
			json: {
				tokenUsage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
					cacheReadInputTokens: 4,
					cost: 0.01,
				},
			},
		});

		expect(usage?.tokens.cacheReadTokens).toBe(4);
		expect(usage?.cost).toEqual({ amount: 0.01, currency: 'USD', source: 'provider' });
	});

	it('returns undefined for an item without usage', () => {
		expect(readLlmInvocationUsage({ json: { response: {} } })).toBeUndefined();
		expect(readLlmInvocationUsage(null)).toBeUndefined();
	});
});

describe('aggregateLlmUsage', () => {
	it('returns empty summaries for a run without LLM descendants', () => {
		const runData: IRunData = { Agent: [agentRun()], Tool: [toolRun('Agent', 0)] };

		const aggregate = aggregateLlmUsage(runData, 'Agent', 0);

		expect(aggregate).toEqual({
			own: emptyLlmUsageSummary(),
			subagents: emptyLlmUsageSummary(),
			total: emptyLlmUsageSummary(),
		});
	});

	it('sums every LLM invocation of the run into own, across iterations, fallback and retries', () => {
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [
				llmRun('Agent', 0, { promptTokens: 100, completionTokens: 10, cost: 0.1 }),
				llmRun('Agent', 0, { promptTokens: 200, completionTokens: 20, cost: 0.2 }),
			],
			'Fallback Model': [llmRun('Agent', 0, { promptTokens: 50, completionTokens: 5, cost: 0.05 })],
			Tool: [toolRun('Agent', 0), toolRun('Agent', 0)],
		};

		const { own, subagents, total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(own.invocations).toBe(3);
		expect(own.tokens.promptTokens).toBe(350);
		expect(own.tokens.completionTokens).toBe(35);
		expect(own.tokens.totalTokens).toBe(385);
		expect(own.cost.amount).toBeCloseTo(0.35);
		expect(own.costComplete).toBe(true);
		expect(subagents).toEqual(emptyLlmUsageSummary());
		expect(total).toEqual(own);
	});

	it('only counts LLM runs that point to this run of the node', () => {
		const runData: IRunData = {
			Agent: [agentRun(), agentRun()],
			Model: [
				llmRun('Agent', 0, { promptTokens: 1, completionTokens: 1 }),
				llmRun('Agent', 1, { promptTokens: 10, completionTokens: 10 }),
				llmRun('Other Agent', 0, { promptTokens: 100, completionTokens: 100 }),
			],
		};

		expect(aggregateLlmUsage(runData, 'Agent', 0).total.tokens.totalTokens).toBe(2);
		expect(aggregateLlmUsage(runData, 'Agent', 1).total.tokens.totalTokens).toBe(20);
	});

	it('keeps cache and reasoning as breakdowns without adding them to the totals', () => {
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [
				llmRun('Agent', 0, {
					promptTokens: 1000,
					completionTokens: 300,
					cacheReadTokens: 600,
					cacheWriteTokens: 100,
					reasoningTokens: 200,
				}),
			],
		};

		const { total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(total.tokens).toEqual({
			promptTokens: 1000,
			completionTokens: 300,
			totalTokens: 1300,
			cacheReadTokens: 600,
			cacheWriteTokens: 100,
			reasoningTokens: 200,
		});
	});

	it('flags estimated usage without marking the tokens incomplete', () => {
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [
				llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5, cost: 0.01 }),
				llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5, estimate: true }),
			],
		};

		const { total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(total.tokensEstimated).toBe(true);
		expect(total.tokensComplete).toBe(true);
		expect(total.tokens.totalTokens).toBe(30);
		// An estimate has no cost, so the monetary aggregate is incomplete while the tokens are not
		expect(total.costComplete).toBe(false);
		expect(total.cost.amount).toBeCloseTo(0.01);
	});

	it('marks tokens incomplete when an invocation reported no usage at all', () => {
		const withoutUsage: ITaskData = {
			...baseTask(),
			source: [{ previousNode: 'Agent', previousNodeRun: 0 }],
			data: { [NodeConnectionTypes.AiLanguageModel]: [[{ json: { response: {} } }]] },
		};
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [
				llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5, cost: 0.01 }),
				withoutUsage,
			],
		};

		const { total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(total.invocations).toBe(2);
		expect(total.tokensComplete).toBe(false);
		expect(total.costComplete).toBe(false);
	});

	it('keeps cost incomplete when a priced and an unpriced invocation are summed', () => {
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [
				llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5, cost: 0.01 }),
				llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5 }),
			],
		};

		const { total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(total.tokensComplete).toBe(true);
		expect(total.costComplete).toBe(false);
		expect(total.cost.amount).toBeCloseTo(0.01);
	});

	it('ignores an errored LLM run, which has no output to count', () => {
		const errored: ITaskData = {
			...baseTask(),
			executionStatus: 'error',
			source: [{ previousNode: 'Agent', previousNodeRun: 0 }],
		};
		const runData: IRunData = {
			Agent: [agentRun()],
			Model: [errored, llmRun('Agent', 0, { promptTokens: 10, completionTokens: 5, cost: 0.01 })],
		};

		const { total } = aggregateLlmUsage(runData, 'Agent', 0);

		expect(total.invocations).toBe(1);
		expect(total.tokensComplete).toBe(true);
	});

	describe('sub-agent trees', () => {
		/**
		 * Builds the runs of a sub-agent invocation: the AgentTool run (pointing to its parent)
		 * with its published aggregate, plus its own LLM run (pointing to the AgentTool run).
		 */
		function subAgent(
			name: string,
			parent: string,
			parentRun: number,
			ownTokens: number,
			children: LlmUsageAggregate[] = [],
		): { runData: IRunData; aggregate: LlmUsageAggregate } {
			const runData: IRunData = {
				[`${name} Model`]: [
					llmRun(name, 0, { promptTokens: ownTokens, completionTokens: 0, cost: ownTokens / 1000 }),
				],
			};
			// The engine computes the child's aggregate when the child's run completes …
			const aggregate = aggregateLlmUsage(
				{
					...runData,
					...Object.fromEntries(
						children.map((child, index) => [`${name} Child ${index}`, [toolRun(name, 0, child)]]),
					),
				},
				name,
				0,
			);
			// … and publishes it on the child's own run, which is what the parent reads.
			runData[name] = [toolRun(parent, parentRun, aggregate)];
			return { runData, aggregate };
		}

		it('composes a three-level chain from the published totals of the direct children only', () => {
			// Agent A (own 400) → SubAgent B (own 300) → SubAgent C (own 200) → SubAgent D (own 100)
			const d = subAgent('D', 'C', 0, 100);
			const c = subAgent('C', 'B', 0, 200, [d.aggregate]);
			const b = subAgent('B', 'A', 0, 300, [c.aggregate]);
			const runData: IRunData = {
				A: [agentRun()],
				'A Model': [llmRun('A', 0, { promptTokens: 400, completionTokens: 0, cost: 0.4 })],
				...b.runData,
				...c.runData,
				...d.runData,
			};

			const a = aggregateLlmUsage(runData, 'A', 0);

			const totals = (aggregate: LlmUsageAggregate) => ({
				own: aggregate.own.tokens.totalTokens,
				subagents: aggregate.subagents.tokens.totalTokens,
				total: aggregate.total.tokens.totalTokens,
			});
			expect(totals(d.aggregate)).toEqual({ own: 100, subagents: 0, total: 100 });
			expect(totals(c.aggregate)).toEqual({ own: 200, subagents: 100, total: 300 });
			expect(totals(b.aggregate)).toEqual({ own: 300, subagents: 300, total: 600 });
			expect(totals(a)).toEqual({ own: 400, subagents: 600, total: 1000 });

			// node.total = node.own + Σ child.total, at every level
			expect(a.total.tokens.totalTokens).toBe(
				a.own.tokens.totalTokens + b.aggregate.total.tokens.totalTokens,
			);
			expect(b.aggregate.total.tokens.totalTokens).toBe(
				b.aggregate.own.tokens.totalTokens + c.aggregate.total.tokens.totalTokens,
			);
			// A.subagents is semantically B + C + D even though A only read B.total
			expect(a.subagents.tokens.totalTokens).toBe(
				b.aggregate.own.tokens.totalTokens +
					c.aggregate.own.tokens.totalTokens +
					d.aggregate.own.tokens.totalTokens,
			);
			// Invocations prove no LLM run was counted twice: exactly one per level
			expect(a.total.invocations).toBe(4);
			expect(a.own.invocations).toBe(1);
			expect(a.subagents.invocations).toBe(3);
			// Cost follows the same rule
			expect(a.total.cost.amount).toBeCloseTo(0.4 + 0.3 + 0.2 + 0.1);
			expect(a.total.costComplete).toBe(true);
		});

		it('sums sibling sub-agents and a sub-agent invoked twice', () => {
			const b1 = subAgent('B1', 'A', 0, 10);
			const b2 = subAgent('B2', 'A', 0, 20);
			const runData: IRunData = {
				A: [agentRun()],
				'A Model': [llmRun('A', 0, { promptTokens: 5, completionTokens: 0, cost: 0.005 })],
				...b1.runData,
				...b2.runData,
			};
			// B1 is called a second time by the same run of A
			runData.B1.push(toolRun('A', 0, b1.aggregate));

			const a = aggregateLlmUsage(runData, 'A', 0);

			expect(a.own.tokens.totalTokens).toBe(5);
			expect(a.subagents.tokens.totalTokens).toBe(10 + 20 + 10);
			expect(a.total.tokens.totalTokens).toBe(45);
		});

		it('propagates an incomplete cost from a deep descendant without touching the tokens', () => {
			const d: IRunData = {
				'D Model': [llmRun('D', 0, { promptTokens: 100, completionTokens: 0 })],
			};
			const dAggregate = aggregateLlmUsage(d, 'D', 0);
			expect(dAggregate.total.costComplete).toBe(false);
			const c = subAgent('C', 'A', 0, 200, [dAggregate]);
			const runData: IRunData = {
				A: [agentRun()],
				'A Model': [llmRun('A', 0, { promptTokens: 400, completionTokens: 0, cost: 0.4 })],
				...c.runData,
			};

			const a = aggregateLlmUsage(runData, 'A', 0);

			expect(a.total.tokensComplete).toBe(true);
			expect(a.total.tokens.totalTokens).toBe(700);
			expect(a.total.costComplete).toBe(false);
			expect(a.own.costComplete).toBe(true);
		});

		it('counts a model reached through a model selector as own usage', () => {
			const selector = aggregateLlmUsage(
				{ Model: [llmRun('Selector', 0, { promptTokens: 30, completionTokens: 0 })] },
				'Selector',
				0,
			);
			const runData: IRunData = {
				Agent: [agentRun()],
				Selector: [
					{
						...baseTask(),
						source: [{ previousNode: 'Agent', previousNodeRun: 0 }],
						data: { [NodeConnectionTypes.AiLanguageModel]: [[{ json: {} }]] },
						metadata: { llmUsage: selector },
					},
				],
				Model: [llmRun('Selector', 0, { promptTokens: 30, completionTokens: 0 })],
			};

			const agent = aggregateLlmUsage(runData, 'Agent', 0);

			expect(agent.own.tokens.totalTokens).toBe(30);
			expect(agent.subagents.invocations).toBe(0);
		});
	});
});
