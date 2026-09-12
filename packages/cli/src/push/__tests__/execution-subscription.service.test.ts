import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type { IExecutionResponse, User, UserRepository } from '@n8n/db';
import { stringify } from 'flatted';
import { mock } from 'vitest-mock-extended';

import type { ExecutionPersistence } from '@/executions/execution-persistence';
import type { ExecutionRedactionServiceProxy } from '@/executions/execution-redaction-proxy.service';
import type { ExecutionSnapshotService } from '@/executions/execution-snapshot.service';
import type { Push } from '@/push';
import { ExecutionSubscriptionRegistry } from '@/push/execution-subscription.registry';
import { ExecutionSubscriptionService } from '@/push/execution-subscription.service';
import type { OnPushMessage } from '@/push/types';
import type { WorkflowSharingService } from '@/workflows/workflow-sharing.service';

describe('ExecutionSubscriptionService', () => {
	const pushRef = 'push-ref';
	const userId = 'user-id';
	const executionId = 'execution-id';

	const logger = mock<Logger>();
	const push = mock<Push>();
	const executionPersistence = mock<ExecutionPersistence>();
	const workflowSharingService = mock<WorkflowSharingService>();
	const userRepository = mock<UserRepository>();
	const executionSnapshotService = mock<ExecutionSnapshotService>();
	const executionRedactionServiceProxy = mock<ExecutionRedactionServiceProxy>();
	const globalConfig = mock<GlobalConfig>({ executions: { maxDisplaySize: 1024 } } as never);

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
	/** The listener the service registers on the push service. */
	let onMessage: (event: OnPushMessage) => void;

	/** Runs the handler and lets its promise chain settle. */
	const deliver = async (msg: unknown, overrides: Partial<OnPushMessage> = {}) => {
		onMessage({ pushRef, userId, msg, ...overrides });
		await new Promise(setImmediate);
	};

	beforeEach(() => {
		vi.resetAllMocks();
		logger.scoped.mockReturnValue(logger);

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
		);
		// The snapshot and redaction steps pass the execution through unless a test says otherwise.
		executionSnapshotService.complete.mockImplementation(async (e) => e);
		executionRedactionServiceProxy.processExecution.mockImplementation(async (e) => e);

		push.on.mockImplementation((event, listener) => {
			if (event === 'message') onMessage = listener as (event: OnPushMessage) => void;
			return push;
		});

		service.init();
	});

	const allowAccess = (found: IExecutionResponse = execution()) => {
		userRepository.findOne.mockResolvedValue(mock<User>({ id: userId }));
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
		executionPersistence.findOneInWorkflows.mockResolvedValue(found);
	};

	test('registers a subscription for a user who may read the execution', async () => {
		allowAccess();

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
		expect(workflowSharingService.getSharedWorkflowIds).toHaveBeenCalledWith(expect.anything(), {
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

			await deliver({ type: 'subscribeToExecution', executionId });

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
			executionSnapshotService.complete.mockResolvedValue(completed);
			executionRedactionServiceProxy.processExecution.mockResolvedValue(redacted);

			await deliver({ type: 'subscribeToExecution', executionId });

			expect(executionSnapshotService.complete).toHaveBeenCalledWith(found);
			expect(executionRedactionServiceProxy.processExecution).toHaveBeenCalledWith(
				completed,
				expect.objectContaining({ user: expect.objectContaining({ id: userId }) }),
			);
			expect(push.send).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ flattedRunData: stringify({ Redacted: [] }) }),
				}),
				pushRef,
			);
		});

		test('leaves out run data that is too large to display', async () => {
			allowAccess(execution({ dataTooLargeToDisplay: true }));

			await deliver({ type: 'subscribeToExecution', executionId });

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

			await deliver({ type: 'subscribeToExecution', executionId });

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

		test('is not sent to a subscriber who was refused', async () => {
			userRepository.findOne.mockResolvedValue(mock<User>({ id: userId }));
			workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
			executionPersistence.findOneInWorkflows.mockResolvedValue(undefined);

			await deliver({ type: 'subscribeToExecution', executionId });

			expect(push.send).not.toHaveBeenCalled();
		});

		test('keeps the subscription when the snapshot cannot be built', async () => {
			allowAccess();
			executionSnapshotService.complete.mockRejectedValue(new Error('journal unavailable'));

			await deliver({ type: 'subscribeToExecution', executionId });

			expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
			expect(push.send).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalled();
		});
	});

	test('refuses silently when the execution is out of the user’s reach', async () => {
		userRepository.findOne.mockResolvedValue(mock<User>({ id: userId }));
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
		executionPersistence.findOneInWorkflows.mockResolvedValue(undefined);

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([]);
	});

	test('refuses when the user shares no workflow at all', async () => {
		userRepository.findOne.mockResolvedValue(mock<User>({ id: userId }));
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue([]);

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(executionPersistence.findOneInWorkflows).not.toHaveBeenCalled();
	});

	test('refuses when the user no longer exists', async () => {
		userRepository.findOne.mockResolvedValue(null);

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(workflowSharingService.getSharedWorkflowIds).not.toHaveBeenCalled();
	});

	test('removes a subscription without checking entitlement again', async () => {
		allowAccess();
		await deliver({ type: 'subscribeToExecution', executionId });

		vi.resetAllMocks();
		logger.scoped.mockReturnValue(logger);

		await deliver({ type: 'unsubscribeFromExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(userRepository.findOne).not.toHaveBeenCalled();
	});

	test.each([
		['a message of another kind', { type: 'workflowOpened', workflowId: 'w' }],
		['a message without an execution id', { type: 'subscribeToExecution' }],
		['a message with an empty execution id', { type: 'subscribeToExecution', executionId: '' }],
		['a primitive', 'subscribeToExecution'],
		['null', null],
	])('ignores %s', async (_label, msg) => {
		await deliver(msg);

		expect(userRepository.findOne).not.toHaveBeenCalled();
		expect(registry.subscribersOf(executionId)).toEqual([]);
	});

	test('keeps running when entitlement lookup fails', async () => {
		userRepository.findOne.mockRejectedValue(new Error('db is down'));

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			'Could not handle an execution subscription message',
			expect.objectContaining({ pushRef, error: 'db is down' }),
		);
	});
});
