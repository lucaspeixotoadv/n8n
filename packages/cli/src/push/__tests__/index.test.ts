import type { PushMessage } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import { mockInstance } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import type { Application } from 'express';
import type { InstanceSettings } from 'n8n-core';
import type { Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { MockInstance } from 'vitest';
import { captor, mock } from 'vitest-mock-extended';
import { type WebSocket, Server as WSServer } from 'ws';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { Push } from '@/push';
import { ExecutionSubscriptionRegistry } from '@/push/execution-subscription.registry';
import { SSEPush } from '@/push/sse.push';
import type { WebSocketPushRequest, SSEPushRequest, PushResponse } from '@/push/types';
import { WebSocketPush } from '@/push/websocket.push';
import type { Publisher } from '@/scaling/pubsub/publisher.service';

import type { PushConfig } from '../push.config';

vi.mock('ws', async () => ({
	Server: vi.fn(),
}));
vi.unmock('@/push');
vi.mock('@n8n/backend-common', async () => {
	return {
		...(await vi.importActual<typeof import('@n8n/backend-common')>('@n8n/backend-common')),
		inProduction: true,
	};
});

describe('Push', () => {
	const pushRef = 'valid-push-ref';
	const host = 'example.com';
	const user = mock<User>({ id: 'user-id' });
	const config = mock<PushConfig>();
	const logger = mock<Logger>();

	let push: Push;
	const sseBackend = mockInstance(SSEPush);
	const wsBackend = mockInstance(WebSocketPush);

	beforeEach(() => {
		vi.resetAllMocks();
		logger.scoped.mockReturnValue(logger);
	});

	describe('setupPushServer', () => {
		const restEndpoint = 'rest';
		const app = mock<Application>();
		const server = mock<Server>();
		// @ts-expect-error `vi.spyOn` typings don't allow `constructor`
		const wssSpy = vi.spyOn(WSServer.prototype, 'constructor') as MockInstance<WSServer>;

		describe('sse backend', () => {
			test('should not create a WebSocket server', () => {
				config.backend = 'sse';
				push = new Push(config, mock(), logger, mock(), mock(), mock());

				push.setupPushServer(restEndpoint, server, app);

				expect(wssSpy).not.toHaveBeenCalled();
				expect(server.on).not.toHaveBeenCalled();
			});
		});

		describe('websocket backend', () => {
			let onUpgrade: (request: WebSocketPushRequest, socket: Socket, head: Buffer) => void;
			const wsServer = mock<WSServer>();
			const socket = mock<Socket>();
			const upgradeHead = mock<Buffer>();

			beforeEach(() => {
				config.backend = 'websocket';
				push = new Push(config, mock(), logger, mock(), mock(), mock());
				// `new WSServer()` constructs the mock; return the stub from a function.
				wssSpy.mockImplementation(function () {
					return wsServer;
				} as never);

				push.setupPushServer(restEndpoint, server, app);

				expect(wssSpy).toHaveBeenCalledWith({ noServer: true });
				const onUpgradeCaptor = captor<typeof onUpgrade>();
				expect(server.on).toHaveBeenCalledWith('upgrade', onUpgradeCaptor);
				onUpgrade = onUpgradeCaptor.value;
			});

			test('should not upgrade non-push urls', () => {
				const request = mock<WebSocketPushRequest>({ url: '/rest/testing' });

				onUpgrade(request, socket, upgradeHead);

				expect(wsServer.handleUpgrade).not.toHaveBeenCalled();
			});

			test('should upgrade push url, and route it to express', () => {
				const request = mock<WebSocketPushRequest>({ url: '/rest/push' });

				onUpgrade(request, socket, upgradeHead);

				const handleUpgradeCaptor = captor<(ws: WebSocket) => void>();
				expect(wsServer.handleUpgrade).toHaveBeenCalledWith(
					request,
					socket,
					upgradeHead,
					handleUpgradeCaptor,
				);

				const ws = mock<WebSocket>();
				handleUpgradeCaptor.value(ws);

				expect(request.ws).toBe(ws);

				const serverResponseCaptor = captor<ServerResponse>();
				// @ts-expect-error `handle` isn't documented
				expect(app.handle).toHaveBeenCalledWith(request, serverResponseCaptor);

				serverResponseCaptor.value.writeHead(200);
				expect(ws.close).not.toHaveBeenCalled();

				serverResponseCaptor.value.writeHead(404);
				expect(ws.close).toHaveBeenCalled();
			});
		});
	});

	describe('handleRequest', () => {
		const backendNames = ['sse', 'websocket'] as const;
		let req: ReturnType<typeof mock<SSEPushRequest | WebSocketPushRequest>>;
		let res: ReturnType<typeof mock<PushResponse>>;
		let ws: ReturnType<typeof mock<WebSocket>>;

		beforeEach(() => {
			req = mock<SSEPushRequest | WebSocketPushRequest>({ user });
			res = mock<PushResponse>();
			ws = mock<WebSocket>();

			res.status.mockReturnThis();

			req.headers.host = host;
			req.headers.origin = `https://${host}`;
			req.query = { pushRef };
		});

		describe.each(backendNames)('%s backend', (backendName) => {
			const backend = backendName === 'sse' ? sseBackend : wsBackend;

			beforeEach(() => {
				config.backend = backendName;
				push = new Push(config, mock(), logger, mock(), mock(), mock());
				req.ws = backendName === 'sse' ? undefined : ws;
			});

			describe('should throw on invalid origin', () => {
				test.each([
					{
						name: 'origin does not match host',
						origin: 'https://123example.com',
						xForwardedHost: undefined,
					},
					{
						name: 'origin does not match host (subdomain)',
						origin: `https://subdomain.${host}`,
						xForwardedHost: undefined,
					},
					{
						name: 'origin does not match x-forwarded-host',
						origin: `https://${host}`, // this is correct
						xForwardedHost: '123example.com', // this is not
					},
					{
						name: 'origin does not match x-forwarded-host (subdomain)',
						origin: `https://${host}`, // this is correct
						xForwardedHost: `subdomain.${host}`, // this is not
					},
				])('$name', ({ origin, xForwardedHost }) => {
					req.headers.origin = origin;
					req.headers['x-forwarded-host'] = xForwardedHost;

					if (backendName === 'sse') {
						expect(() => push.handleRequest(req, res)).toThrow(BadRequestError);
						expect(() => push.handleRequest(req, res)).toThrow('Invalid origin!');
					} else {
						push.handleRequest(req, res);
						expect(ws.send).toHaveBeenCalledWith('Invalid origin!');
						expect(ws.close).toHaveBeenCalledWith(1008);
					}
					expect(backend.add).not.toHaveBeenCalled();
				});
			});

			test('should only accept a missing origin header on SSE', () => {
				req.headers = {
					host,
					'sec-fetch-site': 'same-origin',
				} as typeof req.headers;
				const emitSpy = vi.spyOn(push, 'emit');

				push.handleRequest(req, res);

				if (backendName === 'sse') {
					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, { req, res });
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				} else {
					expect(ws.send).toHaveBeenCalledWith('Invalid origin!');
					expect(ws.close).toHaveBeenCalledWith(1008);
					expect(backend.add).not.toHaveBeenCalled();
				}
			});

			describe('should not throw on invalid origin if `X-Forwarded-Host` is set correctly', () => {
				test.each([
					{
						name: 'origin matches forward headers (https)',
						origin: `https://${host}`,
						xForwardedHost: host,
					},
					{
						name: 'origin matches forward headers (http)',
						origin: `http://${host}`,
						xForwardedHost: host,
					},
					{
						name: 'origin matches host (https)',
						origin: `https://${host}`,
						xForwardedHost: undefined,
					},
					{
						name: 'origin matches host (http)',
						origin: `http://${host}`,
						xForwardedHost: undefined,
					},
				])('$name', ({ origin, xForwardedHost }) => {
					// ARRANGE
					req.headers.origin = origin;
					req.headers['x-forwarded-host'] = xForwardedHost;

					const emitSpy = vi.spyOn(push, 'emit');
					const connection = backendName === 'sse' ? { req, res } : ws;

					// ACT
					push.handleRequest(req, res);

					// ASSERT
					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				});
			});

			describe('port normalization bug reproduction', () => {
				test.each([
					{
						name: 'HTTPS origin without port should match x-forwarded-host with default HTTPS port (443)',
						origin: `https://${host}`,
						xForwardedHost: `${host}:443`,
						shouldPass: true,
					},
					{
						name: 'HTTP origin without port should match x-forwarded-host with default HTTP port (80)',
						origin: `http://${host}`,
						xForwardedHost: `${host}:80`,
						shouldPass: true,
					},
					{
						name: 'origin with explicit port should match x-forwarded-host with same port',
						origin: `https://${host}:8080`,
						xForwardedHost: `${host}:8080`,
						shouldPass: true,
					},
					{
						name: 'origin without port should NOT match x-forwarded-host with non-default port',
						origin: `https://${host}`,
						xForwardedHost: `${host}:8080`,
						shouldPass: false,
					},
				])('$name', ({ origin, xForwardedHost, shouldPass }) => {
					// ARRANGE
					req.headers.origin = origin;
					req.headers['x-forwarded-host'] = xForwardedHost;

					if (shouldPass) {
						// Expected behavior: connection should be established
						const emitSpy = vi.spyOn(push, 'emit');
						const connection = backendName === 'sse' ? { req, res } : ws;

						// ACT
						push.handleRequest(req, res);

						// ASSERT
						expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
						expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
					} else {
						// Expected behavior: connection should be rejected
						if (backendName === 'sse') {
							expect(() => push.handleRequest(req, res)).toThrow(BadRequestError);
							expect(() => push.handleRequest(req, res)).toThrow('Invalid origin!');
						} else {
							push.handleRequest(req, res);
							expect(ws.send).toHaveBeenCalledWith('Invalid origin!');
							expect(ws.close).toHaveBeenCalledWith(1008);
						}
						expect(backend.add).not.toHaveBeenCalled();
					}
				});
			});

			test('should throw if pushRef is invalid', () => {
				req.query = { pushRef: '' };

				if (backendName === 'sse') {
					expect(() => push.handleRequest(req, res)).toThrow(BadRequestError);
					expect(() => push.handleRequest(req, res)).toThrow(
						'The query parameter "pushRef" is missing!',
					);
				} else {
					push.handleRequest(req, mock());
					expect(ws.send).toHaveBeenCalled();
					expect(ws.close).toHaveBeenCalledWith(1008);
				}
				expect(backend.add).not.toHaveBeenCalled();
			});

			test('should add the connection if pushRef is valid', () => {
				const emitSpy = vi.spyOn(push, 'emit');

				push.handleRequest(req, res);

				const connection = backendName === 'sse' ? { req, res } : ws;
				expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
				expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
			});

			if (backendName === 'websocket') {
				test('should respond with 401 if request is not WebSocket', () => {
					req.ws = undefined;

					push.handleRequest(req, res);

					expect(res.status).toHaveBeenCalledWith(401);
					expect(res.send).toHaveBeenCalledWith('Unauthorized');
					expect(backend.add).not.toHaveBeenCalled();
				});
			}

			describe('additional edge cases', () => {
				test('should handle array x-forwarded-host header (use first)', () => {
					req.headers['x-forwarded-host'] = [host, 'other-host.com'] as any;
					req.headers.origin = `https://${host}`;

					const emitSpy = vi.spyOn(push, 'emit');
					const connection = backendName === 'sse' ? { req, res } : ws;

					push.handleRequest(req, res);

					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				});

				test('should handle Forwarded header with precedence over x-forwarded-*', () => {
					req.headers.forwarded = `proto=https;host=${host}`;
					req.headers['x-forwarded-host'] = 'wrong-host.com'; // Should be ignored
					req.headers.origin = `https://${host}`;

					const emitSpy = vi.spyOn(push, 'emit');
					const connection = backendName === 'sse' ? { req, res } : ws;

					push.handleRequest(req, res);

					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				});

				test('should normalize default ports in Forwarded header', () => {
					req.headers.forwarded = `proto=https;host=${host}:443`;
					req.headers.origin = `https://${host}`;

					const emitSpy = vi.spyOn(push, 'emit');
					const connection = backendName === 'sse' ? { req, res } : ws;

					push.handleRequest(req, res);

					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				});

				test('should handle IPv6 addresses correctly', () => {
					req.headers.origin = 'https://[::1]:443';
					req.headers['x-forwarded-host'] = '[::1]:443';

					const emitSpy = vi.spyOn(push, 'emit');
					const connection = backendName === 'sse' ? { req, res } : ws;

					push.handleRequest(req, res);

					expect(backend.add).toHaveBeenCalledWith(pushRef, user.id, connection);
					expect(emitSpy).toHaveBeenCalledWith('editorUiConnected', pushRef);
				});
			});
		});
	});

	describe('sendToExecution', () => {
		const executionId = 'execution-id';
		const pushMsg = mock<PushMessage>({ type: 'executionStarted' });
		const publisher = mock<Publisher>();

		let subscriptions: ExecutionSubscriptionRegistry;
		let instanceSettings: InstanceSettings;

		const buildPush = () => {
			subscriptions = new ExecutionSubscriptionRegistry();
			push = new Push(config, instanceSettings, logger, mock(), publisher, subscriptions);
		};

		beforeEach(() => {
			config.backend = 'websocket';
			instanceSettings = mock<InstanceSettings>({ isWorker: false, isMultiMain: false });
			buildPush();
		});

		test('should send to every session watching the execution', () => {
			subscriptions.subscribe(executionId, 'watcher-1');
			subscriptions.subscribe(executionId, 'watcher-2');

			push.sendToExecution(executionId, pushMsg);

			expect(wsBackend.sendToOne).toHaveBeenCalledWith(pushMsg, 'watcher-1', false);
			expect(wsBackend.sendToOne).toHaveBeenCalledWith(pushMsg, 'watcher-2', false);
		});

		test('should send to the originating session even if it does not watch', () => {
			wsBackend.hasPushRef.mockReturnValue(true);

			push.sendToExecution(executionId, pushMsg, 'origin-ref');

			expect(wsBackend.sendToOne).toHaveBeenCalledExactlyOnceWith(pushMsg, 'origin-ref', false);
		});

		test('should send only once to a session that both watches and originated', () => {
			wsBackend.hasPushRef.mockReturnValue(true);
			subscriptions.subscribe(executionId, 'origin-ref');

			push.sendToExecution(executionId, pushMsg, 'origin-ref');

			expect(wsBackend.sendToOne).toHaveBeenCalledExactlyOnceWith(pushMsg, 'origin-ref', false);
		});

		test('should skip an originating session held by another instance', () => {
			wsBackend.hasPushRef.mockReturnValue(false);

			push.sendToExecution(executionId, pushMsg, 'origin-ref');

			expect(wsBackend.sendToOne).not.toHaveBeenCalled();
			expect(publisher.publishCommand).not.toHaveBeenCalled();
		});

		test('should relay via pubsub from a worker, which holds no session', () => {
			instanceSettings = mock<InstanceSettings>({ isWorker: true, isMultiMain: false });
			buildPush();

			push.sendToExecution(executionId, pushMsg, 'origin-ref');

			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'relay-execution-lifecycle-event',
				payload: { ...pushMsg, pushRef: 'origin-ref', asBinary: false, executionId },
			});
		});
	});

	describe('handleRelayExecutionLifecycleEvent', () => {
		const executionId = 'execution-id';
		const instanceSettings = mock<InstanceSettings>({ isWorker: false, isMultiMain: true });

		let subscriptions: ExecutionSubscriptionRegistry;

		beforeEach(() => {
			config.backend = 'websocket';
			subscriptions = new ExecutionSubscriptionRegistry();
			push = new Push(config, instanceSettings, logger, mock(), mock(), subscriptions);
		});

		test('should deliver a relayed event to the sessions this instance holds', () => {
			subscriptions.subscribe(executionId, 'watcher-1');
			wsBackend.hasPushRef.mockReturnValue(false);

			push.handleRelayExecutionLifecycleEvent({
				type: 'executionStarted',
				data: mock(),
				pushRef: 'origin-on-another-main',
				asBinary: false,
				executionId,
			});

			expect(wsBackend.sendToOne).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ type: 'executionStarted' }),
				'watcher-1',
				false,
			);
		});

		test('should drop a relayed event with no local session for the execution', () => {
			wsBackend.hasPushRef.mockReturnValue(false);

			push.handleRelayExecutionLifecycleEvent({
				type: 'executionStarted',
				data: mock(),
				pushRef: 'origin-on-another-main',
				asBinary: false,
				executionId,
			});

			expect(wsBackend.sendToOne).not.toHaveBeenCalled();
		});
	});

	describe('disconnect', () => {
		test('should drop the subscriptions of a session that goes away', () => {
			config.backend = 'websocket';
			const subscriptions = new ExecutionSubscriptionRegistry();
			const unsubscribeAll = vi.spyOn(subscriptions, 'unsubscribeAll');

			push = new Push(config, mock(), logger, mock(), mock(), subscriptions);

			const listener = captor<(pushRef: string) => void>();
			expect(wsBackend.on).toHaveBeenCalledWith('disconnected', listener);

			const emitSpy = vi.spyOn(push, 'emit');
			listener.value('gone-ref');

			expect(unsubscribeAll).toHaveBeenCalledWith('gone-ref');
			expect(emitSpy).toHaveBeenCalledWith('disconnected', 'gone-ref');
		});
	});
});
