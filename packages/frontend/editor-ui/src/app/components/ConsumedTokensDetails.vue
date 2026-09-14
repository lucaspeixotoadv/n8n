<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@n8n/i18n';
import { type LlmTokenUsageData } from '@/Interface';
import { formatTokenUsageCost, formatTokenUsageCount } from '@/app/utils/aiUtils';
import { N8nText } from '@n8n/design-system';
const { consumedTokens } = defineProps<{ consumedTokens: LlmTokenUsageData }>();
const i18n = useI18n();

const breakdowns = computed(() =>
	(
		[
			['runData.aiContentBlock.tokens.cacheRead', consumedTokens.cacheReadTokens],
			['runData.aiContentBlock.tokens.cacheWrite', consumedTokens.cacheWriteTokens],
			['runData.aiContentBlock.tokens.reasoning', consumedTokens.reasoningTokens],
		] as const
	).filter((entry): entry is [(typeof entry)[0], number] => (entry[1] ?? 0) > 0),
);

// A cost is shown once something was priced; a sum with unpriced invocations says so.
const cost = computed(() => {
	const value = consumedTokens.cost;
	if (!value || (!value.isComplete && value.amount === 0)) return undefined;
	return value;
});
</script>

<template>
	<div>
		<N8nText :bold="true" size="small">
			{{ i18n.baseText('runData.aiContentBlock.tokens.prompt') }}
			{{
				i18n.baseText('runData.aiContentBlock.tokens', {
					interpolate: {
						count: formatTokenUsageCount(consumedTokens, 'prompt'),
					},
				})
			}}
		</N8nText>
		<br />
		<N8nText :bold="true" size="small">
			{{ i18n.baseText('runData.aiContentBlock.tokens.completion') }}
			{{
				i18n.baseText('runData.aiContentBlock.tokens', {
					interpolate: {
						count: formatTokenUsageCount(consumedTokens, 'completion'),
					},
				})
			}}
		</N8nText>
		<template v-for="[key, count] in breakdowns" :key="key">
			<br />
			<N8nText size="small" color="text-light">
				{{ i18n.baseText(key) }}
				{{
					i18n.baseText('runData.aiContentBlock.tokens', {
						interpolate: {
							count: consumedTokens.isEstimate ? `~${count}` : count.toLocaleString(),
						},
					})
				}}
			</N8nText>
		</template>
		<template v-if="cost">
			<br />
			<N8nText :bold="true" size="small" data-test-id="consumed-tokens-cost">
				{{ i18n.baseText('runData.aiContentBlock.cost') }}
				{{ formatTokenUsageCost(cost) }}
				<template v-if="!cost.isComplete">
					{{ i18n.baseText('runData.aiContentBlock.cost.incomplete') }}
				</template>
			</N8nText>
		</template>
	</div>
</template>
