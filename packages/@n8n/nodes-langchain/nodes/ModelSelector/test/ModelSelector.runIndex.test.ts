import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { N8nLlmTracing } from '@n8n/ai-utilities';
import type { INode, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { ModelSelector } from '../ModelSelector.node';

vi.mock('@n8n/ai-utilities', async () => {
	const actual = await vi.importActual<typeof import('@n8n/ai-utilities')>('@n8n/ai-utilities');
	return {
		...actual,
		// keep the tracer real but skip the tokenizer, which is not what is under test
		estimateTokensFromStringList: vi.fn().mockResolvedValue(0),
	};
});

const serializedModel: Serialized = {
	lc: 1,
	type: 'constructor',
	id: ['langchain', 'chat_models', 'openai'],
	kwargs: { model: 'gpt-4o' },
};

type Handler = {
	handleLLMStart: (llm: Serialized, prompts: string[], runId: string) => Promise<void>;
	handleLLMEnd: (output: unknown, runId: string) => Promise<void>;
};

describe('ModelSelector run attribution', () => {
	it('points every model run to the selector run of the same invocation, whatever ran before', async () => {
		// The selector already logged 2 runs, the model already logged 5 (earlier agent runs)
		let selectorRuns = 2;
		let modelRuns = 5;
		const selectorContext = mock<ISupplyDataFunctions>();
		selectorContext.getNode.mockReturnValue({ name: 'Selector', parameters: {} } as INode);
		selectorContext.getNextRunIndex.mockImplementation(() => selectorRuns);
		selectorContext.addInputData.mockImplementation(() => ({ index: selectorRuns++ }));
		const modelContext = mock<ISupplyDataFunctions>();
		modelContext.getNode.mockReturnValue({ name: 'Model', type: 'test' } as INode);
		modelContext.getNextRunIndex.mockImplementation(() => modelRuns);
		modelContext.addInputData.mockImplementation(() => ({ index: modelRuns++ }));
		const model = {
			_llmType: () => 'fake',
			callbacks: [new N8nLlmTracing(modelContext)],
		} as unknown as BaseChatModel;
		selectorContext.getInputConnectionData.mockResolvedValue([model]);
		selectorContext.getNodeParameter
			.mockReturnValueOnce([{ modelIndex: '1', conditions: {} }])
			.mockReturnValueOnce(true);

		const { response } = await new ModelSelector().supplyData.call(selectorContext, 0);
		const handlers = (response as BaseChatModel).callbacks as unknown as Handler[];

		// LangChain starts every handler for the same run id (concurrently)
		for (const runId of ['run-a', 'run-b']) {
			await Promise.all(
				handlers.map(async (h) => await h.handleLLMStart(serializedModel, ['hi'], runId)),
			);
			await Promise.all(
				handlers.map(
					async (h) =>
						await h.handleLLMEnd(
							{
								generations: [[{ text: 'ok' }]],
								llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1 } },
							},
							runId,
						),
				),
			);
		}

		// Selector runs 2 and 3 opened; model runs 5 and 6 point to exactly those
		expect(modelContext.addInputData).toHaveBeenNthCalledWith(
			1,
			NodeConnectionTypes.AiLanguageModel,
			expect.any(Array),
			2,
		);
		expect(modelContext.addInputData).toHaveBeenNthCalledWith(
			2,
			NodeConnectionTypes.AiLanguageModel,
			expect.any(Array),
			3,
		);
		expect(modelContext.addOutputData).toHaveBeenNthCalledWith(
			1,
			NodeConnectionTypes.AiLanguageModel,
			5,
			expect.any(Array),
			undefined,
			2,
		);
		expect(modelContext.addOutputData).toHaveBeenNthCalledWith(
			2,
			NodeConnectionTypes.AiLanguageModel,
			6,
			expect.any(Array),
			undefined,
			3,
		);
	});
});
