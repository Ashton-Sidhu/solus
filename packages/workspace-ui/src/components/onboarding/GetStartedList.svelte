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
  import { getWorkspaceContext } from "../../contexts";
  import { cn } from "../../lib/utils";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { getStartedItems, type GetStartedItemId } from "./lib/get-started";

  const ICONS: Record<GetStartedItemId, typeof ChevronIcon> = {
    machine: MachineIcon,
    agents: AgentsIcon,
    github: GithubIcon,
    project: ProjectIcon,
  };

  let { class: className }: { class?: string } = $props();

  const session = getWorkspaceContext();
  const items = $derived(
    cloud.accountLoaded && !cloud.isOpen ? getStartedItems(cloud.getStartedFacts) : [],
  );

  onMount(() => {
    if (cloud.isCloud) cloud.refreshGetStarted(session.ctx);
  });
</script>

{#if items.length > 0}
  <section class={cn("flex w-full flex-col gap-1.5", className)} aria-label="Get started">
    <span class="px-1 text-workspace-chrome font-medium text-(--solus-text-tertiary)">Get started</span>
    <div
      class="flex flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-card-shadow)]"
    >
      {#each items as item (item.id)}
        {@const Icon = ICONS[item.id]}
        <button
          type="button"
          class="group flex min-h-14 w-full items-center gap-3 overflow-hidden px-4 py-2.5 text-left transition-colors duration-150 not-last:shadow-[inset_0_-1px_0_var(--hairline)] hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-1)] focus-visible:outline-none"
          onclick={() => cloud.reopenAt(item.stage)}
        >
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-lg"
            style="background: color-mix(in oklch, var(--primary) 12%, transparent); color: color-mix(in oklch, var(--primary) 72%, var(--foreground))"
          >
            <Icon size={16} />
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-sm font-medium text-(--solus-text-primary)">{item.label}</span>
            <span class="truncate text-workspace-chrome text-(--solus-text-tertiary)">{item.detail}</span>
          </span>
          <ChevronIcon
            size={14}
            class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
          />
        </button>
      {/each}
    </div>
  </section>
{/if}
