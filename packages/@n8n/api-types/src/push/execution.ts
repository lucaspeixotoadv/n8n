import type {
	ExecutionStatus,
	ITaskData,
	ITaskStartedData,
	NodeConnectionType,
	WorkflowExecuteMode,
	WorkflowExecutionSource,
} from 'n8n-workflow';

export type ExecutionStarted = {
	type: 'executionStarted';
	data: {
		executionId: string;
		mode: WorkflowExecuteMode;
		/**
		 * Who initiated the run. Absent for ordinary user runs; `'instance_ai'`
		 * when the AI assistant ran the workflow on the user's behalf.
		 */
		source?: WorkflowExecutionSource;
		startedAt: Date;
		workflowId: string;
		workflowName?: string;
		retryOf?: string;
		flattedRunData: string;
	};
};

/**
 * What an execution has done so far, sent to a session the moment it subscribes to the
 * execution, and before any later event of that execution.
 *
 * The session that started a run gets its baseline inside `executionStarted`; a session
 * that opens a run already in progress gets it here, on the same channel as the events
 * that follow, so nothing can fall between the baseline and the stream. A subscription
 * that is renewed after a lost connection gets a fresh one, which is how the session
 * catches up on what it missed.
 */
export type ExecutionSnapshot = {
	type: 'executionSnapshot';
	data: {
		executionId: string;
		workflowId: string;
		status: ExecutionStatus;
		/**
		 * The run data so far, `flatted`-stringified. Absent when the execution has no run
		 * data yet, or when it is too large to send, in which case the session keeps what it
		 * has and the terminal fetch completes it.
		 */
		flattedRunData?: string;
		/**
		 * The node runs that have started and not finished, in the order they started. Each
		 * carries the `sequenceNumber` its own `nodeExecuteBefore` carried, so the session
		 * can place the events that follow the snapshot relative to it.
		 */
		executingNodes?: Array<{
			nodeName: string;
			sequenceNumber: number;
			data: ITaskStartedData;
		}>;
	};
};

export type ExecutionWaiting = {
	type: 'executionWaiting';
	data: {
		executionId: string;
		source?: WorkflowExecutionSource;
	};
};

export type ExecutionFinished = {
	type: 'executionFinished';
	data: {
		executionId: string;
		workflowId: string;
		status: ExecutionStatus;
		/**
		 * Who initiated the run. Absent for ordinary user runs; `'instance_ai'`
		 * when the AI assistant ran the workflow on the user's behalf.
		 */
		source?: WorkflowExecutionSource;
	};
};

export type ExecutionRecovered = {
	type: 'executionRecovered';
	data: {
		executionId: string;
	};
};

export type AgentNodeCapability =
	| { kind: 'tool'; name: string }
	| { kind: 'skill'; id: string; name?: string }
	| { kind: 'skill'; id?: never; name: string };

export type AgentNodeProgress = {
	type: 'agentNodeProgress';
	data: {
		executionId: string;
		nodeId: string;
		nodeName: string;
		runIndex: number;
		itemIndex: number;
		sequenceNumber: number;
		toolCallId: string;
		capability: AgentNodeCapability;
		status: 'running' | 'succeeded' | 'failed';
	};
};

export type NodeExecuteBefore = {
	type: 'nodeExecuteBefore';
	data: {
		executionId: string;
		nodeName: string;
		/**
		 * Where this event sits in the execution's node-event order. Derived from the
		 * `executionIndex` the engine gave the task, so the start of a task comes before its
		 * end and every task after it carries a higher number, across a resume too. The UI
		 * uses it to drop a node event that arrives late or out of order (e.g. after a
		 * suspended background tab resumes) and to render only the latest node as executing.
		 * The same number is carried by an `executionSnapshot` for a node still running, so
		 * events that follow a snapshot can be placed relative to it.
		 */
		sequenceNumber: number;
		data: ITaskStartedData;
	};
};

/**
 * Message sent after a node has finished executing that contains all that node's data
 * except for the output items which are sent in the `NodeExecuteAfterData` message.
 */
export type NodeExecuteAfter = {
	type: 'nodeExecuteAfter';
	data: {
		executionId: string;
		nodeName: string;
		/** Position in the node-event order — see {@link NodeExecuteBefore}. */
		sequenceNumber: number;
		/**
		 * The data field for task data in `NodeExecuteAfter` is always trimmed (undefined).
		 */
		data: Omit<ITaskData, 'data'>;
		/**
		 * The number of items per output connection type. This is needed so that the frontend
		 * can know how many items to expect when receiving the `NodeExecuteAfterData` message.
		 */
		itemCountByConnectionType: Partial<Record<NodeConnectionType, number[]>>;
	};
};

/**
 * Message sent after a node has finished executing that contains the entire output data
 * of that node. This is sent immediately after `NodeExecuteAfter`.
 */
export type NodeExecuteAfterData = {
	type: 'nodeExecuteAfterData';
	data: {
		executionId: string;
		nodeName: string;
		/**
		 * When a worker relays updates about a manual execution to main, if the
		 * payload size is above a limit, we send only a placeholder to the client.
		 * Later we fetch the entire execution data and fill in any placeholders.
		 */
		data: ITaskData;
		itemCountByConnectionType: NodeExecuteAfter['data']['itemCountByConnectionType'];
	};
};

export type ExecutionPushMessage =
	| ExecutionStarted
	| ExecutionSnapshot
	| ExecutionWaiting
	| ExecutionFinished
	| ExecutionRecovered
	| AgentNodeProgress
	| NodeExecuteBefore
	| NodeExecuteAfter
	| NodeExecuteAfterData;
