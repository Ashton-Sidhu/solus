<script lang="ts">
  import { LayoutGrid as AppIcon, TriangleAlert as AttentionIcon } from "@lucide/svelte";
  import type { WorkspaceAppItem } from "./lib/workspace-apps";
  import { formatGeneratedFull, formatLedgerTime } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";

  /**
   * One app as a card: the host that runs it and its active version, its
   * name, the project folder it came from, what needs the owner, and its last
   * call.
   */
  interface Props {
    item: WorkspaceAppItem;
    selected: boolean;
    query: string;
    onOpen: () => void;
  }
  let { item, selected, query, onOpen }: Props = $props();

  const titleRuns = $derived(highlightRuns(item.title, query));
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
    <span class="shrink-0 tabular-nums" data-testid="workspace-app-version">{item.activeVersion === null ? "No version" : `v${item.activeVersion}`}</span>
  </span>

  <span class="line-clamp-2 text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-foreground text-pretty">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
  </span>

  {#if item.attention.length > 0}
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="What needs you">
      {#each item.attention as entry (entry.kind + entry.detail)}
        <li class="flex min-w-0 items-center gap-1 text-(--warning)" title={entry.detail}>
          <AttentionIcon size={12} class="shrink-0" aria-hidden="true" />
          <span class="min-w-0 truncate">{entry.detail}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <span class="flex min-h-[18px] min-w-0 items-center gap-1.5 text-muted-foreground">
    <span class="min-w-0 truncate">{item.folderName || "No project"}</span>
    <span class="flex-1"></span>
    {#if item.lastCallAt === null}
      <span class="shrink-0">No calls yet</span>
    {:else}
      <span class="shrink-0 tabular-nums" title="Last call {formatGeneratedFull(item.lastCallAt)}">Last call {formatLedgerTime(item.lastCallAt)}</span>
    {/if}
  </span>
</div>
