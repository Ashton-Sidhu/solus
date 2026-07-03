<script lang="ts">
  import { MagnifyingGlassIcon, UserIcon, ArrowsDownUpIcon, CaretDownIcon, XIcon } from "phosphor-svelte";
  import Input from "../ui/Input.svelte";
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

  const STATUS_TABS: { value: StatusFilter; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "in_progress", label: "In progress" },
    { value: "done", label: "Done" },
  ];

  const tabClass = (active: boolean) =>
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-[0.5625rem] py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out " +
    (active
      ? "bg-(--solus-accent-light) text-(--solus-accent)"
      : "bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)");
</script>

<div class="flex items-center gap-2.5 px-5 pb-2.5 pt-1">
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <MagnifyingGlassIcon
      size={15}
      class="text-(--solus-text-tertiary) flex-shrink-0"
    />
    <Input
      bind:el={searchEl}
      bind:value={query}
      type="text"
      variant="bare"
      size="lg"
      placeholder="Search tasks…"
    />
    {#if query}
      <button
        type="button"
        class="relative grid size-[1.125rem] shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-(--solus-surface-hover) text-(--solus-text-tertiary) transition-colors duration-100 after:absolute after:-inset-1.5 hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:text-(--solus-text-primary)"
        onclick={() => {
          query = "";
          searchEl?.focus();
        }}
        aria-label="Clear search"
        title="Clear search (Esc)"
      >
        <XIcon size={10} weight="bold" />
      </button>
    {/if}
  </div>

  {#if showStatus}
    <div
      class="h-4 w-px shrink-0 bg-(--solus-container-border)"
      aria-hidden="true"
    ></div>

    <div class="flex min-w-0 gap-0.5">
      {#each STATUS_TABS as tab (tab.value)}
        <button
          type="button"
          class={tabClass(status === tab.value)}
          onclick={() => (status = tab.value)}
          aria-pressed={status === tab.value}
        >
          {tab.label}
          <span class="tabular-nums opacity-70">{counts[tab.value]}</span>
        </button>
      {/each}
    </div>
  {/if}

  <button
    type="button"
    class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 text-[0.6875rem] transition-[background-color,border-color,color] duration-100 ease-in-out hover:bg-(--solus-accent-light) {assignedToMe
      ? 'border-(--solus-accent-border) bg-(--solus-accent-light) text-(--solus-accent)'
      : 'border-(--solus-container-border) bg-transparent text-(--solus-text-secondary)'}"
    onclick={() => (assignedToMe = !assignedToMe)}
    aria-pressed={assignedToMe}
    title="Only tasks assigned to me"
  >
    <UserIcon size={11} weight={assignedToMe ? "fill" : "regular"} />
    <span>Mine</span>
  </button>

  <!-- Sort: how to order both the list and the board ("what's next"). -->
  <div
    class="relative inline-flex shrink-0 items-center rounded-lg border border-(--solus-container-border) bg-transparent text-(--solus-text-secondary) hover:border-[color-mix(in_srgb,var(--solus-accent)_35%,transparent)] transition-colors duration-100"
    title="Sort tasks"
  >
    <ArrowsDownUpIcon size={11} class="pointer-events-none absolute left-2 text-(--solus-text-tertiary)" />
    <select
      bind:value={sort}
      aria-label="Sort tasks"
      class="cursor-pointer appearance-none rounded-lg border-0 bg-transparent py-1 pl-6 pr-5 text-[0.6875rem] outline-none"
    >
      {#each SORT_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <CaretDownIcon size={9} weight="bold" class="pointer-events-none absolute right-2 text-(--solus-text-tertiary)" />
  </div>
</div>
