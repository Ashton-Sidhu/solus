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

<div class="flex flex-wrap items-center gap-2 pb-4">
  <SearchField bind:ref={searchEl} bind:value={query} placeholder="Search tasks…" />

  {#if showStatus}
    <SegmentedControl
      options={STATUS_TABS.map((t) => ({ ...t, count: counts[t.value] }))}
      isActive={(v) => status === v}
      onSelect={(v) => (status = v)}
      ariaLabel="Filter by status"
    />
  {/if}

  <div class="ml-auto flex shrink-0 items-center gap-1">
    <button
      type="button"
      class="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-2 py-1 text-[0.6875rem] font-medium transition-[background-color,color] duration-100 ease-in-out focus-visible:bg-(--solus-accent-light) focus-visible:outline-none [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-2.5 {assignedToMe
        ? 'bg-(--solus-accent-light) text-(--solus-accent)'
        : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
      onclick={() => (assignedToMe = !assignedToMe)}
      aria-pressed={assignedToMe}
      title="Only tasks assigned to me"
    >
      <UserIcon size={11} weight={assignedToMe ? "fill" : "regular"} />
      <span>Mine</span>
    </button>

    <!-- Sort: how to order both the list and the board ("what's next"). -->
    <SortMenu bind:value={sort} options={SORT_OPTIONS} ariaLabel="Sort tasks" />
  </div>
</div>
