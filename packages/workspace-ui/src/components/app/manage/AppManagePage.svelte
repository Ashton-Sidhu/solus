<script lang="ts">
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import ActivitySection from "./ActivitySection.svelte";
  import ConfigSection from "./ConfigSection.svelte";
  import DeploymentSection from "./DeploymentSection.svelte";
  import FilesSection from "./FilesSection.svelte";
  import OperationsSection from "./OperationsSection.svelte";
  import OverviewSection from "./OverviewSection.svelte";
  import SchedulesSection from "./SchedulesSection.svelte";
  import SecretsSection from "./SecretsSection.svelte";
  import SessionsSection from "./SessionsSection.svelte";
  import SignalsSection from "./SignalsSection.svelte";
  import VersionsSection from "./VersionsSection.svelte";
  import WebhooksSection from "./WebhooksSection.svelte";
  import WorkflowsSection from "./WorkflowsSection.svelte";
  import { adjacentManageSection, manageSectionCounts, manageSectionGroups, manageSectionLabel } from "../lib/app-manage";
  import type { AppProblem } from "../lib/app-view";

  /**
   * The Manage page of one app (docs/plans/apps.md §9.2): where its owner
   * operates it. The sections are a plain list under four headings beside the
   * page in a wide pane, and a strip above it in a narrow one. The pane
   * decides, never the window.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    state: AppState | undefined;
    problems: AppProblem[];
    section: AppManageSection;
    /** The page was opened with the keyboard, so it takes the keyboard. */
    takesFocus: boolean;
    /** A command of the surface runs: Stop, Start, and Delete wait. */
    busy: boolean;
    /** The app is pinned in the sidebar's places column. */
    pinned: boolean;
    onSelectSection: (section: AppManageSection) => void;
    onToggleStopped: () => void;
    onTogglePinned: () => void;
    /** Absent for an app with no UI. */
    onOpenApp?: () => void;
    onDelete: () => void;
  }
  let { serverId, app, state: appState, problems, section, takesFocus, busy, pinned, onSelectSection, onToggleStopped, onTogglePinned, onOpenApp, onDelete }: Props = $props();

  const groups = manageSectionGroups();
  const counts = $derived(manageSectionCounts(app, appState, problems));
  /** The run the Workflows section shows open. The Activity section opens the run of a step's call. */
  let openRunId = $state<string | null>(null);

  function openRun(runId: string) {
    openRunId = runId;
    onSelectSection("workflows");
  }

  /** The arrow keys move through the sections, down the list or along the strip. */
  function handleNavKeydown(event: KeyboardEvent & { currentTarget: HTMLElement }, forward: string, back: string) {
    const delta = event.key === forward ? 1 : event.key === back ? -1 : 0;
    if (delta === 0) return;
    const next = adjacentManageSection(section, delta);
    if (next === section) return;
    event.preventDefault();
    onSelectSection(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus();
  }
</script>

<!-- The figure at the edge of a row: a plain count is quiet, a problem count is in the colour of its tone. -->
{#snippet countMark(sectionId: AppManageSection, problemsOnly: boolean)}
  {@const mark = counts[sectionId]}
  {#if mark && (mark.tone || !problemsOnly)}
    <span
      class="shrink-0 text-xs tabular-nums {mark.tone === 'error' ? 'font-medium text-(--failure)' : mark.tone === 'warning' ? 'font-medium text-(--warning)' : 'text-(--solus-text-tertiary)'}"
      aria-label={mark.tone ? `${mark.count} ${mark.count === 1 ? "problem" : "problems"}` : undefined}>{mark.count}</span
    >
  {/if}
{/snippet}

<div class="flex h-full min-h-0 w-full min-w-0 flex-col text-workspace-chrome" data-testid="app-manage">
  <!-- The strip replaces the section list, not adds to it: it shows at exactly the pane width where the list goes. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav
    class="flex shrink-0 items-center gap-0.5 overflow-x-auto px-5 pt-3 pb-1 [scrollbar-width:none] @min-[48rem]/pane:hidden [&::-webkit-scrollbar]:h-0"
    aria-label="Manage sections"
    data-testid="app-manage-strip"
    onkeydown={(event) => handleNavKeydown(event, "ArrowRight", "ArrowLeft")}
  >
    {#each groups as group, groupIndex (group.label)}
      {#if groupIndex > 0}
        <span class="mx-1.5 h-4 w-px shrink-0 bg-[var(--hairline-strong)]" aria-hidden="true"></span>
      {/if}
      {#each group.sections as entry (entry.id)}
        {@const isActive = entry.id === section}
        <button
          type="button"
          class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] border-0 px-3 text-workspace-chrome whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:tap-area {isActive
            ? 'bg-[var(--wash-3)] font-medium text-foreground'
            : 'bg-transparent font-normal text-(--solus-text-secondary) hover:bg-[var(--wash-2)] hover:text-foreground'}"
          aria-current={isActive ? "page" : undefined}
          data-section={entry.id}
          onclick={() => onSelectSection(entry.id)}
        >
          {entry.label}
          {@render countMark(entry.id, true)}
        </button>
      {/each}
    {/each}
  </nav>

  <div class="flex min-h-0 flex-1 gap-7 pl-5 @max-[48rem]/pane:pl-0">
    <!-- The section list. Below 48rem of pane width the strip above replaces it. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav
      class="flex w-42 shrink-0 flex-col gap-4.5 overflow-y-auto pt-7 pb-6 @max-[48rem]/pane:hidden"
      aria-label="Manage sections"
      data-testid="app-manage-rail"
      onkeydown={(event) => handleNavKeydown(event, "ArrowDown", "ArrowUp")}
    >
      {#each groups as group (group.label)}
        <div class="flex flex-col gap-px" role="group" aria-label={group.label}>
          <span aria-hidden="true" class="px-2.5 pb-1.5 text-xs text-(--solus-text-tertiary)">{group.label}</span>
          {#each group.sections as entry (entry.id)}
            {@const isActive = entry.id === section}
            <button
              type="button"
              class="flex h-8 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-[9px] border-0 px-2.5 text-left text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {isActive
                ? 'bg-[var(--wash-3)] font-medium text-foreground'
                : 'bg-transparent font-normal text-(--solus-text-secondary) hover:bg-[var(--wash-2)] hover:text-foreground'}"
              aria-current={isActive ? "page" : undefined}
              data-section={entry.id}
              onclick={() => onSelectSection(entry.id)}
            >
              <span class="min-w-0 flex-1 truncate">{entry.label}</span>
              {@render countMark(entry.id, false)}
            </button>
          {/each}
        </div>
      {/each}
    </nav>

    <div
      class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain pr-6 outline-none @max-[48rem]/pane:px-5"
      role="region"
      aria-label={manageSectionLabel(section)}
      tabindex="-1"
      data-testid="app-manage-section"
      data-section={section}
      {@attach (element) => {
        if (takesFocus) element.focus({ preventScroll: true });
      }}
    >
      <div class="min-w-0 pt-7 pb-12 text-sm @max-[48rem]/pane:pt-4">
        {#if section === "overview"}
          <OverviewSection {serverId} {app} state={appState} {problems} {busy} {pinned} {onSelectSection} {onToggleStopped} {onTogglePinned} {onOpenApp} {onDelete} />
        {:else if section === "activity"}
          <ActivitySection {serverId} {app} state={appState} onOpenRun={openRun} />
        {:else if section === "workflows"}
          <WorkflowsSection {serverId} {app} state={appState} bind:openRunId />
        {:else if section === "versions"}
          <VersionsSection {serverId} {app} {onSelectSection} />
        {:else if section === "deployment"}
          <DeploymentSection {serverId} {app} />
        {:else if section === "schedules"}
          <SchedulesSection {serverId} {app} />
        {:else if section === "webhooks"}
          <WebhooksSection {serverId} {app} />
        {:else if section === "signals"}
          <SignalsSection {serverId} {app} />
        {:else if section === "secrets"}
          <SecretsSection {serverId} {app} secrets={appState?.secrets} />
        {:else if section === "config"}
          <ConfigSection {serverId} {app} config={appState?.config} />
        {:else if section === "files"}
          <FilesSection {serverId} {app} />
        {:else if section === "operations"}
          <OperationsSection {serverId} {app} state={appState} onOpenActivity={() => onSelectSection("activity")} />
        {:else}
          <SessionsSection {serverId} {app} />
        {/if}
      </div>
    </div>
  </div>
</div>
