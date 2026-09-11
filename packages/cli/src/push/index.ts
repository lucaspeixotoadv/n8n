import type { PushMessage } from '@n8n/api-types';
import { inProduction, Logger, TypedEmitter } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { OnPubSubEvent, OnShutdown } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { toMb } from '@n8n/utils/number/bytes';
import type { Application } from 'express';
import { ServerResponse } from 'http';
import type { Server } from 'http';
import pick from 'lodash/pick';
import { InstanceSettings } from 'n8n-core';
import { parse as parseUrl } from 'url';
import { Server as WSServer } from 'ws';

import { AuthService } from '@/auth/auth.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { MAX_PUBSUB_PAYLOAD_BYTES } from '@/scaling/constants';
import { Publisher } from '@/scaling/pubsub/publisher.service';

import { ExecutionSubscriptionRegistry } from './execution-subscription.registry';
import { validateSseOrigin, validateWebSocketOrigin } from './origin-validator';
import { isPushResponse, isSSEPushRequest, isWebSocketPushRequest } from './push-helpers';
import { PushConfig } from './push.config';
import { SSEPush } from './sse.push';
import {
	type OnPushMessage,
	type PushResponse,
	type SSEPushRequest,
	type WebSocketPushRequest,
} from './types';
import { WebSocketPush } from './websocket.push';

type PushEvents = {
	editorUiConnected: string;
	message: OnPushMessage;
	disconnected: string;
};

/**
 * Push service for uni- or bi-directional communication with frontend clients.
 * Uses either server-sent events (SSE, unidirectional from backend --> frontend)
 * or WebSocket (bidirectional backend <--> frontend) depending on the configuration.
 *
 * @emits message when a message is received from a client
 */
@Service()
export class Push extends TypedEmitter<PushEvents> {
	private useWebSockets = this.config.backend === 'websocket';

	isBidirectional = this.useWebSockets;

	private backend = this.useWebSockets ? Container.get(WebSocketPush) : Container.get(SSEPush);

	constructor(
		private readonly config: PushConfig,
		private readonly instanceSettings: InstanceSettings,
		private readonly logger: Logger,
		private readonly authService: AuthService,
		private readonly publisher: Publisher,
		private readonly executionSubscriptions: ExecutionSubscriptionRegistry,
	) {
		super();
		this.logger = this.logger.scoped('push');

		if (this.useWebSockets) this.backend.on('message', (msg) => this.emit('message', msg));
		this.backend.on('disconnected', (pushRef) => {
			this.executionSubscriptions.unsubscribeAll(pushRef);
			this.emit('disconnected', pushRef);
		});
	}

	getBackend() {
		return this.backend;
	}

	/** Sets up the main express app to upgrade websocket connections */
	setupPushServer(restEndpoint: string, server: Server, app: Application) {
		if (this.useWebSockets) {
			const wsServer = new WSServer({ noServer: true });
			server.on('upgrade', (request: WebSocketPushRequest, socket, upgradeHead) => {
				if (parseUrl(request.url).pathname === `/${restEndpoint}/push`) {
					wsServer.handleUpgrade(request, socket, upgradeHead, (ws) => {
						request.ws = ws;

						const response = new ServerResponse(request);
						response.writeHead = (statusCode) => {
							if (statusCode > 200) ws.close();
							return response;
						};

						// @ts-expect-error `handle` isn't documented
						// eslint-disable-next-line @typescript-eslint/no-unsafe-call
						app.handle(request, response);
					});
				}
			});
		}
	}

	/** Sets up the push endpoint that the frontend connects to. */
	setupPushHandler(restEndpoint: string, app: Application) {
		app.use(
			`/${restEndpoint}/push`,

			this.authService.createAuthMiddleware({ allowSkipMFA: false }),
			(req, res) => {
				if (!isWebSocketPushRequest(req) && !isSSEPushRequest(req)) {
					throw new BadRequestError('Request is not a PushRequest');
				}
				if (!isPushResponse(res)) {
					throw new InternalServerError('Malformed response object');
				}
				return this.handleRequest(req, res);
			},
		);
	}

	handleRequest(req: SSEPushRequest | WebSocketPushRequest, res: PushResponse) {
		const {
			ws,
			query: { pushRef },
			user,
			headers,
		} = req;

		let connectionError = '';

		if (!pushRef) {
			connectionError = 'The query parameter "pushRef" is missing!';
		} else if (inProduction) {
			const validation = ws ? validateWebSocketOrigin(headers) : validateSseOrigin(headers);
			if (!validation.isValid) {
				this.logger.warn(
					'Origin header does NOT match the expected origin. ' +
						`(Origin: "${headers.origin}" -> "${validation.originInfo?.host || 'N/A'}", ` +
						`Expected: "${validation.rawExpectedHost}" -> "${validation.expectedHost}", ` +
						`Protocol: "${validation.expectedProtocol}")`,
					{
						headers: pick(headers, [
							'host',
							'origin',
							'x-forwarded-proto',
							'x-forwarded-host',
							'forwarded',
						]),
					},
				);
				connectionError = 'Invalid origin!';
			}
		}

		if (connectionError) {
			if (ws) {
				ws.send(connectionError);
				ws.close(1008);
				return;
			}
			throw new BadRequestError(connectionError);
		}

		if (req.ws) {
			(this.backend as WebSocketPush).add(pushRef, user.id, req.ws);
		} else if (!this.useWebSockets) {
			(this.backend as SSEPush).add(pushRef, user.id, { req, res });
		} else {
			res.status(401).send('Unauthorized');
			return;
		}

		this.emit('editorUiConnected', pushRef);
	}

	broadcast(pushMsg: PushMessage) {
		this.backend.sendToAll(pushMsg);
	}

	/** Returns whether a given push ref is registered. */
	hasPushRef(pushRef: string) {
		return this.backend.hasPushRef(pushRef);
	}

	/**
	 * Send a push message to a specific push ref.
	 *
	 * @param asBinary - Whether to send the message as a binary frames or text frames
	 */
	send(pushMsg: PushMessage, pushRef: string, asBinary: boolean = false) {
		if (this.shouldRelayViaPubSub(pushRef)) {
			this.relayViaPubSub(pushMsg, pushRef, asBinary);
			return;
		}

		this.backend.sendToOne(pushMsg, pushRef, asBinary);
	}

	/**
	 * Send an execution's event to everyone entitled to see it: the session that started
	 * the run, if it is still around, and every session watching the execution.
	 *
	 * Addressing by execution rather than by session is what makes an execution observable
	 * on its own terms — by whoever has it open, whether or not they started it, and whether
	 * it was triggered manually, by a webhook or by a schedule. With nobody watching and no
	 * originating session, this costs one map lookup and sends nothing.
	 */
	sendToExecution(
		executionId: string,
		pushMsg: PushMessage,
		originPushRef?: string,
		asBinary: boolean = false,
	) {
		const localRefs = new Set(this.executionSubscriptions.subscribersOf(executionId));
		if (originPushRef && this.hasPushRef(originPushRef)) localRefs.add(originPushRef);

		for (const pushRef of localRefs) {
			this.backend.sendToOne(pushMsg, pushRef, asBinary);
		}

		// Other instances hold their own watchers, and in multi-main the originating session
		// may live on one of them. A worker holds none, so for it this is the only delivery.
		const { isWorker, isMultiMain } = this.instanceSettings;
		if (isWorker || isMultiMain) {
			this.relayViaPubSub(pushMsg, originPushRef ?? '', asBinary, executionId);
		}
	}

	sendToUsers(pushMsg: PushMessage, userIds: Array<User['id']>) {
		this.backend.sendToUsers(pushMsg, userIds);
	}

	@OnShutdown()
	onShutdown() {
		this.backend.closeAllConnections();
	}

	/**
	 * Whether to relay a push message via pubsub channel to other instances,
	 * instead of pushing the message directly to the frontend.
	 *
	 * This is needed in two scenarios:
	 *
	 * In scaling mode, in single- or multi-main setup, in a manual execution, a
	 * worker has no connection to a frontend and so relays to all mains lifecycle
	 * events for manual executions. Only the main who holds the session for the
	 * execution will push to the frontend who commissioned the execution.
	 *
	 * In scaling mode, in multi-main setup, in a manual webhook execution, if
	 * the main who handles a webhook is not the main who created the webhook,
	 * the handler main relays execution lifecycle events to all mains. Only
	 * the main who holds the session for the execution will push events to
	 * the frontend who commissioned the execution.
	 */
	private shouldRelayViaPubSub(pushRef: string) {
		const { isWorker, isMultiMain } = this.instanceSettings;

		return isWorker || (isMultiMain && !this.hasPushRef(pushRef));
	}

	@OnPubSubEvent('relay-execution-lifecycle-event', { instanceType: 'main' })
	handleRelayExecutionLifecycleEvent({
		pushRef,
		asBinary,
		executionId,
		...pushMsg
	}: PushMessage & { asBinary: boolean; pushRef: string; executionId?: string }) {
		// Relayed on behalf of an execution: deliver to the sessions this instance holds,
		// which is the originating one and anyone watching. Every main does the same for its
		// own, so between them the event reaches every entitled session exactly once.
		if (executionId !== undefined) {
			const localRefs = new Set(this.executionSubscriptions.subscribersOf(executionId));
			if (pushRef && this.hasPushRef(pushRef)) localRefs.add(pushRef);

			for (const ref of localRefs) {
				this.backend.sendToOne(pushMsg, ref, asBinary);
			}
			return;
		}

		if (!this.hasPushRef(pushRef)) return;
		this.send(pushMsg, pushRef, asBinary);
	}

	/**
	 * Relay a push message via the `n8n.commands` pubsub channel,
	 * reducing the payload size if too large.
	 *
	 * See {@link shouldRelayViaPubSub} for more details.
	 */
	private relayViaPubSub(
		pushMsg: PushMessage,
		pushRef: string,
		asBinary: boolean = false,
		executionId?: string,
	) {
		const { type } = pushMsg;

		if (type === 'nodeExecuteAfterData') {
			const eventSizeBytes = new TextEncoder().encode(JSON.stringify(pushMsg.data)).length;

			if (eventSizeBytes > MAX_PUBSUB_PAYLOAD_BYTES) {
				const eventMb = toMb(eventSizeBytes);
				const maxMb = toMb(MAX_PUBSUB_PAYLOAD_BYTES);

				this.logger.warn(
					`Size of "${type}" (${eventMb} MB) exceeds max size ${maxMb} MB. Skipping...`,
				);
				// In case of nodeExecuteAfterData, we omit the message entirely. We
				// already include the amount of items in the nodeExecuteAfter message,
				// based on which the FE will construct placeholder data. The actual
				// data is then fetched at the end of the execution.
				return;
			}
		}

		void this.publisher.publishCommand({
			command: 'relay-execution-lifecycle-event',
			payload: { ...pushMsg, pushRef, asBinary, executionId },
		});
	}
}
