import type { INodeProperties } from 'n8n-workflow';

import { credentialIdLocator } from './CredentialLocator';
import { parseAndSetBodyJson, prepareCredentialUpdateBody } from './GenericFunctions';

export const credentialOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'create',
		displayOptions: {
			show: {
				resource: ['credential'],
			},
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a credential',
				routing: {
					request: {
						method: 'POST',
						url: '/credentials',
					},
				},
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a credential',
				routing: {
					request: {
						method: 'DELETE',
						url: '=/credentials/{{ $parameter.credentialId }}',
					},
				},
			},
			{
				name: 'Get Schema',
				value: 'getSchema',
				action: 'Get credential data schema for type',
				routing: {
					request: {
						method: 'GET',
						url: '=/credentials/schema/{{ $parameter.credentialTypeName }}',
					},
				},
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a credential',
				// The routing lives on the credential resourceLocator, see updateOperation.
			},
		],
	},
];

const createOperation: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		placeholder: 'e.g. n8n account',
		required: true,
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['create'],
			},
		},
		routing: {
			request: {
				body: {
					name: '={{ $value }}',
				},
			},
		},
		description: 'Name of the new credential',
	},
	{
		displayName: 'Credential Type',
		name: 'credentialTypeName',
		type: 'string',
		placeholder: 'e.g. n8nApi',
		default: '',
		required: true,
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['create'],
			},
		},
		routing: {
			request: {
				body: {
					type: '={{ $value }}',
				},
			},
		},
		description:
			"The available types depend on nodes installed on the n8n instance. Some built-in types include e.g. 'githubApi', 'notionApi', and 'slackApi'.",
	},
	{
		displayName: 'Data',
		name: 'data',
		type: 'json',
		default: '',
		placeholder:
			'// e.g. for n8nApi \n{\n  "apiKey": "my-n8n-api-key",\n  "baseUrl": "https://<name>.app.n8n.cloud/api/v1",\n}',
		required: true,
		typeOptions: {
			alwaysOpenEditWindow: true,
		},
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['create'],
			},
		},
		routing: {
			send: {
				// Validate that the 'data' property is parseable as JSON and
				// set it into the request as body.data.
				preSend: [parseAndSetBodyJson('data', 'data')],
			},
		},
		description:
			"A valid JSON object with properties required for this Credential Type. To see the expected format, you can use 'Get Schema' operation.",
	},
];

const deleteOperation: INodeProperties[] = [
	{
		displayName: 'Credential ID',
		name: 'credentialId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['delete'],
			},
		},
	},
];

const getSchemaOperation: INodeProperties[] = [
	{
		displayName: 'Credential Type',
		name: 'credentialTypeName',
		default: '',
		placeholder: 'e.g. n8nApi',
		required: true,
		type: 'string',
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['getSchema'],
			},
		},
		description:
			"The available types depend on nodes installed on the n8n instance. Some built-in types include e.g. 'githubApi', 'notionApi', and 'slackApi'.",
	},
];

const updateOperation: INodeProperties[] = [
	{
		...credentialIdLocator,
		required: true,
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['update'],
			},
		},
		// The routing for resourceLocator-enabled properties currently needs to
		// happen in the property block where the property itself is defined, or
		// extractValue won't work when used with $parameter in routing.request.url.
		routing: {
			request: {
				method: 'PATCH',
				url: '=/credentials/{{ $value }}',
			},
		},
	},
	{
		displayName: 'Credential Data',
		name: 'credentialData',
		type: 'resourceMapper',
		noDataExpression: true,
		default: {
			mappingMode: 'defineBelow',
			value: null,
		},
		required: true,
		description:
			'Only the fields you set are updated. A field left empty or removed keeps its stored value. The stored values are never loaded into the node.',
		typeOptions: {
			loadOptionsDependsOn: ['credentialId.value'],
			resourceMapper: {
				resourceMapperMethod: 'getCredentialFields',
				mode: 'map',
				valuesLabel: 'Credential Data',
				fieldWords: {
					singular: 'field',
					plural: 'fields',
				},
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		displayOptions: {
			show: {
				resource: ['credential'],
				operation: ['update'],
			},
		},
		routing: {
			send: {
				preSend: [prepareCredentialUpdateBody],
			},
		},
	},
];

export const credentialFields: INodeProperties[] = [
	...createOperation,
	...deleteOperation,
	...getSchemaOperation,
	...updateOperation,
];
