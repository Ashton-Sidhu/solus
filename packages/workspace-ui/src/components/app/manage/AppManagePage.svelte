<script lang="ts">
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import ActivitySection from "./ActivitySection.svelte";
  import ConfigSection from "./ConfigSection.svelte";
  import ModelsSection from "./ModelsSection.svelte";
  import FilesSection from "./FilesSection.svelte";
  import OperationsSection from "./OperationsSection.svelte";
  import OverviewSection from "./OverviewSection.svelte";
  import SchedulesSection from "./SchedulesSection.svelte";
  import SecretsSection from "./SecretsSection.svelte";
  import SessionsSection from "./SessionsSection.svelte";
  import SignalsSection from "./SignalsSection.svelte";
  import SourceSection from "./SourceSection.svelte";
  import VersionsSection from "./VersionsSection.svelte";
  import WebhooksSection from "./WebhooksSection.svelte";
  import WorkflowsSection from "./WorkflowsSection.svelte";
  import { adjacentManageSection, manageSectionLabel, manageSections, type AppManageSectionEntry } from "../lib/app-manage";
  import type { AppProblem } from "../lib/app-view";
  import { MANAGE_SECTION_ICONS } from "./lib/section-icons";

  /**
   * The Manage page of one app (docs/plans/apps.md §9.2): where its owner
   * operates it. The sections are a rail beside the content in a wide pane and
   * a strip above it in a narrow one. The pane decides, never the window.
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
    onSelectSection: (section: AppManageSection) => void;
    onToggleStopped: () => void;
    onDelete: () => void;
  }
  let { serverId, app, state: appState, problems, section, takesFocus, busy, onSelectSection, onToggleStopped, onDelete }: Props = $props();

  const entries = $derived(manageSections(problems));
  /** The run the Workflows section shows open. The Activity section opens the run of a step's call. */
  let openRunId = $state<string | null>(null);

  function openRun(runId: string) {
    openRunId = runId;
    onSelectSection("workflows");
  }

  /** The arrow keys move through the sections, along the rail or along the strip. */
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

{#snippet problemDot(entry: AppManageSectionEntry)}
  {#if entry.problemTone}
    <span class="size-1.5 shrink-0 rounded-full {entry.problemTone === 'error' ? 'bg-destructive' : 'bg-(--warning)'}" role="img" aria-label={entry.problemTone === "error" ? "Has an error" : "Needs a value"}></span>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 w-full min-w-0 text-workspace-chrome" data-testid="app-manage">
  <!-- The rail. Below 48rem of pane width the strip in the content column replaces it. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav
    class="flex w-48 shrink-0 flex-col gap-px overflow-y-auto border-r border-border/50 px-2 py-3 @max-[48rem]/pane:hidden"
    aria-label="Manage sections"
    data-testid="app-manage-rail"
    onkeydown={(event) => handleNavKeydown(event, "ArrowDown", "ArrowUp")}
  >
    {#each entries as entry (entry.id)}
      {@const Icon = MANAGE_SECTION_ICONS[entry.id]}
      {@const isActive = entry.id === section}
      <button
        type="button"
        class="flex h-8 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border-0 px-2.5 text-left text-workspace-chrome text-foreground transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {isActive
          ? 'bg-[var(--wash-3)] font-medium'
          : 'bg-transparent font-normal hover:bg-[var(--wash-2)]'}"
        aria-current={isActive ? "page" : undefined}
        data-section={entry.id}
        onclick={() => onSelectSection(entry.id)}
      >
        <Icon size={16} strokeWidth={1.5} class="shrink-0 {isActive ? '' : 'text-muted-foreground'}" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{entry.label}</span>
        {@render problemDot(entry)}
      </button>
    {/each}
  </nav>

  <div class="flex min-w-0 flex-1 flex-col">
    <!-- The rail's replacement, not an addition: it shows at exactly the pane width where the rail goes. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav
      class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-3 py-1.5 [scrollbar-width:none] @min-[48rem]/pane:hidden [&::-webkit-scrollbar]:h-0"
      aria-label="Manage sections"
      data-testid="app-manage-strip"
      onkeydown={(event) => handleNavKeydown(event, "ArrowRight", "ArrowLeft")}
    >
      {#each entries as entry (entry.id)}
        {@const isActive = entry.id === section}
        <button
          type="button"
          class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {isActive
            ? 'bg-[var(--wash-3)] font-medium text-foreground'
            : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
          aria-current={isActive ? "page" : undefined}
          data-section={entry.id}
          onclick={() => onSelectSection(entry.id)}
        >
          {entry.label}
          {@render problemDot(entry)}
        </button>
      {/each}
    </nav>

    <div
      class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain outline-none"
      role="region"
      aria-label={manageSectionLabel(section)}
      tabindex="-1"
      data-testid="app-manage-section"
      data-section={section}
      {@attach (element) => {
        if (takesFocus) element.focus({ preventScroll: true });
      }}
    >
      <div class="mx-auto w-full max-w-4xl px-[clamp(1rem,3cqi,2rem)] pt-5 pb-10 text-sm">
        {#if section === "overview"}
          <OverviewSection {serverId} {app} state={appState} {problems} {busy} {onSelectSection} {onToggleStopped} />
        {:else if section === "activity"}
          <ActivitySection {serverId} {app} state={appState} onOpenRun={openRun} />
        {:else if section === "workflows"}
          <WorkflowsSection {serverId} {app} state={appState} bind:openRunId />
        {:else if section === "versions"}
          <VersionsSection {serverId} {app} />
        {:else if section === "schedules"}
          <SchedulesSection {serverId} {app} />
        {:else if section === "webhooks"}
          <WebhooksSection {serverId} {app} />
        {:else if section === "signals"}
          <SignalsSection {serverId} {app} />
        {:else if section === "models"}
          <ModelsSection {serverId} {app} state={appState} />
        {:else if section === "secrets"}
          <SecretsSection {serverId} {app} secrets={appState?.secrets} />
        {:else if section === "config"}
          <ConfigSection {serverId} {app} config={appState?.config} />
        {:else if section === "files"}
          <FilesSection {serverId} {app} />
        {:else if section === "operations"}
          <OperationsSection {serverId} {app} state={appState} />
        {:else if section === "sessions"}
          <SessionsSection {serverId} {app} />
        {:else}
          <SourceSection {serverId} {app} state={appState} {busy} {onSelectSection} {onDelete} />
        {/if}
      </div>
    </div>
  </div>
</div>
