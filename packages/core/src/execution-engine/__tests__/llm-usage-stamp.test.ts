import type { IRunData, ITaskData, Workflow } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { stampLlmUsage } from '../llm-usage-stamp';

const task = (extra: Partial<ITaskData> = {}): ITaskData => ({
	startTime: 0,
	executionTime: 0,
	executionIndex: 0,
	source: [],
	...extra,
});

const llmRun = (parent: string, parentRun: number, promptTokens: number): ITaskData =>
	task({
		source: [{ previousNode: parent, previousNodeRun: parentRun }],
		data: {
			[NodeConnectionTypes.AiLanguageModel]: [
				[
					{
						json: { tokenUsage: { promptTokens, completionTokens: 0, totalTokens: promptTokens } },
					},
				],
			],
		},
	});

describe('stampLlmUsage', () => {
	const workflow = mock<Workflow>({
		connectionsByDestinationNode: {
			Agent: { main: [], [NodeConnectionTypes.AiLanguageModel]: [] },
			'Plain Node': { main: [] },
		},
	});

	it('publishes own, subagents and total on the run of a node with LLM usage below it', () => {
		const runData: IRunData = {
			Model: [llmRun('Agent', 0, 40)],
			'Sub Agent': [
				task({
					source: [{ previousNode: 'Agent', previousNodeRun: 0 }],
					data: { [NodeConnectionTypes.AiTool]: [[{ json: {} }]] },
					metadata: {
						llmUsage: {
							own: summary(30),
							subagents: summary(0),
							total: summary(30),
						},
					},
				}),
			],
		};
		const taskData = task({ metadata: { tracing: { 'ai.agent.version': 'v3' } } });

		stampLlmUsage(workflow, runData, 'Agent', 0, taskData);

		expect(taskData.metadata?.tracing).toEqual({ 'ai.agent.version': 'v3' });
		expect(taskData.metadata?.llmUsage?.own.tokens.totalTokens).toBe(40);
		expect(taskData.metadata?.llmUsage?.subagents.tokens.totalTokens).toBe(30);
		expect(taskData.metadata?.llmUsage?.total.tokens.totalTokens).toBe(70);
	});

	it('leaves a run without LLM usage below it untouched', () => {
		const taskData = task();

		stampLlmUsage(workflow, { Model: [llmRun('Other', 0, 40)] }, 'Agent', 0, taskData);

		expect(taskData.metadata).toBeUndefined();
	});

	it('skips nodes that have no sub-node inputs without scanning the run data', () => {
		const taskData = task();
		const runData = { Model: [llmRun('Plain Node', 0, 40)] };

		stampLlmUsage(workflow, runData, 'Plain Node', 0, taskData);

		expect(taskData.metadata).toBeUndefined();
	});

	it('only reads the runs that point to the given run index', () => {
		const runData: IRunData = { Model: [llmRun('Agent', 0, 10), llmRun('Agent', 1, 20)] };
		const first = task();
		const second = task();

		stampLlmUsage(workflow, runData, 'Agent', 0, first);
		stampLlmUsage(workflow, runData, 'Agent', 1, second);

		expect(first.metadata?.llmUsage?.total.tokens.totalTokens).toBe(10);
		expect(second.metadata?.llmUsage?.total.tokens.totalTokens).toBe(20);
	});
});

function summary(totalTokens: number) {
	return {
		invocations: totalTokens > 0 ? 1 : 0,
		tokens: {
			promptTokens: totalTokens,
			completionTokens: 0,
			totalTokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		},
		tokensEstimated: false,
		tokensComplete: true,
		cost: { amount: 0, currency: 'USD' as const },
		costComplete: totalTokens === 0,
	};
}
