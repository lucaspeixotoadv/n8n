import { describe, it, expect } from 'vitest';
import { NodeConnectionTypes, type INodeTypeDescription } from 'n8n-workflow';

import { getDefaultOnError, isToolNodeType, nodeTypeHasOutput } from './nodeTypeTransforms';

const withOutputs = (outputs: INodeTypeDescription['outputs']) => ({ outputs });

describe('nodeTypeHasOutput', () => {
	it('finds a type in a list of output types', () => {
		expect(nodeTypeHasOutput(withOutputs(['main', 'ai_tool']), NodeConnectionTypes.AiTool)).toBe(
			true,
		);
		expect(nodeTypeHasOutput(withOutputs(['main']), NodeConnectionTypes.AiTool)).toBe(false);
	});

	it('finds a type in a list of output configurations', () => {
		expect(
			nodeTypeHasOutput(
				withOutputs([{ type: NodeConnectionTypes.AiTool, displayName: 'Tool' }]),
				NodeConnectionTypes.AiTool,
			),
		).toBe(true);
	});

	it('finds a type named by an outputs expression', () => {
		const outputs = "={{ $parameter.mode === 'retrieve-as-tool' ? ['ai_tool'] : ['main'] }}";

		expect(nodeTypeHasOutput(withOutputs(outputs), NodeConnectionTypes.AiTool)).toBe(true);
		expect(nodeTypeHasOutput(withOutputs(outputs), NodeConnectionTypes.AiLanguageModel)).toBe(
			false,
		);
	});

	it('finds nothing on a missing node type', () => {
		expect(nodeTypeHasOutput(null, NodeConnectionTypes.AiTool)).toBe(false);
		expect(nodeTypeHasOutput(undefined, NodeConnectionTypes.AiTool)).toBe(false);
	});
});

describe('isToolNodeType', () => {
	it('is true only for a type with an ai_tool output', () => {
		expect(isToolNodeType(withOutputs(['ai_tool']))).toBe(true);
		expect(isToolNodeType(withOutputs(['ai_languageModel']))).toBe(false);
		expect(isToolNodeType(null)).toBe(false);
	});
});

describe('getDefaultOnError', () => {
	it('continues for a tool and stops for every other node', () => {
		expect(getDefaultOnError(true)).toBe('continueRegularOutput');
		expect(getDefaultOnError(false)).toBe('stopWorkflow');
	});
});
