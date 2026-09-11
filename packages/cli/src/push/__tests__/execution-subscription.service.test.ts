import type { Logger } from '@n8n/backend-common';
import type { IExecutionBase, User, UserRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { ExecutionPersistence } from '@/executions/execution-persistence';
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
		);

		push.on.mockImplementation((event, listener) => {
			if (event === 'message') onMessage = listener as (event: OnPushMessage) => void;
			return push;
		});

		service.init();
	});

	const allowAccess = () => {
		userRepository.findOne.mockResolvedValue(mock<User>({ id: userId }));
		workflowSharingService.getSharedWorkflowIds.mockResolvedValue(['workflow-id']);
		executionPersistence.findOneInWorkflows.mockResolvedValue(mock<IExecutionBase>());
	};

	test('registers a subscription for a user who may read the execution', async () => {
		allowAccess();

		await deliver({ type: 'subscribeToExecution', executionId });

		expect(registry.subscribersOf(executionId)).toEqual([pushRef]);
		expect(workflowSharingService.getSharedWorkflowIds).toHaveBeenCalledWith(expect.anything(), {
			scopes: ['workflow:read'],
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
