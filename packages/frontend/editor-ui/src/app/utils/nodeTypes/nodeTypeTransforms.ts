import {
	NodeConnectionTypes,
	type INodeTypeDescription,
	type NodeConnectionType,
	type OnError,
} from 'n8n-workflow';
import type { NodeTypesByTypeNameAndVersion } from '@/Interface';
import { DEFAULT_NODETYPE_VERSION } from '@/app/constants';
import type { NodeTypesStore } from '@/app/stores/nodeTypes.store';

export type NodeTypeProvider = Pick<NodeTypesStore, 'getNodeType'>;

export function getNodeVersions(nodeType: INodeTypeDescription) {
	return Array.isArray(nodeType.version) ? nodeType.version : [nodeType.version];
}

/**
 * Groups given node types by their name and version
 *
 * @example
 * const nodeTypes = [
 * 	{ name: 'twitter', version: '1', ... },
 * 	{ name: 'twitter', version: '2', ... },
 * ]
 *
 * const groupedNodeTypes = groupNodeTypesByNameAndType(nodeTypes);
 * // {
 * // 	twitter: {
 * // 		1: { name: 'twitter', version: '1', ... },
 * // 		2: { name: 'twitter', version: '2', ... },
 * // 	}
 * // }
 */
export function groupNodeTypesByNameAndType(
	nodeTypes: INodeTypeDescription[],
): NodeTypesByTypeNameAndVersion {
	const groupedNodeTypes = nodeTypes.reduce<NodeTypesByTypeNameAndVersion>((groups, nodeType) => {
		const newNodeVersions = getNodeVersions(nodeType);

		if (newNodeVersions.length === 0) {
			const singleVersion = { [DEFAULT_NODETYPE_VERSION]: nodeType };

			groups[nodeType.name] = singleVersion;
			return groups;
		}

		for (const version of newNodeVersions) {
			// Node exists with the same name
			if (groups[nodeType.name]) {
				groups[nodeType.name][version] = Object.assign(
					groups[nodeType.name][version] ?? {},
					nodeType,
				);
			} else {
				groups[nodeType.name] = Object.assign(groups[nodeType.name] ?? {}, {
					[version]: nodeType,
				});
			}
		}

		return groups;
	}, {});

	return groupedNodeTypes;
}

/**
 * Whether the node type declares an output of the given connection type. Outputs are
 * either a list of types or configurations, or an expression string naming the types the
 * node can produce; both spellings count.
 */
export function nodeTypeHasOutput(
	nodeType: Pick<INodeTypeDescription, 'outputs'> | null | undefined,
	connectionType: NodeConnectionType,
): boolean {
	const outputs = nodeType?.outputs;
	if (outputs === undefined) return false;
	if (typeof outputs === 'string') return outputs.includes(connectionType);

	return outputs.some(
		(output) => (typeof output === 'string' ? output : output.type) === connectionType,
	);
}

/** A node type that runs as an agent tool: it publishes an `ai_tool` output. */
export function isToolNodeType(
	nodeType: Pick<INodeTypeDescription, 'outputs'> | null | undefined,
): boolean {
	return nodeTypeHasOutput(nodeType, NodeConnectionTypes.AiTool);
}

/**
 * The `onError` value a node runs with when none is stored. A tool continues by default:
 * the engine hands the error to the agent as the tool result. Every other node stops.
 * Storing the default is therefore never needed, and the absence of the key is what
 * keeps a node on it.
 */
export function getDefaultOnError(isToolNode: boolean): OnError {
	return isToolNode ? 'continueRegularOutput' : 'stopWorkflow';
}
