<script lang="ts">
  import { LightningIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
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
    session.openAutomations(ref.automationId);
  }

  function openSecondary() {
    session.openAutomationBuilderSecondary(ref.automationId);
  }
</script>

<ConversationRefCard
  title={ref.name}
  actionLabel="Open"
  ariaLabel={`Open automation: ${ref.name}`}
  onOpen={open}
  onOpenSecondary={openSecondary}
  secondaryActionLabel="Open automation in side pane"
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

  {#snippet statusSlot()}
    <span class="automation-ref-meta">
      <span>{summary}</span>
      {#if !ref.enabled}
        <span class="automation-ref-meta__paused">Paused</span>
      {/if}
    </span>
  {/snippet}
</ConversationRefCard>

<style>
  .automation-ref-meta {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .automation-ref-meta > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .automation-ref-meta__paused {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
  }

  .automation-ref-meta__paused::before {
    content: "";
    display: inline-block;
    width: 0.25rem;
    height: 0.25rem;
    margin: 0 0.375rem 0.0625rem 0;
    border-radius: 999rem;
    background: currentColor;
    opacity: 0.55;
  }
</style>
