import { createDeferredPromise } from '@n8n/utils/promise/deferred-promise';
import type { INodeTypeData, IRun, ITaskData } from 'n8n-workflow';
import { NodeConnectionTypes, Workflow } from 'n8n-workflow';

import * as Helpers from '@test/helpers';

import { createNodeData } from '../partial-execution-utils/__tests__/helpers';
import { WorkflowExecute } from '../workflow-execute';

/** A root node with a model input and a model sub-node, enough for the engine to see a sub-node tree. */
const nodeTypes: INodeTypeData = {
	'test.agent': {
		sourcePath: '',
		type: {
			description: {
				displayName: 'Test agent',
				name: 'testAgent',
				group: ['transform'],
				version: 1,
				description: '',
				defaults: { name: 'Agent' },
				inputs: [NodeConnectionTypes.Main, NodeConnectionTypes.AiLanguageModel],
				outputs: [NodeConnectionTypes.Main],
				properties: [],
			},
		},
	},
	'test.model': {
		sourcePath: '',
		type: {
			description: {
				displayName: 'Test model',
				name: 'testModel',
				group: ['transform'],
				version: 1,
				description: '',
				defaults: { name: 'Model' },
				inputs: [],
				outputs: [NodeConnectionTypes.AiLanguageModel],
				properties: [],
			},
		},
	},
};

describe('WorkflowExecute LLM usage publication', () => {
	it('publishes own, subagents and total on the run of a root node once its sub-nodes ran', async () => {
		const agent = { ...createNodeData({ name: 'Agent' }), type: 'test.agent' };
		const model = { ...createNodeData({ name: 'Model' }), type: 'test.model' };
		const workflow = new Workflow({
			id: 'test',
			nodes: [agent, model],
			connections: {
				Model: {
					[NodeConnectionTypes.AiLanguageModel]: [
						[{ node: 'Agent', type: NodeConnectionTypes.AiLanguageModel, index: 0 }],
					],
				},
			},
			active: false,
			nodeTypes: Helpers.NodeTypes(nodeTypes),
		});
		const waitPromise = createDeferredPromise<IRun>();
		const additionalData = Helpers.WorkflowExecuteAdditionalData(waitPromise);
		const workflowExecute = new WorkflowExecute(additionalData, 'manual');

		// Stand in for the model sub-node: while the agent runs, its model logs one invocation
		// pointing to this run of the agent, exactly as N8nLlmTracing does.
		vi.spyOn(workflowExecute, 'runNode').mockImplementation(
			async (_workflow, _executionData, runExecutionData, runIndex) => {
				const llmRun: ITaskData = {
					startTime: 0,
					executionTime: 0,
					executionIndex: 1,
					executionStatus: 'success',
					source: [{ previousNode: 'Agent', previousNodeRun: runIndex }],
					data: {
						[NodeConnectionTypes.AiLanguageModel]: [
							[
								{
									json: {
										tokenUsage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
										cost: { amount: 0.003, currency: 'USD', source: 'catalog' },
									},
								},
							],
						],
					},
				};
				runExecutionData.resultData.runData.Model = [llmRun];
				return { data: [[{ json: { output: 'done' } }]] };
			},
		);

		await workflowExecute.run({ workflow, startNode: agent });
		const result = await waitPromise.promise;

		const agentRun = result.data.resultData.runData.Agent[0];
		expect(agentRun.metadata?.llmUsage).toMatchObject({
			own: { invocations: 1, tokens: { totalTokens: 150 }, cost: { amount: 0.003 } },
			subagents: { invocations: 0 },
			total: { invocations: 1, tokens: { totalTokens: 150 }, costComplete: true },
		});
		// The model run itself carries no aggregate: it is a leaf, not an agent
		expect(result.data.resultData.runData.Model[0].metadata?.llmUsage).toBeUndefined();
	});
});
