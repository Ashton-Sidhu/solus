<script lang="ts">
  import { untrack } from "svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hasRunOnce, scheduleCardState } from "./lib/schedule-card";
  import { getWorkspaceContext } from "../../contexts";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
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

<ConversationRefCard
  kicker={isSessionSchedule ? "Scheduled check" : "Automation"}
  title={automation?.name ?? ref.name}
  actionLabel="Open"
  ariaLabel={`Open automation: ${ref.name}`}
  onOpen={open}
  onOpenSecondary={openSecondary}
  secondaryActionLabel="Open automation in side pane"
  {skipMotion}
>
  {#snippet headerMeta()}
    <span
      class:text-destructive={!!error || !!loadError}
      aria-live="polite"
    >
      {error || loadError || scheduleState}
    </span>
  {/snippet}
  {#snippet chip()}
    <span class="max-w-[50%] shrink-0 truncate text-workspace-chrome font-normal text-muted-foreground" title={summary}>
      {summary}
    </span>
  {/snippet}

  {#snippet footer()}
    {#if isSessionSchedule && automation}
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Schedule controls">
        {#if !automation.archivedAt && !automation.archiveRequested && automation.trigger.type !== "manual" && !hasRunOnce(automation)}
          <button type="button" class="rounded-md px-3 py-2 text-workspace-chrome text-muted-foreground hover:bg-accent focus-visible:outline-2 disabled:opacity-50" disabled={saving || !!loadError} onclick={() => changeSchedule()}>{automation.enabled ? "Pause" : "Resume"}</button>
          <button type="button" class="rounded-md px-3 py-2 text-workspace-chrome text-muted-foreground hover:bg-accent focus-visible:outline-2 disabled:opacity-50" title="Stop future checks. A check already queued or running can finish." disabled={saving || !!loadError} onclick={() => changeSchedule(true)}>Stop</button>
        {/if}
        <button type="button" class="rounded-md px-3 py-2 text-workspace-chrome text-muted-foreground hover:bg-accent focus-visible:outline-2" onclick={open}>{automation.archivedAt ? "Schedule again" : "Change"}</button>
      </div>
    {/if}
    {#if loadError && serverId}
      <button type="button" class="rounded-md px-3 py-2 text-workspace-chrome" onclick={() => serverId && store.loadAll(serverId)}>Retry</button>
    {/if}
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
