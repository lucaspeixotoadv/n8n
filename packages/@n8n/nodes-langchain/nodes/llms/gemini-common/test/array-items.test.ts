import { completeArrayItems } from '../array-items';

describe('completeArrayItems', () => {
	it('gives an empty items schema to an array schema without one', () => {
		expect(
			completeArrayItems({
				type: 'object',
				properties: {
					types: { anyOf: [{ type: 'object' }, { type: 'array' }] },
					matrix: { type: 'array', items: { type: 'array' } },
				},
			}),
		).toEqual({
			type: 'object',
			properties: {
				types: { anyOf: [{ type: 'object' }, { type: 'array', items: {} }] },
				matrix: { type: 'array', items: { type: 'array', items: {} } },
			},
		});
	});

	it('keeps the items schema of an array', () => {
		const schema = { type: 'array', items: { type: 'string' }, description: 'Tags' };

		expect(completeArrayItems(schema)).toEqual(schema);
	});
});
