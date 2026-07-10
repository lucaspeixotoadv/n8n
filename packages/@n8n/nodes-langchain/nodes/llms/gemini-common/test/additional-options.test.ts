import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import { getAdditionalOptions } from '../additional-options';

function findOption(options: ReturnType<typeof getAdditionalOptions>, name: string) {
	return options.options?.find((option) => option.name === name) as INodeProperties | undefined;
}

describe('getAdditionalOptions', () => {
	it('omits Thinking Budget and Thinking Level by default', () => {
		const options = getAdditionalOptions({ supportsThinkingBudget: false });

		expect(findOption(options, 'thinkingBudget')).toBeUndefined();
		expect(findOption(options, 'thinkingLevel')).toBeUndefined();
	});

	it('adds Thinking Budget only when supported', () => {
		const options = getAdditionalOptions({ supportsThinkingBudget: true });

		expect(findOption(options, 'thinkingBudget')).toBeDefined();
		expect(findOption(options, 'thinkingLevel')).toBeUndefined();
	});

	it('adds Thinking Level with the expected values when supported', () => {
		const options = getAdditionalOptions({
			supportsThinkingBudget: false,
			supportsThinkingLevel: true,
		});

		const thinkingLevel = findOption(options, 'thinkingLevel');
		expect(thinkingLevel).toBeDefined();
		expect(thinkingLevel?.type).toBe('options');
		// empty default means "don't send", leaving the model's behavior untouched
		expect(thinkingLevel?.default).toBe('');

		const values = (thinkingLevel as { options: INodePropertyOptions[] }).options.map(
			(option) => option.value,
		);
		expect(values).toEqual(['', 'minimal', 'low', 'medium', 'high']);
	});

	it('keeps Thinking Budget and Thinking Level mutually exclusive per node', () => {
		// The Gemini API rejects requests that set both; nodes enable one or the other.
		const geminiOptions = getAdditionalOptions({
			supportsThinkingBudget: false,
			supportsThinkingLevel: true,
		});
		const vertexOptions = getAdditionalOptions({
			supportsThinkingBudget: true,
			supportsThinkingLevel: false,
		});

		expect(findOption(geminiOptions, 'thinkingBudget')).toBeUndefined();
		expect(findOption(geminiOptions, 'thinkingLevel')).toBeDefined();
		expect(findOption(vertexOptions, 'thinkingBudget')).toBeDefined();
		expect(findOption(vertexOptions, 'thinkingLevel')).toBeUndefined();
	});
});
