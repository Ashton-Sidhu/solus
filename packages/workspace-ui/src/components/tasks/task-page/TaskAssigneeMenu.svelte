<script lang="ts">
  import type { TaskAssigneeCandidate } from "@solus/contracts/task-types";
  import { LoaderCircle as CircleNotchIcon, User as UserIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { ListAvatar, personFrom } from "../../ui/list-page";

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

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
  <DropdownMenu.Trigger {disabled} class={triggerClass}>
    {#if assignee}
      <ListAvatar person={personFrom(assignee, undefined, assigneeAvatarUrl)} size={20} />
      <span class="min-w-0 truncate">{assignee}</span>
    {:else}
      <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] text-muted-foreground">
        <UserIcon size={12} aria-hidden="true" />
      </span>
      <span class="text-muted-foreground">Unassigned</span>
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Content
    align="end"
    class="max-h-72 w-60 pointer-fine:[.is-laptop-display_&]:max-h-64 pointer-fine:[.is-laptop-display_&]:w-52"
  >
    <div class="px-1 pb-1.5">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        data-dictation="false"
        value={query}
        oninput={(event) => (query = event.currentTarget.value)}
        onkeydown={(event) => event.stopPropagation()}
        placeholder="Search people…"
        aria-label="Search assignees"
        class="h-9 w-full rounded-lg bg-[var(--wash-2)] px-2.5 text-workspace-chrome outline-none placeholder:text-muted-foreground focus:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_55%,transparent)] pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2"
      />
    </div>

    {#if assignee}
      <DropdownMenu.Item onSelect={() => select(null)}>
        <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] text-muted-foreground">
          <UserIcon size={12} aria-hidden="true" />
        </span>
        Unassigned
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
    {/if}

    {#if loading}
      <DropdownMenu.Item disabled>
        <CircleNotchIcon size={14} class="animate-spin" />
        Loading people…
      </DropdownMenu.Item>
    {:else if error}
      <DropdownMenu.Item disabled class="whitespace-normal text-muted-foreground">
        {error}
      </DropdownMenu.Item>
    {:else if visibleCandidates.length === 0}
      <DropdownMenu.Item disabled>
        {query ? "No matching people" : "No people available"}
      </DropdownMenu.Item>
    {:else}
      {#each visibleCandidates as candidate (candidate.login)}
        <DropdownMenu.Item onSelect={() => select(candidate.login)}>
          <ListAvatar person={personFrom(candidate.login, undefined, candidate.avatarUrl)} size={20} />
          <span class="min-w-0 flex-1 truncate">{candidate.login}</span>
          {#if candidate.login === assignee}
            <span class="text-primary" aria-hidden="true">✓</span>
          {/if}
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
