<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import { triggerSummary } from "./lib/automation-format";
  import type { AutomationTrigger } from "@solus/contracts/types";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  interface Props {
    ref: {
      automationId: string;
      name: string;
      trigger: AutomationTrigger;
      enabled: boolean;
    };
    linkContext?: TaskLinkContext;
    skipMotion?: boolean;
  }
  let { ref, linkContext, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const summary = $derived(triggerSummary(ref.trigger));

  function open() {
    session.openAutomations(ref.automationId);
  }

  function openSecondary() {
    session.openAutomationBuilder(ref.automationId, "aside");
  }
</script>

<ConversationRefCard
  kicker="Automation"
  title={ref.name}
  subtitle={summary}
  actionLabel="Open"
  ariaLabel={`Open automation: ${ref.name}`}
  onOpen={open}
  onOpenSecondary={openSecondary}
  secondaryActionLabel="Open automation in side pane"
  {skipMotion}
>
  <!-- No status dot: the chip says paused, or nothing does. -->
  {#snippet chip()}
    {#if !ref.enabled}
      <TranscriptChip>Paused</TranscriptChip>
    {/if}
  {/snippet}

  {#snippet footer()}
    <span class="flex-1"></span>
    <TaskLinkControl
      target={{ kind: "automation", targetScope: "", targetKey: ref.automationId }}
      title={ref.name}
      serverId={linkContext?.serverId}
      projectKey={linkContext?.projectKey}
      conversationTaskId={linkContext?.conversationTaskId}
    />
  {/snippet}
</ConversationRefCard>
