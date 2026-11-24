<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    FolderGit2 as RepositoryIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import type { DiffRepository } from "./lib/diff-repositories";

  /**
   * Which repository of the session the review reads: the repository of the
   * working directory, or one of the session's `git` folders. The host owns
   * the choice, so a selection goes back to it and the scope, the turns and
   * the diff all read the new repository.
   */
  let {
    repositories,
    repository,
    onSelect,
  }: {
    repositories: DiffRepository[];
    repository: DiffRepository;
    onSelect: (path: string) => void;
  } = $props();

  let open = $state(false);
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="no-drag flex shrink-0 cursor-pointer items-center gap-1.5 border-0 h-8 rounded-full bg-background px-2.5 text-workspace-chrome text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:tap-area aria-expanded:bg-[var(--wash-1)]"
        aria-label={`Repository: ${repository.name}`}
        data-testid="review-repository-picker"
      >
        <RepositoryIcon class="size-[15px] shrink-0 text-(--solus-text-tertiary)" strokeWidth={1.5} aria-hidden="true" />
        <span class="max-w-40 truncate text-(--solus-text-primary) @max-[30rem]/band:max-w-24">{repository.name}</span>
        <CaretDownIcon class="size-3.5 shrink-0 text-(--solus-text-tertiary)" strokeWidth={1.5} aria-hidden="true" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(15rem,calc(100vw-2rem))]"
  >
    <DropdownMenu.Label>Repository</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={repository.path}>
      {#each repositories as each (each.path)}
        <DropdownMenu.RadioItem value={each.path} title={each.path} onSelect={() => onSelect(each.path)}>
          <RepositoryIcon size={14} />
          <span class="min-w-0 truncate">{each.name}</span>
          {#if each.isWorkingDirectory}
            <span class="ml-auto shrink-0 text-(--solus-text-tertiary)">Working directory</span>
          {/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
