import type { IRunData, ITaskData, Workflow } from 'n8n-workflow';
import { aggregateLlmUsage } from 'n8n-workflow';

/** Whether the node has any sub-node input, i.e. anything that could carry LLM usage below it. */
function hasSubNodeInputs(workflow: Workflow, nodeName: string): boolean {
	const inputs = workflow.connectionsByDestinationNode[nodeName];
	if (!inputs) return false;
	return Object.keys(inputs).some((connectionType) => connectionType !== 'main');
}

/**
 * Publishes the LLM usage aggregate (`own`, `subagents`, `total`) on the task data of a
 * completed node run, computed from the sub-node runs that point to it. Called right before
 * the run is stored, so every child run (LLM calls, sub-agents) is already in `runData`
 * and carries its own published aggregate. A run without LLM usage below it is left as is.
 */
export function stampLlmUsage(
	workflow: Workflow,
	runData: IRunData,
	nodeName: string,
	runIndex: number,
	taskData: ITaskData,
): void {
	if (!hasSubNodeInputs(workflow, nodeName)) return;

	const llmUsage = aggregateLlmUsage(runData, nodeName, runIndex);
	if (llmUsage.total.invocations === 0) return;

	taskData.metadata = { ...taskData.metadata, llmUsage };
}
