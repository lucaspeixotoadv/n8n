import { NodeTestHarness } from '@nodes-testing/node-test-harness';
import nock from 'nock';

describe('Test N8n Node: credential update', () => {
	const baseUrl = 'https://test.app.n8n.cloud/api/v1';
	const credentials = {
		n8nApi: {
			apiKey: 'key123',
			baseUrl,
		},
	};

	beforeAll(async () => {
		const { pinData } = await import('./workflow.n8n.credentialUpdate.json');
		const [updated] = pinData.n8n.map((item) => item.json);
		// The body matcher is exact: the removed field and the field whose expression
		// resolved to undefined must not be sent, the empty expression result must be.
		nock(baseUrl)
			.patch('/credentials/42', { data: { apiKey: 'sk-new', baseURL: '' }, isPartialData: true })
			.reply(200, updated);
	});

	new NodeTestHarness().setupTests({
		credentials,
		workflowFiles: ['workflow.n8n.credentialUpdate.json'],
	});
});
