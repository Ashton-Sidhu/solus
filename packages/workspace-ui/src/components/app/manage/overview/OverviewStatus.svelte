<script lang="ts">
  import type { AppState, AppSummary, AppVersionView } from "@solus/contracts/apps";
  import { lastActivation } from "@solus/client-core/app-versions";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../../contexts/workspace/routing/route-registry";
  import { toasts } from "../../../../lib/toasts";
  import { Switch } from "../../../ui/switch";
  import { appTime, scheduleTriggerText } from "../../lib/app-view";
  import { nextScheduleRun, scheduleNextText } from "../lib/overview";

  /**
   * The right column under the last 24 hours, a plain list of facts: the live
   * version, a build in progress, agent access (a switch), the next schedule,
   * and the work in progress. Then the schedules with their next run. A row
   * with more to see opens its section.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
    versions: AppVersionView[] | undefined;
    building: { number: number } | null;
    onSelectSection: (section: AppManageSection) => void;
  }
  let { serverId, app, state: appState, versions, building, onSelectSection }: Props = $props();

  const schedules = $derived(appsStore.schedules.get(serverId, app.id));
  const nextSchedule = $derived(nextScheduleRun(schedules ?? []));
  const liveVersion = $derived(versions?.find((version) => version.number === app.activeVersion) ?? null);
  let isSettingAccess = $state(false);

  async function setAgentAccess(enabled: boolean) {
    if (isSettingAccess) return;
    isSettingAccess = true;
    try {
      await appsStore.setAgentAccess(serverId, app.id, enabled);
    } catch (cause) {
      toasts.error(enabled ? "Agent access was not turned on" : "Agent access was not turned off", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isSettingAccess = false;
    }
  }
</script>

{#snippet linkRow(label: string, value: string, section: AppManageSection, testId: string)}
  <button
    type="button"
    class="flex h-10 w-full min-w-0 shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden border-0 border-t border-[var(--hairline)] bg-transparent p-0 text-left text-sm transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-12"
    onclick={() => onSelectSection(section)}
    data-testid={testId}
  >
    <span class="shrink-0 text-(--solus-text-tertiary)">{label}</span>
    <span class="min-w-0 truncate tabular-nums text-foreground" title={value}>{value}</span>
  </button>
{/snippet}

<div class="flex w-75 shrink-0 flex-col gap-8 @max-[56rem]/pane:w-full">
  <section class="flex flex-col" aria-label="Status">
    <h3 class="m-0 pb-2 text-[15px] font-semibold text-foreground">Status</h3>
    {@render linkRow(
      "Live version",
      app.activeVersion === null ? "None" : liveVersion ? `${app.activeVersion} · ${appTime(lastActivation(liveVersion).at)}` : String(app.activeVersion),
      "versions",
      "app-overview-version",
    )}
    {#if building}
      {@render linkRow("Building", `Version ${building.number}`, "versions", "app-overview-building")}
    {:else if app.hasUndeployedRevision}
      {@render linkRow("Newest save", "Waits for a deploy", "versions", "app-overview-undeployed")}
    {/if}
    <div class="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-[var(--hairline)] text-sm pointer-coarse:h-12">
      <span class="text-(--solus-text-tertiary)" title={app.agentAccess ? "Agents can call its operations as tools." : "Agents cannot call this app."}>Agent access</span>
      <Switch
        aria-label="Agent access"
        bind:checked={() => app.agentAccess, (enabled) => void setAgentAccess(enabled)}
        disabled={isSettingAccess || app.activeVersion === null}
        data-testid="app-overview-agent-access"
      />
    </div>
    {#if schedules && schedules.length > 0}
      {@render linkRow("Next schedule", nextSchedule ? appTime(nextSchedule.nextRunAt) : "None planned", "schedules", "app-overview-next-schedule")}
    {/if}
    <div class="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-[var(--hairline)] text-sm pointer-coarse:h-12">
      <span class="text-(--solus-text-tertiary)">In progress</span>
      <span class="tabular-nums text-foreground">{appState ? appState.runtime.inFlight.toLocaleString() : "–"}</span>
    </div>
  </section>

  {#if schedules && schedules.length > 0}
    <section class="flex flex-col" aria-label="Schedules">
      <h3 class="m-0 pb-2 text-[15px] font-semibold text-foreground">Schedules</h3>
      {#each schedules as schedule (schedule.name)}
        <button
          type="button"
          class="flex min-h-10 w-full min-w-0 shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden border-0 border-t border-[var(--hairline)] bg-transparent py-2 pr-0 pl-0 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
          title={schedule.lastOutcome === "failed" ? `${scheduleTriggerText(schedule)}. The last run failed.` : scheduleTriggerText(schedule)}
          onclick={() => onSelectSection("schedules")}
          data-testid="app-overview-schedule"
        >
          <span class="min-w-0 truncate {schedule.lastOutcome === 'failed' ? 'text-(--failure)' : 'text-foreground'}">{schedule.name}</span>
          <span class="shrink-0 tabular-nums text-(--solus-text-tertiary)">{scheduleNextText(schedule)}</span>
        </button>
      {/each}
    </section>
  {/if}
</div>
