<script lang="ts">
  import { UserIcon } from "phosphor-svelte";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import type { StatusFilter, TaskSort } from "./lib/tasks-api";

  interface Props {
    query: string;
    status: StatusFilter;
    assignedToMe: boolean;
    sort: TaskSort;
    counts: Record<StatusFilter, number>;
    searchEl?: HTMLInputElement | HTMLTextAreaElement | null;
    /** Hidden in board mode, where the columns already are the status filter. */
    showStatus?: boolean;
  }
  let {
    query = $bindable(),
    status = $bindable(),
    assignedToMe = $bindable(),
    sort = $bindable(),
    counts,
    searchEl = $bindable(null),
    showStatus = true,
  }: Props = $props();

  const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "priority", label: "Priority" },
    { value: "due", label: "Due date" },
  ];

  const STATUS_TABS: { value: StatusFilter; label: string; short?: string }[] = [
    { value: "active", label: "Active" },
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "in_progress", label: "In progress", short: "WIP" },
    { value: "done", label: "Done" },
  ];
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2.5 pt-1 pb-4">
  <SearchField
    bind:ref={searchEl}
    bind:value={query}
    placeholder="Search tasks…"
    class="h-8 min-w-0 flex-1 basis-0 rounded-lg border-0 bg-muted px-3 py-0 @max-[44rem]:basis-0"
  />

  {#if showStatus}
    <SegmentedControl
      variant="bar"
      options={STATUS_TABS.map((t) => ({ ...t, count: counts[t.value] }))}
      isActive={(v) => status === v}
      onSelect={(v) => (status = v)}
      ariaLabel="Filter by status"
    />
  {/if}

  <div class="ml-auto flex shrink-0 items-center gap-1">
    <button
      type="button"
      class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border-0 px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {assignedToMe
        ? 'bg-secondary text-secondary-foreground'
        : 'bg-muted text-muted-foreground hover:bg-(--solus-surface-active) hover:text-foreground'}"
      onclick={() => (assignedToMe = !assignedToMe)}
      aria-pressed={assignedToMe}
      title="Only tasks assigned to me"
    >
      <UserIcon size={11} weight={assignedToMe ? "fill" : "regular"} />
      <span>Mine</span>
    </button>

    <!-- Sort: how to order both the list and the board ("what's next"). -->
    <SortMenu
      bind:value={sort}
      options={SORT_OPTIONS}
      ariaLabel="Sort tasks"
      class="h-8 gap-1.5 bg-muted px-2.5 py-0 text-[12.5px] font-normal text-muted-foreground hover:bg-(--solus-surface-active) hover:text-foreground"
    />
  </div>
</div>
