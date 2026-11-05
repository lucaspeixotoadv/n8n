import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { N8nChatVertexAI } from '../n8n-chat-vertex-ai';

type GeminiRequest = {
	contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
	tools?: Array<{ functionDeclarations: Array<{ parameters: unknown }> }>;
};

function createModel() {
	const model = new N8nChatVertexAI({
		model: 'gemini-3-flash-preview',
		authOptions: {
			projectId: 'test-project',
			credentials: { client_email: 'test@example.com', private_key: 'test-key' },
		},
	});
	const request = vi.fn(async () => ({
		data: {
			candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }],
		},
	}));
	// The HTTP client of the connection sends the request to Vertex AI
	(
		model as unknown as { connection: { client: { request: typeof request } } }
	).connection.client.request = request;

	const sentRequest = () => {
		const [options] = request.mock.calls[0] as unknown as [{ data: GeminiRequest }];
		return options.data;
	};
	return { model, sentRequest };
}

describe('N8nChatVertexAI', () => {
	describe('history from another provider', () => {
		// The turn of an Anthropic fallback model, as the agent replays it
		const history = [
			new HumanMessage('Open case 1'),
			new AIMessage({
				content: [
					{ type: 'thinking', thinking: 'I need the case.', signature: 'anthropic-signature' },
					{ type: 'text', text: 'Looking up the case.' },
					{ type: 'tool_use', id: 'toolu_1', name: 'getCase', input: { caseId: '1' } },
				],
				response_metadata: { model_provider: 'anthropic' },
			}),
			new ToolMessage({ content: 'case 1', tool_call_id: 'toolu_1', name: 'getCase' }),
		];

		it('should send the text and the tool call of the turn, without the reasoning', async () => {
			const { model, sentRequest } = createModel();

			await model.invoke(history);

			expect(sentRequest().contents[1]).toEqual({
				role: 'model',
				parts: [
					{ text: 'Looking up the case.' },
					{
						functionCall: { name: 'getCase', args: { caseId: '1' } },
						thoughtSignature: 'skip_thought_signature_validator',
					},
				],
			});
		});
	});

	describe('function declarations', () => {
		it('should accept a union schema and give an items schema to each array', async () => {
			const { model, sentRequest } = createModel();
			// An object or a list of any values, as the MCP client gets it for a $fromAI json argument
			const tool = new DynamicStructuredTool({
				name: 'search',
				description: 'Search cases',
				schema: z.object({ types: z.union([z.record(z.any()), z.array(z.any())]) }),
				func: async () => '',
			});

			await model.bindTools([tool]).invoke('Search');

			expect(sentRequest().tools?.[0].functionDeclarations[0].parameters).toMatchObject({
				properties: { types: { anyOf: [{ type: 'object' }, { type: 'array', items: {} }] } },
			});
		});
	});
});
