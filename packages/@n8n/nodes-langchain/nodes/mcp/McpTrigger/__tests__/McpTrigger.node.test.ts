import type { Tool } from '@langchain/core/tools';
import type {
	CredentialCheckResult,
	INode,
	INodePropertyOptions,
	IWebhookFunctions,
	ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { recordConsumedAuth, REDACTED } from 'n8n-workflow';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { Mock, Mocked } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { getConnectedTools } from '@utils/helpers';

import {
	createMockLogger,
	createMockRequest,
	createMockResponse,
	createListToolsMessage,
	createValidToolCallMessage,
} from './helpers';
import { CONNECT_CREDENTIALS_TOOL_NAME } from '../CredentialGateTool';
import { McpServer } from '../McpServer';
import { McpTrigger } from '../McpTrigger.node';

const INBOUND_TRIGGER_AUTHENTICATION_BUILDER_HINT =
	"Default to 'none'. n8n exposes inbound trigger URLs publicly by design. Only select an authentication method when the user explicitly asks to authenticate inbound traffic.";

// Mock the McpServer
vi.mock('../McpServer', () => ({
	McpServer: {
		instance: vi.fn(),
	},
	MCP_LIST_TOOLS_REQUEST_MARKER: 'mcp_list_tools_request',
}));

const { validateWebhookAuthenticationMock } = vi.hoisted(() => ({
	validateWebhookAuthenticationMock: vi.fn(),
}));

// Mock webhook utils from nodes-base
vi.mock('n8n-nodes-base/dist/nodes/Webhook/utils', () => ({
	validateWebhookAuthentication: validateWebhookAuthenticationMock,
}));

// Mock getConnectedTools from utils
vi.mock('@utils/helpers', () => ({
	getConnectedTools: vi.fn().mockResolvedValue([]),
}));

describe('McpTrigger', () => {
	let mcpTrigger: McpTrigger;
	let mockMcpServer: Mocked<McpServer>;
	let mockContext: Mocked<IWebhookFunctions>;
	let mockLogger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		mcpTrigger = new McpTrigger();
		mockLogger = createMockLogger();

		mockMcpServer = {
			handleSetupRequest: vi.fn().mockResolvedValue(undefined),
			handlePostMessage: vi.fn().mockResolvedValue({
				wasToolCall: false,
				toolCallInfo: undefined,
				messageId: undefined,
				relaySessionId: undefined,
				needsListToolsRelay: false,
			}),
			handleDeleteRequest: vi.fn().mockResolvedValue(undefined),
			handleStreamableHttpSetup: vi.fn().mockResolvedValue(undefined),
			getSessionId: vi.fn().mockReturnValue(undefined),
		} as unknown as Mocked<McpServer>;

		(McpServer.instance as Mock).mockReturnValue(mockMcpServer);

		mockContext = mock<IWebhookFunctions>({
			getWebhookName: vi.fn().mockReturnValue('setup'),
			getRequestObject: vi.fn(),
			getResponseObject: vi.fn(),
			getNode: vi.fn(),
			logger: mockLogger,
			getCredentials: vi.fn().mockResolvedValue({} as ICredentialDataDecryptedObject),
			checkTriggerCredentialStatus: vi.fn().mockResolvedValue(undefined),
		});

		(getConnectedTools as Mock).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	const toolInputPassedToSubNodes = () =>
		vi.mocked(getConnectedTools).mock.calls.at(-1)?.[4]?.inputData;

	describe('description', () => {
		it('should have the correct node metadata', () => {
			expect(mcpTrigger.description.name).toBe('mcpTrigger');
			expect(mcpTrigger.description.displayName).toBe('MCP Server Trigger');
			expect(mcpTrigger.description.group).toContain('trigger');
		});

		it('should support multiple versions', () => {
			expect(mcpTrigger.description.version).toEqual([1, 1.1, 2, 2.1]);
		});

		it('should have authentication options', () => {
			const authParam = mcpTrigger.description.properties?.find((p) => p.name === 'authentication');
			expect(authParam).toBeDefined();
			expect(authParam?.type).toBe('options');
			expect(authParam?.default).toBe('none');
			expect(authParam?.options).toHaveLength(5);
			expect(authParam?.builderHint).toEqual({
				propertyHint: INBOUND_TRIGGER_AUTHENTICATION_BUILDER_HINT,
			});
		});

		it('should gate the n8nOAuth2 option to node version 2 and above', () => {
			const authParam = mcpTrigger.description.properties?.find((p) => p.name === 'authentication');
			const options = authParam?.options as INodePropertyOptions[];
			const oauthOption = options.find((o) => o.value === 'n8nOAuth2');

			expect(oauthOption).toBeDefined();
			expect(oauthOption?.displayOptions).toEqual({ show: { '@version': [{ _cnd: { gte: 2 } }] } });
		});

		it('should gate the jwtAuth option and its credential to the versions that expose the request', () => {
			const authParam = mcpTrigger.description.properties?.find((p) => p.name === 'authentication');
			const options = authParam?.options as INodePropertyOptions[];
			const jwtOption = options.find((o) => o.value === 'jwtAuth');

			expect(jwtOption?.displayOptions).toEqual({
				show: { '@version': [{ _cnd: { gte: 2.1 } }] },
			});
			expect(mcpTrigger.description.credentials).toContainEqual({
				name: 'jwtAuth',
				required: true,
				displayOptions: { show: { authentication: ['jwtAuth'] } },
			});
		});

		it('should show the JWT claim parameters only for jwtAuth', () => {
			const names = ['jwtIssuer', 'jwtCheckAudience', 'jwtMaxAge'];
			const params = mcpTrigger.description.properties?.filter((p) => names.includes(p.name));

			expect(params).toHaveLength(3);
			for (const param of params ?? []) {
				expect(param.displayOptions).toEqual({ show: { authentication: ['jwtAuth'] } });
			}
			expect(params?.find((p) => p.name === 'jwtCheckAudience')?.default).toBe(true);
		});

		it('should define webhook endpoints', () => {
			const webhooks = mcpTrigger.description.webhooks;
			expect(webhooks).toHaveLength(3);

			const setupWebhook = webhooks?.find((w) => w.name === 'setup');
			expect(setupWebhook?.httpMethod).toBe('GET');

			const defaultWebhooks = webhooks?.filter((w) => w.name === 'default');
			expect(defaultWebhooks).toHaveLength(2);
			expect(defaultWebhooks?.map((w) => w.httpMethod)).toEqual(['POST', 'DELETE']);
		});
	});

	describe('webhook - setup (GET)', () => {
		it('should handle setup request for version 1', async () => {
			const req = createMockRequest({ path: '/webhook/sse' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 1,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('should forward configured instructions to the setup request', async () => {
			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			mockContext.getNodeParameter.mockImplementation((name: string) =>
				name === 'instructions' ? 'Call the context tool first.' : undefined,
			);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				expect.any(String),
				expect.any(String),
				expect.any(Array),
				'Call the context tool first.',
			);
		});

		// An expression can resolve `instructions` to any type, but the MCP client
		// only accepts a string in the initialize result
		it.each([
			{ label: 'a number', value: 123, expected: '123' },
			{ label: 'a boolean', value: false, expected: 'false' },
			{ label: 'null', value: null, expected: undefined },
		])('should coerce instructions resolving to $label', async ({ value, expected }) => {
			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			mockContext.getNodeParameter.mockImplementation((name: string) =>
				name === 'instructions' ? value : undefined,
			);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				expect.any(String),
				expect.any(String),
				expect.any(Array),
				expected,
			);
		});

		it('should use n8n-mcp-server name for version 1', async () => {
			const req = createMockRequest({ path: '/webhook/sse' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 1,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				'n8n-mcp-server',
				expect.any(String),
				expect.any(Array),
				undefined,
			);
		});

		it('should use sanitized node name for version > 1', async () => {
			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'My Custom MCP Server',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			await mcpTrigger.webhook(mockContext);

			// nodeNameToToolName converts "My Custom MCP Server" to a sanitized name
			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				expect.stringMatching(/^[a-z0-9_-]+$/i),
				expect.any(String),
				expect.any(Array),
				undefined,
			);
		});

		it('should compute correct POST URL for version 1', async () => {
			const req = createMockRequest({ path: '/webhook/sse' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 1,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				expect.any(String),
				'/webhook/messages',
				expect.any(Array),
				undefined,
			);
		});

		it('should use same path as POST URL for version 2', async () => {
			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalledWith(
				req,
				resp,
				expect.any(String),
				'/webhook',
				expect.any(Array),
				undefined,
			);
		});
	});

	describe('webhook - default POST', () => {
		it('should handle POST with existing session', async () => {
			const req = createMockRequest({ method: 'POST', query: { sessionId: 'test-session' } });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockMcpServer.getSessionId.mockReturnValue('test-session');

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handlePostMessage).toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		const setupToolCall = (typeVersion: number) => {
			const req = createMockRequest({
				method: 'POST',
				query: { sessionId: 'test-session' },
				headers: { 'x-user-id': 'user-1' },
			});
			const resp = createMockResponse();
			const node = mock<INode>({ typeVersion, name: 'MCP Server Trigger' });

			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockMcpServer.handlePostMessage.mockResolvedValue({
				wasToolCall: true,
				toolCallInfo: { toolName: 'test-tool', arguments: { arg1: 'value1' } },
				messageId: 'msg-123',
				relaySessionId: undefined,
				needsListToolsRelay: false,
			});

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			mockContext.getBodyData.mockReturnValue({ method: 'tools/call' });

			return { req };
		};

		it('should return workflow data when tool call is detected', async () => {
			setupToolCall(2);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result).toEqual({
				noWebhookResponse: true,
				workflowData: [
					[
						{
							json: {
								mcpToolCall: { toolName: 'test-tool', arguments: { arg1: 'value1' } },
								mcpMessageId: 'msg-123',
							},
						},
					],
				],
			});
		});

		it('should include the request headers from version 2.1 on', async () => {
			setupToolCall(2.1);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.workflowData?.[0][0].json).toEqual({
				mcpToolCall: { toolName: 'test-tool', arguments: { arg1: 'value1' } },
				mcpMessageId: 'msg-123',
				headers: { 'x-user-id': 'user-1' },
			});
		});

		it('should carry the tool input on the response from version 2.1 on', async () => {
			setupToolCall(2.1);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.toolInput).toEqual({
				body: { method: 'tools/call' },
				headers: { 'x-user-id': 'user-1' },
			});
		});

		it('should not produce a tool input on version 2.0', async () => {
			setupToolCall(2);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.toolInput).toBeUndefined();
			expect(toolInputPassedToSubNodes()).toBeUndefined();
		});

		it('should handle Streamable HTTP setup when no session exists', async () => {
			const req = createMockRequest({ method: 'POST' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockMcpServer.getSessionId.mockReturnValue(undefined);

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleStreamableHttpSetup).toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('should forward configured instructions to the Streamable HTTP setup', async () => {
			const req = createMockRequest({ method: 'POST' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockMcpServer.getSessionId.mockReturnValue(undefined);

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			mockContext.getNodeParameter.mockImplementation((name: string) =>
				name === 'instructions' ? 'Call the context tool first.' : undefined,
			);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleStreamableHttpSetup).toHaveBeenCalledWith(
				req,
				resp,
				expect.any(String),
				expect.any(Array),
				'Call the context tool first.',
			);
		});
	});

	describe('webhook - default DELETE', () => {
		it('should handle DELETE request', async () => {
			const req = createMockRequest({ method: 'DELETE' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleDeleteRequest).toHaveBeenCalledWith(req, resp);
			expect(result).toEqual({ noWebhookResponse: true });
		});
	});

	describe('authentication', () => {
		it('should rethrow non-authorization errors', async () => {
			const genericError = new Error('Something went wrong');
			validateWebhookAuthenticationMock.mockRejectedValue(genericError);

			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			await expect(mcpTrigger.webhook(mockContext)).rejects.toThrow('Something went wrong');
		});

		it('should return 401 for authentication errors', async () => {
			const { WebhookAuthorizationError }: { WebhookAuthorizationError: any } =
				await vi.importActual('n8n-nodes-base/dist/nodes/Webhook/error');
			validateWebhookAuthenticationMock.mockRejectedValue(
				new WebhookAuthorizationError(401, 'Unauthorized'),
			);

			const req = createMockRequest({ path: '/webhook' });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(resp.writeHead).toHaveBeenCalledWith(401);
			expect(resp.end).toHaveBeenCalledWith('Unauthorized');
			expect(result).toEqual({ noWebhookResponse: true });
		});
	});

	describe('n8nOAuth2 authentication', () => {
		const resourceUrl = 'https://n8n.example.com/mcp/abc';
		const prmUrl = 'https://n8n.example.com/.well-known/oauth-protected-resource/mcp/abc';
		const OAUTH_USER = { id: 'u1', email: 'u@example.com', firstName: 'U', lastName: 'One' };

		function setupContext(opts: {
			typeVersion: number;
			headers?: Record<string, string>;
			includeUserInOutput?: boolean;
		}) {
			const req = createMockRequest({ path: '/mcp/abc', headers: opts.headers ?? {} });
			const resp = createMockResponse();
			const node = mock<INode>({ typeVersion: opts.typeVersion, name: 'MCP Server Trigger' });

			mockContext.getNodeParameter.mockImplementation((name, fallback) => {
				if (name === 'authentication') return 'n8nOAuth2';
				if (name === 'includeUserInOutput') return opts.includeUserInOutput ?? fallback;
				return fallback;
			});
			mockContext.getWebhookResourceUrl.mockReturnValue(resourceUrl);
			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			return { req, resp, node };
		}

		const setupToolCall = (opts: Parameters<typeof setupContext>[0]) => {
			const context = setupContext(opts);

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getBodyData.mockReturnValue({ method: 'tools/call' });
			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockMcpServer.handlePostMessage.mockResolvedValue({
				wasToolCall: true,
				toolCallInfo: { toolName: 'test-tool', arguments: {} },
				messageId: 'msg-123',
				relaySessionId: undefined,
				needsListToolsRelay: false,
			});

			return context;
		};

		it('fails closed with 401 on node version below 2', async () => {
			const { resp } = setupContext({ typeVersion: 1.1 });

			const result = await mcpTrigger.webhook(mockContext);

			expect(resp.writeHead).toHaveBeenCalledWith(401);
			expect(mockContext.validateN8nOAuth2Token).not.toHaveBeenCalled();
			expect(mockMcpServer.handleSetupRequest).not.toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('returns 401 with resource_metadata and no error when the bearer token is missing', async () => {
			const { resp } = setupContext({ typeVersion: 2 });

			const result = await mcpTrigger.webhook(mockContext);

			expect(resp.writeHead).toHaveBeenCalledWith(401, {
				'WWW-Authenticate': `Bearer realm="n8n MCP Server", resource_metadata="${prmUrl}"`,
			});
			expect(mockContext.validateN8nOAuth2Token).not.toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('returns 401 with error="invalid_token" when the token is rejected', async () => {
			const { resp } = setupContext({
				typeVersion: 2,
				headers: { authorization: 'Bearer bad-token' },
			});
			mockContext.validateN8nOAuth2Token.mockResolvedValue({
				valid: false,
				reason: 'invalid_token',
			});

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockContext.validateN8nOAuth2Token).toHaveBeenCalledWith('bad-token', resourceUrl);
			expect(resp.writeHead).toHaveBeenCalledWith(401, {
				'WWW-Authenticate': `Bearer realm="n8n MCP Server", resource_metadata="${prmUrl}", error="invalid_token"`,
			});
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('returns 503 when the token verifier is unavailable', async () => {
			const { resp } = setupContext({
				typeVersion: 2,
				headers: { authorization: 'Bearer some-token' },
			});
			mockContext.validateN8nOAuth2Token.mockResolvedValue({
				valid: false,
				reason: 'verifier_unavailable',
			});

			const result = await mcpTrigger.webhook(mockContext);

			expect(resp.status).toHaveBeenCalledWith(503);
			expect(resp.writeHead).not.toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('proceeds to MCP dispatch when the token is valid', async () => {
			setupContext({ typeVersion: 2, headers: { authorization: 'Bearer good-token' } });
			mockContext.validateN8nOAuth2Token.mockResolvedValue({ valid: true, user: OAUTH_USER });

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('redacts the bearer token in the input the tools see, exposing the caller as `user`', async () => {
			const { req } = setupContext({
				typeVersion: 2.1,
				headers: { authorization: 'Bearer good-token', 'x-user-id': 'user-1' },
			});
			mockContext.validateN8nOAuth2Token.mockResolvedValue({ valid: true, user: OAUTH_USER });
			mockContext.getBodyData.mockReturnValue({ method: 'tools/list' });

			await mcpTrigger.webhook(mockContext);

			expect(toolInputPassedToSubNodes()).toEqual({
				body: { method: 'tools/list' },
				headers: { authorization: REDACTED, 'x-user-id': 'user-1' },
				user: OAUTH_USER,
			});
			expect(req.headers.authorization).toBe('Bearer good-token');
		});

		it('omits the caller when the user is excluded from the output', async () => {
			setupContext({
				typeVersion: 2.1,
				headers: { authorization: 'Bearer good-token' },
				includeUserInOutput: false,
			});
			mockContext.validateN8nOAuth2Token.mockResolvedValue({ valid: true, user: OAUTH_USER });
			mockContext.getBodyData.mockReturnValue({ method: 'tools/list' });

			await mcpTrigger.webhook(mockContext);

			expect(toolInputPassedToSubNodes()).not.toHaveProperty('user');
		});

		it('exposes no user on version 2.0', async () => {
			setupToolCall({ typeVersion: 2, headers: { authorization: 'Bearer good-token' } });
			mockContext.validateN8nOAuth2Token.mockResolvedValue({ valid: true, user: OAUTH_USER });

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.workflowData?.[0][0].json).not.toHaveProperty('user');
			expect(result.toolInput).toBeUndefined();
		});

		it('exposes the caller in the trigger output on a tool call', async () => {
			setupToolCall({ typeVersion: 2.1, headers: { authorization: 'Bearer good-token' } });
			mockContext.validateN8nOAuth2Token.mockResolvedValue({ valid: true, user: OAUTH_USER });

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.workflowData?.[0][0].json).toEqual({
				mcpToolCall: { toolName: 'test-tool', arguments: {} },
				mcpMessageId: 'msg-123',
				headers: { authorization: REDACTED },
				user: OAUTH_USER,
			});
			expect(result.toolInput).toMatchObject({ user: OAUTH_USER });
		});
	});

	describe('jwtAuth authentication', () => {
		const MCP_URL = 'https://n8n.example.com/mcp/abc';
		const ISSUER = 'https://issuer.example.com';

		const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

		const nowSeconds = () => Math.floor(Date.now() / 1000);
		const signEs256 = (claims: Record<string, unknown> = {}, options: SignOptions = {}): string =>
			jwt.sign({ aud: MCP_URL, iss: ISSUER, ...claims }, privateKey, {
				algorithm: 'ES256',
				...options,
			});
		const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const unsigned = (header: object, payload: object) =>
			`${base64Url(header)}.${base64Url(payload)}`;

		const setup = (opts: {
			token?: string;
			typeVersion?: number;
			authentication?: string;
			params?: Record<string, unknown>;
		}) => {
			const { token, typeVersion = 2.1, authentication = 'jwtAuth', params = {} } = opts;
			const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
			const req = createMockRequest({ path: '/mcp/abc', headers });
			const resp = createMockResponse();

			const parameters: Record<string, unknown> = {
				authentication,
				jwtIssuer: ISSUER,
				jwtCheckAudience: true,
				jwtMaxAge: 0,
				...params,
			};
			mockContext.getNodeParameter.mockImplementation((name, fallback) =>
				name in parameters ? (parameters[name] as never) : fallback,
			);
			mockContext.getCredentials.mockResolvedValue({
				keyType: 'pemKey',
				publicKey: publicPem,
				secret: '',
				algorithm: 'ES256',
			});
			mockContext.getHeaderData.mockReturnValue(headers);
			mockContext.getWebhookResourceUrl.mockReturnValue(MCP_URL);
			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getBodyData.mockReturnValue({ method: 'tools/call' });
			mockContext.getNode.mockReturnValue(mock<INode>({ typeVersion, name: 'MCP Server Trigger' }));
			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockMcpServer.handlePostMessage.mockResolvedValue({
				wasToolCall: true,
				toolCallInfo: { toolName: 'test-tool', arguments: {} },
				messageId: 'msg-123',
				relaySessionId: undefined,
				needsListToolsRelay: false,
			});

			return { req, resp };
		};

		beforeEach(async () => {
			const actual = await vi.importActual<
				typeof import('n8n-nodes-base/dist/nodes/Webhook/utils')
			>('n8n-nodes-base/dist/nodes/Webhook/utils');
			const { WebhookAuthorizationError }: { WebhookAuthorizationError: any } =
				await vi.importActual('n8n-nodes-base/dist/nodes/Webhook/error');
			// The real helper loads its own copy of the error class, so rethrow it as the class the trigger checks for.
			validateWebhookAuthenticationMock.mockImplementation(async (...args: unknown[]) => {
				try {
					return await Reflect.apply(actual.validateWebhookAuthentication, undefined, args);
				} catch (error) {
					if (error instanceof Error && 'responseCode' in error) {
						throw new WebhookAuthorizationError(error.responseCode, error.message);
					}
					throw error;
				}
			});
		});

		const expectRefused = async (
			opts: Parameters<typeof setup>[0],
			status: number,
			message?: string,
		) => {
			const { resp } = setup(opts);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result).toEqual({ noWebhookResponse: true });
			expect(resp.writeHead).toHaveBeenCalledWith(status);
			if (message) expect(resp.end).toHaveBeenCalledWith(expect.stringContaining(message));
			expect(mockMcpServer.handlePostMessage).not.toHaveBeenCalled();
			expect(getConnectedTools).not.toHaveBeenCalled();
		};

		it('passes the verified payload to the tools and redacts the token', async () => {
			const token = signEs256({ sub: 'caller-1', tenant: 'acme' });
			const { req } = setup({ token });

			const result = await mcpTrigger.webhook(mockContext);

			const expectedPayload = expect.objectContaining({
				sub: 'caller-1',
				tenant: 'acme',
				iss: ISSUER,
				aud: MCP_URL,
			});
			expect(result.toolInput).toEqual({
				body: { method: 'tools/call' },
				headers: { authorization: REDACTED },
				jwtPayload: expectedPayload,
			});
			expect(toolInputPassedToSubNodes()).toEqual(result.toolInput);
			expect(result.workflowData?.[0][0].json).toEqual({
				mcpToolCall: { toolName: 'test-tool', arguments: {} },
				mcpMessageId: 'msg-123',
				headers: { authorization: REDACTED },
				jwtPayload: expectedPayload,
			});
			expect(JSON.stringify(result)).not.toContain(token);
			expect(req.headers.authorization).toBe(`Bearer ${token}`);
			expect(mockContext.getWebhookResourceUrl).toHaveBeenCalledWith('default');
		});

		it('does not check the audience or the issuer when they are not configured', async () => {
			const token = signEs256({ aud: 'https://elsewhere.example.com', iss: 'someone-else' });
			setup({ token, params: { jwtIssuer: '', jwtCheckAudience: false } });

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.toolInput).toHaveProperty('jwtPayload');
		});

		it('checks the audience against the setup URL on the setup request', async () => {
			const token = signEs256();
			setup({ token });
			mockContext.getWebhookName.mockReturnValue('setup');

			await mcpTrigger.webhook(mockContext);

			expect(mockContext.getWebhookResourceUrl).toHaveBeenCalledWith('setup');
			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalled();
		});

		it('refuses a request without a token with 401', async () => {
			await expectRefused({}, 401, 'No token provided');
		});

		it('refuses a token with the none algorithm', async () => {
			const token = `${unsigned({ alg: 'none', typ: 'JWT' }, { aud: MCP_URL, iss: ISSUER })}.`;
			await expectRefused({ token }, 403);
		});

		it('refuses an HS256 token signed with the public key as the secret', async () => {
			const signingInput = unsigned(
				{ alg: 'HS256', typ: 'JWT' },
				{ aud: MCP_URL, iss: ISSUER, iat: nowSeconds() },
			);
			const signature = createHmac('sha256', publicPem).update(signingInput).digest('base64url');
			await expectRefused({ token: `${signingInput}.${signature}` }, 403);
		});

		it('refuses a token with a changed payload', async () => {
			const [header, , signature] = signEs256({ sub: 'caller-1' }).split('.');
			const payload = base64Url({ aud: MCP_URL, iss: ISSUER, sub: 'caller-2' });
			await expectRefused({ token: `${header}.${payload}.${signature}` }, 403, 'invalid signature');
		});

		it('refuses an expired token', async () => {
			await expectRefused({ token: signEs256({ exp: nowSeconds() - 60 }) }, 403, 'jwt expired');
		});

		it('refuses a token for another audience', async () => {
			const token = signEs256({ aud: 'https://n8n.example.com/mcp-test/abc' });
			await expectRefused({ token }, 403, 'audience invalid');
		});

		it('refuses a token from another issuer', async () => {
			await expectRefused(
				{ token: signEs256({ iss: 'https://other.example.com' }) },
				403,
				'issuer',
			);
		});

		it('refuses a token older than the maximum age', async () => {
			const token = signEs256({ iat: nowSeconds() - 600 });
			await expectRefused({ token, params: { jwtMaxAge: 60 } }, 403, 'maxAge exceeded');
		});

		it('refuses a token without iat when a maximum age is set', async () => {
			const token = signEs256({}, { noTimestamp: true });
			await expectRefused({ token, params: { jwtMaxAge: 60 } }, 403, 'iat required');
		});

		it('refuses with 500 when the audience URL is not available', async () => {
			const { resp } = setup({ token: signEs256() });
			mockContext.getWebhookResourceUrl.mockReturnValue(undefined);

			await mcpTrigger.webhook(mockContext);

			expect(resp.writeHead).toHaveBeenCalledWith(500);
			expect(mockMcpServer.handlePostMessage).not.toHaveBeenCalled();
		});

		it.each(['none', 'bearerAuth', 'headerAuth'])(
			'exposes no jwtPayload with %s authentication',
			async (authentication) => {
				setup({ authentication });
				validateWebhookAuthenticationMock.mockResolvedValue(undefined);

				const result = await mcpTrigger.webhook(mockContext);

				expect(result.toolInput).not.toHaveProperty('jwtPayload');
				expect(result.workflowData?.[0][0].json).not.toHaveProperty('jwtPayload');
			},
		);

		it('exposes no jwtPayload on version 2.0', async () => {
			setup({ token: signEs256(), typeVersion: 2 });

			const result = await mcpTrigger.webhook(mockContext);

			expect(result.toolInput).toBeUndefined();
			expect(result.workflowData?.[0][0].json).not.toHaveProperty('jwtPayload');
		});
	});

	describe('consumed auth headers', () => {
		const setup = (typeVersion: number) => {
			const req = createMockRequest({
				path: '/mcp/abc',
				headers: { 'x-api-key': 'secret-value', 'x-tenant-id': 'acme' },
			});
			const resp = createMockResponse();

			validateWebhookAuthenticationMock.mockImplementation(async () => {
				recordConsumedAuth(req, ['x-api-key']);
			});

			mockContext.getNodeParameter.mockReturnValue('headerAuth');
			mockContext.getWebhookName.mockReturnValue('setup');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getBodyData.mockReturnValue({ method: 'tools/list' });
			mockContext.getNode.mockReturnValue(mock<INode>({ typeVersion, name: 'MCP Server Trigger' }));

			return { req };
		};

		it('redacts the header the credential named, keeping the rest', async () => {
			const { req } = setup(2.1);

			await mcpTrigger.webhook(mockContext);

			expect(toolInputPassedToSubNodes()).toEqual({
				body: { method: 'tools/list' },
				headers: { 'x-api-key': REDACTED, 'x-tenant-id': 'acme' },
			});
			expect(req.headers).toEqual({ 'x-api-key': 'secret-value', 'x-tenant-id': 'acme' });
		});

		it('exposes no headers to the tools on version 2.0', async () => {
			setup(2);

			await mcpTrigger.webhook(mockContext);

			expect(toolInputPassedToSubNodes()).toBeUndefined();
		});
	});

	describe('credential gate during session setup and tool listing', () => {
		const notReadyGate: CredentialCheckResult = {
			readyToExecute: false,
			credentials: [
				{
					credentialId: 'cred-1',
					credentialName: 'Downstream MCP OAuth',
					credentialType: 'mcpOAuth2Api',
					status: 'missing',
					authorizationUrl: 'https://n8n.example.com/connect/cred-1',
				},
			],
		};
		const readyGate: CredentialCheckResult = { readyToExecute: true, credentials: [] };
		const toolBuildError = new Error(
			'Error in sub-node MCP Client: Could not connect to your MCP server. Authentication failed.',
		);

		function setupWebhookContext(opts: { webhookName: 'setup' | 'default'; rawBody?: string }) {
			// Earlier auth tests leave the shared mock rejecting; make auth pass here.
			validateWebhookAuthenticationMock.mockResolvedValue(undefined);
			const req = createMockRequest({
				path: '/mcp/test',
				method: opts.webhookName === 'setup' ? 'GET' : 'POST',
				rawBody: opts.rawBody,
			});
			const resp = createMockResponse();
			const node = mock<INode>({ typeVersion: 2, name: 'MCP Server Trigger' });

			mockContext.getWebhookName.mockReturnValue(opts.webhookName);
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);
			return { req, resp, node };
		}

		it('exposes the connect-credentials placeholder on SSE setup when tool building fails and the gate is not ready', async () => {
			setupWebhookContext({ webhookName: 'setup' });
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(notReadyGate);
			(getConnectedTools as Mock).mockRejectedValue(toolBuildError);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleSetupRequest).toHaveBeenCalled();
			const tools = mockMcpServer.handleSetupRequest.mock.calls[0][4];
			expect(tools).toHaveLength(1);
			expect(tools[0].name).toBe(CONNECT_CREDENTIALS_TOOL_NAME);
			expect(tools[0].description).toContain('Downstream MCP OAuth');
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('exposes the connect-credentials placeholder on Streamable HTTP setup when tool building fails and the gate is not ready', async () => {
			setupWebhookContext({ webhookName: 'default' });
			mockMcpServer.getSessionId.mockReturnValue(undefined);
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(notReadyGate);
			(getConnectedTools as Mock).mockRejectedValue(toolBuildError);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handleStreamableHttpSetup).toHaveBeenCalled();
			const tools = mockMcpServer.handleStreamableHttpSetup.mock.calls[0][3];
			expect(tools).toHaveLength(1);
			expect(tools[0].name).toBe(CONNECT_CREDENTIALS_TOOL_NAME);
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('exposes the connect-credentials placeholder on tools/list when tool building fails and the gate is not ready', async () => {
			setupWebhookContext({ webhookName: 'default', rawBody: createListToolsMessage() });
			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(notReadyGate);
			(getConnectedTools as Mock).mockRejectedValue(toolBuildError);

			const result = await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handlePostMessage).toHaveBeenCalled();
			const tools = mockMcpServer.handlePostMessage.mock.calls[0][2] as Tool[];
			expect(tools).toHaveLength(1);
			expect(tools[0].name).toBe(CONNECT_CREDENTIALS_TOOL_NAME);
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('passes the gate result to handlePostMessage for tool calls without re-checking', async () => {
			setupWebhookContext({
				webhookName: 'default',
				rawBody: createValidToolCallMessage('some_tool', {}),
			});
			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(notReadyGate);

			await mcpTrigger.webhook(mockContext);

			expect(mockContext.checkTriggerCredentialStatus).toHaveBeenCalledTimes(1);
			expect(mockMcpServer.handlePostMessage).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.any(Array),
				expect.any(String),
				notReadyGate,
				undefined,
			);
		});

		it('does not pass the gate result to handlePostMessage for non-tool-call messages', async () => {
			setupWebhookContext({ webhookName: 'default', rawBody: createListToolsMessage() });
			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(notReadyGate);

			await mcpTrigger.webhook(mockContext);

			expect(mockMcpServer.handlePostMessage).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.any(Array),
				expect.any(String),
				undefined,
				undefined,
			);
		});

		it('rethrows tool-building errors when the gate is ready', async () => {
			setupWebhookContext({ webhookName: 'setup' });
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(readyGate);
			(getConnectedTools as Mock).mockRejectedValue(toolBuildError);

			await expect(mcpTrigger.webhook(mockContext)).rejects.toThrow(toolBuildError.message);
			expect(mockMcpServer.handleSetupRequest).not.toHaveBeenCalled();
		});

		it('rethrows tool-building errors when there is no gate (no identity or module disabled)', async () => {
			setupWebhookContext({ webhookName: 'setup' });
			mockContext.checkTriggerCredentialStatus.mockResolvedValue(undefined);
			(getConnectedTools as Mock).mockRejectedValue(toolBuildError);

			await expect(mcpTrigger.webhook(mockContext)).rejects.toThrow(toolBuildError.message);
			expect(mockMcpServer.handleSetupRequest).not.toHaveBeenCalled();
		});
	});

	describe('list tools relay', () => {
		it('should return list tools relay data when needed', async () => {
			// Reset validateWebhookAuthentication to resolve (not reject)
			validateWebhookAuthenticationMock.mockResolvedValue(undefined);

			const req = createMockRequest({ method: 'POST', query: { sessionId: 'test-session' } });
			const resp = createMockResponse();
			const node = mock<INode>({
				typeVersion: 2,
				name: 'MCP Server Trigger',
			});

			mockMcpServer.getSessionId.mockReturnValue('test-session');
			mockMcpServer.handlePostMessage.mockResolvedValue({
				wasToolCall: false,
				toolCallInfo: undefined,
				messageId: 'msg-456',
				relaySessionId: 'relay-session-789',
				needsListToolsRelay: true,
			});

			mockContext.getWebhookName.mockReturnValue('default');
			mockContext.getRequestObject.mockReturnValue(req as never);
			mockContext.getResponseObject.mockReturnValue(resp as never);
			mockContext.getNode.mockReturnValue(node);

			const result = await mcpTrigger.webhook(mockContext);

			expect(result).toEqual({
				noWebhookResponse: true,
				workflowData: [
					[
						{
							json: {
								mcpListToolsRelay: {
									sessionId: 'relay-session-789',
									messageId: 'msg-456',
									marker: 'mcp_list_tools_request',
								},
							},
						},
					],
				],
			});
		});
	});
});
