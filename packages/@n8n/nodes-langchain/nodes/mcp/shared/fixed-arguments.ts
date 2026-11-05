import omit from 'lodash/omit';
import { type IDataObject, type INode, NodeOperationError } from 'n8n-workflow';

import type { McpTool } from './types';

/**
 * An argument of an MCP tool that the client sets itself. The AI agent does not
 * see it, and its value goes into every call of that tool.
 */
export type McpFixedArgument = {
	tool: string;
	argument: string;
	value: IDataObject[string];
};

/**
 * Returns the fixed arguments of a tool, keyed by argument name.
 */
export function getFixedArguments(fixedArguments: McpFixedArgument[], toolName: string) {
	const toolArguments: IDataObject = {};
	for (const { tool, argument, value } of fixedArguments) {
		if (tool === toolName) toolArguments[argument] = value;
	}
	return toolArguments;
}

/**
 * Removes the fixed arguments from the input schema of a tool, so the AI agent
 * is not asked to fill them.
 */
export function hideFixedArguments(tool: McpTool, toolArguments: IDataObject): McpTool {
	const names = Object.keys(toolArguments);
	if (names.length === 0) return tool;

	const { properties, required } = tool.inputSchema;
	return {
		...tool,
		inputSchema: {
			...tool.inputSchema,
			properties: omit(properties, names),
			...(required && { required: required.filter((name) => !names.includes(name)) }),
		},
	};
}

/**
 * Throws when a fixed argument names a tool that the node does not use, or an
 * argument that the tool does not publish, so a value never goes nowhere.
 */
export function assertFixedArgumentsExist(
	node: INode,
	tools: McpTool[],
	fixedArguments: McpFixedArgument[],
) {
	for (const { tool: toolName, argument } of fixedArguments) {
		const tool = tools.find(({ name }) => name === toolName);
		if (!tool) {
			throw new NodeOperationError(
				node,
				`The fixed argument "${argument}" is set for the tool "${toolName}", which is not one of the tools of this node`,
			);
		}
		if (!(argument in (tool.inputSchema.properties ?? {}))) {
			throw new NodeOperationError(
				node,
				`The tool "${toolName}" has no argument "${argument}" to fix`,
			);
		}
	}
}
