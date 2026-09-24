<script lang="ts">
  import { untrack } from "svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hasRunOnce, scheduleCardState } from "./lib/schedule-card";
  import { getWorkspaceContext } from "../../contexts";
  import { Clock as ClockIcon } from "@lucide/svelte";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
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
  const store = session.automationsStore;
  const serverId = $derived(store.hostFor(ref.automationId) ?? linkContext?.serverId);
  const automation = $derived(store.get(ref.automationId));
  const trigger = $derived(automation?.trigger ?? ref.trigger);
  const summary = $derived(trigger.type === "once" ? "Once" : triggerSummary(trigger));
  const isSessionSchedule = $derived(!!automation?.action.sessionId);
  const scheduleState = $derived(automation ? scheduleCardState(automation) : "Schedule state unavailable");
  const loadError = $derived(serverId ? store.loadErrors.get(serverId) : undefined);
  const canPause = $derived(
    !!automation &&
      !automation.archivedAt &&
      !automation.archiveRequested &&
      automation.trigger.type !== "manual" &&
      !hasRunOnce(automation),
  );
  // The card opens the automations page on this automation, or its builder beside the chat.
  const isOpen = $derived(
    session.router.params("automations")?.automationId === ref.automationId ||
      session.router.params("automation")?.automationId === ref.automationId,
  );
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    const hostId = serverId;
    if (hostId) return untrack(() => store.watchHost(hostId));
  });

  async function changeSchedule(stop = false) {
    if (!automation || saving || !serverId) return;
    saving = true;
    error = "";
    try {
      if (stop) await store.update(automation.id, { archived: true });
      else await store.setEnabled(automation.id, !automation.enabled);
      requestInputFocus();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update schedule.";
    } finally {
      saving = false;
    }
  }

  function open() {
    if (!automation && serverId && store.hasLoadedHost(serverId)) {
      error = "Schedule history is no longer available. The conversation is kept.";
      return;
    }
    session.openAutomations(ref.automationId);
  }

  function openSecondary() {
    if (!automation && serverId && store.hasLoadedHost(serverId)) {
      error = "Schedule history is no longer available. The conversation is kept.";
      return;
    }
    session.openAutomationBuilder(ref.automationId, "aside");
  }
</script>

<TranscriptCard
  title={automation?.name ?? ref.name}
  type={summary}
  ariaLabel={`Open automation: ${ref.name}`}
  onOpen={open}
  onOpenSecondary={openSecondary}
  secondaryActionLabel="Open automation in side pane"
  open={isOpen}
  failed={!!error || !!loadError}
  {skipMotion}
>
  {#snippet glyph()}<ClockIcon />{/snippet}
  {#snippet rail()}
    <span class:text-destructive={!!error || !!loadError} aria-live="polite">
      {error || loadError || scheduleState}
    </span>
  {/snippet}
  {#snippet actions()}
    {#if loadError && serverId}
      <TranscriptCardAction kind="ghost" onclick={() => serverId && store.loadAll(serverId)}>Retry</TranscriptCardAction>
    {:else if isSessionSchedule && automation && canPause}
      <TranscriptCardAction kind="ghost" disabled={saving} onclick={() => changeSchedule()}>
        {automation.enabled ? "Pause" : "Resume"}
      </TranscriptCardAction>
    {/if}
  {/snippet}
  {#snippet menu()}
    {#if isSessionSchedule && automation}
      {#if canPause}
        <TranscriptCardAction kind="item" disabled={saving || !!loadError} onclick={() => changeSchedule(true)}>
          Stop future checks
        </TranscriptCardAction>
      {/if}
      <TranscriptCardAction kind="item" onclick={open}>
        {automation.archivedAt ? "Schedule again" : "Change schedule"}
      </TranscriptCardAction>
    {/if}
    <TaskLinkControl
      target={{ kind: "automation", targetScope: "", targetKey: ref.automationId }}
      title={ref.name}
      serverId={linkContext?.serverId}
      projectKey={linkContext?.projectKey}
      conversationTaskId={linkContext?.conversationTaskId}
    />
  {/snippet}
</TranscriptCard>
