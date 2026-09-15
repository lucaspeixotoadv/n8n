import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type { IExecutionResponse, User, UserRepository } from '@n8n/db';
import { stringify } from 'flatted';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { ExecutionPersistence } from '@/executions/execution-persistence';
import type { ExecutionRedactionServiceProxy } from '@/executions/execution-redaction-proxy.service';
import type { ExecutionSnapshotService } from '@/executions/execution-snapshot.service';
import type { Push } from '@/push';
import { ExecutionSubscriptionRegistry } from '@/push/execution-subscription.registry';
import { ExecutionSubscriptionService } from '@/push/execution-subscription.service';
import type { Publisher } from '@/scaling/pubsub/publisher.service';
import type { WorkflowSharingService } from '@/workflows/workflow-sharing.service';

describe('ExecutionSubscriptionService', () => {
	const pushRef = 'push-ref';
	const userId = 'user-id';
	const executionId = 'execution-id';
	const user = mock<User>({ id: userId });

	const logger = mock<Logger>();
	const push = mock<Push>();
	const executionPersistence = mock<ExecutionPersistence>();
	const workflowSharingService = mock<WorkflowSharingService>();
	const userRepository = mock<UserRepository>();
	const executionSnapshotService = mock<ExecutionSnapshotService>();
	const executionRedactionServiceProxy = mock<ExecutionRedactionServiceProxy>();
	const globalConfig = mock<GlobalConfig>({ executions: { maxDisplaySize: 1024 } } as never);
	const publisher = mock<Publisher>();

	const runData = { Node: [{ executionIndex: 0, startTime: 1, executionTime: 1, source: [] }] };

	/** A running execution as the persistence layer hands it over, with its run data. */
	const execution = (overrides: Partial<IExecutionResponse> = {}) =>
		({
			id: executionId,
			workflowId: 'workflow-id',
			status: 'running',
			data: { resultData: { runData } },
			...overrides,
		}) as IExecutionResponse;

	let registry: ExecutionSubscriptionRegistry;
	let service: ExecutionSubscriptionService;
	let instanceSettings: InstanceSettings;

	const build = (settings: Partial<InstanceSettings> = {}) => {
		instanceSettings = mock<InstanceSettings>({ isMultiMain: false, ...settings });
		registry = new ExecutionSubscriptionRegistry();
		service = new ExecutionSubscriptionService(
			logger,
			push,
			registry,
			executionPersistence,
			workflowSharingService,
			userRepository,
			executionSnapshotService,
			executionRedactionServiceProxy,
			globalConfig,
			instanceSettings,
			publisher,
		);
	};

	beforeEach(() => {
		vi.resetAllMocks();
		logger.scoped.mockReturnValue(logger);
		// The session is connected here unless a test says otherwise.
		push.hasPushRef.mockReturnValue(true);
		// The snapshot and redaction steps pass the execution through unless a test says otherwise.
		executionSnapshotService.progress.mockImplementation(async (e) => ({
			execution: e,
			executingNodes: [],
		}));
		executionRedactionServiceProxy.processExecution.mockImplementation(async (e) => e);
		build();
	});

	const allowAccess = (found: IExecutionResponse = execution()) => {
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
		executionPersistence.findOneInWorkflows.mockResolvedValue(found);
	};

	test('registers a subscription for a user who may read the execution', async () => {
		allowAccess();

		await service.subscribe(user, executionId, pushRef);

		expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
		expect(workflowSharingService.getSharedWorkflowIds).toHaveBeenCalledWith(user, {
			scopes: ['workflow:read'],
		});
		expect(executionPersistence.findOneInWorkflows).toHaveBeenCalledWith(
			executionId,
			['workflow-id'],
			{ includeData: true, includeAnnotation: false, maxDataSizeBytes: 1024 },
		);
	});

	describe('the snapshot a subscription starts with', () => {
		test('is sent to the subscriber once it is registered, and after that', async () => {
			allowAccess();
			const order: string[] = [];
			const subscribe = registry.subscribe.bind(registry);
			vi.spyOn(registry, 'subscribe').mockImplementation((...args) => {
				order.push('subscribe');
				subscribe(...args);
			});
			push.send.mockImplementation(() => order.push('snapshot'));

			await service.subscribe(user, executionId, pushRef);

			expect(order).toEqual(['subscribe', 'snapshot']);
			expect(push.send).toHaveBeenCalledExactlyOnceWith(
				{
					type: 'executionSnapshot',
					data: {
						executionId,
						workflowId: 'workflow-id',
						status: 'running',
						flattedRunData: stringify(runData),
					},
				},
				pushRef,
			);
		});

		test('carries the state completed from the journal and redacted for the subscriber', async () => {
			const found = execution();
			allowAccess(found);
			const completed = execution({
				data: { resultData: { runData: { ...runData, Later: [] } } } as never,
			});
			const redacted = execution({
				data: { resultData: { runData: { Redacted: [] } } } as never,
			});
			executionSnapshotService.progress.mockResolvedValue({
				execution: completed,
				executingNodes: [],
			});
			executionRedactionServiceProxy.processExecution.mockResolvedValue(redacted);

			await service.subscribe(user, executionId, pushRef);

			expect(executionSnapshotService.progress).toHaveBeenCalledWith(found);
			expect(executionRedactionServiceProxy.processExecution).toHaveBeenCalledWith(
				completed,
				expect.objectContaining({ user }),
			);
			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ flattedRunData: stringify({ Redacted: [] }) }),
				}),
				pushRef,
			);
		});

		test('names the node the execution is on, with the number its own start event carried', async () => {
			allowAccess();
			const started = { startTime: 1, executionIndex: 4, source: [] };
			executionSnapshotService.progress.mockResolvedValue({
				execution: execution(),
				executingNodes: [{ nodeName: 'Agent', data: started }],
			});

			await service.subscribe(user, executionId, pushRef);

			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						executingNodes: [{ nodeName: 'Agent', sequenceNumber: 8, data: started }],
					}),
				}),
				pushRef,
			);
		});

		test('leaves out run data that is too large to display', async () => {
			allowAccess(execution({ dataTooLargeToDisplay: true }));

			await service.subscribe(user, executionId, pushRef);

			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'executionSnapshot',
					data: expect.not.objectContaining({ flattedRunData: expect.anything() }),
				}),
				pushRef,
			);
			expect(executionRedactionServiceProxy.processExecution).not.toHaveBeenCalled();
		});

		test('leaves out run data of an execution that has none yet', async () => {
			allowAccess(execution({ status: 'new', data: undefined }));

			await service.subscribe(user, executionId, pushRef);

			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: 'new' }),
				}),
				pushRef,
			);
			expect(
				(push.send.mock.calls[0][0] as { data: Record<string, unknown> }).data,
			).not.toHaveProperty('flattedRunData');
		});

		test('keeps the subscription when the snapshot cannot be built', async () => {
			allowAccess();
			executionSnapshotService.progress.mockRejectedValue(new Error('journal unavailable'));

			await service.subscribe(user, executionId, pushRef);

			expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
			expect(push.send).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalled();
		});

		test('is sent again to a session that subscribes to an execution it already receives', async () => {
			allowAccess();

			await service.subscribe(user, executionId, pushRef);
			await service.subscribe(user, executionId, pushRef);

			expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
			expect(push.send).toHaveBeenCalledTimes(2);
		});
	});

	test('refuses as not found when the execution is out of the user’s reach', async () => {
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
		executionPersistence.findOneInWorkflows.mockResolvedValue(undefined);

		await expect(service.subscribe(user, executionId, pushRef)).rejects.toThrow(NotFoundError);

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(push.send).not.toHaveBeenCalled();
	});

	test('refuses when the user shares no workflow at all', async () => {
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue([]);

		await expect(service.subscribe(user, executionId, pushRef)).rejects.toThrow(NotFoundError);

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(executionPersistence.findOneInWorkflows).not.toHaveBeenCalled();
	});

	test('removes a subscription without checking entitlement again', async () => {
		allowAccess();
		await service.subscribe(user, executionId, pushRef);

		vi.resetAllMocks();
		logger.scoped.mockReturnValue(logger);
		push.hasPushRef.mockReturnValue(true);

		await service.unsubscribe(executionId, pushRef);

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(workflowSharingService.getSharedWorkflowIds).not.toHaveBeenCalled();
	});

	test('keeps each session’s subscriptions apart', async () => {
		allowAccess();

		await service.subscribe(user, executionId, 'tab-1');
		await service.subscribe(user, executionId, 'tab-2');
		await service.unsubscribe(executionId, 'tab-1');

		expect(registry.subscribersOf(executionId)).toEqual(['tab-2']);
	});

	describe('a session that is not connected to this instance', () => {
		beforeEach(() => {
			push.hasPushRef.mockReturnValue(false);
		});

		test('is ignored on a single main, which it reaches again when it reconnects', async () => {
			allowAccess();

			await service.subscribe(user, executionId, pushRef);
			await service.unsubscribe(executionId, pushRef);

			expect(registry.subscribersOf(executionId)).toEqual([]);
			expect(push.send).not.toHaveBeenCalled();
			expect(publisher.publishCommand).not.toHaveBeenCalled();
		});

		test('is relayed to the other mains, once the entitlement is checked here', async () => {
			build({ isMultiMain: true });
			allowAccess();

			await service.subscribe(user, executionId, pushRef);

			expect(registry.subscribersOf(executionId)).toEqual([]);
			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'relay-execution-subscription',
				payload: { action: 'subscribe', executionId, pushRef, userId },
			});
		});

		test('is not relayed when the entitlement check fails', async () => {
			build({ isMultiMain: true });
			workflowSharingService.getSharedWorkflowIds.mockResolvedValue([]);

			await expect(service.subscribe(user, executionId, pushRef)).rejects.toThrow(NotFoundError);

			expect(publisher.publishCommand).not.toHaveBeenCalled();
		});

		test('has its release relayed too', async () => {
			build({ isMultiMain: true });

			await service.unsubscribe(executionId, pushRef);

			expect(publisher.publishCommand).toHaveBeenCalledWith({
				command: 'relay-execution-subscription',
				payload: { action: 'unsubscribe', executionId, pushRef },
			});
		});
	});

	describe('a relayed subscription', () => {
		test('is registered on the main that holds the session, which then sends the snapshot', async () => {
			allowAccess();
			userRepository.findOne.mockResolvedValue(user);

			await service.handleRelayedSubscription({
				action: 'subscribe',
				executionId,
				pushRef,
				userId,
			});

			expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'executionSnapshot' }),
				pushRef,
			);
		});

		test('is ignored by a main that does not hold the session', async () => {
			push.hasPushRef.mockReturnValue(false);

			await service.handleRelayedSubscription({
				action: 'subscribe',
				executionId,
				pushRef,
				userId,
			});

			expect(registry.subscribersOf(executionId)).toEqual([]);
			expect(userRepository.findOne).not.toHaveBeenCalled();
		});

		test('is released on the main that holds the session', async () => {
			registry.subscribe(executionId, pushRef);

			await service.handleRelayedSubscription({ action: 'unsubscribe', executionId, pushRef });

			expect(registry.subscribersOf(executionId)).toEqual([]);
		});
	});
});
