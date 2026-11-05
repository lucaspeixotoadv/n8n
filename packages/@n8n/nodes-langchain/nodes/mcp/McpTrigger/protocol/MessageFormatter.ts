import { isRecord } from '@n8n/utils/is-record';
import type { CredentialCheckResult } from 'n8n-workflow';

import { isToolErrorResult } from '@utils/tool-error-result';

import type { McpToolResult } from './types';
import { isMcpContentArray, type McpContentBlock } from '../../shared/utils';

/**
 * Returns the value of a JSON text, or `undefined` when the text is not JSON.
 *
 * Tools hand their result to the server through `DynamicStructuredTool.invoke`,
 * which serializes the tool's return value to a string before it leaves the
 * tool. A structured result therefore arrives here as JSON text.
 */
function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/**
 * Returns the MCP content array of a result from an MCP tool, as an array or as
 * its JSON text (proxy mode), or `null` so the caller wraps the result itself.
 */
function getMcpContentArray(result: unknown): McpContentBlock[] | null {
	const value = typeof result === 'string' ? parseJson(result) : result;
	return isMcpContentArray(value) ? value : null;
}

/**
 * Returns the `structuredContent` of a result that is a JSON object or array,
 * as a value or as its JSON text. MCP requires an object, so an array goes in
 * `{ result }`, which keeps one shape for any number of items. Any other result
 * has no structured form.
 */
function getStructuredContent(result: unknown): Record<string, unknown> | undefined {
	const value = typeof result === 'string' ? parseJson(result) : result;
	if (Array.isArray(value)) return { result: value };
	return isRecord(value) ? value : undefined;
}

/**
 * Returns the text of a result for its text content block.
 */
function toText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (typeof result === 'object' && result !== null) return JSON.stringify(result);
	// null, undefined, numbers, booleans, bigints, symbols, and functions
	return String(result);
}

/**
 * Result of presenting a single missing credential's connection URL to the
 * client via URL-mode elicitation. `action` mirrors the MCP `ElicitResult`
 * actions: `accept` (the client opened the connection page), `decline`, or
 * `cancel`.
 */
export interface CredentialGateElicitationOutcome {
	credentialName: string;
	credentialType: string;
	action: 'accept' | 'decline' | 'cancel';
}

export class MessageFormatter {
	static formatToolResult(result: unknown, isError = false, isFromMcpTool = false): McpToolResult {
		const mcpContent = isFromMcpTool ? getMcpContentArray(result) : null;
		const content = mcpContent ?? [{ type: 'text' as const, text: toText(result) }];

		if (isError) return { isError: true, content };

		// The text block stays for clients that read only `content`.
		const structuredContent = mcpContent ? undefined : getStructuredContent(result);
		return structuredContent ? { content, structuredContent } : { content };
	}

	static isErrorResult(result: unknown): boolean {
		return isToolErrorResult(result);
	}

	static formatError(error: Error): McpToolResult {
		return {
			isError: true,
			content: [{ type: 'text' as const, text: `${error.name}: ${error.message}` }],
		};
	}

	/**
	 * Formats a not-ready credential gate into an actionable MCP tool response: the
	 * workflow did not run because the calling user has not connected one or more
	 * required credentials. Each missing credential is listed with its connection
	 * URL so the client can prompt the user to connect and retry.
	 */
	static formatCredentialGate(result: CredentialCheckResult): McpToolResult {
		const missing = result.credentials.filter((c) => c.status !== 'configured');

		// The connection URL is emitted raw on its own line (not wrapped in prose),
		// so the client can surface it verbatim without mangling the link.
		const lines = missing.flatMap((c) => {
			const label = `- ${c.credentialName} (${c.credentialType})`;
			return c.authorizationUrl ? [label, c.authorizationUrl] : [`${label}: not connected`];
		});

		const text = [
			'This tool requires credentials that are not connected for your account yet.',
			'Connect each of the following, then retry the request:',
			...lines,
		].join('\n');

		return {
			isError: true,
			content: [{ type: 'text' as const, text }],
			credentialGate: result,
		};
	}

	/**
	 * Formats the outcome of driving the credential gate through URL-mode
	 * elicitation. Clients that support elicitation surface the connection page
	 * themselves, so the response only needs to tell the caller what to do next:
	 * retry once the opened page(s) are connected, and which credentials (if any)
	 * were left unconnected. Flagged as an error only when something still needs
	 * connecting so the client keeps prompting.
	 */
	static formatCredentialGateElicited(outcomes: CredentialGateElicitationOutcome[]): McpToolResult {
		const opened = outcomes.filter((o) => o.action === 'accept');
		const skipped = outcomes.filter((o) => o.action !== 'accept');

		const lines: string[] = [];
		if (opened.length) {
			lines.push(
				'A connection page was opened for the following credential(s). Once connected, retry the request:',
				...opened.map((o) => `- ${o.credentialName} (${o.credentialType})`),
			);
		}
		if (skipped.length) {
			lines.push(
				'These credentials still need to be connected before the tool can run:',
				...skipped.map((o) => `- ${o.credentialName} (${o.credentialType})`),
			);
		}

		const content = [{ type: 'text' as const, text: lines.join('\n') }];
		// Omit `isError` when nothing is left to connect, matching formatToolResult.
		return skipped.length > 0 ? { isError: true, content } : { content };
	}
}
