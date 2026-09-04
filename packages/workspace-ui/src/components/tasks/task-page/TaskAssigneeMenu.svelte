<script lang="ts">
  import type { TaskAssigneeCandidate } from "@solus/contracts/task-types";
  import { Check as CheckIcon, User as UserIcon } from "@lucide/svelte";
  import * as Command from "../../ui/command";
  import { ListAvatar, personFrom } from "../../ui/list-page";
  import { MenuSearch } from "../../ui/menu";
  import * as Popover from "../../ui/popover";

  /** Who the task is assigned to, as a menu: the same surface every other
   *  picker in the app opens, over the host's assignable people. */
  interface Props {
    assignee?: string;
    assigneeAvatarUrl?: string;
    candidates: TaskAssigneeCandidate[];
    loading: boolean;
    error?: string;
    disabled: boolean;
    triggerClass: string;
    onOpen: () => void;
    onSelect: (assignee: string | null) => void;
  }

  let {
    assignee,
    assigneeAvatarUrl,
    candidates,
    loading,
    error,
    disabled,
    triggerClass,
    onOpen,
    onSelect,
  }: Props = $props();

  let open = $state(false);
  let query = $state("");
  const visibleCandidates = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? candidates.filter((candidate) => candidate.login.toLowerCase().includes(needle))
      : candidates;
  });

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) onOpen();
    else query = "";
  }

  function select(next: string | null): void {
    open = false;
    query = "";
    onSelect(next);
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger {disabled} class={triggerClass}>
    {#if assignee}
      <ListAvatar person={personFrom(assignee, undefined, assigneeAvatarUrl)} size={20} />
      <span class="min-w-0 truncate">{assignee}</span>
    {:else}
      <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] text-muted-foreground">
        <UserIcon size={12} aria-hidden="true" />
      </span>
      <span class="text-muted-foreground">Unassigned</span>
    {/if}
  </Popover.Trigger>

  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(15rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome pointer-fine:[.is-laptop-display_&]:w-[min(13rem,calc(100vw-2rem))]"
    aria-label="Assign the task"
  >
    <Command.Root shouldFilter={false}>
      <MenuSearch bind:value={query} placeholder="Search people" />
      <Command.List
        class="max-h-[min(17.5rem,calc(var(--bits-popover-content-available-height,20rem)-3rem))] overflow-y-auto p-1.5"
      >
        {#if assignee}
          <Command.Item value="unassigned" onSelect={() => select(null)}>
            <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] text-muted-foreground">
              <UserIcon size={12} aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1 truncate">Unassigned</span>
          </Command.Item>
          <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>
        {/if}

        {#if loading}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">Loading people…</p>
        {:else if error}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">{error}</p>
        {:else if visibleCandidates.length === 0}
          <p class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            {query ? "No matching people" : "No people available"}
          </p>
        {:else}
          {#each visibleCandidates as candidate (candidate.login)}
            {@const current = candidate.login === assignee}
            <Command.Item
              value={candidate.login}
              onSelect={() => select(candidate.login)}
              data-menu-current={current ? "" : undefined}
            >
              <ListAvatar person={personFrom(candidate.login, undefined, candidate.avatarUrl)} size={20} />
              <span class="min-w-0 flex-1 truncate">{candidate.login}</span>
              {#if current}
                <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
              {/if}
            </Command.Item>
          {/each}
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
