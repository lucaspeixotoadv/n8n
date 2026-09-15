import type {
	IExecuteSingleFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeProperties,
	IRequestOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { credentialFields, credentialOperations } from '../CredentialDescription';
import { getCredentialFields, toCredentialFields } from '../CredentialFields';
import { searchCredentials } from '../CredentialLocator';
import { prepareCredentialUpdateBody } from '../GenericFunctions';
import { N8n } from '../N8n.node';

const node = mock<INode>({ name: 'n8n', type: 'n8n-nodes-base.n8n' });

type RequestWithAuthentication = ILoadOptionsFunctions['helpers']['requestWithAuthentication'];

/** A load-options context whose only outbound channel is the authenticated request helper. */
const loadOptionsContext = (requestWithAuthentication: RequestWithAuthentication) => {
	const context = mock<ILoadOptionsFunctions>({
		helpers: mock<ILoadOptionsFunctions['helpers']>({ requestWithAuthentication }),
	});
	context.getNode.mockReturnValue(node);
	context.getCredentials.mockResolvedValue({
		apiKey: 'key123',
		baseUrl: 'https://test.app.n8n.cloud/api/v1',
	});
	return context;
};

/** The mapper as the node receives it at runtime, after expressions are resolved. */
const mapper = (value: Record<string, unknown> | null) => ({
	mappingMode: 'defineBelow',
	value,
	matchingColumns: [],
	schema: [],
	attemptToConvertTypes: false,
	convertFieldsToString: false,
});

describe('n8n node: Credential → Update', () => {
	describe('prepareCredentialUpdateBody', () => {
		const run = async (value: Record<string, unknown> | null) => {
			const context = mock<IExecuteSingleFunctions>();
			context.getNode.mockReturnValue(node);
			context.getNodeParameter.mockReturnValue(mapper(value));
			const requestOptions: IHttpRequestOptions = { url: '', body: { name: 'kept' } };
			return await prepareCredentialUpdateBody.call(context, requestOptions);
		};

		it('sends a set field and always marks the update as partial', async () => {
			const { body } = await run({ apiKey: 'sk-new' });

			expect(body).toEqual({ name: 'kept', data: { apiKey: 'sk-new' }, isPartialData: true });
		});

		it('does not send a field that was removed from the mapper', async () => {
			const { body } = await run({ apiKey: 'sk-new' });

			expect((body as { data: object }).data).not.toHaveProperty('baseURL');
		});

		it('sends an empty string when an expression resolves to ""', async () => {
			const { body } = await run({ apiKey: 'sk-new', organization: '' });

			expect((body as { data: object }).data).toEqual({ apiKey: 'sk-new', organization: '' });
		});

		it('omits a field whose expression resolves to undefined', async () => {
			const { body } = await run({ apiKey: 'sk-new', organization: undefined });

			expect((body as { data: object }).data).toEqual({ apiKey: 'sk-new' });
		});

		it('fails when an expression resolves to null instead of converting it', async () => {
			const failure = run({ apiKey: 'sk-new', organization: null });

			await expect(failure).rejects.toThrow(NodeOperationError);
			await expect(failure).rejects.toThrow('The credential field "organization" resolved to null');
		});

		it('sends numbers and booleans as they are', async () => {
			const { body } = await run({ port: 5432, ssl: true });

			expect((body as { data: object }).data).toEqual({ port: 5432, ssl: true });
		});

		it('fails when no field is set', async () => {
			await expect(run({})).rejects.toThrow('Set at least one credential field to update');
			await expect(run(null)).rejects.toThrow('Set at least one credential field to update');
		});
	});

	describe('getCredentialFields', () => {
		const schema = {
			additionalProperties: false,
			type: 'object',
			properties: {
				apiKey: { type: 'string' },
				baseURL: { type: 'string' },
				region: { type: 'string', enum: ['eu', 'us'] },
				port: { type: 'number' },
				ssl: { type: 'boolean' },
				notice: { type: 'notice' },
				options: { type: 'collection' },
				oauthTokenData: { type: 'json' },
			},
			required: ['apiKey'],
		};
		const localProperties: INodeProperties[] = [
			{
				displayName: 'API Key',
				name: 'apiKey',
				type: 'string',
				typeOptions: { password: true },
				default: '',
			},
			{
				displayName: 'Region',
				name: 'region',
				type: 'options',
				default: 'eu',
				options: [
					{ name: 'Europe', value: 'eu' },
					{ name: 'United States', value: 'us' },
				],
			},
		];

		const setup = (credentialId: string | undefined, localTypeKnown = true) => {
			const requests: IRequestOptions[] = [];
			const requestWithAuthentication = vi.fn<RequestWithAuthentication>(
				async (_credentialsType, options) => {
					requests.push(options);
					if (options.uri?.endsWith('/credentials/42')) {
						return { id: '42', name: 'Prod', type: 'acmeApi' };
					}
					if (options.uri?.endsWith('/credentials/schema/acmeApi')) {
						return schema;
					}
					throw new Error(`Unexpected request ${options.uri}`);
				},
			);
			const context = loadOptionsContext(requestWithAuthentication);
			context.getNodeParameter.mockReturnValue(credentialId);
			if (localTypeKnown) {
				context.getCredentialsProperties.mockReturnValue(localProperties);
			} else {
				context.getCredentialsProperties.mockImplementation(() => {
					throw new Error('Unknown credential type');
				});
			}
			return { context, requests };
		};

		it('resolves the credential type and its schema without ever requesting the data', async () => {
			const { context, requests } = setup('42');

			await getCredentialFields.call(context);

			expect(context.getNodeParameter.mock.calls).toEqual([
				['credentialId', undefined, { extractValue: true }],
			]);
			expect(requests.map(({ method, uri, qs }) => ({ method, uri, qs }))).toEqual([
				{ method: 'GET', uri: 'https://test.app.n8n.cloud/api/v1/credentials/42', qs: {} },
				{
					method: 'GET',
					uri: 'https://test.app.n8n.cloud/api/v1/credentials/schema/acmeApi',
					qs: {},
				},
			]);
		});

		it('maps the schema to optional, empty fields labelled from the local type', async () => {
			const { context } = setup('42');

			const { fields } = await getCredentialFields.call(context);

			// [id, label, type]: notices, collections and the server-owned oauthTokenData are left out
			expect(fields.map(({ id, displayName, type }) => [id, displayName, type])).toEqual([
				['apiKey', 'API Key', 'string'],
				['baseURL', 'baseURL', 'string'],
				['region', 'Region', 'options'],
				['port', 'port', 'number'],
				['ssl', 'ssl', 'boolean'],
			]);
			expect(fields.find((field) => field.id === 'region')?.options).toEqual([
				{ name: 'Europe', value: 'eu' },
				{ name: 'United States', value: 'us' },
			]);
			// Every field is optional, cannot be matched on, and starts empty
			for (const field of fields) {
				expect(field).toMatchObject({
					required: false,
					defaultMatch: false,
					canBeUsedToMatch: false,
					display: true,
				});
				expect(field.defaultValue).toBeUndefined();
			}
		});

		it('falls back to property names when the type is not installed locally', async () => {
			const { context } = setup('42', false);

			const { fields } = await getCredentialFields.call(context);

			expect(fields.map((field) => field.displayName)).toEqual(fields.map((field) => field.id));
			// Without local labels the option value doubles as its label
			expect(fields.find((field) => field.id === 'region')?.options).toEqual(
				['eu', 'us'].map((value) => ({ name: value, value })),
			);
		});

		it('loads nothing until a credential is selected', async () => {
			const { context, requests } = setup('');

			const result = await getCredentialFields.call(context);

			expect(result.fields).toEqual([]);
			expect(result.emptyFieldsNotice).toBeDefined();
			expect(requests).toEqual([]);
		});

		it('explains when the type has no editable field', () => {
			expect(toCredentialFields({ properties: { notice: { type: 'notice' } } })).toEqual([]);
		});
	});

	describe('searchCredentials', () => {
		it('lists credentials by name and type, filtered by the query', async () => {
			const context = loadOptionsContext(
				vi.fn<RequestWithAuthentication>(async () => ({
					data: [
						{ id: '2', name: 'Slack Bot', type: 'slackApi' },
						{ id: '1', name: 'OpenAI Prod', type: 'openAiApi' },
						{ id: '3', name: 'OpenAI Dev', type: 'openAiApi' },
					],
				})),
			);

			expect(await searchCredentials.call(context, 'openai')).toEqual({
				results: [
					{ name: 'OpenAI Dev (openAiApi)', value: '3' },
					{ name: 'OpenAI Prod (openAiApi)', value: '1' },
				],
			});
			expect(await searchCredentials.call(context, '2')).toEqual({
				results: [{ name: 'Slack Bot (slackApi)', value: '2' }],
			});
		});
	});

	describe('node definition', () => {
		const operation = credentialOperations[0].options as Array<{
			value: string;
			routing?: unknown;
		}>;
		const updateFields = credentialFields.filter((field) =>
			field.displayOptions?.show?.operation?.includes('update'),
		);

		it('offers the update operation and routes it through the credential locator', () => {
			expect(operation.find((option) => option.value === 'update')).toBeDefined();
			expect(updateFields.map((field) => field.name)).toEqual(['credentialId', 'credentialData']);

			const [credentialId, credentialData] = updateFields;
			expect(credentialId.type).toBe('resourceLocator');
			expect(credentialId.routing).toEqual({
				request: { method: 'PATCH', url: '=/credentials/{{ $value }}' },
			});
			expect(credentialData.type).toBe('resourceMapper');
			expect(credentialData.typeOptions?.loadOptionsDependsOn).toEqual(['credentialId.value']);
			expect(credentialData.typeOptions?.resourceMapper).toMatchObject({
				resourceMapperMethod: 'getCredentialFields',
				mode: 'map',
				addAllFields: true,
				supportAutoMap: false,
			});
			expect(credentialData.typeOptions?.resourceMapper).not.toHaveProperty('allowEmptyValues');
			expect(credentialData.routing?.send?.preSend).toEqual([prepareCredentialUpdateBody]);
		});

		it('registers the search and field loading methods', () => {
			const { methods } = new N8n();

			expect(methods.listSearch.searchCredentials).toBe(searchCredentials);
			expect(methods.resourceMapping.getCredentialFields).toBe(getCredentialFields);
		});
	});
});
