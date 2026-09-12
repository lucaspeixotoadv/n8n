import { Logger } from '@n8n/backend-common';
import type { IExecutionResponse } from '@n8n/db';
import { Service } from '@n8n/di';
import type { IDataObject, IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { CallbackWait } from './callback-wait.entity';

import { ExecutionAlreadyResumingError } from '@/errors/execution-already-resuming.error';
import { EventService } from '@/events/event.service';
import { ExecutionPersistence } from '@/executions/execution-persistence';
import { OwnershipService } from '@/services/ownership.service';
import { preserveInputOverride } from '@/workflow-helpers';
import { WorkflowRunner } from '@/workflow-runner';

/**
 * Why a resume attempt did not run, when it did not.
 *
 * - `resumed`: the execution was handed back to the runner with the callback body.
 * - `notParkedYet`: the tool call registered its wait but the execution has not been
 *   persisted as waiting yet. Nothing is lost — the claim stays on the row and the
 *   deferred hand-off completes it the moment the execution parks.
 * - `abandoned`: there is no execution left to resume (cancelled, failed, finished, or the
 *   parked node is not the one that registered this wait).
 */
export type CallbackResumeOutcome = 'resumed' | 'notParkedYet' | 'abandoned';

/**
 * Resumes a parked execution with a callback body.
 *
 * The resume deliberately does not go through the waiting-webhook machinery. That path
 * exists to turn a live HTTP request into a node's output, and it is bound to the request
 * that triggered it; here the body is already known and may have arrived long before the
 * execution was ready to be resumed. What is reused instead is the runner's own resume
 * primitive — the same one time-based waits use — which claims the execution row with a
 * compare-and-set so two resumes of one execution cannot both proceed.
 */
@Service()
export class CallbackWaitResumeService {
	constructor(
		private readonly logger: Logger,
		private readonly executionPersistence: ExecutionPersistence,
		private readonly ownershipService: OwnershipService,
		private readonly workflowRunner: WorkflowRunner,
		private readonly eventService: EventService,
	) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	async resume(wait: CallbackWait, payload: IDataObject): Promise<CallbackResumeOutcome> {
		const { executionId } = wait;
		if (!executionId) return 'abandoned';

		const execution = await this.executionPersistence.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});

		if (!execution) return 'abandoned';
		if (execution.finished || execution.data?.resultData?.error) return 'abandoned';
		if (execution.status !== 'waiting') {
			// `running` and `new` mean the tool call registered its wait moments ago and the
			// execution has not been written out yet. Anything else is a dead execution.
			return execution.status === 'running' || execution.status === 'new'
				? 'notParkedYet'
				: 'abandoned';
		}

		if (!this.injectCallbackResult(execution, wait, payload)) return 'abandoned';

		await this.startResume(execution, executionId);

		this.eventService.emit('execution-resumed', {
			executionId,
			workflowId: execution.workflowData.id,
			resumeSource: 'webhook',
			responseAt: new Date(),
		});

		return 'resumed';
	}

	/**
	 * Makes the callback body the parked node's input.
	 *
	 * The node is disabled so it passes that input straight through instead of registering
	 * a second wait, and `rewireOutputLogTo` puts the output on the `ai_tool` channel, which
	 * is exactly where the agent collects the results of the tool calls it asked for. The
	 * agent's own continuation is already on the execution stack underneath, so nothing
	 * about it has to be rebuilt here.
	 *
	 * Clearing `waitTill` is what keeps the engine out of this. While it is set, the engine
	 * runs its own waiting-state handling, which pops the last run of the parked node — the
	 * placeholder `preserveInputOverride` leaves there — so the resumed run would come out
	 * without the arguments the model passed in. The waiting-webhook resume does the same
	 * two steps for the same reason.
	 */
	private injectCallbackResult(
		execution: IExecutionResponse,
		wait: CallbackWait,
		payload: IDataObject,
	): boolean {
		const stackEntry = execution.data.executionData?.nodeExecutionStack?.[0];
		const lastNodeExecuted = execution.data.resultData.lastNodeExecuted;

		// The parked node must be the tool that registered this wait. A mismatch means the
		// execution moved on and the callback no longer has a tool call to resolve.
		if (
			!stackEntry ||
			stackEntry.node.id !== wait.nodeId ||
			lastNodeExecuted !== stackEntry.node.name
		) {
			this.logger.debug('Callback does not match the node the execution is parked on', {
				executionId: wait.executionId,
				nodeId: wait.nodeId,
			});
			return false;
		}

		stackEntry.node.disabled = true;
		execution.data.waitTill = undefined;

		stackEntry.node.rewireOutputLogTo = NodeConnectionTypes.AiTool;
		stackEntry.data.main = [[{ json: payload }]];
		stackEntry.metadata = { ...stackEntry.metadata, forwardAllOutputs: true };

		preserveInputOverride(execution.data.resultData.runData[lastNodeExecuted]);

		return true;
	}

	private async startResume(execution: IExecutionResponse, executionId: string): Promise<void> {
		const workflowId = execution.workflowData.id;
		const project = await this.ownershipService.getWorkflowProjectCached(workflowId);

		const data: IWorkflowExecutionDataProcess = {
			executionMode: execution.mode,
			executionData: execution.data,
			workflowData: execution.workflowData,
			projectId: project.id,
			pushRef: execution.data.pushRef,
			startedAt: execution.startedAt,
		};

		try {
			await this.workflowRunner.run(data, false, false, {
				executionId,
				expectedStatus: 'waiting',
			});
		} catch (error) {
			// Another process claimed the same execution first. Its resume carries the same
			// callback body, so there is nothing left to do here.
			if (error instanceof ExecutionAlreadyResumingError) return;
			throw error;
		}
	}
}
