<script lang="ts">
  /**
   * "Get started" on the new-tab home, for a Solus Cloud account only
   * (docs/plans/cloud-onboarding.md §3.7): the onboarding questions the person
   * skipped, as live facts. A row reopens onboarding at the stage that answers
   * it, and goes away once its fact is true, wherever it was made true. With
   * nothing open, or at any origin that is not Solus Cloud, it renders nothing.
   */
  import {
    Bot as AgentsIcon,
    ChevronRight as ChevronIcon,
    FolderGit2 as ProjectIcon,
    GitPullRequest as GithubIcon,
    Server as MachineIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { cn } from "../../lib/utils";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { getStartedItems, type GetStartedItemId } from "./lib/get-started";

  const ICONS = {
    machine: MachineIcon,
    agents: AgentsIcon,
    github: GithubIcon,
    project: ProjectIcon,
  } satisfies Record<GetStartedItemId, typeof ChevronIcon>;

  let { class: className }: { class?: string } = $props();

  const items = $derived(
    cloud.accountLoaded && !cloud.isOpen ? getStartedItems(cloud.getStartedFacts) : [],
  );

  onMount(() => {
    if (cloud.isCloud) cloud.refreshGetStarted();
  });
</script>

{#if items.length > 0}
  <details class={cn("group/setup w-full text-workspace-chrome text-(--solus-text-secondary)", className)}>
    <summary class="flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
      <ChevronIcon size={14} class="shrink-0 transition-transform group-open/setup:rotate-90 motion-reduce:transition-none" />
      <span>Finish setup</span>
      <span class="text-(--solus-text-tertiary)">· {items.length} {items.length === 1 ? "step" : "steps"}</span>
    </summary>
    <div class="flex flex-wrap gap-1 pt-1">
      {#each items as item (item.id)}
        {@const Icon = ICONS[item.id]}
        <button
          type="button"
          class="flex min-h-9 items-center gap-2 rounded-lg px-3 text-left hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
          onclick={() => cloud.reopenAt(item.stage)}
          title={item.detail}
        >
          <Icon size={16} class="shrink-0" />
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  </details>
{/if}
