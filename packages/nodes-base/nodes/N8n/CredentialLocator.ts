import type { ILoadOptionsFunctions, INodeListSearchResult, INodeProperties } from 'n8n-workflow';

import { apiRequestAllItems } from './GenericFunctions';

/** The subset of `GET /credentials` list items the locator needs. Secrets are never part of it. */
interface CredentialListItem {
	id: string;
	name: string;
	type: string;
}

/**
 * A helper to populate credential lists. It lists the credentials the API key
 * can see and matches them against the specified query by name, type or id.
 */
export async function searchCredentials(
	this: ILoadOptionsFunctions,
	query?: string,
): Promise<INodeListSearchResult> {
	const credentials = (await apiRequestAllItems.call(
		this,
		'GET',
		'credentials',
		{},
	)) as CredentialListItem[];

	const lowerCaseQuery = query?.toLowerCase();
	const results = credentials
		.map((credential) => ({
			name: `${credential.name} (${credential.type})`,
			value: credential.id,
		}))
		.filter(
			(credential) =>
				!lowerCaseQuery ||
				credential.name.toLowerCase().includes(lowerCaseQuery) ||
				credential.value === query,
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	return { results };
}

/**
 * A resourceLocator to pick an existing credential by list or by ID.
 * The routing must be set where the property is used, see WorkflowLocator.
 */
export const credentialIdLocator: INodeProperties = {
	displayName: 'Credential',
	name: 'credentialId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	description: 'The credential to update. Its stored values are never loaded into the node.',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select a Credential...',
			typeOptions: {
				searchListMethod: 'searchCredentials',
				searchFilterRequired: false,
				searchable: true,
			},
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '[0-9a-zA-Z]{1,}',
						errorMessage: 'Not a valid Credential ID',
					},
				},
			],
			placeholder: 'e.g. 3',
		},
	],
};
