import type { Logger } from '@n8n/backend-common';
import type { CallbackWait } from '../callback-wait.entity';
import type { WorkflowExecuteAfterContext } from '@n8n/decorators';
import type { InstanceSettings } from 'n8n-core';
import { WAIT_FOR_CALLBACK_TOOL_TYPE } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { Publisher } from '@/scaling/pubsub/publisher.service';
import { CallbackWaitDeliveryService } from '../callback-wait-delivery.service';
import type { CallbackWaitResumeService } from '../callback-wait-resume.service';
import type { CallbackWaitService } from '../callback-wait.service';

const EXECUTION_ID = 'exec-1';

const undeliveredWait = {
	id: 'row-1',
	executionId: EXECUTION_ID,
	status: 'resuming',
	payload: { id: 125 },
} as unknown as CallbackWait;

function makeContext(status: string, nodeType = WAIT_FOR_CALLBACK_TOOL_TYPE) {
	return {
		executionId: EXECUTION_ID,
		runData: { status },
		workflow: { nodes: [{ type: nodeType }] },
	} as unknown as WorkflowExecuteAfterContext;
}

describe('CallbackWaitDeliveryService', () => {
	const callbackWaitService = mock<CallbackWaitService>();
	const resumeService = mock<CallbackWaitResumeService>();
	const publisher = mock<Publisher>();

	function makeService(isWorker = false) {
		return new CallbackWaitDeliveryService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			callbackWaitService,
			resumeService,
			mock<InstanceSettings>({ isWorker }),
			publisher,
		);
	}

	beforeEach(() => vi.clearAllMocks());

	it('delivers a callback that arrived before the execution had parked', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockResolvedValue('resumed');

		await makeService().handleWorkflowExecuteAfter(makeContext('waiting'));

		expect(resumeService.resume).toHaveBeenCalledWith(undeliveredWait, { id: 125 });
		expect(callbackWaitService.markResolved).toHaveBeenCalledWith('row-1');
	});

	it('never queries the store for a workflow that has no callback tool', async () => {
		await makeService().handleWorkflowExecuteAfter(makeContext('waiting', 'n8n-nodes-base.noOp'));

		expect(callbackWaitService.findUndelivered).not.toHaveBeenCalled();
		expect(callbackWaitService.forgetExecution).not.toHaveBeenCalled();
	});

	it('does nothing when the parked execution has no undelivered callback', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([]);

		await makeService().handleWorkflowExecuteAfter(makeContext('waiting'));

		expect(resumeService.resume).not.toHaveBeenCalled();
	});

	it('releases the correlation keys of an execution that ended without resuming', async () => {
		await makeService().handleWorkflowExecuteAfter(makeContext('canceled'));

		expect(callbackWaitService.forgetExecution).toHaveBeenCalledWith(EXECUTION_ID);
		expect(resumeService.resume).not.toHaveBeenCalled();
	});

	it('relays the delivery to a main instead of resuming from a worker', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);

		await makeService(true).handleWorkflowExecuteAfter(makeContext('waiting'));

		expect(publisher.publishCommand).toHaveBeenCalledWith({
			command: 'deliver-pending-callbacks',
			payload: { executionId: EXECUTION_ID },
		});
		expect(resumeService.resume).not.toHaveBeenCalled();
	});

	it('keeps the claim when the relayed delivery still finds nothing parked', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockResolvedValue('notParkedYet');

		await makeService().handleDeliveryRelay({ executionId: EXECUTION_ID });

		expect(callbackWaitService.markResolved).not.toHaveBeenCalled();
	});

	it('does not let a failing delivery escape into the execution that triggered it', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockRejectedValue(new Error('runner unavailable'));

		await expect(
			makeService().handleWorkflowExecuteAfter(makeContext('waiting')),
		).resolves.toBeUndefined();
	});

	it('gives the claim back when the delivery fails, so a later delivery can retry', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockRejectedValue(new Error('runner unavailable'));

		await makeService().handleWorkflowExecuteAfter(makeContext('waiting'));

		// The same rule the endpoint applies: a row left in `resuming` would turn every later
		// delivery of the event into a no-op and leave the execution parked for good.
		expect(callbackWaitService.releaseClaim).toHaveBeenCalledWith('row-1');
		expect(callbackWaitService.markResolved).not.toHaveBeenCalled();
	});

	it('still swallows the failure when the claim cannot be given back either', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockRejectedValue(new Error('runner unavailable'));
		callbackWaitService.releaseClaim.mockRejectedValue(new Error('database unavailable'));

		await expect(
			makeService().handleWorkflowExecuteAfter(makeContext('waiting')),
		).resolves.toBeUndefined();
	});

	it('resolves a callback whose execution is gone instead of keeping its claim', async () => {
		callbackWaitService.findUndelivered.mockResolvedValue([undeliveredWait]);
		resumeService.resume.mockResolvedValue('abandoned');

		await makeService().handleWorkflowExecuteAfter(makeContext('waiting'));

		expect(callbackWaitService.markResolved).toHaveBeenCalledWith('row-1');
	});
});
