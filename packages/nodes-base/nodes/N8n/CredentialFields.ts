import type {
	FieldType,
	ILoadOptionsFunctions,
	INodeProperties,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

import { apiRequest } from './GenericFunctions';

/**
 * The JSON Schema returned by `GET /credentials/schema/{type}`. It is built by the
 * Public API from the credential type's own properties, so every key is a property
 * name and `type` is the property type. Hidden properties are never part of it.
 */
export interface CredentialJsonSchema {
	properties?: Record<string, { type?: string; enum?: Array<string | number | boolean> }>;
}

/**
 * Properties the update must never set: the server owns them and writes them itself.
 */
const MANAGED_PROPERTY_NAMES = new Set(['oauthTokenData', 'csrfSecret']);

/**
 * Credential property types the resource mapper can edit. Anything else (notices,
 * collections, hidden values) is left out of the field list.
 */
const FIELD_TYPE_BY_PROPERTY_TYPE: Record<string, FieldType> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	options: 'options',
	multiOptions: 'array',
	json: 'object',
};

function isNodePropertyOptions(
	options: INodeProperties['options'],
): options is INodePropertyOptions[] {
	return Array.isArray(options) && options.every((option) => 'value' in option);
}

/**
 * Turns the credential type schema into resource mapper fields. Every field is optional
 * and has no default: a field the user does not fill in is not sent, so its stored value
 * is kept. The local property definitions, when the type is installed on this instance,
 * only add labels; the schema of the target instance decides which fields exist.
 */
export function toCredentialFields(
	schema: CredentialJsonSchema,
	localProperties: INodeProperties[] = [],
): ResourceMapperField[] {
	const localPropertyByName = new Map(localProperties.map((property) => [property.name, property]));
	const fields: ResourceMapperField[] = [];

	for (const [name, definition] of Object.entries(schema.properties ?? {})) {
		if (MANAGED_PROPERTY_NAMES.has(name)) continue;

		const localProperty = localPropertyByName.get(name);
		const isOptions = definition.enum !== undefined;
		const fieldType = isOptions ? 'options' : FIELD_TYPE_BY_PROPERTY_TYPE[definition.type ?? ''];
		if (fieldType === undefined) continue;

		const field: ResourceMapperField = {
			id: name,
			displayName: localProperty?.displayName ?? name,
			required: false,
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type: fieldType,
		};

		if (isOptions) {
			const localOptions = isNodePropertyOptions(localProperty?.options)
				? localProperty.options
				: [];
			field.options = (definition.enum ?? []).map((value) => ({
				name: localOptions.find((option) => option.value === value)?.name ?? String(value),
				value,
			}));
		}

		fields.push(field);
	}

	return fields;
}

/**
 * The property definitions of the credential type on this instance, when it is installed
 * here. The n8n API credential can point at another instance, so a missing type is not an
 * error: the fields then use their property names as labels.
 */
function getLocalCredentialProperties(
	this: ILoadOptionsFunctions,
	credentialType: string,
): INodeProperties[] {
	try {
		return this.getCredentialsProperties(credentialType);
	} catch {
		return [];
	}
}

/**
 * Loads the fields of the selected credential's type for the 'Credential Data' mapper.
 * Only the credential's type and the type's schema are requested: the Public API does not
 * return credential data on any of these endpoints, so stored values never reach the node.
 */
export async function getCredentialFields(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const credentialId = this.getNodeParameter('credentialId', undefined, {
		extractValue: true,
	}) as string | undefined;

	if (!credentialId) {
		return { fields: [], emptyFieldsNotice: 'Select a credential to load its fields' };
	}

	const credential = (await apiRequest.call(this, 'GET', `credentials/${credentialId}`, {})) as {
		type: string;
	};
	const schema = (await apiRequest.call(
		this,
		'GET',
		`credentials/schema/${credential.type}`,
		{},
	)) as CredentialJsonSchema;

	const fields = toCredentialFields(
		schema,
		getLocalCredentialProperties.call(this, credential.type),
	);

	if (fields.length === 0) {
		return {
			fields,
			emptyFieldsNotice: `The credential type "${credential.type}" has no fields this operation can update`,
		};
	}

	return { fields };
}
