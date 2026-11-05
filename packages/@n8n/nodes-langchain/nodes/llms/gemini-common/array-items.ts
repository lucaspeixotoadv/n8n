/** The parts of a Gemini schema that hold other schemas. */
type Schema = {
	type?: string;
	items?: Schema;
	properties?: Record<string, Schema>;
	anyOf?: Schema[];
};

/**
 * Gives an `items` schema to each array schema that has none.
 *
 * In JSON Schema, an array without `items` accepts items of any type, the same as
 * `items: {}`. The Gemini schema format requires `items` on an array, and the API
 * rejects a function declaration without it. `items: {}` keeps the meaning of the
 * schema.
 */
export function completeArrayItems<S extends Schema>(schema: S): S {
	const { properties, anyOf, items } = schema;
	return {
		...schema,
		...(properties && {
			properties: Object.fromEntries(
				Object.entries(properties).map(([name, property]) => [name, completeArrayItems(property)]),
			),
		}),
		...(anyOf && { anyOf: anyOf.map(completeArrayItems) }),
		...(schema.type === 'array' && { items: items ? completeArrayItems(items) : {} }),
	};
}
