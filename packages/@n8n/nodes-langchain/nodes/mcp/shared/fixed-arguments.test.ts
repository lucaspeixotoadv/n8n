import { mock } from 'vitest-mock-extended';
import type { INode } from 'n8n-workflow';

import {
	assertFixedArgumentsExist,
	getFixedArguments,
	hideFixedArguments,
	type McpFixedArgument,
} from './fixed-arguments';
import type { McpTool } from './types';

const createRecord: McpTool = {
	name: 'createRecord',
	inputSchema: {
		type: 'object',
		properties: {
			caseId: { type: 'string' },
			title: { type: 'string' },
			tags: { type: 'array' },
		},
		required: ['caseId', 'title'],
	},
};

const fixedArguments: McpFixedArgument[] = [
	{ tool: 'createRecord', argument: 'caseId', value: '1234567890123456' },
	{ tool: 'createRecord', argument: 'tags', value: ['1'] },
	{ tool: 'otherTool', argument: 'caseId', value: 'other' },
];

describe('getFixedArguments', () => {
	it('returns the fixed arguments of the tool, keyed by argument name', () => {
		expect(getFixedArguments(fixedArguments, 'createRecord')).toEqual({
			caseId: '1234567890123456',
			tags: ['1'],
		});
	});

	it('returns no arguments for a tool without fixed arguments', () => {
		expect(getFixedArguments(fixedArguments, 'deleteRecord')).toEqual({});
	});
});

describe('hideFixedArguments', () => {
	it('removes the fixed arguments from the properties and from the required list', () => {
		const tool = hideFixedArguments(createRecord, { caseId: '1', tags: [] });

		expect(tool.inputSchema).toEqual({
			type: 'object',
			properties: { title: { type: 'string' } },
			required: ['title'],
		});
	});

	it('does not add a required list to a schema without one', () => {
		const tool = hideFixedArguments(
			{
				name: 'search',
				inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
			},
			{ query: 'n8n' },
		);

		expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
	});

	it('returns the tool unchanged when it has no fixed arguments', () => {
		expect(hideFixedArguments(createRecord, {})).toBe(createRecord);
	});
});

describe('assertFixedArgumentsExist', () => {
	const node = mock<INode>({ name: 'MCP Client' });

	it('accepts fixed arguments that the server publishes', () => {
		expect(() =>
			assertFixedArgumentsExist(node, [createRecord], [fixedArguments[0], fixedArguments[1]]),
		).not.toThrow();
	});

	it('throws for a tool that is not one of the tools of the node', () => {
		expect(() => assertFixedArgumentsExist(node, [createRecord], fixedArguments)).toThrow(
			'The fixed argument "caseId" is set for the tool "otherTool", which is not one of the tools of this node',
		);
	});

	it('throws for an argument that the tool does not publish', () => {
		expect(() =>
			assertFixedArgumentsExist(
				node,
				[createRecord],
				[{ tool: 'createRecord', argument: 'responsible', value: '1' }],
			),
		).toThrow('The tool "createRecord" has no argument "responsible" to fix');
	});
});
