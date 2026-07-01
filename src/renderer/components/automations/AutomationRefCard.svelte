<script lang="ts">
  import { LightningIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import { triggerSummary } from "./lib/automation-format";
  import type { AutomationTrigger } from "../../../shared/types";

  interface Props {
    ref: {
      automationId: string;
      name: string;
      trigger: AutomationTrigger;
      enabled: boolean;
    };
    skipMotion?: boolean;
  }
  let { ref, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const summary = $derived(triggerSummary(ref.trigger));

  function open() {
    session.openAutomationBuilderSecondary(ref.automationId);
  }
</script>

<ConversationRefCard
  title={ref.name}
  subtitle="{summary}{ref.enabled ? '' : ' · Paused'}"
  ariaLabel={`Open automation: ${ref.name}`}
  onOpen={open}
  {skipMotion}
>
  {#snippet icon()}
    <span
      style:color={ref.enabled
        ? "var(--solus-accent)"
        : "var(--solus-text-tertiary)"}
    >
      <LightningIcon size={18} weight={ref.enabled ? "fill" : "regular"} />
    </span>
  {/snippet}
</ConversationRefCard>
