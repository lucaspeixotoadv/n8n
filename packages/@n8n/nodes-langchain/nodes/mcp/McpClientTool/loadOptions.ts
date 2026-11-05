import { type ILoadOptionsFunctions, type INodePropertyOptions } from 'n8n-workflow';

import {
	loadMcpToolArgumentOptions,
	loadMcpToolOptions,
	type McpConnectionConfig,
} from '../shared/runtime';
import type { McpAuthenticationOption, McpServerTransport } from '../shared/types';

function resolveConnectionConfig(ctx: ILoadOptionsFunctions): McpConnectionConfig {
	const authentication = ctx.getNodeParameter('authentication') as McpAuthenticationOption;
	const timeout = ctx.getNodeParameter('options.timeout', 60000) as number;

	let serverTransport: McpServerTransport;
	let endpointUrl: string;
	if (ctx.getNode().typeVersion === 1) {
		serverTransport = 'sse';
		endpointUrl = ctx.getNodeParameter('sseEndpoint') as string;
	} else {
		serverTransport = ctx.getNodeParameter('serverTransport') as McpServerTransport;
		endpointUrl = ctx.getNodeParameter('endpointUrl') as string;
	}

	return { authentication, transport: serverTransport, endpointUrl, timeout };
}

export async function getTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await loadMcpToolOptions(this, resolveConnectionConfig(this));
}

export async function getToolArguments(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const toolName = this.getCurrentNodeParameter('&tool') as string;
	return await loadMcpToolArgumentOptions(this, resolveConnectionConfig(this), toolName);
}
