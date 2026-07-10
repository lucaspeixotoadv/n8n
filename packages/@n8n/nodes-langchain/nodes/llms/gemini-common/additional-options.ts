import type { HarmBlockThreshold, HarmCategory } from '@google/genai';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import { harmCategories, harmThresholds } from './safety-options';

// Ordered by increasing reasoning depth (not alphabetically). Values are the
// lowercase strings the generateContent API expects for thinkingConfig.thinkingLevel.
// Empty value means "don't send thinkingLevel", leaving the model's default untouched.
const thinkingLevelOptions: INodePropertyOptions[] = [
	{ name: 'Default (Model Decides)', value: '' },
	{ name: 'Minimal', value: 'minimal' },
	{ name: 'Low', value: 'low' },
	{ name: 'Medium', value: 'medium' },
	{ name: 'High', value: 'high' },
];

export function getAdditionalOptions({
	supportsThinkingBudget,
	supportsThinkingLevel = false,
}: { supportsThinkingBudget: boolean; supportsThinkingLevel?: boolean }) {
	const baseOptions: INodeProperties = {
		displayName: 'Options',
		name: 'options',
		placeholder: 'Add Option',
		description: 'Additional options to add',
		type: 'collection',
		default: {},
		options: [
			{
				displayName: 'Maximum Number of Tokens',
				name: 'maxOutputTokens',
				default: 2048,
				description: 'The maximum number of tokens to generate in the completion',
				type: 'number',
			},
			{
				displayName: 'Sampling Temperature',
				name: 'temperature',
				default: 0.4,
				typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
				description:
					'Controls randomness: Lowering results in less random completions. As the temperature approaches zero, the model will become deterministic and repetitive.',
				type: 'number',
			},
			{
				displayName: 'Top K',
				name: 'topK',
				default: 32,
				typeOptions: { maxValue: 40, minValue: -1, numberPrecision: 1 },
				description:
					'Used to remove "long tail" low probability responses. Defaults to -1, which disables it.',
				type: 'number',
			},
			{
				displayName: 'Top P',
				name: 'topP',
				default: 1,
				typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
				description:
					'Controls diversity via nucleus sampling: 0.5 means half of all likelihood-weighted options are considered. We generally recommend altering this or temperature but not both.',
				type: 'number',
			},
			// Safety Settings
			{
				displayName: 'Safety Settings',
				name: 'safetySettings',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {
					values: {
						category: harmCategories[0].name as HarmCategory,
						threshold: harmThresholds[0].name as HarmBlockThreshold,
					},
				},
				placeholder: 'Add Option',
				options: [
					{
						name: 'values',
						displayName: 'Values',
						values: [
							{
								displayName: 'Safety Category',
								name: 'category',
								type: 'options',
								description: 'The category of harmful content to block',
								default: 'HARM_CATEGORY_UNSPECIFIED',
								options: harmCategories,
							},
							{
								displayName: 'Safety Threshold',
								name: 'threshold',
								type: 'options',
								description: 'The threshold of harmful content to block',
								default: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
								options: harmThresholds,
							},
						],
					},
				],
			},
		],
	};
	// only supported in the new google genai SDK
	if (supportsThinkingBudget) {
		baseOptions.options?.push({
			displayName: 'Thinking Budget',
			name: 'thinkingBudget',
			default: -1,
			description:
				'Controls reasoning tokens for thinking models. Set to 0 to disable automatic thinking. Set to -1 for dynamic thinking (default).',
			type: 'number',
			typeOptions: {
				minValue: -1,
				numberPrecision: 0,
			},
		});
	}
	// Mutually exclusive with Thinking Budget: the Gemini API rejects (400) a
	// request that sets both. Nodes therefore enable one or the other, not both.
	if (supportsThinkingLevel) {
		baseOptions.options?.push({
			displayName: 'Thinking Level',
			name: 'thinkingLevel',
			default: '',
			description:
				"Controls the depth of the model's internal reasoning before it answers. Applies to Gemini 3.x models; other models will reject it. Leave as Default to use the model's built-in behavior.",
			type: 'options',
			options: thinkingLevelOptions,
		});
	}
	return baseOptions;
}
