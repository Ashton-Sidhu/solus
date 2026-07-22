<script lang="ts">
  import {
    CaretUpDownIcon,
    CheckIcon,
  } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { displayProjectPath } from "./lib/pr-utils";

  // The inbox title: the project name is the page's primary scoping control,
  // so it renders title-sized as a real button with the switcher menu anchored
  // beneath it. PRs load per project, defaulting to the one being worked in;
  // switching pins the inbox to another repo. `compact` shrinks it for the
  // docked list pane.
  let {
    options,
    activePath,
    currentPath,
    compact = false,
    onSelect,
  }: {
    options: { path: string; name: string }[];
    activePath: string;
    currentPath: string;
    compact?: boolean;
    onSelect: (path: string) => void;
  } = $props();

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const activeName = $derived(
    options.find((option) => option.path === activePath)?.name ??
      "Choose a project",
  );
</script>

<Button
  type="button"
  bind:ref={triggerEl}
  class="flex min-w-0 cursor-pointer items-center rounded-lg border-0 bg-transparent font-medium text-(--solus-text-primary) transition-colors duration-100 hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {compact
    ? '-ml-1.5 gap-1.5 px-1.5 py-0.5 text-[0.75rem]'
    : '-ml-2 gap-2 px-2 py-1 text-[0.9375rem] tracking-[-0.01em]'}"
  aria-label="Project"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  onclick={() => (menuOpen = !menuOpen)}
>
  {#key activePath}
    <ProjectFavicon projectRoot={activePath} />
  {/key}
  <span class="min-w-0 truncate">{activeName}</span>
  <CaretUpDownIcon
    size={compact ? 10 : 12}
    class="shrink-0 text-(--solus-text-tertiary)"
  />
</Button>
<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="start"
    sideOffset={6}
    class="w-[272px]"
  >
    <div class="py-1">
      {#each options as option (option.path)}
        <DropdownMenu.Item
          onSelect={() => {
            menuOpen = false;
            onSelect(option.path);
          }}
        >
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <ProjectFavicon projectRoot={option.path} />
            <div class="min-w-0 flex-1">
              <p
                class="flex items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-text-primary)"
              >
                <span class="min-w-0 truncate">{option.name}</span>
                {#if option.path === currentPath}
                  <span
                    class="shrink-0 rounded-full bg-(--solus-accent-light) px-1.5 py-px text-[0.5625rem] font-semibold text-(--solus-accent)"
                  >
                    Current
                  </span>
                {/if}
              </p>
              <p class="truncate text-[0.625rem] text-(--solus-text-tertiary)">
                {displayProjectPath(option.path)}
              </p>
            </div>
            {#if option.path === activePath}
              <CheckIcon
                size={12}
                weight="bold"
                class="shrink-0 text-(--solus-accent)"
              />
            {/if}
          </div>
        </DropdownMenu.Item>
      {/each}
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
