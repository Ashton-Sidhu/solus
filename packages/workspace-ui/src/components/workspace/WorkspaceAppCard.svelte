<script lang="ts">
  import { CircleAlert as ErrorIcon, LayoutGrid as AppIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import type { AppManageSection } from "../../contexts/workspace/routing/route-registry";
  import { Button } from "../ui/button";
  import { versionLabel } from "../app/lib/app-view";
  import { appRunStateLabel } from "../app/manage/lib/overview";
  import { calls24hText, type WorkspaceAppItem } from "./lib/workspace-apps";
  import { formatGeneratedFull, formatLedgerTime } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";

  /**
   * One app as a card (docs/plans/apps.md §9.3): the host that runs it, its
   * state and its active version, its name, the calls of the last 24 hours,
   * what needs the owner, the project folder it came from, and its last call.
   * The card opens the app; Manage and each problem open the Manage page.
   */
  interface Props {
    item: WorkspaceAppItem;
    selected: boolean;
    query: string;
    onOpen: () => void;
    onManage: (section?: AppManageSection) => void;
  }
  let { item, selected, query, onOpen, onManage }: Props = $props();

  const titleRuns = $derived(highlightRuns(item.title, query));

  /** A control inside the card acts for itself: the card does not open the app too. */
  function manage(event: MouseEvent, section?: AppManageSection) {
    event.stopPropagation();
    onManage(section);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl bg-card px-4 pt-3.5 pb-3 text-xs transition-shadow duration-200 select-none focus-visible:outline-none {selected
    ? 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--primary)_40%,transparent)]'
    : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--foreground)_22%,transparent)]'}"
  data-selected={selected ? "true" : null}
  data-testid="workspace-app-card"
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onOpen}
>
  <span class="flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground">
    <AppIcon size={14} class="shrink-0 text-[color-mix(in_oklab,var(--solus-art-7)_66%,var(--foreground))]" aria-hidden="true" />
    <span class="min-w-0 truncate" data-testid="workspace-app-host">{item.hostLabel}</span>
    <span class="flex-1"></span>
    <span class="flex shrink-0 items-center gap-1" data-testid="workspace-app-state" data-state={item.state}>
      <span
        class="size-1.5 shrink-0 rounded-full {item.state === 'running' ? 'bg-(--success)' : item.state === 'building' ? 'bg-(--warning)' : 'bg-muted-foreground/50'}"
        aria-hidden="true"
      ></span>
      {appRunStateLabel(item.state)}
    </span>
    {#if item.activeVersion !== null}
      <span class="shrink-0 tabular-nums" data-testid="workspace-app-version">{versionLabel(item.activeVersion)}</span>
    {/if}
  </span>

  <span class="line-clamp-2 text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-foreground text-pretty">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
  </span>

  <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
    <span class="min-w-0 truncate tabular-nums {item.failed24h > 0 ? 'text-destructive' : ''}" data-testid="workspace-app-calls">{calls24hText(item)}</span>
    {#if item.hasUndeployedRevision}
      <span class="shrink-0 rounded-full bg-[var(--wash-2)] px-1.5 py-px text-foreground" title="The newest revision has no version" data-testid="workspace-app-undeployed">Waits for a deploy</span>
    {/if}
  </span>

  {#if item.problems.length > 0}
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="What needs you">
      {#each item.problems as problem (problem.kind + problem.detail)}
        <li class="flex min-w-0">
          <button
            type="button"
            class="flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-sm border-0 bg-transparent p-0 text-left hover:underline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {problem.tone === 'error' ? 'text-destructive' : 'text-(--warning)'}"
            title="{problem.detail} {problem.action}."
            data-tone={problem.tone}
            onclick={(event) => manage(event, problem.section)}
          >
            {#if problem.tone === "error"}
              <ErrorIcon size={12} class="shrink-0" aria-hidden="true" />
            {:else}
              <WarningIcon size={12} class="shrink-0" aria-hidden="true" />
            {/if}
            <span class="min-w-0 truncate">{problem.detail}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <span class="flex min-h-6 min-w-0 items-center gap-1.5 text-muted-foreground">
    <span class="min-w-0 truncate">{item.folderName || "No project"}</span>
    <span class="flex-1"></span>
    {#if item.lastCallAt === null}
      <span class="shrink-0">No calls yet</span>
    {:else}
      <span class="shrink-0 tabular-nums" title="Last call {formatGeneratedFull(item.lastCallAt)}">Last call {formatLedgerTime(item.lastCallAt)}</span>
    {/if}
    <Button size="xs" variant="outline" class="shrink-0" onclick={(event: MouseEvent) => manage(event)} data-testid="workspace-app-manage">Manage</Button>
  </span>
</div>
